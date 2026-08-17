import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { ForbiddenError } from "../../common/errors.js";
import { hasRole } from "../../common/tenant-context.js";
import { ParkingService } from "./parking.service.js";

const vehicleSchema = z.object({
  plate: z.string().min(4).max(24),
  unitId: z.string().uuid().optional(),
  staffId: z.string().uuid().optional(),
  kind: z.enum(["car", "two_wheeler", "bicycle", "commercial", "other"]).optional(),
  makeModel: z.string().max(120).optional(),
  colour: z.string().max(40).optional(),
  stickerNo: z.string().max(40).optional(),
});

const slotSchema = z.object({
  code: z.string().min(1).max(40),
  kind: z.enum(["covered", "open", "stack", "visitor", "accessible", "ev"]).optional(),
  towerId: z.string().uuid().optional(),
  level: z.string().max(20).optional(),
  monthlyRate: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
});

const allotSchema = z.object({
  slotId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
});

const violationSchema = z.object({
  plate: z.string().min(4).max(24),
  reason: z.string().min(1).max(120),
  slotId: z.string().uuid().optional(),
  photoKey: z.string().max(400).optional(),
});

/**
 * Vehicles and parking.
 *
 * The plate lookup is available to guards — it is the route a gate actually calls, many
 * times an hour. Everything that changes an allotment is committee work, because a
 * parking space is a scarce asset and reassigning one is a decision, not an operation.
 */
@Controller("v1/parking")
export class ParkingController {
  constructor(private readonly parking: ParkingService) {}

  @Get("vehicles")
  async vehicles(@Query("unitId") unitId?: string) {
    return this.parking.listVehicles(unitId);
  }

  @Post("vehicles")
  async registerVehicle(@Body() body: unknown) {
    this.requireCommittee();
    return this.parking.registerVehicle(vehicleSchema.parse(body));
  }

  @Delete("vehicles/:id")
  async deregister(@Param("id") id: string) {
    this.requireCommittee();
    return this.parking.deregisterVehicle(id);
  }

  /** The gate lookup. Unknown plates come back as `known: false`, not as an error. */
  @Get("lookup")
  async lookup(@Query("plate") plate: string) {
    this.requireGate();
    return this.parking.lookup(plate);
  }

  @Get("slots")
  async slots(@Query("free") free?: string) {
    return this.parking.slots(free === "true");
  }

  @Post("slots")
  async createSlot(@Body() body: unknown) {
    this.requireCommittee();
    return this.parking.createSlot(slotSchema.parse(body));
  }

  @Post("slots/allot")
  async allot(@Body() body: unknown) {
    this.requireCommittee();
    const input = allotSchema.parse(body);
    return this.parking.allot(input.slotId, input.vehicleId, input.unitId);
  }

  @Post("slots/:id/release")
  async release(@Param("id") id: string) {
    this.requireCommittee();
    return this.parking.release(id);
  }

  @Get("violations")
  async violations() {
    this.requireGate();
    return this.parking.openViolations();
  }

  @Post("violations")
  async flag(@Body() body: unknown) {
    this.requireGate();
    return this.parking.flagViolation(violationSchema.parse(body));
  }

  @Post("violations/:id/resolve")
  async resolve(@Param("id") id: string) {
    this.requireGate();
    return this.parking.resolveViolation(id);
  }

  @Get("summary")
  async summary() {
    return this.parking.summary();
  }

  private requireCommittee(): void {
    if (!hasRole("society_admin", "mc_member")) {
      throw new ForbiddenError("Only the committee can manage vehicles and parking.");
    }
  }

  private requireGate(): void {
    if (!hasRole("society_admin", "mc_member", "guard")) {
      throw new ForbiddenError("Only a guard or the committee can do that.");
    }
  }
}
