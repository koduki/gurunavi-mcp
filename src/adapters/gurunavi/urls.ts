import { isIP } from "node:net";

import type { RestaurantSearchInput, VisitIntent } from "../../domain/models.js";

const RESTAURANT_ID_PATTERN = /^[a-zA-Z0-9_-]{5,40}$/;

export function assertGurunaviUrl(candidate: string | URL, baseUrl: URL): URL {
  const url = candidate instanceof URL ? new URL(candidate) : new URL(candidate, baseUrl);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && url.hostname === "localhost")
  ) {
    throw new Error("Only HTTPS Gurunavi URLs are allowed");
  }
  if (url.hostname !== baseUrl.hostname) {
    throw new Error(`URL host must be ${baseUrl.hostname}`);
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

export function isSafeBrowserRequestUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
    return false;
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (
    hostname === "localhost" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return false;
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const octets = hostname.split(".").map(Number);
    const [a, b] = octets;
    if (a === undefined || b === undefined) {
      return false;
    }
    return (
      a !== 0 &&
      a !== 10 &&
      a !== 127 &&
      !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && b === 168) &&
      !(a === 198 && (b === 18 || b === 19)) &&
      a < 224
    );
  }
  if (ipVersion === 6) {
    return !(
      hostname === "::" ||
      hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      /^fe[89ab]/.test(hostname) ||
      (hostname.includes(":ffff:") && isPrivateMappedIpv4(hostname))
    );
  }
  return hostname.length > 0;
}

function isPrivateMappedIpv4(hostname: string): boolean {
  const mapped = hostname.match(/(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
  return mapped === undefined || !isSafeBrowserRequestUrl(`https://${mapped}/`);
}

export function extractRestaurantId(candidate: string | URL): string {
  const url = candidate instanceof URL ? candidate : new URL(candidate);
  const segments = url.pathname.split("/").filter(Boolean);
  const planIndex = segments.indexOf("plan");
  const value = planIndex >= 0 ? segments[planIndex + 1] : segments[0];
  if (value === undefined || !RESTAURANT_ID_PATTERN.test(value)) {
    throw new Error("Could not identify a Gurunavi restaurant ID");
  }
  return value;
}

export function restaurantUrl(baseUrl: URL, restaurantId: string): URL {
  if (!RESTAURANT_ID_PATTERN.test(restaurantId)) {
    throw new Error("Invalid Gurunavi restaurant ID");
  }
  return assertGurunaviUrl(new URL(`/${encodeURIComponent(restaurantId)}/`, baseUrl), baseUrl);
}

export function reservationPlanListUrl(
  baseUrl: URL,
  restaurantId: string,
  visit?: { date: string; party_size: number },
): URL {
  if (!RESTAURANT_ID_PATTERN.test(restaurantId)) {
    throw new Error("Invalid Gurunavi restaurant ID");
  }
  const url = new URL(
    `/plan/${encodeURIComponent(restaurantId)}/plan-reserve/plan/plan_list/`,
    baseUrl,
  );
  if (visit !== undefined) {
    url.searchParams.set("date", visit.date.replaceAll("-", ""));
    url.searchParams.set("num", String(visit.party_size));
  }
  return assertGurunaviUrl(url, baseUrl);
}

export function validateReservationSlotUrl(
  baseUrl: URL,
  candidate: string | URL,
  restaurantId: string,
  visit: VisitIntent,
): URL {
  if (!RESTAURANT_ID_PATTERN.test(restaurantId)) {
    throw new Error("Invalid Gurunavi restaurant ID");
  }
  if (visit.time === undefined) {
    throw new Error("A visit time is required for a reservation slot");
  }

  const url = assertGurunaviUrl(candidate, baseUrl);
  const expectedPath = `/plan/${restaurantId}/plan-reserve/plan/input/form`;
  if (decodeURIComponent(url.pathname) !== expectedPath) {
    throw new Error("Reservation slot URL does not match the selected restaurant");
  }

  const expected = {
    date: visit.date.replaceAll("-", ""),
    num: String(visit.party_size),
    coursetime: visit.time.replace(":", ""),
  };
  for (const [name, value] of Object.entries(expected)) {
    if (url.searchParams.getAll(name).length !== 1 || url.searchParams.get(name) !== value) {
      throw new Error(`Reservation slot URL ${name} does not match the confirmed visit`);
    }
  }
  if (
    url.searchParams.getAll("tableid").length !== 1 ||
    !/^\d+$/.test(url.searchParams.get("tableid") ?? "")
  ) {
    throw new Error("Reservation slot URL is missing a valid tableid");
  }
  if (
    url.searchParams.getAll("courseid").length !== 1 ||
    !/^-?\d+$/.test(url.searchParams.get("courseid") ?? "")
  ) {
    throw new Error("Reservation slot URL is missing a valid courseid");
  }
  return url;
}

interface CursorPayload {
  page: number;
}

export function decodeSearchCursor(cursor?: string): number {
  if (cursor === undefined) {
    return 1;
  }
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (!Number.isInteger(payload.page) || payload.page < 1 || payload.page > 100) {
      throw new Error("out of range");
    }
    return payload.page;
  } catch {
    throw new Error("Invalid search cursor");
  }
}

export function encodeSearchCursor(page: number): string {
  return Buffer.from(JSON.stringify({ page }), "utf8").toString("base64url");
}

export function buildSearchUrl(baseUrl: URL, input: RestaurantSearchInput): URL {
  const terms = [
    input.query,
    input.area?.free_text,
    input.area?.prefecture,
    input.area?.city,
    input.area?.station,
    ...(input.preferences?.cuisines ?? []),
    ...(input.preferences?.features ?? []),
    input.preferences?.occasion,
    ...(input.preferences?.free_text ?? []),
  ].filter((value): value is string => value !== undefined && value.trim().length > 0);

  const page = decodeSearchCursor(input.cursor);
  const url = new URL("/area/jp/rs/", baseUrl);
  url.searchParams.set("fw", terms.join(" "));
  if (page > 1) {
    url.searchParams.set("p", String(page));
  }
  return assertGurunaviUrl(url, baseUrl);
}
