import type {
  BrowserSession,
  Interaction,
  ReservationIntent,
} from "../domain/models.js";
import type { KeyValueStore } from "./key-value-store.js";

export interface OAuthClientRecord {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
}

export interface OAuthAuthorizationRequest {
  request_id: string;
  client_id: string;
  redirect_uri: string;
  state?: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: "S256";
  created_at: string;
  expires_at: string;
}

export interface OAuthAuthorizationCode extends OAuthAuthorizationRequest {
  code: string;
  email: string;
}

export class Repositories {
  constructor(readonly store: KeyValueStore) {}

  getReservation(id: string): Promise<ReservationIntent | undefined> {
    return this.store.get("reservations", id);
  }

  putReservation(value: ReservationIntent): Promise<void> {
    return this.store.put("reservations", value.reservation_id, value, value.expires_at);
  }

  claimReservation(
    next: ReservationIntent,
    expectedNonce: string,
    expectedStates: ReservationIntent["state"][],
  ): Promise<boolean> {
    return this.store.compareAndSet<ReservationIntent>(
      "reservations",
      next.reservation_id,
      (current) =>
        current !== undefined &&
        current.principal_id === next.principal_id &&
        current.summary_hash === next.summary_hash &&
        current.confirmation_nonce === expectedNonce &&
        expectedStates.includes(current.state),
      next,
      next.expires_at,
    );
  }

  getBrowserSession(id: string): Promise<BrowserSession | undefined> {
    return this.store.get("browser_sessions", id);
  }

  putBrowserSession(value: BrowserSession): Promise<void> {
    return this.store.put("browser_sessions", value.session_id, value, value.expires_at);
  }

  getInteraction(id: string): Promise<Interaction | undefined> {
    return this.store.get("interactions", id);
  }

  putInteraction(value: Interaction): Promise<void> {
    return this.store.put("interactions", value.interaction_id, value, value.expires_at);
  }

  getOAuthClient(id: string): Promise<OAuthClientRecord | undefined> {
    return this.store.get("oauth_clients", id);
  }

  putOAuthClient(value: OAuthClientRecord): Promise<void> {
    return this.store.put("oauth_clients", value.client_id, value);
  }

  getOAuthRequest(id: string): Promise<OAuthAuthorizationRequest | undefined> {
    return this.store.get("oauth_requests", id);
  }

  putOAuthRequest(value: OAuthAuthorizationRequest): Promise<void> {
    return this.store.put("oauth_requests", value.request_id, value, value.expires_at);
  }

  deleteOAuthRequest(id: string): Promise<void> {
    return this.store.delete("oauth_requests", id);
  }

  getOAuthCode(code: string): Promise<OAuthAuthorizationCode | undefined> {
    return this.store.get("oauth_codes", code);
  }

  putOAuthCode(value: OAuthAuthorizationCode): Promise<void> {
    return this.store.put("oauth_codes", value.code, value, value.expires_at);
  }

  deleteOAuthCode(code: string): Promise<void> {
    return this.store.delete("oauth_codes", code);
  }
}
