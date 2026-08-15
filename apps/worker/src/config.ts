/**
 * Worker configuration.
 *
 * Notably absent: any database credential. The worker holds no connection pool and no
 * schema knowledge — it reaches the database only through the API. That keeps tenant
 * scoping enforced in exactly one place rather than two implementations that must agree.
 */

import { z } from "zod";

const optionalString = z
  .string()
  .transform((v) => (v.trim() === "" ? undefined : v.trim()))
  .optional();

const schema = z.object({
  ENVIRONMENT: z.enum(["local", "dev", "staging", "production"]).default("local"),
  PORT: z.coerce.number().default(8081),
  LOG_LEVEL: z.string().default("info"),

  CORE_API_URL: z.string().default("http://localhost:8080"),

  /**
   * Shared secret presented to the API's internal endpoints.
   *
   * Required, with no default. A worker that silently starts without credentials looks
   * healthy while every job it runs fails authentication — and scheduled jobs have
   * nobody watching them fail.
   */
  SERVICE_TOKEN: z.string().min(16, "SERVICE_TOKEN must be at least 16 characters"),

  GCP_PROJECT_ID: optionalString,
  GCP_REGION: z.string().default("asia-southeast1"),

  /**
   * OIDC audience Cloud Tasks and Scheduler mint tokens for.
   *
   * When set, inbound job requests must carry a matching Google-signed token. Unset in
   * local development, where the service token alone guards the endpoints.
   */
  WORKER_AUDIENCE: optionalString,
});

export type Config = z.infer<typeof schema> & { isProduction: boolean };

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid worker configuration:\n${issues}`);
  }

  cached = { ...parsed.data, isProduction: parsed.data.ENVIRONMENT === "production" };
  return cached;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
