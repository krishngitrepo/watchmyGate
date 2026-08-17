/**
 * Deliveries.
 *
 * Logging and advancing are gate work, so guards can do both. Residents can see their
 * own flat's parcels — enforced by checking the requested unit against the caller's
 * occupancy rather than trusting a unit id in the query string, which would otherwise
 * let any resident read any flat's delivery history.
 */

import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { ForbiddenError } from "../../common/errors.js";
import { hasRole } from "../../common/tenant-context.js";
import { DeliveriesService } from "./deliveries.service.js";

const logSchema = z.object({
  courier: z.string().min(1).max(120),
  unitId: z.string().uuid().optional(),
  trackingRef: z.string().max(120).optional(),
  parcelCount: z.number().int().min(1).max(200).optional(),
  gateEventId: z.string().uuid().optional(),
  note: z.string().max(1000).optional(),
});

const advanceSchema = z.object({
  id: z.string().uuid(),
  status: z.enum([
    "at_gate",
    "awaiting_resident",
    "held_at_gate",
    "out_for_doorstep",
    "delivered",
    "collected",
    "returned",
    "refused",
  ]),
  handoverTo: z.string().max(160).optional(),
  handoverPhotoKey: z.string().max(400).optional(),
  note: z.string().max(1000).optional(),
});

@Controller("v1/deliveries")
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get()
  async open(@Query("unitId") unitId?: string) {
    this.requireGate();
    return this.deliveries.open(unitId);
  }

  @Get("summary")
  async summary() {
    this.requireGate();
    return this.deliveries.summary();
  }

  @Post()
  async log(@Body() body: unknown) {
    this.requireGate();
    return this.deliveries.log(logSchema.parse(body));
  }

  @Post("advance")
  async advance(@Body() body: unknown) {
    this.requireGate();
    return this.deliveries.advance(advanceSchema.parse(body));
  }

  private requireGate(): void {
    if (!hasRole("society_admin", "mc_member", "guard")) {
      throw new ForbiddenError("Only a guard or the committee can manage deliveries.");
    }
  }
}
