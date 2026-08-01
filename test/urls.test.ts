import { describe, expect, it } from "vitest";

import {
  assertGurunaviUrl,
  buildSearchUrl,
  decodeSearchCursor,
  encodeSearchCursor,
  extractRestaurantId,
  isSafeBrowserRequestUrl,
  reservationPlanListUrl,
  validateReservationSlotUrl,
} from "../src/adapters/gurunavi/urls.js";

const baseUrl = new URL("https://r.gnavi.co.jp");

describe("Gurunavi URL boundary", () => {
  it("builds a provider search from agent-level criteria", () => {
    const url = buildSearchUrl(baseUrl, {
      query: "静かな 個室",
      area: { station: "東京駅" },
      preferences: { cuisines: ["和食"], occasion: "接待" },
      limit: 10,
    });

    expect(url.origin).toBe("https://r.gnavi.co.jp");
    expect(url.pathname).toBe("/area/jp/rs/");
    expect(url.searchParams.get("fw")).toBe("静かな 個室 東京駅 和食 接待");
  });

  it("round-trips an opaque page cursor", () => {
    expect(decodeSearchCursor(encodeSearchCursor(7))).toBe(7);
    expect(() => decodeSearchCursor("attacker-controlled")).toThrow("Invalid search cursor");
  });

  it("refuses open-proxy URLs", () => {
    expect(() => assertGurunaviUrl("https://example.com/", baseUrl)).toThrow(
      "URL host must be r.gnavi.co.jp",
    );
    expect(() => assertGurunaviUrl("http://r.gnavi.co.jp/", baseUrl)).toThrow(
      "Only HTTPS Gurunavi URLs are allowed",
    );
    expect(() =>
      assertGurunaviUrl("ftp://localhost/", new URL("http://localhost:8080")),
    ).toThrow("Only HTTPS Gurunavi URLs are allowed");
  });

  it("blocks browser requests to local and metadata networks", () => {
    expect(isSafeBrowserRequestUrl("https://r.gnavi.co.jp/")).toBe(true);
    expect(isSafeBrowserRequestUrl("https://cdn.example.com/asset.js")).toBe(true);
    expect(isSafeBrowserRequestUrl("http://r.gnavi.co.jp/")).toBe(false);
    expect(isSafeBrowserRequestUrl("https://metadata.google.internal/")).toBe(false);
    expect(isSafeBrowserRequestUrl("https://169.254.169.254/computeMetadata/v1/")).toBe(false);
    expect(isSafeBrowserRequestUrl("https://127.0.0.1/")).toBe(false);
    expect(isSafeBrowserRequestUrl("https://10.0.0.1/")).toBe(false);
    expect(isSafeBrowserRequestUrl("https://[::1]/")).toBe(false);
  });

  it("normalizes restaurant and reservation URLs", () => {
    expect(extractRestaurantId("https://r.gnavi.co.jp/gvrvmm690000/")).toBe("gvrvmm690000");
    expect(
      reservationPlanListUrl(baseUrl, "gvrvmm690000", {
        date: "2026-08-10",
        party_size: 4,
      }).toString(),
    ).toContain("date=20260810");
  });

  it("binds a booking slot URL to the confirmed restaurant and visit", () => {
    const candidate =
      "https://r.gnavi.co.jp/plan/gvrvmm690000/plan-reserve/plan/input/form?courseid=2&num=4&date=20260810&tableid=31&coursetime=1900";
    expect(
      validateReservationSlotUrl(baseUrl, candidate, "gvrvmm690000", {
        date: "2026-08-10",
        time: "19:00",
        party_size: 4,
      }).toString(),
    ).toBe(candidate);

    expect(() =>
      validateReservationSlotUrl(baseUrl, candidate, "gvrvmm690000", {
        date: "2026-08-10",
        time: "19:30",
        party_size: 4,
      }),
    ).toThrow("coursetime does not match");
    expect(() =>
      validateReservationSlotUrl(baseUrl, candidate, "another123", {
        date: "2026-08-10",
        time: "19:00",
        party_size: 4,
      }),
    ).toThrow("does not match the selected restaurant");
    expect(() =>
      validateReservationSlotUrl(
        baseUrl,
        `${candidate}&num=99`,
        "gvrvmm690000",
        {
          date: "2026-08-10",
          time: "19:00",
          party_size: 4,
        },
      ),
    ).toThrow("num does not match");
  });
});
