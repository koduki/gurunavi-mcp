import type { NextFunction, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";

import type { AppConfig } from "../config.js";

export function createWorkerAuth(
  config: AppConfig,
  expectedEmail = config.browserInvokerEmail,
  expectedAudience = config.browserWorkerAudience ??
    config.browserWorkerUrl?.origin ??
    config.browserInteractionBaseUrl.origin,
) {
  const verifier = new OAuth2Client();
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (config.nodeEnv !== "production") {
      next();
      return;
    }
    const authorization = request.header("authorization");
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (token === undefined) {
      response.status(401).json({ error: "missing_worker_identity" });
      return;
    }
    try {
      const ticket = await verifier.verifyIdToken({ idToken: token, audience: expectedAudience });
      const payload = ticket.getPayload();
      const email = payload?.email?.toLowerCase();
      if (
        email === undefined ||
        (expectedEmail !== undefined && email !== expectedEmail)
      ) {
        response.status(403).json({ error: "worker_identity_not_allowed" });
        return;
      }
      next();
    } catch {
      response.status(401).json({ error: "invalid_worker_identity" });
    }
  };
}
