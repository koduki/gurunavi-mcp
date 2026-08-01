import { createHash, randomUUID } from "node:crypto";

import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { jwtVerify, SignJWT } from "jose";

import type { AppConfig } from "../config.js";

interface AccessTokenClaims {
  email: string;
  client_id: string;
  scope: string;
}

export class AccessTokenService implements OAuthTokenVerifier {
  readonly #key: Uint8Array;

  constructor(readonly config: AppConfig) {
    this.#key = createHash("sha256").update(config.tokenSigningSecret, "utf8").digest();
  }

  async issue(email: string, clientId: string, scope: string): Promise<{
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    scope: string;
  }> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresIn = 3600;
    const accessToken = await new SignJWT({
      email,
      client_id: clientId,
      scope,
    } satisfies AccessTokenClaims)
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(this.config.publicBaseUrl.origin)
      .setAudience(new URL("/mcp", this.config.publicBaseUrl).toString())
      .setSubject(email)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + expiresIn)
      .setJti(randomUUID())
      .sign(this.#key);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const resource = new URL("/mcp", this.config.publicBaseUrl);
      const { payload } = await jwtVerify(token, this.#key, {
        issuer: this.config.publicBaseUrl.origin,
        audience: resource.toString(),
        algorithms: ["HS256"],
      });
      if (
        typeof payload.email !== "string" ||
        typeof payload.client_id !== "string" ||
        typeof payload.scope !== "string" ||
        typeof payload.exp !== "number"
      ) {
        throw new Error("Access token claims are invalid");
      }
      if (
        this.config.allowedEmails.size > 0 &&
        !this.config.allowedEmails.has(payload.email.toLowerCase())
      ) {
        throw new Error("Account is no longer allowed");
      }
      return {
        token,
        clientId: payload.client_id,
        scopes: payload.scope.split(/\s+/).filter(Boolean),
        expiresAt: payload.exp,
        resource,
        extra: { email: payload.email },
      };
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is invalid or expired");
    }
  }
}
