import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { AgentResult, BrowserSession, Interaction } from "../domain/models.js";
import type { Repositories } from "../storage/repositories.js";
import type { TokenService } from "./token-service.js";

export class InteractionService {
  constructor(
    readonly config: AppConfig,
    readonly repositories: Repositories,
    readonly tokens: TokenService,
  ) {}

  async create(
    principalId: string,
    kind: Interaction["kind"],
    targetUrl: string,
    existingSessionId?: string,
  ): Promise<AgentResult<{ session_id: string; interaction_url: string }>> {
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.config.interactionTokenTtlSeconds * 1000,
    ).toISOString();
    const sessionId = existingSessionId ?? randomUUID();
    let session = await this.repositories.getBrowserSession(sessionId);
    if (session !== undefined && session.principal_id !== principalId) {
      throw new Error("Browser session ownership mismatch");
    }
    if (session === undefined) {
      session = {
        session_id: sessionId,
        principal_id: principalId,
        connected: false,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      } satisfies BrowserSession;
      await this.repositories.putBrowserSession(session);
    }

    const interactionId = randomUUID();
    const interaction: Interaction = {
      interaction_id: interactionId,
      principal_id: principalId,
      kind,
      state: "pending",
      session_id: sessionId,
      target_url: targetUrl,
      created_at: now.toISOString(),
      expires_at: expiresAt,
    };
    await this.repositories.putInteraction(interaction);
    const issued = await this.tokens.issueInteraction(principalId, interactionId, sessionId);
    const url = new URL(
      `/interactions/${encodeURIComponent(interactionId)}`,
      this.config.browserInteractionBaseUrl,
    );
    url.hash = `token=${encodeURIComponent(issued.token)}`;

    return {
      status: "human_action_required",
      interaction_id: interactionId,
      data: { session_id: sessionId, interaction_url: url.toString() },
      required_actions: [
        {
          type: "open_interaction_url",
          message:
            "期限付き専用ブラウザを開き、ログイン・本人確認など必要な操作だけを完了してください。資格情報はMCPへ返されません。",
          interaction_url: url.toString(),
          expires_at: issued.expiresAt,
        },
      ],
    };
  }

  async resume(
    principalId: string,
    interactionId: string,
  ): Promise<AgentResult<Record<string, unknown>>> {
    const interaction = await this.repositories.getInteraction(interactionId);
    if (interaction === undefined || interaction.principal_id !== principalId) {
      return {
        status: "failed",
        error: { code: "INTERACTION_NOT_FOUND", message: "Interaction not found", retryable: false },
      };
    }
    if (Date.parse(interaction.expires_at) <= Date.now() && interaction.state !== "completed") {
      interaction.state = "expired";
      await this.repositories.putInteraction(interaction);
    }
    if (interaction.state === "completed") {
      return {
        status: "completed",
        data: {
          session_id: interaction.session_id,
          interaction_state: interaction.state,
          ...(interaction.result ?? {}),
        },
      };
    }
    return {
      status: "human_action_required",
      interaction_id: interaction.interaction_id,
      data: { session_id: interaction.session_id, interaction_state: interaction.state },
      required_actions: [
        {
          type: "open_interaction_url",
          message: "専用ブラウザで必要な操作を完了してから、もう一度再開してください。",
        },
      ],
    };
  }
}
