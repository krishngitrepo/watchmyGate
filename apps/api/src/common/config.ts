/**
 * Configuration.
 *
 * Everything comes from the environment. In production Cloud Run injects these from
 * Google Secret Manager; nothing sensitive is read from a file in the repo.
 *
 * Two guards worth knowing about:
 *
 * 1. **Blank means unset.** `.env.example` ships credentials as empty values. Loaded
 *    naively they become `""`, which is truthy-not-undefined, every stub check reports
 *    "configured", and the service makes live calls to real providers with empty
 *    credentials. This bit us once already in the Python implementation — a local test
 *    posted a real phone number to MSG91. Blank is normalised to undefined here.
 *
 * 2. **Placeholders never reach production.** The example file uses the literal string
 *    PLACEHOLDER; booting production with one is a hard failure rather than a subtle
 *    outage.
 */

import { z } from "zod";

/** Treat empty and whitespace-only values as absent. */
const optionalString = z
  .string()
  .transform((v) => (v.trim() === "" ? undefined : v.trim()))
  .optional();

const schema = z.object({
  ENVIRONMENT: z.enum(["local", "dev", "staging", "production"]).default("local"),
  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_MIGRATION_URL: optionalString,
  DB_POOL_SIZE: z.coerce.number().default(10),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_ACCESS_TTL_MINUTES: z.coerce.number().default(15),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().default(30),
  OTP_TTL_SECONDS: z.coerce.number().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().default(60),

  MSG91_AUTH_KEY: optionalString,
  MSG91_SENDER_ID: optionalString,
  MSG91_OTP_TEMPLATE_ID: optionalString,

  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,

  R2_ACCOUNT_ID: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,
  R2_BUCKET: z.string().default("watchmygate"),
  R2_PUBLIC_HOST: optionalString,

  EXOTEL_SID: optionalString,
  EXOTEL_TOKEN: optionalString,
  EXOTEL_CALLER_ID: optionalString,

  FCM_CREDENTIALS_JSON: optionalString,

  GCP_PROJECT_ID: optionalString,
  GCP_REGION: z.string().default("asia-southeast1"),
  CLOUD_TASKS_QUEUE: z.string().default("approval-ladder"),
  WORKER_BASE_URL: optionalString,
  WORKER_SERVICE_ACCOUNT: optionalString,

  /**
   * Origins allowed to call this API from a browser.
   *
   * Comma-separated. An explicit list rather than a wildcard: reflecting any Origin
   * would let any site a committee member visits issue authenticated calls with their
   * session.
   *
   * The defaults cover local development and the Tauri desktop shell, whose origin is
   * `tauri://localhost` on macOS/Linux and `http://tauri.localhost` on Windows.
   */
  CORS_ORIGINS: z
    .string()
    .default(
      "http://localhost:3000,http://127.0.0.1:3000,app://wmg",
    )
    .transform((v) =>
      v
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  /** Shared secret the Python AI/device service presents. */
  SERVICE_TOKEN: optionalString,

  SENTRY_DSN: optionalString,
});

export type Config = z.infer<typeof schema> & {
  isProduction: boolean;
  smsIsStubbed: boolean;
  paymentsAreStubbed: boolean;
  storageIsStubbed: boolean;
  pushIsStubbed: boolean;
  voiceIsStubbed: boolean;
  tasksAreStubbed: boolean;
};

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const env = parsed.data;
  const isProduction = env.ENVIRONMENT === "production";

  if (isProduction) {
    // Fail loudly rather than shipping placeholders or dev secrets.
    const placeholders = Object.entries(env).filter(
      ([, v]) => typeof v === "string" && v.includes("PLACEHOLDER"),
    );
    if (placeholders.length > 0) {
      throw new Error(
        `Production configuration still contains placeholders: ${placeholders
          .map(([k]) => k)
          .join(", ")}`,
      );
    }
    if (!env.MSG91_AUTH_KEY) {
      throw new Error(
        "MSG91 credentials are required in production — OTP cannot be stubbed.",
      );
    }
  }

  cached = {
    ...env,
    isProduction,
    // Stub mode: the integration is logged instead of called, so the whole app runs
    // locally with no cloud accounts at all.
    smsIsStubbed: !env.MSG91_AUTH_KEY,
    paymentsAreStubbed: !env.RAZORPAY_KEY_ID,
    storageIsStubbed: !env.R2_ACCESS_KEY_ID,
    pushIsStubbed: !env.FCM_CREDENTIALS_JSON,
    voiceIsStubbed: !env.EXOTEL_SID,
    tasksAreStubbed: !env.GCP_PROJECT_ID || !env.WORKER_BASE_URL,
  };

  return cached;
}
