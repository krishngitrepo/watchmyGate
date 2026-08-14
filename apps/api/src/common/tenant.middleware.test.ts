/**
 * Regression test for the bug that made the entire API unreachable.
 *
 * `TenantMiddleware` matched public routes against `req.path`. Under Nest's
 * `forRoutes("*")` mounting, Express reports `path = "/"` and puts the real route in
 * `baseUrl`, so `req.path` was `"/"` for every request and matched no public path.
 *
 * The consequence was total: `/v1/auth/otp/request` — the endpoint that issues tokens —
 * required a token. Nobody could log in. It returned a plausible 401 rather than
 * crashing, so it read as correct and was only caught by calling it.
 */

import { describe, expect, it } from "vitest";

import { requestPath } from "./tenant.middleware.js";

describe("requestPath", () => {
  it("uses originalUrl, which is the full path regardless of mounting", () => {
    // Exactly what Express reported in the failing case.
    expect(
      requestPath({ originalUrl: "/healthz", url: "/" }),
    ).toBe("/healthz");
  });

  it("recovers the login route so OTP request stays public", () => {
    expect(
      requestPath({ originalUrl: "/v1/auth/otp/request", url: "/" }),
    ).toBe("/v1/auth/otp/request");
  });

  it("strips the query string", () => {
    expect(requestPath({ originalUrl: "/v1/gate/events?unitId=abc&limit=10" })).toBe(
      "/v1/gate/events",
    );
  });

  it("treats a trailing slash as the same route", () => {
    expect(requestPath({ originalUrl: "/healthz/" })).toBe("/healthz");
    expect(requestPath({ originalUrl: "/healthz//" })).toBe("/healthz");
  });

  it("keeps the root path intact rather than collapsing it to empty", () => {
    expect(requestPath({ originalUrl: "/" })).toBe("/");
  });

  it("falls back to url when originalUrl is absent", () => {
    expect(requestPath({ url: "/readyz" })).toBe("/readyz");
  });

  it("does not throw on a request carrying neither", () => {
    expect(requestPath({})).toBe("/");
  });

  /**
   * The property that matters: a public path must resolve to itself so the
   * `PUBLIC_PATHS.includes(...)` check can succeed. Before the fix every one of these
   * resolved to "/" and the API had no reachable entry point at all.
   */
  it.each([
    "/healthz",
    "/readyz",
    "/v1/auth/otp/request",
    "/v1/auth/otp/verify",
    "/v1/auth/refresh",
  ])("public path %s survives extraction", (path) => {
    expect(requestPath({ originalUrl: path, url: "/" })).toBe(path);
  });
});
