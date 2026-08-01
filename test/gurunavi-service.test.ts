import { describe, expect, it } from "vitest";

import type {
  AgentResult,
  ReservationSlotSelection,
  RestaurantDetail,
} from "../src/domain/models.js";
import { GurunaviService } from "../src/services/gurunavi-service.js";
import { InteractionService } from "../src/services/interaction-service.js";
import { NoopTaskScheduler } from "../src/services/task-scheduler.js";
import { TokenService } from "../src/services/token-service.js";
import { MemoryKeyValueStore } from "../src/storage/key-value-store.js";
import { Repositories } from "../src/storage/repositories.js";
import { FakeBrowserOperator, testConfig } from "./helpers.js";

const restaurant: RestaurantDetail = {
  restaurant_id: "test12345",
  provider: "gurunavi",
  name: "銀座 テスト亭",
  source_url: "https://r.gnavi.co.jp/test12345/",
  categories: ["日本料理"],
  facts: { キャンセル規定: "当日100%" },
};

describe("reservation state machine", () => {
  it("prepares a fresh, hash-bound confirmation without submitting", async () => {
    const fixture = createFixture(false);
    const result = await fixture.service.prepareReservation("master@example.com", {
      restaurant_id: "test12345",
      option_id: ":c2",
      visit: { date: "2026-08-10", time: "19:00", party_size: 2 },
      profile: {
        name: "山田 太郎",
        phone: "090-0000-0000",
        email: "master@example.com",
      },
    });

    expect(result.status).toBe("confirmation_required");
    expect(result.data?.confirmation_token).toBeTypeOf("string");
    expect(result.data?.reservation.slot).not.toHaveProperty("booking_url");
    expect(fixture.browser.commands.map((command) => command.operation)).toEqual([
      "restaurant_get",
      "reservation_options_get",
    ]);
  });

  it("keeps real submission disabled by default", async () => {
    const fixture = createFixture(false);
    const prepared = await fixture.service.prepareReservation("master@example.com", {
      restaurant_id: "test12345",
      option_id: ":c2",
      visit: { date: "2026-08-10", time: "19:00", party_size: 2 },
      profile: {
        name: "山田 太郎",
        phone: "090-0000-0000",
        email: "master@example.com",
      },
    });
    const submitted = await fixture.service.submitReservation("master@example.com", {
      reservation_id: prepared.data?.reservation.reservation_id as string,
      confirmation_token: prepared.data?.confirmation_token as string,
    });

    expect(submitted).toMatchObject({
      status: "failed",
      error: { code: "RESERVATION_SUBMIT_DISABLED" },
    });
    expect(fixture.browser.commands).toHaveLength(2);
  });

  it("uses a connected session and consumes the confirmation on submit", async () => {
    const fixture = createFixture(true);
    const sessionId = "f0aa55ac-c89f-4f0d-9a7c-14cfe5d22465";
    await fixture.repositories.putBrowserSession({
      session_id: sessionId,
      principal_id: "master@example.com",
      connected: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const prepared = await fixture.service.prepareReservation("master@example.com", {
      restaurant_id: "test12345",
      option_id: ":c2",
      visit: { date: "2026-08-10", time: "19:00", party_size: 2 },
      profile: {
        name: "山田 太郎",
        phone: "090-0000-0000",
        email: "master@example.com",
      },
      special_requests: "静かな席",
      session_id: sessionId,
    });
    const input = {
      reservation_id: prepared.data?.reservation.reservation_id as string,
      confirmation_token: prepared.data?.confirmation_token as string,
    };
    const submitted = await fixture.service.submitReservation("master@example.com", input);
    const replay = await fixture.service.submitReservation("master@example.com", input);

    expect(submitted).toMatchObject({ status: "completed", data: { state: "accepted" } });
    expect(replay).toMatchObject({ status: "failed", error: { code: "INVALID_CONFIRMATION" } });
    const retained = await fixture.repositories.getReservation(input.reservation_id);
    expect(retained?.profile).toBeUndefined();
    expect(retained?.special_requests).toBeUndefined();
  });

  it("atomically allows only one concurrent submission", async () => {
    const fixture = createFixture(true);
    const sessionId = "619ef99a-42bd-4c43-adc4-dd283fd24548";
    await fixture.repositories.putBrowserSession({
      session_id: sessionId,
      principal_id: "master@example.com",
      connected: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const prepared = await fixture.service.prepareReservation("master@example.com", {
      restaurant_id: "test12345",
      option_id: ":c2",
      visit: { date: "2026-08-10", time: "19:00", party_size: 2 },
      session_id: sessionId,
    });
    const input = {
      reservation_id: prepared.data?.reservation.reservation_id as string,
      confirmation_token: prepared.data?.confirmation_token as string,
    };

    const results = await Promise.all([
      fixture.service.submitReservation("master@example.com", input),
      fixture.service.submitReservation("master@example.com", input),
    ]);

    expect(results.filter((result) => result.status === "completed")).toHaveLength(1);
    expect(
      fixture.browser.commands.filter((command) => command.operation === "reservation_submit"),
    ).toHaveLength(1);
  });

  it("requires slot_id when the same time has multiple seat choices", async () => {
    const slots: ReservationSlotSelection[] = [
      testSlot,
      {
        slot_id: "slot_table_42",
        time: "19:00",
        seat_label: "カウンター",
        booking_type: "request",
        booking_url:
          "https://r.gnavi.co.jp/plan/test12345/plan-reserve/plan/input/form?courseid=2&num=2&date=20260810&tableid=42&coursetime=1900",
      },
    ];
    const fixture = createFixture(false, slots);
    const ambiguous = await fixture.service.prepareReservation("master@example.com", {
      restaurant_id: "test12345",
      option_id: ":c2",
      visit: { date: "2026-08-10", time: "19:00", party_size: 2 },
      profile: {
        name: "山田 太郎",
        phone: "090-0000-0000",
        email: "master@example.com",
      },
    });

    expect(ambiguous).toMatchObject({
      status: "input_required",
      error: { code: "SLOT_SELECTION_REQUIRED" },
      required_actions: [{ fields: ["slot_id"] }],
    });

    const selected = await fixture.service.prepareReservation("master@example.com", {
      restaurant_id: "test12345",
      option_id: ":c2",
      slot_id: "slot_table_42",
      visit: { date: "2026-08-10", time: "19:00", party_size: 2 },
      profile: {
        name: "山田 太郎",
        phone: "090-0000-0000",
        email: "master@example.com",
      },
    });
    expect(selected).toMatchObject({
      status: "confirmation_required",
      data: {
        reservation: {
          slot: {
            slot_id: "slot_table_42",
            seat_label: "カウンター",
            booking_type: "request",
          },
        },
      },
    });
  });

  it("keeps provider booking URLs out of the agent-facing options", async () => {
    const fixture = createFixture(false);
    const result = await fixture.service.getReservationOptions("master@example.com", {
      restaurant_id: "test12345",
      option_id: ":c2",
      visit: { date: "2026-08-10", party_size: 2 },
    });

    expect(result.status).toBe("completed");
    expect(result.data?.options[0]?.slots?.[0]).toMatchObject({
      slot_id: "slot_table_31",
      seat_label: "個室",
      booking_type: "instant",
    });
    expect(result.data?.options[0]?.slots?.[0]).not.toHaveProperty("booking_url");
  });
});

const testSlot: ReservationSlotSelection = {
  slot_id: "slot_table_31",
  time: "19:00",
  seat_label: "個室",
  booking_type: "instant",
  booking_url:
    "https://r.gnavi.co.jp/plan/test12345/plan-reserve/plan/input/form?courseid=2&num=2&date=20260810&tableid=31&coursetime=1900",
};

function createFixture(
  reservationSubmitEnabled: boolean,
  slots: ReservationSlotSelection[] = [testSlot],
) {
  const config = testConfig({ reservationSubmitEnabled });
  const repositories = new Repositories(new MemoryKeyValueStore());
  const browser = new FakeBrowserOperator((command): AgentResult<unknown> => {
    if (command.operation === "restaurant_get") {
      return { status: "completed", data: restaurant };
    }
    if (command.operation === "reservation_options_get") {
      return {
        status: "completed",
        data: {
          restaurant_id: "test12345",
          visit: command.input.visit,
          options: [
            {
              option_id: ":c2",
              name: "季節の会席",
              option_url:
                "https://r.gnavi.co.jp/plan/test12345/plan-reserve/plan/plan_list/:c2",
              kind: "course",
              price: { currency: "JPY", min: 8000, max: 8000, basis: "per_person" },
              available_times: ["19:00"],
              booking_type: "instant",
              cancellation_policy: "当日100%",
              slots,
            },
          ],
        },
      };
    }
    if (command.operation === "reservation_submit") {
      return {
        status: "completed",
        data: {
          reservation_id: command.reservation_id,
          state: "accepted",
          updated_at: new Date().toISOString(),
        },
      };
    }
    return { status: "failed", error: { code: "UNEXPECTED", message: "Unexpected command", retryable: false } };
  });
  const tokens = new TokenService(config);
  const interactions = new InteractionService(config, repositories, tokens);
  const service = new GurunaviService(
    config,
    browser,
    repositories,
    tokens,
    interactions,
    new NoopTaskScheduler(),
  );
  return { service, browser, repositories };
}
