/**
 * Society administration — towers, flats, occupants, roles.
 *
 * Everything here is committee/admin work, so every route is role-gated. Tenant scoping
 * comes from the token and the database enforces it regardless, but these endpoints
 * decide *who inside a society* may reshape it: a resident must not be able to add
 * flats or grant themselves the accountant role.
 */

import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { ForbiddenError } from "../../common/errors.js";
import { hasRole } from "../../common/tenant-context.js";
import { SocietyService } from "./society.service.js";

const towerSchema = z.object({
  name: z.string().min(1).max(80),
  floors: z.number().int().min(1).max(200).optional(),
});

const unitSchema = z.object({
  towerId: z.string().uuid(),
  number: z.string().min(1).max(32),
  floor: z.number().int().min(-5).max(200).optional(),
  // A string, never a number: this feeds per-sq-ft billing, and a float here would be
  // the one place a rounding error could enter the money path.
  carpetAreaSqft: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  bhk: z.number().int().min(1).max(20).optional(),
});

const bulkUnitsSchema = z.object({
  units: z.array(unitSchema).min(1).max(2000),
});

const occupantSchema = z.object({
  unitId: z.string().uuid(),
  phone: z.string().min(6).max(20),
  name: z.string().max(200).optional(),
  relationship: z.enum(["owner", "tenant", "family_member", "occupant"]),
  isBillingLiable: z.boolean(),
  hasVotingRight: z.boolean(),
  hasAppAccess: z.boolean().default(true),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const roleSchema = z.object({
  phone: z.string().min(6).max(20),
  name: z.string().max(200).optional(),
  roleCode: z.enum([
    "society_admin",
    "mc_member",
    "accountant",
    "auditor",
    "guard",
    "resident",
    "staff",
  ]),
});

@Controller("v1/society")
export class SocietyController {
  constructor(private readonly society: SocietyService) {}

  @Get("summary")
  async summary() {
    return this.society.summary();
  }

  @Get("towers")
  async towers() {
    return this.society.listTowers();
  }

  @Post("towers")
  async createTower(@Body() body: unknown) {
    this.requireAdmin();
    return this.society.createTower(towerSchema.parse(body));
  }

  @Get("units")
  async units(@Query("towerId") towerId?: string) {
    return this.society.listUnits(towerId);
  }

  @Post("units")
  async createUnit(@Body() body: unknown) {
    this.requireAdmin();
    return this.society.createUnit(unitSchema.parse(body));
  }

  /**
   * Bulk import.
   *
   * The single most important endpoint for growth: a 400-flat society switching from a
   * competitor will not retype its register, and migration quality is what actually
   * decides whether a society moves. Per-row results, so a bad spreadsheet row is
   * reported rather than aborting the import.
   */
  @Post("units/bulk")
  async createUnits(@Body() body: unknown) {
    this.requireAdmin();
    const { units } = bulkUnitsSchema.parse(body);
    return this.society.createUnitsBulk(units);
  }

  /**
   * Who occupies a flat, optionally as of a past date.
   *
   * `?on=2026-06-15` answers "who was liable in June?" — the question a disputed
   * invoice always raises, and the reason occupancy is bitemporal.
   */
  @Get("units/:id/occupants")
  async occupants(@Param("id") id: string, @Query("on") on?: string) {
    return this.society.occupantsOf(id, on);
  }

  @Post("occupancies")
  async assignOccupant(@Body() body: unknown) {
    this.requireAdmin();
    return this.society.assignOccupant(occupantSchema.parse(body));
  }

  @Delete("occupancies/:id")
  async endOccupancy(@Param("id") id: string, @Query("validTo") validTo?: string) {
    this.requireAdmin();
    const date = validTo ?? new Date().toISOString().slice(0, 10);
    return this.society.endOccupancy(id, date);
  }

  @Get("directory")
  async directory() {
    return this.society.directory();
  }

  @Post("roles")
  async grantRole(@Body() body: unknown) {
    // Deliberately narrower than requireAdmin: granting roles is how someone would
    // escalate their own privileges, so committee members cannot do it.
    if (!hasRole("society_admin")) {
      throw new ForbiddenError("Only a society admin can grant roles.");
    }
    return this.society.grantRole(roleSchema.parse(body));
  }

  @Delete("roles")
  async revokeRole(@Body() body: unknown) {
    if (!hasRole("society_admin")) {
      throw new ForbiddenError("Only a society admin can revoke roles.");
    }
    const input = z
      .object({ personId: z.string().uuid(), roleCode: z.string().max(32) })
      .parse(body);
    return this.society.revokeRole(input);
  }

  private requireAdmin(): void {
    if (!hasRole("society_admin", "mc_member")) {
      throw new ForbiddenError("Only the committee can change society records.");
    }
  }
}
