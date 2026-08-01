import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import { isSafeBrowserRequestUrl } from "../adapters/gurunavi/urls.js";
import type { AppConfig } from "../config.js";
import type { Interaction } from "../domain/models.js";
import type { Repositories } from "../storage/repositories.js";
import type { StateCipher } from "../storage/state-cipher.js";
import type { TokenService } from "../services/token-service.js";

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number().min(0).max(1600), y: z.number().min(0).max(1200) }),
  z.object({ type: z.literal("text"), text: z.string().max(2048) }),
  z.object({
    type: z.literal("key"),
    key: z.enum([
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ]),
  }),
  z.object({ type: z.literal("scroll"), delta_y: z.number().min(-2000).max(2000) }),
  z.object({ type: z.literal("refresh") }),
  z.object({ type: z.literal("finish") }),
]);
const authenticationMessageSchema = z.object({
  type: z.literal("authenticate"),
  token: z.string().min(20).max(8192),
});

type StoredPlaywrightState = Exclude<BrowserContextOptions["storageState"], string | undefined>;

interface ActiveInteraction {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  socket: WebSocket;
  interaction: Interaction;
  screenshotTimer: NodeJS.Timeout;
}

export class BrowserHandoffManager {
  readonly #webSockets = new WebSocketServer({ noServer: true });
  readonly #active = new Map<string, ActiveInteraction>();

  constructor(
    readonly config: AppConfig,
    readonly repositories: Repositories,
    readonly cipher: StateCipher,
    readonly tokens: TokenService,
    readonly logger: Logger,
  ) {}

  attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      this.#upgrade(request, socket, head);
    });
  }

  async close(): Promise<void> {
    for (const active of this.#active.values()) {
      clearInterval(active.screenshotTimer);
      active.socket.close(1012, "Server shutting down");
      await active.context.close().catch(() => undefined);
      await active.browser.close().catch(() => undefined);
    }
    this.#active.clear();
    this.#webSockets.close();
  }

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      if (!hasSameOrigin(request, this.config.nodeEnv !== "production")) {
        socket.destroy();
        return;
      }
      const url = new URL(request.url ?? "/", "https://browser.invalid");
      const match = url.pathname.match(/^\/interactions\/([0-9a-f-]{36})\/ws$/i);
      if (match?.[1] === undefined) {
        socket.destroy();
        return;
      }
      this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        void this.#authenticateAndStart(webSocket, match[1] as string);
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Rejected browser handoff WebSocket");
      socket.destroy();
    }
  }

  async #authenticateAndStart(socket: WebSocket, interactionId: string): Promise<void> {
    try {
      const raw = await new Promise<WebSocket.RawData>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Interaction authentication timed out")), 10_000);
        socket.once("message", (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        socket.once("close", () => {
          clearTimeout(timer);
          reject(new Error("Interaction socket closed before authentication"));
        });
      });
      const message = authenticationMessageSchema.parse(
        JSON.parse(rawDataToString(raw)),
      );
      const claims = await this.tokens.verifyInteraction(message.token);
      if (claims.interaction_id !== interactionId) {
        throw new Error("Interaction token path mismatch");
      }
      const interaction = await this.repositories.getInteraction(claims.interaction_id);
      if (
        interaction === undefined ||
        interaction.principal_id !== claims.sub ||
        interaction.session_id !== claims.session_id ||
        Date.parse(interaction.expires_at) <= Date.now() ||
        !["pending", "active"].includes(interaction.state)
      ) {
        throw new Error("Interaction is unavailable or expired");
      }
      if (this.#active.has(interaction.interaction_id)) {
        throw new Error("Interaction is already open");
      }
      await this.#start(socket, interaction);
    } catch (error) {
      this.logger.warn({ err: error, interactionId }, "Rejected browser handoff authentication");
      socket.close(1008, "Unauthorized interaction");
    }
  }

  async #start(socket: WebSocket, interaction: Interaction): Promise<void> {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    try {
      const session = await this.repositories.getBrowserSession(interaction.session_id);
      if (session === undefined || session.principal_id !== interaction.principal_id) {
        throw new Error("Browser session not found");
      }
      const storageState =
        session.encrypted_storage_state === undefined
          ? undefined
          : await this.cipher.decrypt<StoredPlaywrightState>(session.encrypted_storage_state);
      browser = await chromium.launch({
        headless: true,
        args: ["--disable-dev-shm-usage", "--no-sandbox"],
      });
      context = await browser.newContext({
        locale: "ja-JP",
        timezoneId: "Asia/Tokyo",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 800 },
        ...(storageState === undefined ? {} : { storageState }),
      });
      await context.route("**/*", async (route) => {
        if (!isSafeBrowserRequestUrl(route.request().url())) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });
      let page = await context.newPage();
      page.setDefaultTimeout(this.config.gurunaviNavigationTimeoutMs);
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame() && !isAllowedInteractionUrl(frame.url())) {
          this.#send(socket, {
            type: "error",
            message: "安全のため、ぐるなび／楽天以外への移動を遮断しました。",
          });
          void page.goBack().catch(() => undefined);
        }
      });
      context.on("page", (newPage) => {
        void (async () => {
          await newPage.waitForLoadState("domcontentloaded").catch(() => undefined);
          if (!isAllowedInteractionUrl(newPage.url())) {
            await newPage.close();
            return;
          }
          page = newPage;
          const active = this.#active.get(interaction.interaction_id);
          if (active !== undefined) {
            active.page = page;
          }
        })();
      });
      if (!isAllowedInteractionUrl(interaction.target_url)) {
        throw new Error("Interaction target is outside the Gurunavi/Rakuten allowlist");
      }
      await page.goto(interaction.target_url, {
        waitUntil: "domcontentloaded",
        timeout: this.config.gurunaviNavigationTimeoutMs,
      });
      if (!isAllowedInteractionUrl(page.url())) {
        throw new Error("Interaction target left the allowed Gurunavi/Rakuten hosts");
      }

      interaction.state = "active";
      await this.repositories.putInteraction(interaction);
      const screenshotTimer = setInterval(() => {
        void this.#sendScreenshot(interaction.interaction_id);
      }, 900);
      const active: ActiveInteraction = {
        browser,
        context,
        page,
        socket,
        interaction,
        screenshotTimer,
      };
      this.#active.set(interaction.interaction_id, active);
      this.#send(socket, { type: "ready", expires_at: interaction.expires_at });
      await this.#sendScreenshot(interaction.interaction_id);

      socket.on("message", (raw) => {
        const message = rawDataToString(raw);
        void this.#onMessage(interaction.interaction_id, message);
      });
      socket.on("close", () => {
        void this.#stop(interaction.interaction_id, false);
      });
      socket.on("error", (error) => {
        this.logger.warn({ err: error, interactionId: interaction.interaction_id }, "Handoff socket error");
      });
    } catch (error) {
      this.logger.warn({ err: error, interactionId: interaction.interaction_id }, "Handoff failed");
      this.#send(socket, {
        type: "error",
        message: "専用ブラウザを開始できませんでした。新しい接続URLを発行してください。",
      });
      socket.close(1011);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }

  async #onMessage(interactionId: string, raw: string): Promise<void> {
    const active = this.#active.get(interactionId);
    if (active === undefined) {
      return;
    }
    try {
      const message = clientMessageSchema.parse(JSON.parse(raw));
      switch (message.type) {
        case "click":
          await active.page.mouse.click(message.x, message.y);
          break;
        case "text":
          await active.page.keyboard.insertText(message.text);
          break;
        case "key":
          await active.page.keyboard.press(message.key);
          break;
        case "scroll":
          await active.page.mouse.wheel(0, message.delta_y);
          break;
        case "refresh":
          await active.page.reload({ waitUntil: "domcontentloaded" });
          break;
        case "finish":
          await this.#stop(interactionId, true);
          return;
      }
      await this.#sendScreenshot(interactionId);
    } catch (error) {
      this.logger.debug({ err: error, interactionId }, "Ignored invalid handoff input");
      this.#send(active.socket, { type: "error", message: "その操作を処理できませんでした。" });
    }
  }

  async #sendScreenshot(interactionId: string): Promise<void> {
    const active = this.#active.get(interactionId);
    if (active === undefined || active.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (!isAllowedInteractionUrl(active.page.url())) {
      return;
    }
    const image = await active.page
      .screenshot({ type: "jpeg", quality: 65, animations: "disabled" })
      .catch(() => undefined);
    if (image === undefined) {
      return;
    }
    this.#send(active.socket, {
      type: "frame",
      image: image.toString("base64"),
      url: redactUrl(active.page.url()),
      title: await active.page.title().catch(() => "ぐるなび"),
      width: 1280,
      height: 800,
    });
  }

  async #stop(interactionId: string, completed: boolean): Promise<void> {
    const active = this.#active.get(interactionId);
    if (active === undefined) {
      return;
    }
    this.#active.delete(interactionId);
    clearInterval(active.screenshotTimer);
    try {
      if (completed) {
        const session = await this.repositories.getBrowserSession(active.interaction.session_id);
        if (session !== undefined) {
          session.encrypted_storage_state = await this.cipher.encrypt(
            await active.context.storageState(),
          );
          session.connected = true;
          session.updated_at = new Date().toISOString();
          await this.repositories.putBrowserSession(session);
        }
        active.interaction.state = "completed";
        active.interaction.result = { final_url: redactUrl(active.page.url()) };
        await this.repositories.putInteraction(active.interaction);
        this.#send(active.socket, {
          type: "complete",
          message: "ブラウザ状態を安全に保存しました。この画面を閉じてエージェントへ戻れます。",
        });
        active.socket.close(1000, "Completed");
      } else if (active.interaction.state === "active") {
        active.interaction.state = "pending";
        await this.repositories.putInteraction(active.interaction);
      }
    } finally {
      await active.context.close().catch(() => undefined);
      await active.browser.close().catch(() => undefined);
    }
  }

  #send(socket: WebSocket, value: Record<string, unknown>): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(value));
    }
  }
}

function rawDataToString(raw: WebSocket.RawData): string {
  return Array.isArray(raw)
    ? Buffer.concat(raw).toString("utf8")
    : raw instanceof ArrayBuffer
      ? Buffer.from(new Uint8Array(raw)).toString("utf8")
      : Buffer.from(raw).toString("utf8");
}

function isAllowedInteractionUrl(candidate: string): boolean {
  if (candidate === "about:blank") {
    return true;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") {
      return false;
    }
    return [
      "gnavi.co.jp",
      "rakuten.co.jp",
      "rakuten.com",
    ].some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function redactUrl(candidate: string): string {
  try {
    const url = new URL(candidate);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function hasSameOrigin(request: IncomingMessage, allowInsecure: boolean): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.host !== host) {
      return false;
    }
    return parsed.protocol === "https:" || (allowInsecure && parsed.protocol === "http:");
  } catch {
    return false;
  }
}
