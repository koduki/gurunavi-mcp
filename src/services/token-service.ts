import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { SignJWT, jwtVerify, type JWTPayload } from "jose";

import type { AppConfig } from "../config.js";

interface ConfirmationClaims extends JWTPayload {
  purpose: "reservation_submit" | "reservation_cancel";
  reservation_id: string;
  summary_hash: string;
  nonce: string;
}

interface InteractionClaims extends JWTPayload {
  purpose: "browser_interaction";
  interaction_id: string;
  session_id: string;
}

export class TokenService {
  readonly #key: Uint8Array;

  constructor(readonly config: AppConfig) {
    this.#key = createHash("sha256").update(config.tokenSigningSecret, "utf8").digest();
  }

  async issueConfirmation(
    principalId: string,
    reservationId: string,
    summaryHash: string,
    purpose: ConfirmationClaims["purpose"],
    nonce = randomUUID(),
  ): Promise<{ token: string; nonce: string; expiresAt: string }> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + this.config.interactionTokenTtlSeconds;
    const token = await new SignJWT({
      purpose,
      reservation_id: reservationId,
      summary_hash: summaryHash,
      nonce,
    } satisfies Omit<ConfirmationClaims, keyof JWTPayload>)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.config.publicBaseUrl.origin)
      .setAudience("gurunavi-mcp-confirmation")
      .setSubject(principalId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(randomUUID())
      .sign(this.#key);
    return { token, nonce, expiresAt: new Date(expiresAt * 1000).toISOString() };
  }

  async verifyConfirmation(
    token: string,
    purpose: ConfirmationClaims["purpose"],
  ): Promise<ConfirmationClaims> {
    const { payload } = await jwtVerify(token, this.#key, {
      issuer: this.config.publicBaseUrl.origin,
      audience: "gurunavi-mcp-confirmation",
      algorithms: ["HS256"],
    });
    if (
      payload.purpose !== purpose ||
      typeof payload.reservation_id !== "string" ||
      typeof payload.summary_hash !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.sub !== "string"
    ) {
      throw new Error("Confirmation token claims are invalid");
    }
    return payload as ConfirmationClaims;
  }

  async issueInteraction(
    principalId: string,
    interactionId: string,
    sessionId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + this.config.interactionTokenTtlSeconds;
    const token = await new SignJWT({
      purpose: "browser_interaction",
      interaction_id: interactionId,
      session_id: sessionId,
    } satisfies Omit<InteractionClaims, keyof JWTPayload>)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.config.publicBaseUrl.origin)
      .setAudience("gurunavi-browser-interaction")
      .setSubject(principalId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(randomUUID())
      .sign(this.#key);
    return { token, expiresAt: new Date(expiresAt * 1000).toISOString() };
  }

  async verifyInteraction(token: string): Promise<InteractionClaims> {
    const { payload } = await jwtVerify(token, this.#key, {
      issuer: this.config.publicBaseUrl.origin,
      audience: "gurunavi-browser-interaction",
      algorithms: ["HS256"],
    });
    if (
      payload.purpose !== "browser_interaction" ||
      typeof payload.interaction_id !== "string" ||
      typeof payload.session_id !== "string" ||
      typeof payload.sub !== "string"
    ) {
      throw new Error("Interaction token claims are invalid");
    }
    return payload as InteractionClaims;
  }

  static safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
    );
  }
}
