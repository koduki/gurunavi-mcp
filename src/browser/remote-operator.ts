import { GoogleAuth } from "google-auth-library";
import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type { AgentResult } from "../domain/models.js";
import { workerCommandSchema, type WorkerCommand } from "../domain/schemas.js";
import type { BrowserOperator } from "./operator.js";

export class RemoteBrowserOperator implements BrowserOperator {
  readonly #auth = new GoogleAuth();

  constructor(
    readonly config: AppConfig,
    readonly logger: Logger,
  ) {
    if (config.browserWorkerUrl === undefined) {
      throw new Error("BROWSER_WORKER_URL is required for the remote browser operator");
    }
  }

  async execute(command: WorkerCommand): Promise<AgentResult<unknown>> {
    const body = JSON.stringify(workerCommandSchema.parse(command));
    const endpoint = new URL("/internal/browser/execute", this.config.browserWorkerUrl);
    const headers = new Headers({ "content-type": "application/json" });

    if (this.config.nodeEnv === "production") {
      const audience =
        this.config.browserWorkerAudience ?? this.config.browserWorkerUrl?.origin ?? endpoint.origin;
      const client = await this.#auth.getIdTokenClient(audience);
      const requestHeaders = await client.getRequestHeaders(endpoint.toString());
      for (const [name, value] of requestHeaders.entries()) {
        headers.set(name, value);
      }
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      this.logger.warn({ status: response.status }, "Browser worker request failed");
      return {
        status: response.status === 429 || response.status >= 500 ? "temporarily_blocked" : "failed",
        error: {
          code: "BROWSER_WORKER_ERROR",
          message: `Browser worker returned HTTP ${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
        },
      };
    }
    return (await response.json()) as AgentResult<unknown>;
  }
}
