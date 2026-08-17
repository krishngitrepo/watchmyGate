import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { ForbiddenError } from "../../common/errors.js";
import { hasRole } from "../../common/tenant-context.js";
import { MigrationService } from "./migration.service.js";

const unitRow = z.object({
  tower: z.string().min(1).max(80),
  number: z.string().min(1).max(32),
  floor: z.number().int().min(-5).max(200).optional(),
  // A string, never a number. This feeds per-sq-ft billing, and it is the one place a
  // float could enter the money path through an import.
  carpetAreaSqft: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  bhk: z.number().int().min(1).max(20).optional(),
  ownerName: z.string().max(200).optional(),
  ownerPhone: z.string().max(24).optional(),
  tenantName: z.string().max(200).optional(),
  tenantPhone: z.string().max(24).optional(),
});

const balanceRow = z.object({
  unitNumber: z.string().min(1).max(32),
  amount: z.string().max(32),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().max(500).optional(),
});

/**
 * Migration.
 *
 * **`dryRun` defaults to true on every route here.** That is the opposite of the usual
 * convention and it is deliberate: the failure mode of forgetting the flag should be a
 * harmless preview, never 400 flats written into a live society. Committing requires
 * saying so explicitly.
 */
@Controller("v1/migration")
export class MigrationController {
  constructor(private readonly migration: MigrationService) {}

  @Get("state")
  async state() {
    this.requireAdmin();
    return this.migration.currentState();
  }

  @Post("units")
  async units(@Body() body: unknown, @Query("commit") commit?: string) {
    this.requireAdmin();
    const { rows } = z.object({ rows: z.array(unitRow).min(1).max(5000) }).parse(body);
    return this.migration.importUnits(rows, commit !== "true");
  }

  @Post("opening-balances")
  async balances(@Body() body: unknown, @Query("commit") commit?: string) {
    this.requireAdmin();
    const { rows } = z.object({ rows: z.array(balanceRow).min(1).max(5000) }).parse(body);
    return this.migration.importOpeningBalances(rows, commit !== "true");
  }

  /**
   * Importing rewrites a society's register and its arrears. Restricted to the society
   * admin alone — not the wider committee — because an accidental run by a well-meaning
   * MC member is a very expensive afternoon.
   */
  private requireAdmin(): void {
    if (!hasRole("society_admin")) {
      throw new ForbiddenError("Only the society admin can run an import.");
    }
  }
}
