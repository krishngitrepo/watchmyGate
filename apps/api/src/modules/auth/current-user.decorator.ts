import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

import { AuthenticationError } from "../../common/errors.js";
import type { AccessClaims } from "./auth.service.js";

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessClaims => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AccessClaims }>();
    if (!request.user) {
      throw new AuthenticationError("Sign in to continue.");
    }
    return request.user;
  },
);
