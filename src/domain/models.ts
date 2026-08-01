export type AgentResultStatus =
  | "completed"
  | "input_required"
  | "confirmation_required"
  | "human_action_required"
  | "temporarily_blocked"
  | "page_changed"
  | "failed";

export interface Evidence {
  source_url: string;
  observed_at: string;
  fields?: string[] | undefined;
}

export interface AgentWarning {
  code: string;
  message: string;
}

export interface RequiredAction {
  type:
    | "provide_input"
    | "open_interaction_url"
    | "confirm"
    | "contact_restaurant"
    | "retry_later";
  message: string;
  fields?: string[] | undefined;
  interaction_url?: string | undefined;
  expires_at?: string | undefined;
}

export interface AgentResult<T> {
  status: AgentResultStatus;
  data?: T | undefined;
  interaction_id?: string | undefined;
  required_actions?: RequiredAction[] | undefined;
  warnings?: AgentWarning[] | undefined;
  evidence?: Evidence[] | undefined;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface MoneyRange {
  currency: "JPY";
  min?: number | undefined;
  max?: number | undefined;
  basis: "per_person" | "total";
}

export interface VisitIntent {
  date: string;
  time?: string | undefined;
  party_size: number;
}

export interface RestaurantSearchInput {
  query?: string | undefined;
  area?: {
    free_text?: string | undefined;
    prefecture?: string | undefined;
    city?: string | undefined;
    station?: string | undefined;
    max_walk_minutes?: number | undefined;
  } | undefined;
  visit?: VisitIntent | undefined;
  preferences?: {
    cuisines?: string[] | undefined;
    excluded_cuisines?: string[] | undefined;
    features?: string[] | undefined;
    occasion?: string | undefined;
    free_text?: string[] | undefined;
  } | undefined;
  budget?: MoneyRange | undefined;
  sort?: "provider_default" | "relevance" | "budget_low" | "budget_high" | undefined;
  limit: number;
  cursor?: string | undefined;
}

export type AvailabilityKind = "instant" | "request" | "phone_only" | "unavailable" | "unknown";

export interface AvailabilityDay {
  date: string;
  kind: AvailabilityKind;
}

export interface RestaurantSummary {
  restaurant_id: string;
  provider: "gurunavi";
  name: string;
  source_url: string;
  categories: string[];
  access?: string | undefined;
  address?: string | undefined;
  budget_lunch?: MoneyRange | undefined;
  budget_dinner?: MoneyRange | undefined;
  availability?: AvailabilityDay[] | undefined;
  badges?: string[] | undefined;
  highlighted_plan?: {
    name: string;
    price?: MoneyRange | undefined;
  } | undefined;
}

export interface RestaurantSearchResult {
  restaurants: RestaurantSummary[];
  next_cursor?: string | undefined;
  ranking_disclosure: string;
  applied_criteria: string[];
  unapplied_criteria: string[];
}

export interface OpeningHours {
  day: string;
  opens?: string | undefined;
  closes?: string | undefined;
  note?: string | undefined;
}

export interface RestaurantDetail extends RestaurantSummary {
  description?: string | undefined;
  phone?: string | undefined;
  coordinates?: {
    latitude: number;
    longitude: number;
  } | undefined;
  opening_hours?: OpeningHours[] | undefined;
  payment_methods?: string[] | undefined;
  amenities?: string[] | undefined;
  reservation_url?: string | undefined;
  reservation_accepted?: boolean | undefined;
  cancellation_policy?: string | undefined;
  facts: Record<string, string>;
}

export interface ReservationOption {
  option_id: string;
  name: string;
  option_url: string;
  kind: "course" | "seat_only";
  price?: MoneyRange | undefined;
  min_party_size?: number | undefined;
  max_party_size?: number | undefined;
  available_times?: string[] | undefined;
  booking_type: "instant" | "request" | "consultation" | "unknown";
  cancellation_policy?: string | undefined;
  notes?: string[] | undefined;
  slots?: ReservationSlot[] | undefined;
}

export interface ReservationSlot {
  slot_id: string;
  time: string;
  seat_label?: string | undefined;
  booking_type: "instant" | "request" | "consultation" | "unknown";
}

export interface ReservationSlotSelection extends ReservationSlot {
  booking_url: string;
}

export interface InternalReservationOption extends Omit<ReservationOption, "slots"> {
  slots?: ReservationSlotSelection[] | undefined;
}

export interface ReservationOptionsResult {
  restaurant_id: string;
  visit: VisitIntent;
  options: ReservationOption[];
}

export interface InternalReservationOptionsResult {
  restaurant_id: string;
  visit: VisitIntent;
  options: InternalReservationOption[];
}

export interface ReservationProfile {
  name_kana?: string | undefined;
  name?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
}

export type ReservationState =
  | "draft"
  | "awaiting_input"
  | "awaiting_login"
  | "awaiting_confirmation"
  | "submitting"
  | "submitted"
  | "accepted"
  | "requested"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "expired";

export interface ReservationIntent {
  reservation_id: string;
  principal_id: string;
  restaurant_id: string;
  restaurant_name?: string | undefined;
  restaurant_url: string;
  option: ReservationOption;
  slot?: ReservationSlotSelection | undefined;
  visit: VisitIntent;
  profile?: ReservationProfile | undefined;
  special_requests?: string | undefined;
  session_id?: string | undefined;
  state: ReservationState;
  summary_hash: string;
  confirmation_nonce?: string | undefined;
  provider_reservation_id?: string | undefined;
  provider_manage_url?: string | undefined;
  provider_status?: string | undefined;
  created_at: string;
  updated_at: string;
  expires_at: string;
  last_error?: string | undefined;
}

export interface ReservationPrepareResult {
  reservation: {
    reservation_id: string;
    restaurant_id: string;
    restaurant_name?: string | undefined;
    option: ReservationOption;
    slot?: ReservationSlot | undefined;
    visit: VisitIntent;
    special_requests?: string | undefined;
    state: ReservationState;
    expires_at: string;
  };
  confirmation_token?: string | undefined;
}

export interface ReservationStatusResult {
  reservation_id: string;
  state: ReservationState;
  provider_reservation_id?: string | undefined;
  provider_status?: string | undefined;
  updated_at: string;
  next_action?: string | undefined;
}

export interface BrowserSession {
  session_id: string;
  principal_id: string;
  encrypted_storage_state?: string | undefined;
  connected: boolean;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface Interaction {
  interaction_id: string;
  principal_id: string;
  kind: "login" | "reservation" | "challenge";
  state: "pending" | "active" | "completed" | "expired" | "failed";
  session_id: string;
  target_url: string;
  created_at: string;
  expires_at: string;
  result?: Record<string, unknown> | undefined;
}
