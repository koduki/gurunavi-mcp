import { describe, expect, it } from "vitest";

import {
  parseReservationOptions,
  parseReservationSlots,
  parseRestaurantDetail,
  parseSearchCards,
} from "../src/adapters/gurunavi/parsers.js";

describe("Gurunavi semantic parsers", () => {
  it("normalizes result cards and calendar semantics", () => {
    const results = parseSearchCards(
      [
        {
          name: "銀座 テスト亭",
          url: "https://r.gnavi.co.jp/test12345/",
          text: "ランチ 1,500円 ディナー 6,000円",
          access: "銀座駅 徒歩3分",
          categoryTexts: ["日本料理", "懐石"],
          ariaLabels: ["8月1日 空席あり", "8月2日 リクエスト予約", "8月3日 TEL"],
          badges: ["個室あり"],
          highlightedPlan: "季節の会席 8,000円",
        },
      ],
      10,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      restaurant_id: "test12345",
      budget_lunch: { min: 1500 },
      budget_dinner: { min: 6000 },
      availability: [
        { kind: "instant" },
        { kind: "request" },
        { kind: "phone_only" },
      ],
    });
  });

  it("prefers Restaurant JSON-LD and keeps visible facts as evidence", () => {
    const detail = parseRestaurantDetail(
      [
        {
          "@context": "https://schema.org",
          "@type": "Restaurant",
          name: "銀座 テスト亭",
          telephone: "03-0000-0000",
          servesCuisine: ["日本料理"],
          priceRange: "5,000円～8,000円",
          acceptsReservations: true,
          address: {
            postalCode: "104-0000",
            addressRegion: "東京都",
            addressLocality: "中央区",
            streetAddress: "銀座1-1-1",
          },
          geo: { latitude: 35.67, longitude: 139.76 },
          potentialAction: {
            "@type": "ReserveAction",
            target: "https://r.gnavi.co.jp/plan/test12345/plan-reserve/plan/plan_list/",
          },
        },
      ],
      { キャンセル規定: "当日100%" },
      "https://r.gnavi.co.jp/test12345/",
    );

    expect(detail).toMatchObject({
      restaurant_id: "test12345",
      name: "銀座 テスト亭",
      reservation_accepted: true,
      cancellation_policy: "当日100%",
      coordinates: { latitude: 35.67, longitude: 139.76 },
    });
    expect(detail.reservation_url).toContain("/plan/");
  });

  it("distinguishes instant, request, and seat-only plans", () => {
    const options = parseReservationOptions([
      {
        url: "https://r.gnavi.co.jp/plan/test12345/plan-reserve/plan/plan_list/:c2",
        name: "季節の会席",
        text: "季節の会席 8,000円 2名～8名 ○ 即予約 18:00 19:00",
      },
      {
        url: "https://r.gnavi.co.jp/plan/test12345/plan-reserve/plan/plan_list/:c-1",
        name: "席のみ予約",
        text: "席のみ予約 ■ リクエスト予約",
      },
    ]);

    expect(options).toMatchObject([
      { option_id: ":c2", kind: "course", booking_type: "instant", min_party_size: 2 },
      { option_id: ":c-1", kind: "seat_only", booking_type: "request" },
    ]);
  });

  it("normalizes seat-specific booking slots and rejects proxy escapes", () => {
    const slots = parseReservationSlots([
      {
        url: "https://r.gnavi.co.jp/plan/test12345/plan-reserve/plan/input/form?courseid=2&num=2&date=20260810&tableid=31&coursetime=1900",
        time: "18:30",
        seatLabel: "  個室\n（2～4名） ",
        activeStatus: "4",
      },
      {
        url: "https://r.gnavi.co.jp/plan/test12345/plan-reserve/plan/input/form?courseid=2&num=2&date=20260810&tableid=42&coursetime=1900",
        time: "19:00",
        seatLabel: "カウンター",
        activeStatus: "2",
      },
      {
        url: "https://attacker.example/plan/input/form?courseid=2&num=2&date=20260810&tableid=99&coursetime=1900",
        time: "19:00",
        activeStatus: "4",
      },
      {
        url: "https://r.gnavi.co.jp/plan/test12345/plan-reserve/plan/input/form?courseid=2&num=2&date=20260231&tableid=99&coursetime=1900",
        time: "19:00",
        activeStatus: "4",
      },
    ]);

    expect(slots).toHaveLength(2);
    expect(slots).toMatchObject([
      {
        time: "19:00",
        seat_label: "個室 （2～4名）",
        booking_type: "instant",
      },
      {
        time: "19:00",
        seat_label: "カウンター",
        booking_type: "request",
      },
    ]);
    expect(slots[0]?.slot_id).toMatch(/^slot_[A-Za-z0-9_-]{22}$/);
  });
});
