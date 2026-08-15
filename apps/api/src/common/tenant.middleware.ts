import { randomUUID, timingSafeEqual } from "node:crypto";

import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

import { loadConfig } from "./config.js";
import { AuthenticationError, ForbiddenError } from "./errors.js";
import { runWithContext } from "./tenant-context.js";
import { AuthService, type AccessClaims } from "../modules/auth/auth.service.js";

/** Endpoints reachable without a session. */
const PUBLIC_PATHS = [
  "/healthz",
  "/readyz",
  "/v1/auth/otp/request",
  "/v1/auth/otp/verify",
  "/v1/auth/refresh",
];

/** Authenticated, but usable before a society has been chosen. */
const SOCIETY_OPTIONAL_PATHS = ["/v1/auth/me/memberships", "/v1/auth/logout"];

/**
 * The request's full path, independent of where the middleware is mounted.
 *
 * `req.path` is NOT usable here. Nest applies `forRoutes("*")` by mounting the
 * middleware per route, so Express reports `baseUrl = "/healthz"` and `path = "/"` —
 * meaning `req.path` is `"/"` for *every* request and matches nothing.
 *
 * That is not a cosmetic bug. It made every entry in PUBLIC_PATHS unreachable, so
 * `/v1/auth/otp/request` demanded the very token it exists to issue: login was
 * impossible and the whole API was inaccessible. It returned 401 rather than erroring,
 * which is exactly why it survived a reading of the code and was only caught by
 * actually calling the endpoint.
 *
 * `originalUrl` is always the full path as received, so it is what we match on.
 */
export function requestPath(req: {
  originalUrl?: string | undefined;
  url?: string | undefined;
}): string {
  const raw = req.originalUrl ?? req.url ?? "/";
  const withoutQuery = raw.split("?")[0] ?? "/";
  // Treat /healthz and /healthz/ as the same route; keep "/" itself intact.
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Establishes the request's identity and tenant scope.
 *
 * Every handler downstream runs inside an AsyncLocalStorage context, so it cannot
 * choose a society for itself. A token with no society claim cannot reach tenant data
 * at all — the caller must pick one first, because a person may belong to several.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const path = requestPath(req);
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
    res.setHeader("x-request-id", requestId);

    if (PUBLIC_PATHS.includes(path)) {
      next();
      return;
    }

    // Worker traffic: a shared service token rather than a user session, because there
    // is no person behind a scheduled billing run and inventing one would corrupt the
    // audit trail. The handlers set their own tenant scope from the request body, since
    // the worker is explicitly acting across societies.
    if (path.startsWith("/internal/")) {
      this.requireServiceToken(req);
      next();
      return;
    }

    const header = req.headers.authorization;
    if (!header?.toLowerCase().startsWith("bearer ")) {
      next(new AuthenticationError("Sign in to continue."));
      return;
    }

    let claims: AccessClaims;
    try {
      claims = await this.auth.verifyAccessToken(header.slice(7).trim());
    } catch (error) {
      next(error);
      return;
    }

    (req as Request & { user?: AccessClaims }).user = claims;

    if (SOCIETY_OPTIONAL_PATHS.includes(path)) {
      next();
      return;
    }

    if (!claims.societyId) {
      next(new ForbiddenError("Select a society before continuing."));
      return;
    }

    runWithContext(
      {
        societyId: claims.societyId,
        personId: claims.personId,
        roles: claims.roles,
        requestId,
      },
      async () => {
        next();
      },
    ).catch(next);
  }

  /**
   * Verify the worker's shared secret.
   *
   * Compared in constant time. A plain `===` on a secret leaks its prefix through timing
   * — an attacker who can measure response times recovers it a byte at a time. That is a
   * slow attack and an entirely avoidable one.
   *
   * If no token is configured, these endpoints are closed rather than open. An
   * unconfigured secret must never mean "no check": that is how an internal endpoint
   * ends up reachable from the internet.
   */
  private requireServiceToken(req: Request): void {
    const expected = loadConfig().SERVICE_TOKEN;
    if (!expected) {
      throw new ForbiddenError(
        "Internal endpoints are disabled because SERVICE_TOKEN is not configured.",
      );
    }

    const presented = req.headers["x-service-token"];
    if (typeof presented !== "string") {
      throw new AuthenticationError("This endpoint requires a service token.");
    }

    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AuthenticationError("This endpoint requires a service token.");
    }
  }
}
