import { createHash } from "node:crypto";

import type {
  AvailabilityDay,
  AvailabilityKind,
  MoneyRange,
  OpeningHours,
  ReservationOption,
  ReservationSlotSelection,
  RestaurantDetail,
  RestaurantSummary,
} from "../../domain/models.js";
import { extractRestaurantId } from "./urls.js";

export interface RawSearchCard {
  name: string;
  url: string;
  text: string;
  access?: string;
  categoryTexts: string[];
  ariaLabels: string[];
  badges: string[];
  highlightedPlan?: string;
}

export interface RawReservationOption {
  url: string;
  name: string;
  text: string;
}

export interface RawReservationSlot {
  url: string;
  time: string;
  seatLabel?: string;
  activeStatus?: string;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const stringValue = asString(item);
      return stringValue === undefined ? [] : [stringValue];
    });
  }
  const stringValue = asString(value);
  return stringValue === undefined ? [] : [stringValue];
}

function firstNumber(text: string): number | undefined {
  const match = text.replaceAll(",", "").match(/(?:¥|￥)?\s*(\d{3,7})\s*円?/);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function priceRangeFromText(text: string): MoneyRange | undefined {
  const normalized = text.replaceAll(",", "");
  const numbers = Array.from(normalized.matchAll(/(?:¥|￥)?\s*(\d{3,7})\s*円/g)).map((match) =>
    Number(match[1]),
  );
  if (numbers.length === 0) {
    return undefined;
  }
  const first = numbers[0];
  if (first === undefined) {
    return undefined;
  }
  return {
    currency: "JPY",
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    basis: "per_person",
  };
}

function availabilityKind(label: string): AvailabilityKind {
  if (label.includes("空席あり") || label.includes("即予約")) {
    return "instant";
  }
  if (label.includes("リクエスト")) {
    return "request";
  }
  if (label.includes("TEL") || label.includes("電話")) {
    return "phone_only";
  }
  if (label.includes("満席") || label.includes("空席なし") || label.includes("予約不可")) {
    return "unavailable";
  }
  return "unknown";
}

export function parseAvailabilityLabels(labels: string[], now = new Date()): AvailabilityDay[] {
  const year = Number(
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Tokyo", year: "numeric" }).format(now),
  );
  const monthNow = Number(
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Tokyo", month: "numeric" }).format(now),
  );

  const values = new Map<string, AvailabilityKind>();
  for (const label of labels) {
    const match = label.match(/(?:(\d{1,2})月)?(\d{1,2})日/);
    if (match?.[2] === undefined) {
      continue;
    }
    const month = match[1] === undefined ? monthNow : Number(match[1]);
    const day = Number(match[2]);
    const adjustedYear = month < monthNow - 6 ? year + 1 : year;
    const date = `${String(adjustedYear).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    values.set(date, availabilityKind(label));
  }
  return Array.from(values, ([date, kind]) => ({ date, kind }));
}

export function parseSearchCards(cards: RawSearchCard[], limit: number): RestaurantSummary[] {
  const seen = new Set<string>();
  const results: RestaurantSummary[] = [];
  for (const card of cards) {
    if (results.length >= limit) {
      break;
    }
    let restaurantId: string;
    try {
      restaurantId = extractRestaurantId(card.url);
    } catch {
      continue;
    }
    if (seen.has(restaurantId) || card.name.trim().length === 0) {
      continue;
    }
    seen.add(restaurantId);

    const lunchMatch = card.text.match(/ランチ[^0-9¥￥]{0,20}([¥￥]?\s*[\d,]+\s*円?)/);
    const dinnerMatch = card.text.match(
      /(?:ディナー|夜)[^0-9¥￥]{0,20}([¥￥]?\s*[\d,]+\s*円?)/,
    );
    const lunch = lunchMatch?.[1] === undefined ? undefined : firstNumber(lunchMatch[1]);
    const dinner = dinnerMatch?.[1] === undefined ? undefined : firstNumber(dinnerMatch[1]);
    const highlightedPrice =
      card.highlightedPlan === undefined ? undefined : priceRangeFromText(card.highlightedPlan);

    results.push({
      restaurant_id: restaurantId,
      provider: "gurunavi",
      name: card.name.trim(),
      source_url: card.url,
      categories: card.categoryTexts.map((value) => value.trim()).filter(Boolean).slice(0, 8),
      ...(card.access === undefined ? {} : { access: card.access.trim() }),
      ...(lunch === undefined
        ? {}
        : { budget_lunch: { currency: "JPY", min: lunch, max: lunch, basis: "per_person" } }),
      ...(dinner === undefined
        ? {}
        : { budget_dinner: { currency: "JPY", min: dinner, max: dinner, basis: "per_person" } }),
      ...(card.ariaLabels.length === 0
        ? {}
        : { availability: parseAvailabilityLabels(card.ariaLabels) }),
      ...(card.badges.length === 0 ? {} : { badges: card.badges }),
      ...(card.highlightedPlan === undefined
        ? {}
        : {
            highlighted_plan: {
              name: card.highlightedPlan.trim(),
              ...(highlightedPrice === undefined ? {} : { price: highlightedPrice }),
            },
          }),
    });
  }
  return results;
}

function findRestaurantJsonLd(values: unknown[]): JsonObject | undefined {
  const queue = [...values];
  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      for (const item of current as unknown[]) {
        queue.push(item);
      }
      continue;
    }
    const object = asObject(current);
    if (object === undefined) {
      continue;
    }
    const types = asStringArray(object["@type"]);
    if (types.some((type) => type === "Restaurant" || type === "FoodEstablishment")) {
      return object;
    }
    if (Array.isArray(object["@graph"])) {
      for (const item of object["@graph"] as unknown[]) {
        queue.push(item);
      }
    }
  }
  return undefined;
}

function parseOpeningHours(value: unknown): OpeningHours[] {
  if (typeof value === "string") {
    return [{ day: "unspecified", note: value }];
  }
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => {
    const object = asObject(entry);
    if (object === undefined) {
      return [];
    }
    const days = asStringArray(object.dayOfWeek);
    const opens = asString(object.opens);
    const closes = asString(object.closes);
    const effectiveDays = days.length === 0 ? ["unspecified"] : days;
    return effectiveDays.map((day) => ({
      day: day.replace("https://schema.org/", ""),
      ...(opens === undefined ? {} : { opens }),
      ...(closes === undefined ? {} : { closes }),
    }));
  });
}

function addressText(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct !== undefined) {
    return direct;
  }
  const object = asObject(value);
  if (object === undefined) {
    return undefined;
  }
  return [
    asString(object.postalCode),
    asString(object.addressRegion),
    asString(object.addressLocality),
    asString(object.streetAddress),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

function actionUrl(value: unknown): string | undefined {
  const actions = Array.isArray(value) ? value : [value];
  for (const action of actions) {
    const object = asObject(action);
    if (object === undefined) {
      continue;
    }
    const direct = asString(object.target) ?? asString(object.url);
    if (direct !== undefined) {
      return direct;
    }
    const targetObject = asObject(object.target);
    const nested = targetObject === undefined ? undefined : asString(targetObject.urlTemplate);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

export function parseRestaurantDetail(
  jsonLdValues: unknown[],
  facts: Record<string, string>,
  canonicalUrl: string,
): RestaurantDetail {
  const restaurant = findRestaurantJsonLd(jsonLdValues) ?? {};
  const name = asString(restaurant.name) ?? facts["店名"] ?? facts["店舗名"];
  if (name === undefined) {
    throw new Error("Restaurant name was not found in the current Gurunavi page");
  }
  const id = extractRestaurantId(canonicalUrl);
  const geo = asObject(restaurant.geo);
  const latitude = geo === undefined ? undefined : Number(geo.latitude);
  const longitude = geo === undefined ? undefined : Number(geo.longitude);
  const amenityEntries = Array.isArray(restaurant.amenityFeature)
    ? restaurant.amenityFeature
    : [restaurant.amenityFeature];
  const amenities = amenityEntries.flatMap((entry) => {
    const object = asObject(entry);
    const nameValue = object === undefined ? asString(entry) : asString(object.name);
    return nameValue === undefined ? [] : [nameValue];
  });
  const price = asString(restaurant.priceRange);
  const budget = price === undefined ? undefined : priceRangeFromText(price);
  const address = addressText(restaurant.address);
  const description = asString(restaurant.description);
  const telephone = asString(restaurant.telephone);
  const reservationUrl = actionUrl(restaurant.potentialAction);

  return {
    restaurant_id: id,
    provider: "gurunavi",
    name,
    source_url: canonicalUrl,
    categories: asStringArray(restaurant.servesCuisine),
    ...(address === undefined ? {} : { address }),
    ...(budget === undefined ? {} : { budget_dinner: budget }),
    ...(description === undefined ? {} : { description }),
    ...(telephone === undefined ? {} : { phone: telephone }),
    ...(Number.isFinite(latitude) && Number.isFinite(longitude)
      ? { coordinates: { latitude: latitude as number, longitude: longitude as number } }
      : {}),
    ...(restaurant.openingHoursSpecification === undefined
      ? {}
      : { opening_hours: parseOpeningHours(restaurant.openingHoursSpecification) }),
    ...(asString(restaurant.paymentAccepted) === undefined
      ? {}
      : { payment_methods: asStringArray(restaurant.paymentAccepted) }),
    ...(amenities.length === 0 ? {} : { amenities }),
    ...(reservationUrl === undefined ? {} : { reservation_url: reservationUrl }),
    ...(typeof restaurant.acceptsReservations !== "boolean"
      ? {}
      : { reservation_accepted: restaurant.acceptsReservations }),
    ...(facts["キャンセル規定"] === undefined
      ? {}
      : { cancellation_policy: facts["キャンセル規定"] }),
    facts,
  };
}

export function parseReservationOptions(rawOptions: RawReservationOption[]): ReservationOption[] {
  const seen = new Set<string>();
  return rawOptions.flatMap((raw) => {
    const match = raw.url.match(/\/(:c[^/#?]+)/);
    const optionId = match?.[1];
    if (optionId === undefined || seen.has(optionId)) {
      return [];
    }
    seen.add(optionId);
    const text = `${raw.name}\n${raw.text}`;
    const partyMatch = text.match(/(\d+)\s*名[～〜~-]\s*(\d+)\s*名/);
    const singlePartyMatch = text.match(/(\d+)\s*名(?:様)?から/);
    const times = Array.from(
      text.matchAll(/(?:^|\s)([012]\d:[0-5]\d)(?=\s|$)/g),
      (value) => value[1],
    ).filter((value): value is string => value !== undefined);
    const bookingType =
      text.includes("即予約") || text.includes("空席あり") || text.includes("○")
        ? "instant"
        : text.includes("リクエスト") || text.includes("■")
          ? "request"
          : text.includes("相談")
            ? "consultation"
            : "unknown";
    const cancellationLine = text
      .split("\n")
      .find((line) => line.includes("キャンセル") || line.includes("取消"));
    const optionPrice = priceRangeFromText(text);
    return [
      {
        option_id: optionId,
        name: raw.name.trim() || (optionId === ":c-1" ? "席のみ予約" : optionId),
        option_url: raw.url,
        kind: optionId === ":c-1" ? "seat_only" : "course",
        ...(optionPrice === undefined ? {} : { price: optionPrice }),
        ...(partyMatch?.[1] === undefined
          ? singlePartyMatch?.[1] === undefined
            ? {}
            : { min_party_size: Number(singlePartyMatch[1]) }
          : {
              min_party_size: Number(partyMatch[1]),
              max_party_size: Number(partyMatch[2]),
            }),
        ...(times.length === 0 ? {} : { available_times: [...new Set(times)] }),
        booking_type: bookingType,
        ...(cancellationLine === undefined
          ? {}
          : { cancellation_policy: cancellationLine.trim() }),
      },
    ];
  });
}

export function parseReservationSlots(rawSlots: RawReservationSlot[]): ReservationSlotSelection[] {
  const seen = new Set<string>();
  return rawSlots.flatMap((raw) => {
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      return [];
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "r.gnavi.co.jp" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      !url.pathname.endsWith("/plan/input/form")
    ) {
      return [];
    }
    const date = url.searchParams.get("date");
    const party = url.searchParams.get("num");
    const courseTime = url.searchParams.get("coursetime");
    const tableId = url.searchParams.get("tableid");
    const courseId = url.searchParams.get("courseid");
    if (
      url.searchParams.getAll("date").length !== 1 ||
      date === null ||
      !isValidCompactDate(date) ||
      url.searchParams.getAll("num").length !== 1 ||
      party === null ||
      !/^\d{1,2}$/.test(party) ||
      Number(party) < 1 ||
      Number(party) > 50 ||
      url.searchParams.getAll("coursetime").length !== 1 ||
      courseTime === null ||
      !/^(?:[01]\d|2[0-3])[0-5]\d$/.test(courseTime) ||
      url.searchParams.getAll("tableid").length !== 1 ||
      tableId === null ||
      !/^\d+$/.test(tableId) ||
      url.searchParams.getAll("courseid").length !== 1 ||
      courseId === null ||
      !/^-?\d+$/.test(courseId)
    ) {
      return [];
    }
    url.hash = "";
    url.searchParams.sort();
    const canonical = url.toString();
    if (seen.has(canonical)) {
      return [];
    }
    seen.add(canonical);
    const normalizedTime = `${courseTime.slice(0, 2)}:${courseTime.slice(2)}`;
    const bookingType =
      raw.activeStatus === "4"
        ? "instant"
        : raw.activeStatus === "2"
          ? "request"
          : "unknown";
    return [
      {
        slot_id: `slot_${createHash("sha256").update(canonical).digest("base64url").slice(0, 22)}`,
        time: normalizedTime,
        ...(raw.seatLabel === undefined || raw.seatLabel.trim().length === 0
          ? {}
          : { seat_label: raw.seatLabel.trim().replaceAll(/\s+/g, " ") }),
        booking_type: bookingType,
        booking_url: canonical,
      },
    ];
  });
}

function isValidCompactDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
