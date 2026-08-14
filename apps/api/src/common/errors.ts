/**
 * Application errors.
 *
 * Messages here reach clients, so they must never reveal whether a resource exists in
 * another society. Cross-tenant access returns `NotFoundError`, never `ForbiddenError`
 * — confirming existence is itself a disclosure.
 */

export class AppError extends Error {
  readonly statusCode: number = 400;
  readonly code: string = "bad_request";

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends AppError {
  override readonly statusCode = 422;
  override readonly code = "validation_error";
}

export class AuthenticationError extends AppError {
  override readonly statusCode = 401;
  override readonly code = "unauthenticated";
}

export class ForbiddenError extends AppError {
  override readonly statusCode = 403;
  override readonly code = "forbidden";
}

export class NotFoundError extends AppError {
  override readonly statusCode = 404;
  override readonly code = "not_found";
}

export class ConflictError extends AppError {
  override readonly statusCode = 409;
  override readonly code = "conflict";
}

export class RateLimitError extends AppError {
  override readonly statusCode = 429;
  override readonly code = "rate_limited";
}

export class UpstreamError extends AppError {
  override readonly statusCode = 502;
  override readonly code = "upstream_error";
}
