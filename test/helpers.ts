import pino from "pino";

import type { BrowserOperator } from "../src/browser/operator.js";
import type { AppConfig } from "../src/config.js";
import type { AgentResult } from "../src/domain/models.js";
import type { WorkerCommand } from "../src/domain/schemas.js";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    serviceMode: "all",
    port: 8080,
    publicBaseUrl: new URL("http://localhost:8080"),
    gurunaviBaseUrl: new URL("https://r.gnavi.co.jp"),
    browserInteractionBaseUrl: new URL("http://localhost:8080"),
    firestoreDatabaseId: "(default)",
    allowedEmails: new Set(["master@example.com"]),
    tokenSigningSecret: "test-token-signing-secret-with-more-than-32-bytes",
    sessionEncryptionKey: "test-session-encryption-key-with-more-than-32-bytes",
    interactionTokenTtlSeconds: 900,
    reservationSubmitEnabled: false,
    authDisabled: true,
    gurunaviMinRequestIntervalMs: 250,
    gurunaviNavigationTimeoutMs: 5000,
    cloudTasksQueue: "test-queue",
    cloudTasksLocation: "asia-northeast1",
    logLevel: "silent",
    ...overrides,
  };
}

export const silentLogger = pino({ level: "silent" });

export class FakeBrowserOperator implements BrowserOperator {
  readonly commands: WorkerCommand[] = [];

  constructor(
    readonly handler: (command: WorkerCommand) => AgentResult<unknown> | Promise<AgentResult<unknown>>,
  ) {}

  async execute(command: WorkerCommand): Promise<AgentResult<unknown>> {
    this.commands.push(command);
    return this.handler(command);
  }
}
