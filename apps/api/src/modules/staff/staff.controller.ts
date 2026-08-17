/**
 * Staff and attendance.
 *
 * Role gating differs per route rather than being uniform, because the two audiences are
 * different: a guard needs to record a check-in at the gate but must not be able to edit
 * a timesheet, and an accountant needs the timesheet but has no business setting PINs.
 *
 * The timesheet route is the one that feeds pay, so it is limited to the roles that
 * already carry money authority.
 */

import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { ForbiddenError } from "../../common/errors.js";
import { hasRole } from "../../common/tenant-context.js";
import { StaffService } from "./staff.service.js";

const createSchema = z.object({
  fullName: z.string().min(1).max(160),
  phone: z.string().min(6).max(20),
  kind: z.enum([
    "maid",
    "cook",
    "nanny",
    "driver",
    "gardener",
    "security",
    "vendor_staff",
    "other",
  ]),
  employerUnitId: z.string().uuid().optional(),
  vendorName: z.string().max(160).optional(),
  dailyStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  dailyEnd: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  notes: z.string().max(2000).optional(),
  unitIds: z.array(z.string().uuid()).max(50).optional(),
});

const checkInSchema = z.object({
  staffId: z.string().uuid(),
  method: z.enum(["gate_scan", "pin", "card", "manual", "biometric"]),
  pin: z.string().min(4).max(8).optional(),
  gateId: z.string().uuid().optional(),
});

const overrideSchema = z.object({
  attendanceId: z.string().uuid(),
  checkedInAt: z.string().datetime().optional(),
  checkedOutAt: z.string().datetime().optional(),
  note: z.string().min(3).max(500),
});

/**
 * Verification records an outcome, never a document.
 *
 * There is no field here for an Aadhaar number and none in the table. `idLast4` is
 * capped at four digits by the schema and re-checked in the service.
 */
const verificationSchema = z.object({
  status: z.enum(["submitted", "verified", "rejected", "expired"]),
  reference: z.string().max(120).optional(),
  idLast4: z.string().regex(/^\d{4}$/).optional(),
  policeVerified: z.boolean().optional(),
});

const pinSchema = z.object({ pin: z.string().regex(/^\d{4,8}$/) });

const statusSchema = z.object({
  status: z.enum(["pending", "active", "suspended", "exited"]),
});

@Controller("v1/staff")
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  async list(@Query("status") status?: string, @Query("unitId") unitId?: string) {
    return this.staff.list(status, unitId);
  }

  @Post()
  async create(@Body() body: unknown) {
    this.requireAdmin();
    return this.staff.create(createSchema.parse(body));
  }

  @Post(":id/status")
  async setStatus(@Param("id") id: string, @Body() body: unknown) {
    this.requireAdmin();
    return this.staff.setStatus(id, statusSchema.parse(body).status);
  }

  @Post(":id/pin")
  async setPin(@Param("id") id: string, @Body() body: unknown) {
    this.requireAdmin();
    return this.staff.setPin(id, pinSchema.parse(body).pin);
  }

  @Post(":id/verification")
  async verify(@Param("id") id: string, @Body() body: unknown) {
    this.requireAdmin();
    return this.staff.recordVerification(id, verificationSchema.parse(body));
  }

  /** Guards do this all day; admins can too. */
  @Post("attendance/check-in")
  async checkIn(@Body() body: unknown) {
    this.requireGate();
    return this.staff.checkIn(checkInSchema.parse(body));
  }

  @Post("attendance/check-out")
  async checkOut(@Body() body: unknown) {
    this.requireGate();
    const { staffId } = z.object({ staffId: z.string().uuid() }).parse(body);
    return this.staff.checkOut(staffId);
  }

  @Get("attendance/present")
  async present() {
    this.requireGate();
    return this.staff.present();
  }

  /**
   * Editing attendance changes what someone is paid, so it is admin-only and never
   * available to the guard who records the scans.
   */
  @Post("attendance/override")
  async override(@Body() body: unknown) {
    this.requireAdmin();
    return this.staff.override(overrideSchema.parse(body));
  }

  @Get("timesheet")
  async timesheet(@Query("month") month: string) {
    if (!hasRole("society_admin", "mc_member", "accountant")) {
      throw new ForbiddenError("Only the committee or the accountant can view timesheets.");
    }
    return this.staff.timesheet(month);
  }

  private requireAdmin(): void {
    if (!hasRole("society_admin", "mc_member")) {
      throw new ForbiddenError("Only the committee can manage staff.");
    }
  }

  private requireGate(): void {
    if (!hasRole("society_admin", "mc_member", "guard")) {
      throw new ForbiddenError("Only a guard or the committee can record attendance.");
    }
  }
}
