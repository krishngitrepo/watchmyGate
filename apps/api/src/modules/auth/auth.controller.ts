import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { AuthService } from "./auth.service.js";
import { CurrentUser } from "./current-user.decorator.js";
import type { AccessClaims } from "./auth.service.js";

const otpRequestSchema = z.object({ phone: z.string().min(6).max(20) });

const otpVerifySchema = z.object({
  phone: z.string().min(6).max(20),
  code: z.string().min(4).max(8),
  societyId: z.string().uuid().optional(),
  deviceId: z.string().max(128).optional(),
  deviceLabel: z.string().max(128).optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
  societyId: z.string().uuid().optional(),
});

@Controller("v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Send a login code.
   *
   * Always returns 202 whether or not the number is registered — a different response
   * would turn this into a "does this person live here" oracle.
   */
  @Post("otp/request")
  @HttpCode(202)
  async requestOtp(@Body() body: unknown, @Req() req: Request) {
    const { phone } = otpRequestSchema.parse(body);
    await this.auth.requestOtp(this.auth.normalisePhone(phone), req.ip);
    return { status: "sent" };
  }

  @Post("otp/verify")
  async verifyOtp(@Body() body: unknown, @Req() req: Request) {
    const input = otpVerifySchema.parse(body);
    const phone = this.auth.normalisePhone(input.phone);

    const { personId } = await this.auth.verifyOtp(phone, input.code);
    const roles = await this.auth.rolesFor(personId, input.societyId ?? null);

    return this.auth.createSession(personId, {
      societyId: input.societyId ?? null,
      roles,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}),
      ...(req.ip ? { ip: req.ip } : {}),
    });
  }

  @Post("refresh")
  async refresh(@Body() body: unknown) {
    const input = refreshSchema.parse(body);
    return this.auth.rotateSession(input.refreshToken, {
      societyId: input.societyId ?? null,
    });
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Body() body: unknown): Promise<void> {
    const input = refreshSchema.parse(body);
    await this.auth.revokeSession(input.refreshToken);
  }

  /** Societies this person belongs to — one person may be resident in A and MC in B. */
  @Get("me/memberships")
  async memberships(@CurrentUser() user: AccessClaims) {
    return this.auth.memberships(user.personId);
  }
}
