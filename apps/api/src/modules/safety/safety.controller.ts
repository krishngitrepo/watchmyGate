import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { ForbiddenError } from "../../common/errors.js";
import { hasRole } from "../../common/tenant-context.js";
import { SafetyService } from "./safety.service.js";

const sosSchema = z.object({
  type: z.enum(["medical", "fire", "gas", "security"]),
  unitId: z.string().uuid().optional(),
  // Strings, not numbers: these are passed through to responders verbatim and never
  // arithmetic, so a float conversion could only lose precision.
  latitude: z.string().max(24).optional(),
  longitude: z.string().max(24).optional(),
  note: z.string().max(1000).optional(),
});

const amenitySchema = z.object({
  name: z.string().min(1).max(120),
  capacity: z.number().int().min(1).max(10000).optional(),
  slotMinutes: z.number().int().min(15).max(1440).optional(),
  isPaid: z.boolean().optional(),
  rate: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
});

const bookingSchema = z.object({
  amenityId: z.string().uuid(),
  unitId: z.string().uuid(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

/**
 * SOS and amenities.
 *
 * **Raising an SOS is open to every member of the society, with no role check.** That is
 * deliberate and worth stating: the one moment a person must never be told "you do not
 * have permission" is the moment they are pressing panic. Anyone holding a valid session
 * for this society can raise one, and abuse is handled afterwards by the audit trail —
 * every alert records who raised it.
 */
@Controller("v1/safety")
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Post("sos")
  async raise(@Body() body: unknown) {
    return this.safety.raise(sosSchema.parse(body));
  }

  @Get("sos")
  async open() {
    this.requireResponder();
    return this.safety.openAlerts();
  }

  @Post("sos/:id/acknowledge")
  async acknowledge(@Param("id") id: string) {
    this.requireResponder();
    return this.safety.acknowledge(id);
  }

  @Post("sos/:id/close")
  async close(@Param("id") id: string, @Body() body: unknown) {
    this.requireResponder();
    const { note } = z.object({ note: z.string().max(1000).optional() }).parse(body ?? {});
    return this.safety.close(id, note);
  }

  @Get("amenities")
  async amenities() {
    return this.safety.amenities();
  }

  @Post("amenities")
  async createAmenity(@Body() body: unknown) {
    this.requireCommittee();
    return this.safety.createAmenity(amenitySchema.parse(body));
  }

  @Get("bookings")
  async bookings(
    @Query("amenityId") amenityId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.safety.bookings(amenityId, from, to);
  }

  @Post("bookings")
  async book(@Body() body: unknown) {
    return this.safety.book(bookingSchema.parse(body));
  }

  @Delete("bookings/:id")
  async cancel(@Param("id") id: string) {
    return this.safety.cancel(id);
  }

  @Get("summary")
  async summary() {
    return this.safety.safetySummary();
  }

  private requireResponder(): void {
    if (!hasRole("society_admin", "mc_member", "guard")) {
      throw new ForbiddenError("Only a guard or the committee can handle alerts.");
    }
  }

  private requireCommittee(): void {
    if (!hasRole("society_admin", "mc_member")) {
      throw new ForbiddenError("Only the committee can manage amenities.");
    }
  }
}
