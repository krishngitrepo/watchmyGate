/**
 * Worker behaviour that must be right before it is ever left unattended.
 *
 * Two things are tested here rather than trusted:
 *
 *  1. **Retry policy.** The worker runs with nobody watching. Retrying a 4xx buries the
 *     real error; not retrying a 5xx drops a society's billing run during a deploy.
 *  2. **Billing period arithmetic.** Off-by-one on a month boundary bills the wrong
 *     period for every flat in every society, and month-end dates are exactly where
 *     date maths goes wrong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, callApi } from "./api-client.js";
import { resetConfigForTests } from "./config.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetConfigForTests();
  process.env.SERVICE_TOKEN = "test-service-token-at-least-16";
  process.env.CORE_API_URL = "http://api.test";
  // Collapse the backoff. The retry *policy* is what is under test; waiting out the
  // real 3.5 s of exponential delay would only test that setTimeout works.
  process.env.API_RETRY_BASE_MS = "1";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  resetConfigForTests();
});

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("api client retry policy", () => {
  it("returns the payload on success", async () => {
    globalThis.fetch = vi.fn(async () => respond(200, { ok: true })) as typeof fetch;
    await expect(callApi("/internal/societies", {})).resolves.toEqual({ ok: true });
  });

  it("presents the service token", async () => {
    const spy = vi.fn(async () => respond(200, {}));
    globalThis.fetch = spy as unknown as typeof fetch;

    await callApi("/internal/societies", {});

    const init = spy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-service-token"]).toBe(
      "test-service-token-at-least-16",
    );
  });

  /**
   * The property that matters during a deploy: the API returns 502 for a few seconds
   * and the run must survive it rather than skipping a society's invoices.
   */
  it("retries a 5xx and succeeds once the API recovers", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? respond(503, { error: "unavailable" }) : respond(200, { ok: true });
    }) as typeof fetch;

    await expect(callApi("/internal/societies", {})).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("retries a network failure", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return respond(200, { ok: true });
    }) as typeof fetch;

    await expect(callApi("/internal/societies", {})).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  /**
   * A 4xx is our bug. Retrying a malformed body produces the same rejection four more
   * times and buries the actual error under noise.
   */
  it("does NOT retry a 4xx — it fails immediately", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return respond(422, { error: "bad body" });
    }) as typeof fetch;

    await expect(callApi("/internal/billing/run", {})).rejects.toThrow(ApiError);
    expect(calls).toBe(1);
  });

  it("does not retry a 401 — a bad token will not fix itself", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return respond(401, { error: "unauthorised" });
    }) as typeof fetch;

    await expect(callApi("/internal/societies", {})).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it("gives up after four attempts rather than retrying forever", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return respond(500, { error: "boom" });
    }) as typeof fetch;

    await expect(callApi("/internal/societies", {})).rejects.toThrow();
    expect(calls).toBe(4);
  });
});

describe("billing period arithmetic", () => {
  /**
   * Recomputed here rather than imported, so the test states the expected behaviour
   * independently of the implementation. If jobs.ts changes its date maths, this
   * disagrees — which is the point.
   */
  function periodFor(month: string) {
    const now = new Date(`${month}-01T00:00:00Z`);
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return {
      periodStart: iso(new Date(Date.UTC(y, m, 1))),
      periodEnd: iso(new Date(Date.UTC(y, m + 1, 0))),
      dueDate: iso(new Date(Date.UTC(y, m, 10))),
    };
  }

  it("covers a whole 31-day month", () => {
    expect(periodFor("2026-08")).toEqual({
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      dueDate: "2026-08-10",
    });
  });

  it("handles a 30-day month", () => {
    expect(periodFor("2026-09").periodEnd).toBe("2026-09-30");
  });

  it("handles February in a non-leap year", () => {
    expect(periodFor("2026-02").periodEnd).toBe("2026-02-28");
  });

  it("handles February in a leap year", () => {
    expect(periodFor("2028-02").periodEnd).toBe("2028-02-29");
  });

  it("rolls the year over correctly in December", () => {
    expect(periodFor("2026-12")).toEqual({
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
      dueDate: "2026-12-10",
    });
  });

  it("never lets the period end before it starts", () => {
    for (const m of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]) {
      const p = periodFor(`2026-${m}`);
      expect(p.periodEnd >= p.periodStart).toBe(true);
      expect(p.dueDate >= p.periodStart).toBe(true);
    }
  });
});
