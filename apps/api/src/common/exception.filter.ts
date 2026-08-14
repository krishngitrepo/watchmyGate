import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import type { Request, Response } from "express";

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
