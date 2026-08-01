import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Request, Response, Router } from "express";
import express from "express";
import { OAuth2Client } from "google-auth-library";
import type { Logger } from "pino";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { Repositories } from "../storage/repositories.js";
import type { AccessTokenService } from "./access-token-service.js";
import { TokenService } from "../services/token-service.js";

const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(200).default("MCP client"),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

const authorizeSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  scope: z.string().default("mcp"),
  state: z.string().max(2048).optional(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  resource: z.string().url().optional(),
});

const tokenSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(20),
  redirect_uri: z.string().url(),
  client_id: z.string().min(1),
  code_verifier: z.string().min(43).max(128),
});

export class OAuthController {
  readonly #google: OAuth2Client;

  constructor(
    readonly config: AppConfig,
    readonly repositories: Repositories,
    readonly accessTokens: AccessTokenService,
    readonly logger: Logger,
  ) {
    const callbackUrl = new URL("/auth/google/callback", config.publicBaseUrl).toString();
    this.#google = new OAuth2Client(
      config.googleOAuthClientId,
      config.googleOAuthClientSecret,
      callbackUrl,
    );
  }

  router(): Router {
    const router = express.Router();
    router.post("/oauth/register", express.json({ limit: "32kb" }), (request, response) => {
      void this.#register(request, response);
    });
    router.get("/oauth/authorize", (request, response) => {
      void this.#authorize(request, response);
    });
    router.post("/oauth/token", express.urlencoded({ extended: false, limit: "16kb" }), (request, response) => {
      void this.#token(request, response);
    });
    router.get("/auth/google/start", (request, response) => {
      void this.#googleStart(request, response);
    });
    router.get("/auth/google/callback", (request, response) => {
      void this.#googleCallback(request, response);
    });
    return router;
  }

  async #register(request: Request, response: Response): Promise<void> {
    try {
      const input = registrationSchema.parse(request.body);
      for (const uri of input.redirect_uris) {
        assertRedirectUri(uri, this.config.nodeEnv !== "production");
      }
      const client = {
        client_id: randomUUID(),
        client_name: input.client_name,
        redirect_uris: input.redirect_uris,
        created_at: new Date().toISOString(),
      };
      await this.repositories.putOAuthClient(client);
      response.status(201).json({
        client_id: client.client_id,
        client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      });
    } catch (error) {
      response.status(400).json({
        error: "invalid_client_metadata",
        error_description: error instanceof Error ? error.message : "Invalid registration",
      });
    }
  }

  async #authorize(request: Request, response: Response): Promise<void> {
    try {
      const input = authorizeSchema.parse(request.query);
      const client = await this.repositories.getOAuthClient(input.client_id);
      if (client === undefined || !client.redirect_uris.includes(input.redirect_uri)) {
        response.status(400).json({ error: "invalid_request", error_description: "Unknown client or redirect URI" });
        return;
      }
      if (!input.scope.split(/\s+/).includes("mcp")) {
        this.#redirectOAuthError(response, input.redirect_uri, input.state, "invalid_scope");
        return;
      }
      if (input.resource !== undefined) {
        const expected = new URL("/mcp", this.config.publicBaseUrl).toString();
        if (new URL(input.resource).toString() !== expected) {
          this.#redirectOAuthError(response, input.redirect_uri, input.state, "invalid_target");
          return;
        }
      }
      const now = new Date();
      const authorizationRequest = {
        request_id: randomUUID(),
        client_id: input.client_id,
        redirect_uri: input.redirect_uri,
        ...(input.state === undefined ? {} : { state: input.state }),
        scope: input.scope,
        code_challenge: input.code_challenge,
        code_challenge_method: input.code_challenge_method,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      };
      await this.repositories.putOAuthRequest(authorizationRequest);
      response.redirect(
        302,
        `/auth/google/start?request_id=${encodeURIComponent(authorizationRequest.request_id)}`,
      );
    } catch (error) {
      response.status(400).json({
        error: "invalid_request",
        error_description: error instanceof Error ? error.message : "Invalid authorization request",
      });
    }
  }

  async #googleStart(request: Request, response: Response): Promise<void> {
    const requestId = typeof request.query.request_id === "string" ? request.query.request_id : "";
    const authorizationRequest = await this.repositories.getOAuthRequest(requestId);
    if (authorizationRequest === undefined) {
      response.status(400).type("text/plain").send("Authorization request expired.");
      return;
    }
    if (this.config.googleOAuthClientId === undefined) {
      response.status(503).type("text/plain").send("Google OAuth is not configured.");
      return;
    }
    response.cookie("gurunavi_oauth_state", requestId, {
      signed: true,
      httpOnly: true,
      secure: this.config.nodeEnv === "production",
      sameSite: "lax",
      maxAge: 10 * 60 * 1000,
      path: "/auth/google",
    });
    const url = this.#google.generateAuthUrl({
      access_type: "online",
      prompt: "select_account",
      scope: ["openid", "email"],
      state: requestId,
    });
    response.redirect(302, url);
  }

  async #googleCallback(request: Request, response: Response): Promise<void> {
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const code = typeof request.query.code === "string" ? request.query.code : "";
    const signedState =
      typeof request.signedCookies?.gurunavi_oauth_state === "string"
        ? request.signedCookies.gurunavi_oauth_state
        : "";
    if (!TokenService.safeEqual(state, signedState) || code.length === 0) {
      response.status(400).type("text/plain").send("OAuth state validation failed.");
      return;
    }
    const authorizationRequest = await this.repositories.getOAuthRequest(state);
    if (authorizationRequest === undefined) {
      response.status(400).type("text/plain").send("Authorization request expired.");
      return;
    }
    try {
      const { tokens } = await this.#google.getToken(code);
      if (tokens.id_token === null || tokens.id_token === undefined) {
        throw new Error("Google did not return an ID token");
      }
      const clientId = this.config.googleOAuthClientId;
      if (clientId === undefined) {
        throw new Error("Google OAuth is not configured");
      }
      const ticket = await this.#google.verifyIdToken({
        idToken: tokens.id_token,
        audience: clientId,
      });
      const payload = ticket.getPayload();
      const email = payload?.email?.toLowerCase();
      if (email === undefined || payload?.email_verified !== true) {
        throw new Error("A verified Google email is required");
      }
      if (this.config.allowedEmails.size > 0 && !this.config.allowedEmails.has(email)) {
        response.status(403).type("text/plain").send("This Google account is not allowed.");
        return;
      }
      const oauthCode = randomBytes(32).toString("base64url");
      await this.repositories.putOAuthCode({
        ...authorizationRequest,
        code: oauthCode,
        email,
      });
      await this.repositories.deleteOAuthRequest(authorizationRequest.request_id);
      response.clearCookie("gurunavi_oauth_state", { path: "/auth/google" });
      const redirect = new URL(authorizationRequest.redirect_uri);
      redirect.searchParams.set("code", oauthCode);
      if (authorizationRequest.state !== undefined) {
        redirect.searchParams.set("state", authorizationRequest.state);
      }
      response.redirect(302, redirect.toString());
    } catch (error) {
      this.logger.warn({ err: error }, "Google OAuth callback failed");
      this.#redirectOAuthError(
        response,
        authorizationRequest.redirect_uri,
        authorizationRequest.state,
        "access_denied",
      );
    }
  }

  async #token(request: Request, response: Response): Promise<void> {
    try {
      const input = tokenSchema.parse(request.body);
      const authorizationCode = await this.repositories.getOAuthCode(input.code);
      if (
        authorizationCode === undefined ||
        authorizationCode.client_id !== input.client_id ||
        authorizationCode.redirect_uri !== input.redirect_uri
      ) {
        response.status(400).json({ error: "invalid_grant" });
        return;
      }
      const challenge = createHash("sha256")
        .update(input.code_verifier, "ascii")
        .digest("base64url");
      if (!TokenService.safeEqual(challenge, authorizationCode.code_challenge)) {
        response.status(400).json({ error: "invalid_grant" });
        return;
      }
      await this.repositories.deleteOAuthCode(input.code);
      response
        .status(200)
        .setHeader("Cache-Control", "no-store")
        .json(
          await this.accessTokens.issue(
            authorizationCode.email,
            authorizationCode.client_id,
            authorizationCode.scope,
          ),
        );
    } catch (error) {
      response.status(400).json({
        error: "invalid_request",
        error_description: error instanceof Error ? error.message : "Invalid token request",
      });
    }
  }

  #redirectOAuthError(
    response: Response,
    redirectUri: string,
    state: string | undefined,
    error: string,
  ): void {
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("error", error);
    if (state !== undefined) {
      redirect.searchParams.set("state", state);
    }
    response.redirect(302, redirect.toString());
  }
}

function assertRedirectUri(candidate: string, allowLocalhost: boolean): void {
  const url = new URL(candidate);
  if (url.hash.length > 0 || url.username.length > 0 || url.password.length > 0) {
    throw new Error("Redirect URIs cannot contain fragments or credentials");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowLocalhost && local && url.protocol === "http:")) {
    throw new Error("Redirect URIs must use HTTPS, except localhost during development");
  }
}
