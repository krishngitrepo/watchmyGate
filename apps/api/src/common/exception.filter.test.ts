/**
 * The exception filter.
 *
 * The ZodError branch is the one worth testing hardest. Every controller validates with
 * `schema.parse(body)`, so before it existed a single malformed field on any endpoint —
 * a missing uuid, a too-long name — answered 500 "Something went wrong. Please try
 * again." A client had no way to learn which field was wrong, and every one of those
 * logged a stack trace, burying genuine faults.
 */

import type { ArgumentsHost } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AppExceptionFilter } from "./exception.filter.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";

function hostWith(): {
  host: ArgumentsHost;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: "/v1/test", method: "POST" }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

const filter = new AppExceptionFilter();

describe("ZodError", () => {
  const schema = z.object({
    unitId: z.string().uuid(),
    count: z.number().int().min(1),
  });

  function zodFailure(input: unknown): unknown {
    try {
      schema.parse(input);
      throw new Error("expected the parse to fail");
    } catch (e) {
      return e;
    }
  }

  it("answers 422, not 500", () => {
    const { host, status } = hostWith();
    filter.catch(zodFailure({ unitId: "nope", count: 0 }), host);
    expect(status).toHaveBeenCalledWith(422);
  });

  it("names every field that was rejected", () => {
    const { host, json } = hostWith();
    filter.catch(zodFailure({ unitId: "nope", count: 0 }), host);

    const body = json.mock.calls[0]![0] as {
      error: { code: string; fields: { path: string }[] };
    };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.fields.map((f) => f.path).sort()).toEqual(["count", "unitId"]);
  });

  /**
   * Zod's raw issues carry the *received* value. Echoing those back would put a
   * submitted password or OTP into the response body and into any client-side log that
   * captures failed requests.
   */
  it("never echoes the submitted value back", () => {
    const { host, json } = hostWith();
    const secret = "hunter2-should-never-appear";
    filter.catch(zodFailure({ unitId: secret, count: 0 }), host);

    expect(JSON.stringify(json.mock.calls[0]![0])).not.toContain(secret);
  });

  it("reports a missing field as well as a malformed one", () => {
    const { host, json } = hostWith();
    filter.catch(zodFailure({ count: 5 }), host);
    const body = json.mock.calls[0]![0] as { error: { fields: { path: string }[] } };
    expect(body.error.fields.map((f) => f.path)).toContain("unitId");
  });
});

describe("application errors keep their own status", () => {
  it.each([
    [new ValidationError("bad"), 422],
    [new NotFoundError("gone"), 404],
    [new ConflictError("clash"), 409],
  ])("%s", (error, expected) => {
    const { host, status } = hostWith();
    filter.catch(error, host);
    expect(status).toHaveBeenCalledWith(expected);
  });
});

describe("anything unrecognised", () => {
  it("is a 500 that discloses nothing", () => {
    const { host, status, json } = hostWith();
    filter.catch(new Error("connection to db-prod-7 refused: password authentication failed"), host);

    expect(status).toHaveBeenCalledWith(500);
    const serialised = JSON.stringify(json.mock.calls[0]![0]);
    expect(serialised).not.toContain("db-prod-7");
    expect(serialised).not.toContain("password");
  });

  it("passes an HttpException's own status through", () => {
    const { host, status } = hostWith();
    filter.catch(new HttpException("nope", 418), host);
    expect(status).toHaveBeenCalledWith(418);
  });
});
