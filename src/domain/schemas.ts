import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm in 24-hour time");

export const visitIntentSchema = z.object({
  date: isoDate.describe("Visit date in Japan local time (YYYY-MM-DD)"),
  time: timeOfDay.optional().describe("Preferred visit time in Japan local time (HH:mm)"),
  party_size: z.number().int().min(1).max(50),
});

export const moneyRangeSchema = z
  .object({
    currency: z.literal("JPY").default("JPY"),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().optional(),
    basis: z.enum(["per_person", "total"]).default("per_person"),
  })
  .refine((value) => value.min === undefined || value.max === undefined || value.min <= value.max, {
    message: "budget.min must not exceed budget.max",
  });

export const restaurantSearchInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Natural-language restaurant query, dish, venue name, or landmark"),
    area: z
      .object({
        free_text: z.string().trim().min(1).max(120).optional(),
        prefecture: z.string().trim().min(1).max(32).optional(),
        city: z.string().trim().min(1).max(64).optional(),
        station: z.string().trim().min(1).max(64).optional(),
        max_walk_minutes: z.number().int().min(1).max(60).optional(),
      })
      .optional(),
    visit: visitIntentSchema.optional(),
    preferences: z
      .object({
        cuisines: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
        excluded_cuisines: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
        features: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
        occasion: z.string().trim().min(1).max(80).optional(),
        free_text: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
      })
      .optional(),
    budget: moneyRangeSchema.optional(),
    sort: z
      .enum(["provider_default", "relevance", "budget_low", "budget_high"])
      .default("provider_default"),
    limit: z.number().int().min(1).max(20).default(10),
    cursor: z.string().max(512).optional(),
  })
  .refine(
    (value) =>
      Boolean(
        value.query ??
          value.area?.free_text ??
          value.area?.prefecture ??
          value.area?.city ??
          value.area?.station ??
          value.preferences?.cuisines?.length ??
          value.preferences?.free_text?.length,
      ),
    { message: "Provide at least one query, area, cuisine, or free-text preference" },
  );

export const restaurantGetInputSchema = z
  .object({
    restaurant_id: z.string().trim().min(1).max(100).optional(),
    source_url: z.string().url().optional(),
  })
  .refine((value) => value.restaurant_id !== undefined || value.source_url !== undefined, {
    message: "restaurant_id or source_url is required",
  });

export const reservationOptionsInputSchema = z.object({
  restaurant_id: z.string().trim().min(1).max(100),
  option_id: z
    .string()
    .regex(/^:c-?\d+$/, "Use an option_id returned by reservation_options_get")
    .optional(),
  visit: visitIntentSchema,
  budget: moneyRangeSchema.optional(),
  session_id: z.string().uuid().optional(),
});

export const reservationProfileSchema = z.object({
  name_kana: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().min(8).max(30).optional(),
  email: z.string().email().max(254).optional(),
});

export const reservationPrepareInputSchema = z.object({
  restaurant_id: z.string().trim().min(1).max(100),
  option_id: z
    .string()
    .regex(/^:c-?\d+$/, "Use an option_id returned by reservation_options_get"),
  slot_id: z.string().trim().min(8).max(100).optional(),
  visit: visitIntentSchema,
  profile: reservationProfileSchema.optional(),
  special_requests: z.string().trim().max(500).optional(),
  session_id: z.string().uuid().optional(),
});

export const reservationSubmitInputSchema = z.object({
  reservation_id: z.string().uuid(),
  confirmation_token: z
    .string()
    .min(20)
    .describe("One-time token returned by reservation_prepare for this exact summary"),
});

export const reservationStatusInputSchema = z.object({
  reservation_id: z.string().uuid(),
  refresh_from_provider: z.boolean().default(false),
});

export const reservationCancelPrepareInputSchema = z.object({
  reservation_id: z.string().uuid(),
});

export const reservationCancelSubmitInputSchema = z.object({
  reservation_id: z.string().uuid(),
  confirmation_token: z.string().min(20),
});

export const browserSessionConnectInputSchema = z.object({
  purpose: z.enum(["login", "reservation"]).default("login"),
  restaurant_id: z.string().trim().min(1).max(100).optional(),
});

export const interactionResumeInputSchema = z.object({
  interaction_id: z.string().uuid(),
});

export const workerCommandSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("restaurant_search"),
    principal_id: z.string().min(1),
    input: restaurantSearchInputSchema,
  }),
  z.object({
    operation: z.literal("restaurant_get"),
    principal_id: z.string().min(1),
    input: restaurantGetInputSchema,
  }),
  z.object({
    operation: z.literal("reservation_options_get"),
    principal_id: z.string().min(1),
    input: reservationOptionsInputSchema,
  }),
  z.object({
    operation: z.literal("reservation_submit"),
    principal_id: z.string().min(1),
    reservation_id: z.string().uuid(),
  }),
  z.object({
    operation: z.literal("reservation_status_get"),
    principal_id: z.string().min(1),
    reservation_id: z.string().uuid(),
  }),
  z.object({
    operation: z.literal("reservation_cancel_submit"),
    principal_id: z.string().min(1),
    reservation_id: z.string().uuid(),
  }),
]);

export type WorkerCommand = z.infer<typeof workerCommandSchema>;
