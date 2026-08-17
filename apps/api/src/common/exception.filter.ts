import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";

import { BillingError } from "@watchmygate/money";

import { AppError } from "./errors.js";

/**
 * Translates errors into responses.
 *
 * Unexpected errors return a generic message. A database driver error or a stack trace
 * reaching a client can disclose schema, table names and query shape — none of which a
 * resident should ever see.
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (exception instanceof AppError) {
      response.status(exception.statusCode).json({
        error: { code: exception.code, message: exception.message },
      });
      return;
    }

    /**
     * A rejected request body is the caller's fault, not ours.
     *
     * Every controller validates with `schema.parse(body)`, and without this branch a
     * ZodError fell through to the 500 handler — so *any* malformed field on *any*
     * endpoint answered "Something went wrong. Please try again." That is wrong three
     * times over: it blames the server for a client error, it tells the caller nothing
     * about which field to fix, and it logs a stack trace for what is an ordinary
     * validation failure, burying real faults in noise.
     *
     * 422 matches `ValidationError`, which is the same class of problem reached from
     * inside a service rather than at the edge — one status for "your input was
     * rejected" regardless of where it was caught.
     *
     * `path` and `message` only. Zod's raw issues echo the received value back, which
     * for a login or a PIN would put the submitted secret in the response body.
     */
    if (exception instanceof ZodError) {
      response.status(422).json({
        error: {
          code: "validation_failed",
          message: "Some fields were not accepted.",
          fields: exception.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      });
      return;
    }

    /**
     * A billing rule refused the input, and its message is the useful part.
     *
     * `BillingError` comes out of the money package — "Cannot bill 'Water charge': no
     * meter reading for this period", "per_sqft charge needs a carpet area". Every one of
     * those names exactly what the accountant has to supply, and without this branch all
     * of them fell through to the 500 handler and arrived as "Something went wrong.
     * Please try again."
     *
     * Nobody noticed because no client had ever called `/v1/billing/preview` — the
     * console was read-only until the billing screen was built. Typechecking and the unit
     * tests both pass either way; only calling the endpoint finds it.
     *
     * 422, the same as a rejected field: this is the caller's input being refused, not a
     * fault on our side.
     */
    if (exception instanceof BillingError) {
      response.status(422).json({
        error: { code: "billing_input_required", message: exception.message },
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json({
        error: {
          code: status === 404 ? "not_found" : "request_error",
          message: typeof body === "string" ? body : exception.message,
        },
      });
      return;
    }

    // Log the detail, return none of it.
    // eslint-disable-next-line no-console
    console.error({
      event: "unhandled_error",
      path: request.url,
      method: request.method,
      error: exception instanceof Error ? exception.stack : String(exception),
    });

    response.status(500).json({
      error: {
        code: "internal_error",
        message: "Something went wrong. Please try again.",
      },
    });
  }
}
