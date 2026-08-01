import { createHash, randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import type {
  AgentResult,
  InternalReservationOption,
  InternalReservationOptionsResult,
  ReservationIntent,
  ReservationOption,
  ReservationPrepareResult,
  ReservationSlot,
  ReservationSlotSelection,
  ReservationStatusResult,
  RestaurantDetail,
  RestaurantSearchResult,
  ReservationOptionsResult,
} from "../domain/models.js";
import type {
  browserSessionConnectInputSchema,
  interactionResumeInputSchema,
  reservationCancelPrepareInputSchema,
  reservationCancelSubmitInputSchema,
  reservationOptionsInputSchema,
  reservationPrepareInputSchema,
  reservationStatusInputSchema,
  reservationSubmitInputSchema,
  restaurantGetInputSchema,
  restaurantSearchInputSchema,
} from "../domain/schemas.js";
import type { BrowserOperator } from "../browser/operator.js";
import type { Repositories } from "../storage/repositories.js";
import type { z } from "zod";
import type { InteractionService } from "./interaction-service.js";
import type { TokenService } from "./token-service.js";
import type { TaskScheduler } from "./task-scheduler.js";

type SearchInput = z.infer<typeof restaurantSearchInputSchema>;
type GetInput = z.infer<typeof restaurantGetInputSchema>;
type OptionsInput = z.infer<typeof reservationOptionsInputSchema>;
type PrepareInput = z.infer<typeof reservationPrepareInputSchema>;
type SubmitInput = z.infer<typeof reservationSubmitInputSchema>;
type StatusInput = z.infer<typeof reservationStatusInputSchema>;
type CancelPrepareInput = z.infer<typeof reservationCancelPrepareInputSchema>;
type CancelSubmitInput = z.infer<typeof reservationCancelSubmitInputSchema>;
type SessionConnectInput = z.infer<typeof browserSessionConnectInputSchema>;
type InteractionResumeInput = z.infer<typeof interactionResumeInputSchema>;

export class GurunaviService {
  constructor(
    readonly config: AppConfig,
    readonly browser: BrowserOperator,
    readonly repositories: Repositories,
    readonly tokens: TokenService,
    readonly interactions: InteractionService,
    readonly tasks: TaskScheduler,
  ) {}

  search(principalId: string, input: SearchInput): Promise<AgentResult<RestaurantSearchResult>> {
    return this.browser.execute({
      operation: "restaurant_search",
      principal_id: principalId,
      input,
    }) as Promise<AgentResult<RestaurantSearchResult>>;
  }

  getRestaurant(
    principalId: string,
    input: GetInput,
  ): Promise<AgentResult<RestaurantDetail>> {
    return this.browser.execute({
      operation: "restaurant_get",
      principal_id: principalId,
      input,
    }) as Promise<AgentResult<RestaurantDetail>>;
  }

  async getReservationOptions(
    principalId: string,
    input: OptionsInput,
  ): Promise<AgentResult<ReservationOptionsResult>> {
    const result = await this.#getReservationOptionsInternal(principalId, input);
    if (result.data === undefined) {
      return result;
    }
    return {
      ...result,
      data: {
        restaurant_id: result.data.restaurant_id,
        visit: result.data.visit,
        options: result.data.options.map(toPublicReservationOption),
      },
    };
  }

  #getReservationOptionsInternal(
    principalId: string,
    input: OptionsInput,
  ): Promise<AgentResult<InternalReservationOptionsResult>> {
    return this.browser.execute({
      operation: "reservation_options_get",
      principal_id: principalId,
      input,
    }) as Promise<AgentResult<InternalReservationOptionsResult>>;
  }

  async prepareReservation(
    principalId: string,
    input: PrepareInput,
  ): Promise<AgentResult<ReservationPrepareResult>> {
    const [detailResult, optionsResult] = await Promise.all([
      this.getRestaurant(principalId, { restaurant_id: input.restaurant_id }),
      this.#getReservationOptionsInternal(principalId, {
        restaurant_id: input.restaurant_id,
        option_id: input.option_id,
        visit: input.visit,
        ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
      }),
    ]);
    if (detailResult.status !== "completed" || detailResult.data === undefined) {
      return detailResult as unknown as AgentResult<ReservationPrepareResult>;
    }
    if (optionsResult.status !== "completed" || optionsResult.data === undefined) {
      return optionsResult as unknown as AgentResult<ReservationPrepareResult>;
    }
    const option = optionsResult.data.options.find((candidate) => candidate.option_id === input.option_id);
    if (option === undefined) {
      return {
        status: "input_required",
        required_actions: [
          {
            type: "provide_input",
            message: "指定した予約プランは現在の画面にありません。最新候補から選び直してください。",
            fields: ["option_id"],
          },
        ],
        error: {
          code: "OPTION_NOT_AVAILABLE",
          message: "The selected reservation option is not currently available",
          retryable: true,
        },
        ...(optionsResult.evidence === undefined ? {} : { evidence: optionsResult.evidence }),
      };
    }
    const slots = option.slots ?? [];
    if (slots.length === 0) {
      return {
        status: "input_required",
        required_actions: [
          {
            type: "provide_input",
            message:
              "指定日時・人数で選べる座席スロットがありません。日付、時刻、人数、またはプランを変更してください。",
            fields: ["visit.date", "visit.time", "visit.party_size", "option_id"],
          },
        ],
        error: {
          code: "NO_RESERVATION_SLOTS",
          message: "No bookable seat/time slots were found for the selected plan",
          retryable: true,
        },
        evidence: optionsResult.evidence,
      };
    }
    if (input.visit.time === undefined) {
      return {
        status: "input_required",
        required_actions: [
          {
            type: "provide_input",
            message: `予約時刻を選んでください。候補: ${[...new Set(slots.map((slot) => slot.time))].join(", ")}`,
            fields: ["visit.time"],
          },
        ],
      };
    }
    const timeSlots = slots.filter((slot) => slot.time === input.visit.time);
    const selectedSlot =
      input.slot_id === undefined
        ? timeSlots.length === 1
          ? timeSlots[0]
          : undefined
        : timeSlots.find((slot) => slot.slot_id === input.slot_id);
    if (selectedSlot === undefined) {
      const slotSummary = timeSlots
        .map(
          (slot) =>
            `${slot.slot_id}: ${slot.seat_label ?? "座席指定なし"} (${slot.booking_type})`,
        )
        .join(" / ");
      return {
        status: "input_required",
        required_actions: [
          {
            type: "provide_input",
            message:
              timeSlots.length === 0
                ? `希望時刻 ${input.visit.time} は現在選べません。`
                : `同時刻に複数の座席があります。slot_idを選んでください: ${slotSummary}`,
            fields: timeSlots.length === 0 ? ["visit.time"] : ["slot_id"],
          },
        ],
        error: {
          code: timeSlots.length === 0 ? "TIME_NOT_AVAILABLE" : "SLOT_SELECTION_REQUIRED",
          message: "A unique confirmed seat/time slot is required",
          retryable: true,
        },
      };
    }
    option.booking_type = selectedSlot.booking_type;
    if (!["instant", "request"].includes(selectedSlot.booking_type)) {
      return {
        status: "page_changed",
        error: {
          code: "UNSUPPORTED_BOOKING_TYPE",
          message:
            "The selected Gurunavi slot has an unrecognized booking type and will not be submitted",
          retryable: false,
        },
        evidence: optionsResult.evidence,
      };
    }
    const selectedOption = toSelectedReservationOption(option);
    if (
      option.min_party_size !== undefined &&
      input.visit.party_size < option.min_party_size
    ) {
      return this.#invalidParty(option.min_party_size, option.max_party_size);
    }
    if (
      option.max_party_size !== undefined &&
      input.visit.party_size > option.max_party_size
    ) {
      return this.#invalidParty(option.min_party_size, option.max_party_size);
    }
    const session =
      input.session_id === undefined
        ? undefined
        : await this.repositories.getBrowserSession(input.session_id);
    const requiredProfileFields = [
      ...(input.profile?.name === undefined && input.profile?.name_kana === undefined ? ["profile.name"] : []),
      ...(input.profile?.phone === undefined ? ["profile.phone"] : []),
      ...(input.profile?.email === undefined ? ["profile.email"] : []),
    ];
    if (requiredProfileFields.length > 0 && session?.connected !== true) {
      return {
        status: "input_required",
        required_actions: [
          {
            type: "provide_input",
            message:
              "予約者情報を指定するか、ログイン済みブラウザセッションを接続してください。",
            fields: requiredProfileFields,
          },
        ],
      };
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.config.interactionTokenTtlSeconds * 1000,
    ).toISOString();
    const reservationId = randomUUID();
    const summary = {
      restaurant_id: input.restaurant_id,
      restaurant_name: detailResult.data.name,
      restaurant_url: detailResult.data.source_url,
      option: selectedOption,
      slot: selectedSlot,
      visit: input.visit,
      profile: input.profile,
      special_requests: input.special_requests,
      session_id: input.session_id,
    };
    const summaryHash = hashSummary(summary);
    const intent: ReservationIntent = {
      reservation_id: reservationId,
      principal_id: principalId,
      restaurant_id: input.restaurant_id,
      restaurant_name: detailResult.data.name,
      restaurant_url: detailResult.data.source_url,
      option: selectedOption,
      slot: selectedSlot,
      visit: input.visit,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      ...(input.special_requests === undefined
        ? {}
        : { special_requests: input.special_requests }),
      ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
      state: "awaiting_confirmation",
      summary_hash: summaryHash,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: expiresAt,
    };
    const issued = await this.tokens.issueConfirmation(
      principalId,
      reservationId,
      summaryHash,
      "reservation_submit",
    );
    intent.confirmation_nonce = issued.nonce;
    await this.repositories.putReservation(intent);
    return {
      status: "confirmation_required",
      data: {
        reservation: {
          reservation_id: intent.reservation_id,
          restaurant_id: intent.restaurant_id,
          restaurant_name: intent.restaurant_name,
          option: intent.option,
          slot:
            intent.slot === undefined ? undefined : toPublicReservationSlot(intent.slot),
          visit: intent.visit,
          ...(intent.special_requests === undefined
            ? {}
            : { special_requests: intent.special_requests }),
          state: intent.state,
          expires_at: intent.expires_at,
        },
        confirmation_token: issued.token,
      },
      required_actions: [
        {
          type: "confirm",
          message:
            "店名、日時、人数、プラン、料金、予約種別、キャンセル規定をユーザーに明示し、明確な同意後のみ reservation_submit を呼んでください。",
          expires_at: issued.expiresAt,
        },
      ],
      warnings: [
        {
          code: "NO_SEAT_HOLD",
          message: "この準備操作では席を確保していません。確定時にページを再検証します。",
        },
        ...(input.session_id === undefined
          ? [
              {
                code: "LOGIN_SESSION_REQUIRED",
                message: "確定前に browser_session_connect でログインセッションが必要です。",
              },
            ]
          : []),
      ],
      evidence: [...(detailResult.evidence ?? []), ...(optionsResult.evidence ?? [])],
    };
  }

  async submitReservation(
    principalId: string,
    input: SubmitInput,
  ): Promise<AgentResult<unknown>> {
    if (!this.config.reservationSubmitEnabled) {
      return {
        status: "failed",
        error: {
          code: "RESERVATION_SUBMIT_DISABLED",
          message:
            "予約確定は安全のため無効化されています。Terraform変数 enable_reservation_submit=true で明示的に有効化してください。",
          retryable: false,
        },
      };
    }
    const intent = await this.repositories.getReservation(input.reservation_id);
    if (intent === undefined || intent.principal_id !== principalId) {
      return this.#reservationNotFound();
    }
    try {
      const claims = await this.tokens.verifyConfirmation(
        input.confirmation_token,
        "reservation_submit",
      );
      if (
        claims.sub !== principalId ||
        claims.reservation_id !== intent.reservation_id ||
        claims.summary_hash !== intent.summary_hash ||
        intent.confirmation_nonce === undefined ||
        claims.nonce !== intent.confirmation_nonce ||
        !["awaiting_confirmation", "awaiting_login"].includes(intent.state)
      ) {
        throw new Error("Confirmation token does not match the current reservation intent");
      }
    } catch (error) {
      return {
        status: "failed",
        error: {
          code: "INVALID_CONFIRMATION",
          message: error instanceof Error ? error.message : "Confirmation validation failed",
          retryable: false,
        },
      };
    }
    if (intent.session_id === undefined) {
      intent.state = "awaiting_login";
      intent.updated_at = new Date().toISOString();
      const interaction = await this.interactions.create(
        principalId,
        "reservation",
        intent.slot?.booking_url ?? intent.option.option_url,
      );
      const sessionId =
        interaction.data !== undefined && "session_id" in interaction.data
          ? interaction.data.session_id
          : undefined;
      if (typeof sessionId === "string") {
        intent.session_id = sessionId;
      }
      await this.repositories.putReservation(intent);
      return interaction;
    }
    const session = await this.repositories.getBrowserSession(intent.session_id);
    if (session?.connected !== true) {
      intent.state = "awaiting_login";
      intent.updated_at = new Date().toISOString();
      await this.repositories.putReservation(intent);
      return this.interactions.create(
        principalId,
        "reservation",
        intent.slot?.booking_url ?? intent.option.option_url,
        intent.session_id,
      );
    }

    const nonce = intent.confirmation_nonce;
    const claimed: ReservationIntent = {
      ...intent,
      state: "submitting",
      updated_at: new Date().toISOString(),
    };
    delete claimed.confirmation_nonce;
    if (
      nonce === undefined ||
      !(await this.repositories.claimReservation(
        claimed,
        nonce,
        ["awaiting_confirmation", "awaiting_login"],
      ))
    ) {
      return {
        status: "failed",
        error: {
          code: "RESERVATION_IN_PROGRESS",
          message: "This reservation is already being submitted or its confirmation was consumed",
          retryable: false,
        },
      };
    }
    const result = (await this.browser.execute({
      operation: "reservation_submit",
      principal_id: principalId,
      reservation_id: intent.reservation_id,
    })) as AgentResult<ReservationStatusResult>;
    if (
      result.status === "human_action_required" &&
      result.required_actions?.some((action) => action.type === "open_interaction_url")
    ) {
      const latest = await this.repositories.getReservation(intent.reservation_id);
      if (latest !== undefined && ["submitting", "awaiting_login"].includes(latest.state)) {
        latest.state = "awaiting_login";
        latest.confirmation_nonce = nonce;
        latest.updated_at = new Date().toISOString();
        await this.repositories.putReservation(latest);
      }
      return this.interactions.create(
        principalId,
        "reservation",
        intent.slot?.booking_url ?? intent.option.option_url,
        intent.session_id,
      );
    }
    if (
      result.status === "completed" &&
      typeof result.data === "object" &&
      result.data !== null &&
      "state" in result.data &&
      typeof result.data.state === "string"
    ) {
      const latest = await this.repositories.getReservation(intent.reservation_id);
      if (latest !== undefined) {
        const terminalState = result.data.state;
        if (["accepted", "requested", "submitted"].includes(terminalState)) {
          latest.state = terminalState;
          latest.updated_at =
            "updated_at" in result.data && typeof result.data.updated_at === "string"
              ? result.data.updated_at
              : new Date().toISOString();
          latest.expires_at = new Date(
            Date.now() + 180 * 24 * 60 * 60 * 1000,
          ).toISOString();
          if (
            "provider_reservation_id" in result.data &&
            typeof result.data.provider_reservation_id === "string"
          ) {
            latest.provider_reservation_id = result.data.provider_reservation_id;
          }
          if (
            "provider_status" in result.data &&
            typeof result.data.provider_status === "string"
          ) {
            latest.provider_status = result.data.provider_status;
          }
          delete latest.confirmation_nonce;
          delete latest.profile;
          delete latest.special_requests;
          await this.repositories.putReservation(latest);
        }
      }
    }
    if (
      result.status === "completed" &&
      typeof result.data === "object" &&
      result.data !== null &&
      "state" in result.data &&
      result.data.state === "requested"
    ) {
      await this.tasks.scheduleReservationRefresh(principalId, intent.reservation_id, 15 * 60);
    }
    return result;
  }

  async getReservationStatus(
    principalId: string,
    input: StatusInput,
  ): Promise<AgentResult<ReservationStatusResult>> {
    const intent = await this.repositories.getReservation(input.reservation_id);
    if (intent === undefined || intent.principal_id !== principalId) {
      return this.#reservationNotFound();
    }
    if (input.refresh_from_provider) {
      return this.browser.execute({
        operation: "reservation_status_get",
        principal_id: principalId,
        reservation_id: intent.reservation_id,
      }) as Promise<AgentResult<ReservationStatusResult>>;
    }
    return {
      status: "completed",
      data: {
        reservation_id: intent.reservation_id,
        state: intent.state,
        ...(intent.provider_reservation_id === undefined
          ? {}
          : { provider_reservation_id: intent.provider_reservation_id }),
        ...(intent.provider_status === undefined
          ? {}
          : { provider_status: intent.provider_status }),
        updated_at: intent.updated_at,
      },
    };
  }

  async prepareCancellation(
    principalId: string,
    input: CancelPrepareInput,
  ): Promise<AgentResult<{ reservation_id: string; confirmation_token: string }>> {
    const intent = await this.repositories.getReservation(input.reservation_id);
    if (intent === undefined || intent.principal_id !== principalId) {
      return this.#reservationNotFound();
    }
    if (!["accepted", "requested", "submitted"].includes(intent.state)) {
      return {
        status: "failed",
        error: {
          code: "NOT_CANCELLABLE",
          message: `Reservation in state ${intent.state} cannot be cancelled`,
          retryable: false,
        },
      };
    }
    const cancellationHash = hashSummary({
      reservation_id: intent.reservation_id,
      state: intent.state,
      provider_reservation_id: intent.provider_reservation_id,
      action: "cancel",
    });
    const issued = await this.tokens.issueConfirmation(
      principalId,
      intent.reservation_id,
      cancellationHash,
      "reservation_cancel",
    );
    intent.confirmation_nonce = issued.nonce;
    intent.summary_hash = cancellationHash;
    intent.updated_at = new Date().toISOString();
    await this.repositories.putReservation(intent);
    return {
      status: "confirmation_required",
      data: {
        reservation_id: intent.reservation_id,
        confirmation_token: issued.token,
      },
      required_actions: [
        {
          type: "confirm",
          message:
            "キャンセル規定と発生しうる料金をユーザーに示し、明確な同意後のみ reservation_cancel_submit を呼んでください。",
          expires_at: issued.expiresAt,
        },
      ],
    };
  }

  async submitCancellation(
    principalId: string,
    input: CancelSubmitInput,
  ): Promise<AgentResult<ReservationStatusResult>> {
    const intent = await this.repositories.getReservation(input.reservation_id);
    if (intent === undefined || intent.principal_id !== principalId) {
      return this.#reservationNotFound();
    }
    try {
      const claims = await this.tokens.verifyConfirmation(
        input.confirmation_token,
        "reservation_cancel",
      );
      if (
        claims.sub !== principalId ||
        claims.reservation_id !== intent.reservation_id ||
        claims.summary_hash !== intent.summary_hash ||
        claims.nonce !== intent.confirmation_nonce
      ) {
        throw new Error("Cancellation confirmation does not match the current reservation");
      }
    } catch (error) {
      return {
        status: "failed",
        error: {
          code: "INVALID_CONFIRMATION",
          message: error instanceof Error ? error.message : "Confirmation validation failed",
          retryable: false,
        },
      };
    }
    const nonce = intent.confirmation_nonce;
    const originalState = intent.state;
    const claimed: ReservationIntent = {
      ...intent,
      state: "cancelling",
      updated_at: new Date().toISOString(),
    };
    delete claimed.confirmation_nonce;
    if (
      nonce === undefined ||
      !(await this.repositories.claimReservation(
        claimed,
        nonce,
        ["accepted", "requested", "submitted"],
      ))
    ) {
      return {
        status: "failed",
        error: {
          code: "CANCELLATION_IN_PROGRESS",
          message: "This cancellation is already running or its confirmation was consumed",
          retryable: false,
        },
      };
    }
    const result = (await this.browser.execute({
      operation: "reservation_cancel_submit",
      principal_id: principalId,
      reservation_id: intent.reservation_id,
    })) as AgentResult<ReservationStatusResult>;
    if (result.status === "human_action_required") {
      const latest = await this.repositories.getReservation(intent.reservation_id);
      if (latest?.state === "cancelling") {
        latest.state = originalState;
        latest.confirmation_nonce = nonce;
        latest.updated_at = new Date().toISOString();
        await this.repositories.putReservation(latest);
      }
    } else if (result.status === "completed" && result.data?.state === "cancelled") {
      const latest = await this.repositories.getReservation(intent.reservation_id);
      if (latest !== undefined) {
        latest.state = "cancelled";
        latest.provider_status = result.data.provider_status ?? "cancelled";
        latest.updated_at = result.data.updated_at;
        latest.expires_at = new Date(
          Date.now() + 180 * 24 * 60 * 60 * 1000,
        ).toISOString();
        delete latest.confirmation_nonce;
        delete latest.profile;
        delete latest.special_requests;
        await this.repositories.putReservation(latest);
      }
    }
    return result;
  }

  connectBrowserSession(
    principalId: string,
    input: SessionConnectInput,
  ): Promise<AgentResult<{ session_id: string; interaction_url: string }>> {
    const target =
      input.restaurant_id === undefined
        ? this.config.gurunaviBaseUrl.toString()
        : new URL(`/${encodeURIComponent(input.restaurant_id)}/`, this.config.gurunaviBaseUrl).toString();
    return this.interactions.create(principalId, input.purpose, target);
  }

  resumeInteraction(
    principalId: string,
    input: InteractionResumeInput,
  ): Promise<AgentResult<Record<string, unknown>>> {
    return this.interactions.resume(principalId, input.interaction_id);
  }

  #invalidParty(min?: number, max?: number): AgentResult<ReservationPrepareResult> {
    return {
      status: "input_required",
      required_actions: [
        {
          type: "provide_input",
          message: `このプランの対応人数は${min ?? "?"}〜${max ?? "?"}名です。`,
          fields: ["visit.party_size"],
        },
      ],
      error: {
        code: "PARTY_SIZE_OUT_OF_RANGE",
        message: "Party size is outside the selected plan limits",
        retryable: true,
      },
    };
  }

  #reservationNotFound<T>(): AgentResult<T> {
    return {
      status: "failed",
      error: {
        code: "RESERVATION_NOT_FOUND",
        message: "Reservation not found",
        retryable: false,
      },
    };
  }
}

function hashSummary(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("base64url");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function toPublicReservationSlot(slot: ReservationSlotSelection): ReservationSlot {
  return {
    slot_id: slot.slot_id,
    time: slot.time,
    ...(slot.seat_label === undefined ? {} : { seat_label: slot.seat_label }),
    booking_type: slot.booking_type,
  };
}

function toPublicReservationOption(option: InternalReservationOption): ReservationOption {
  const selected = toSelectedReservationOption(option);
  return {
    ...selected,
    ...(option.slots === undefined
      ? {}
      : { slots: option.slots.map(toPublicReservationSlot) }),
  };
}

function toSelectedReservationOption(option: InternalReservationOption): ReservationOption {
  return {
    option_id: option.option_id,
    name: option.name,
    option_url: option.option_url,
    kind: option.kind,
    ...(option.price === undefined ? {} : { price: option.price }),
    ...(option.min_party_size === undefined
      ? {}
      : { min_party_size: option.min_party_size }),
    ...(option.max_party_size === undefined
      ? {}
      : { max_party_size: option.max_party_size }),
    ...(option.available_times === undefined
      ? {}
      : { available_times: option.available_times }),
    booking_type: option.booking_type,
    ...(option.cancellation_policy === undefined
      ? {}
      : { cancellation_policy: option.cancellation_policy }),
    ...(option.notes === undefined ? {} : { notes: option.notes }),
  };
}
