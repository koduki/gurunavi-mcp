import pino, { type Logger } from "pino";

import type { AppConfig } from "./config.js";

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "*.password",
  "*.token",
  "*.confirmation_token",
  "*.confirmationToken",
  "*.storageState",
  "*.phone",
  "*.email",
];

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: redactPaths,
      censor: "[REDACTED]",
    },
    base: {
      service: "gurunavi-mcp",
      mode: config.serviceMode,
    },
  });
}
