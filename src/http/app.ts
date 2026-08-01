import { createServer, type Server } from "node:http";

import cookieParser from "cookie-parser";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  type AuthInfo,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import helmet from "helmet";
import express from "express";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";

import { AccessTokenService } from "../auth/access-token-service.js";
import { OAuthController } from "../auth/oauth-controller.js";
import { createWorkerAuth } from "../auth/worker-auth.js";
import { GurunaviBrowserOperator } from "../adapters/gurunavi/browser-operator.js";
import { BrowserHandoffManager } from "../browser/handoff-manager.js";
import type { BrowserOperator } from "../browser/operator.js";
import { RemoteBrowserOperator } from "../browser/remote-operator.js";
import type { AppConfig } from "../config.js";
import { workerCommandSchema } from "../domain/schemas.js";
import { createGurunaviMcpServer } from "../mcp/server.js";
import { GurunaviService } from "../services/gurunavi-service.js";
import { InteractionService } from "../services/interaction-service.js";
import { TokenService } from "../services/token-service.js";
import { createTaskScheduler } from "../services/task-scheduler.js";
import { createKeyValueStore } from "../storage/key-value-store.js";
import { Repositories } from "../storage/repositories.js";
import { createStateCipher } from "../storage/state-cipher.js";
import { interactionPageHandler } from "./interaction-page.js";
import { z } from "zod";

export interface RunningApplication {
  server: Server;
  close: () => Promise<void>;
}

export function createApplication(config: AppConfig, logger: Logger): RunningApplication {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (request: { url?: string }) =>
          request.url === "/healthz" ||
          request.url === "/readyz" ||
          request.url?.startsWith("/interactions/") === true,
      },
    }),
  );
  app.use(cookieParser(config.tokenSigningSecret));

  const repositories = new Repositories(createKeyValueStore(config));
  const cipher = createStateCipher(config);
  const tokens = new TokenService(config);
  const accessTokens = new AccessTokenService(config);
  const interactions = new InteractionService(config, repositories, tokens);
  const tasks = createTaskScheduler(config, logger);
  const localBrowser = new GurunaviBrowserOperator(config, repositories, cipher, logger);
  const browser: BrowserOperator =
    config.serviceMode === "mcp" && config.browserWorkerUrl !== undefined
      ? new RemoteBrowserOperator(config, logger)
      : localBrowser;
  const service = new GurunaviService(
    config,
    browser,
    repositories,
    tokens,
    interactions,
    tasks,
  );

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok", service_mode: config.serviceMode });
  });
  app.get("/readyz", (_request, response) => {
    response.status(200).json({ status: "ready" });
  });

  let mcpHandler: ReturnType<typeof createMcpHandler> | undefined;
  if (config.serviceMode === "mcp" || config.serviceMode === "all") {
    const issuer = config.publicBaseUrl.origin;
    const resourceUrl = new URL("/mcp", config.publicBaseUrl);
    const oauthMetadata: OAuthMetadata = {
      issuer,
      authorization_endpoint: new URL("/oauth/authorize", config.publicBaseUrl).toString(),
      token_endpoint: new URL("/oauth/token", config.publicBaseUrl).toString(),
      registration_endpoint: new URL("/oauth/register", config.publicBaseUrl).toString(),
      scopes_supported: ["mcp"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    };
    app.use(
      mcpAuthMetadataRouter({
        oauthMetadata,
        resourceServerUrl: resourceUrl,
        scopesSupported: ["mcp"],
        resourceName: "Gurunavi Concierge MCP",
        serviceDocumentationUrl: new URL("/docs", config.publicBaseUrl),
        dangerouslyAllowInsecureIssuerUrl: config.nodeEnv !== "production",
      }),
    );
    const oauth = new OAuthController(config, repositories, accessTokens, logger);
    app.use(oauth.router());

    const refreshTaskSchema = z.object({
      principal_id: z.string().min(1),
      reservation_id: z.string().uuid(),
    });
    app.post(
      "/internal/tasks/reservation-refresh",
      createWorkerAuth(
        config,
        config.tasksInvokerEmail,
        config.tasksTargetUrl?.origin ?? config.publicBaseUrl.origin,
      ),
      async (request, response) => {
        const parsed = refreshTaskSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(400).json({ error: "invalid_task_payload" });
          return;
        }
        const result = await service.getReservationStatus(parsed.data.principal_id, {
          reservation_id: parsed.data.reservation_id,
          refresh_from_provider: true,
        });
        if (result.status === "temporarily_blocked") {
          response.status(503).json(result);
          return;
        }
        response.status(200).json(result);
      },
    );

    mcpHandler = createMcpHandler(
      (context) => createGurunaviMcpServer(service, principalFromAuth(context.authInfo)),
      {
        legacy: "stateless",
        responseMode: "auto",
        onerror: (error) => logger.error({ err: error }, "MCP request error"),
      },
    );
    const nodeHandler = toNodeHandler(mcpHandler, {
      onerror: (error) => logger.error({ err: error }, "MCP Node adapter error"),
    });
    const authMiddleware = config.authDisabled
      ? (request: Parameters<ReturnType<typeof requireBearerAuth>>[0], _response: unknown, next: () => void) => {
          request.auth = developmentAuthInfo(resourceUrl);
          next();
        }
      : requireBearerAuth({
          verifier: accessTokens,
          requiredScopes: ["mcp"],
          resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
        });
    app.all("/mcp", authMiddleware, async (request, response) => {
      await nodeHandler(request, response, request.body);
    });
  }

  let handoff: BrowserHandoffManager | undefined;
  if (config.serviceMode === "worker" || config.serviceMode === "all") {
    const workerAuth = createWorkerAuth(config);
    app.post("/internal/browser/execute", workerAuth, async (request, response) => {
      const parsed = workerCommandSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({
          error: "invalid_worker_command",
          details: parsed.error.issues,
        });
        return;
      }
      response.status(200).json(await localBrowser.execute(parsed.data));
    });
    app.get("/interactions/:interactionId", interactionPageHandler);
    handoff = new BrowserHandoffManager(config, repositories, cipher, tokens, logger);
  }

  app.get("/docs", (_request, response) => {
    response.status(200).type("text/plain").send(
      [
        "Gurunavi Concierge MCP",
        "",
        "MCP endpoint: /mcp",
        "OAuth discovery: /.well-known/oauth-protected-resource/mcp",
        "Live browser data; no restaurant database or broad crawling.",
        "Reservation submission is disabled by default.",
      ].join("\n"),
    );
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "not_found" });
  });

  const server = createServer(app);
  handoff?.attach(server);
  return {
    server,
    close: async () => {
      await mcpHandler?.close();
      await handoff?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

function principalFromAuth(authInfo?: AuthInfo): string {
  const email = authInfo?.extra?.email;
  if (typeof email === "string") {
    return email.toLowerCase();
  }
  return authInfo === undefined ? "anonymous" : `client:${authInfo.clientId}`;
}

function developmentAuthInfo(resource: URL): AuthInfo {
  return {
    token: "development",
    clientId: "local-development",
    scopes: ["mcp"],
    expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    resource,
    extra: { email: "local-master@example.invalid" },
  };
}
