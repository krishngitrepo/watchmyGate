/**
 * HTTP client for the core API's internal endpoints.
 *
 * Retries with exponential backoff and jitter. The worker runs unattended, so a
 * transient 502 during an API deploy must not silently drop a society's billing run.
 *
 * Retries only on 5xx and network errors. A 4xx means the request itself is wrong —
 * retrying a malformed body just produces the same rejection four more times and buries
 * the real error under noise.
 */

import { loadConfig } from "./config.js";

const MAX_ATTEMPTS = 4;

/**
 * Base backoff, doubling per attempt.
 *
 * Overridable so tests do not spend real seconds asleep — a suite that waits out a
 * genuine 3.5 s backoff is a suite people start skipping. It is also useful in
 * production: backoff can be tuned for a flaky network without a code change.
 */
function baseDelayMs(): number {
  const configured = Number(process.env.API_RETRY_BASE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 500;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callApi<T = unknown>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const config = loadConfig();
  const url = `${config.CORE_API_URL}${path}`;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const controller = new AbortController();
      // Generous: a billing run across 400 units legitimately takes minutes.
      const timeout = setTimeout(() => controller.abort(), 300_000);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-service-token": config.SERVICE_TOKEN,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await response.text();

        if (response.ok) {
          return (text ? JSON.parse(text) : {}) as T;
        }

        // A client error is our bug, not a blip. Fail immediately and loudly.
        if (response.status < 500) {
          throw new ApiError(
            `${path} rejected the request (${response.status}): ${text.slice(0, 300)}`,
            response.status,
          );
        }

        lastError = new ApiError(`${path} failed (${response.status})`, response.status);
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) throw error;
      lastError = error as Error;
    }

    if (attempt < MAX_ATTEMPTS) {
      // Jitter matters: without it, every society's retry lands on the API at the same
      // instant and turns a brief blip into a thundering herd.
      const backoff = baseDelayMs() * 2 ** (attempt - 1);
      await sleep(backoff + Math.random() * backoff);
    }
  }

  throw lastError ?? new Error(`${path} failed for an unknown reason.`);
}
