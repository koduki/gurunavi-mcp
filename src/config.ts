import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVICE_MODE: z.enum(["all", "mcp", "worker"]).default("all"),
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  GURUNAVI_BASE_URL: z.string().url().default("https://r.gnavi.co.jp"),
  BROWSER_WORKER_URL: z.string().url().or(z.literal("")).default(""),
  BROWSER_WORKER_AUDIENCE: z.string().default(""),
  BROWSER_INTERACTION_BASE_URL: z.string().url().or(z.literal("")).default(""),
  BROWSER_INVOKER_EMAIL: z.string().default(""),
  FIRESTORE_DATABASE_ID: z.string().default("(default)"),
  GOOGLE_CLOUD_PROJECT: z.string().default(""),
  KMS_KEY_NAME: z.string().default(""),
  CLOUD_TASKS_QUEUE: z.string().default("gurunavi-reservation-status"),
  CLOUD_TASKS_LOCATION: z.string().default("asia-northeast1"),
  TASKS_TARGET_URL: z.string().url().or(z.literal("")).default(""),
  TASKS_INVOKER_EMAIL: z.string().default(""),
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(""),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(""),
  ALLOWED_EMAILS: z.string().default(""),
  TOKEN_SIGNING_SECRET: z.string().min(16).default("local-development-signing-secret"),
  SESSION_ENCRYPTION_KEY: z.string().min(16).default("local-development-encryption-key"),
  INTERACTION_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  RESERVATION_SUBMIT_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  AUTH_DISABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  GURUNAVI_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(250).default(2000),
  GURUNAVI_NAVIGATION_TIMEOUT_MS: z.coerce.number().int().min(5000).default(30000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type ServiceMode = "all" | "mcp" | "worker";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  serviceMode: ServiceMode;
  port: number;
  publicBaseUrl: URL;
  gurunaviBaseUrl: URL;
  browserWorkerUrl?: URL;
  browserWorkerAudience?: string;
  browserInteractionBaseUrl: URL;
  browserInvokerEmail?: string;
  firestoreDatabaseId: string;
  googleCloudProject?: string;
  kmsKeyName?: string;
  cloudTasksQueue: string;
  cloudTasksLocation: string;
  tasksTargetUrl?: URL;
  tasksInvokerEmail?: string;
  googleOAuthClientId?: string;
  googleOAuthClientSecret?: string;
  allowedEmails: ReadonlySet<string>;
  tokenSigningSecret: string;
  sessionEncryptionKey: string;
  interactionTokenTtlSeconds: number;
  reservationSubmitEnabled: boolean;
  authDisabled: boolean;
  gurunaviMinRequestIntervalMs: number;
  gurunaviNavigationTimeoutMs: number;
  logLevel: string;
}

function optionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const browserWorkerUrl = optionalString(parsed.BROWSER_WORKER_URL);
  const browserInteractionBaseUrl = optionalString(parsed.BROWSER_INTERACTION_BASE_URL);
  const publicBaseUrl = new URL(parsed.PUBLIC_BASE_URL);
  const tasksTargetUrl = optionalString(parsed.TASKS_TARGET_URL);

  if (parsed.NODE_ENV === "production" && parsed.AUTH_DISABLED) {
    throw new Error("AUTH_DISABLED cannot be enabled in production");
  }
  if (
    parsed.NODE_ENV === "production" &&
    parsed.SERVICE_MODE !== "worker" &&
    (!parsed.GOOGLE_OAUTH_CLIENT_ID || !parsed.GOOGLE_OAUTH_CLIENT_SECRET)
  ) {
    throw new Error("Google OAuth credentials are required for the MCP service in production");
  }
  if (parsed.NODE_ENV === "production" && !publicBaseUrl.protocol.startsWith("https")) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production");
  }
  if (parsed.NODE_ENV === "production" && parsed.KMS_KEY_NAME.trim().length === 0) {
    throw new Error("KMS_KEY_NAME is required in production");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    serviceMode: parsed.SERVICE_MODE,
    port: parsed.PORT,
    publicBaseUrl,
    gurunaviBaseUrl: new URL(parsed.GURUNAVI_BASE_URL),
    ...(browserWorkerUrl === undefined ? {} : { browserWorkerUrl: new URL(browserWorkerUrl) }),
    ...(optionalString(parsed.BROWSER_WORKER_AUDIENCE) === undefined
      ? {}
      : { browserWorkerAudience: parsed.BROWSER_WORKER_AUDIENCE }),
    browserInteractionBaseUrl:
      browserInteractionBaseUrl === undefined ? publicBaseUrl : new URL(browserInteractionBaseUrl),
    ...(optionalString(parsed.BROWSER_INVOKER_EMAIL) === undefined
      ? {}
      : { browserInvokerEmail: parsed.BROWSER_INVOKER_EMAIL.toLowerCase() }),
    firestoreDatabaseId: parsed.FIRESTORE_DATABASE_ID,
    ...(optionalString(parsed.GOOGLE_CLOUD_PROJECT) === undefined
      ? {}
      : { googleCloudProject: parsed.GOOGLE_CLOUD_PROJECT }),
    ...(optionalString(parsed.KMS_KEY_NAME) === undefined
      ? {}
      : { kmsKeyName: parsed.KMS_KEY_NAME }),
    cloudTasksQueue: parsed.CLOUD_TASKS_QUEUE,
    cloudTasksLocation: parsed.CLOUD_TASKS_LOCATION,
    ...(tasksTargetUrl === undefined ? {} : { tasksTargetUrl: new URL(tasksTargetUrl) }),
    ...(optionalString(parsed.TASKS_INVOKER_EMAIL) === undefined
      ? {}
      : { tasksInvokerEmail: parsed.TASKS_INVOKER_EMAIL.toLowerCase() }),
    ...(optionalString(parsed.GOOGLE_OAUTH_CLIENT_ID) === undefined
      ? {}
      : { googleOAuthClientId: parsed.GOOGLE_OAUTH_CLIENT_ID }),
    ...(optionalString(parsed.GOOGLE_OAUTH_CLIENT_SECRET) === undefined
      ? {}
      : { googleOAuthClientSecret: parsed.GOOGLE_OAUTH_CLIENT_SECRET }),
    allowedEmails: new Set(
      parsed.ALLOWED_EMAILS.split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
    tokenSigningSecret: parsed.TOKEN_SIGNING_SECRET,
    sessionEncryptionKey: parsed.SESSION_ENCRYPTION_KEY,
    interactionTokenTtlSeconds: parsed.INTERACTION_TOKEN_TTL_SECONDS,
    reservationSubmitEnabled: parsed.RESERVATION_SUBMIT_ENABLED,
    authDisabled: parsed.AUTH_DISABLED,
    gurunaviMinRequestIntervalMs: parsed.GURUNAVI_MIN_REQUEST_INTERVAL_MS,
    gurunaviNavigationTimeoutMs: parsed.GURUNAVI_NAVIGATION_TIMEOUT_MS,
    logLevel: parsed.LOG_LEVEL,
  };
}
