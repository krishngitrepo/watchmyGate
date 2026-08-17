/**
 * Vehicles, parking slots and unauthorised parking.
 *
 * The whole module turns on one small function: `normalisePlate`.
 *
 * The same car is written "KA05MJ9876", "KA 05 MJ 9876", "ka-05-mj-9876" and
 * "KA.05.MJ.9876" by four different guards on four different shifts. A lookup that
 * misses because of a space is a resident stopped at their own gate at 11pm, and it is
 * the commonest complaint about every plate-based system in this market. So the
 * normalised form is what gets stored and indexed, and what the human typed is kept
 * beside it for display.
 *
 * Allotment lives on the slot rather than in a join table, because a slot has at most
 * one holder at a time. A separate allotments table would allow two live rows claiming
 * the same space, and then the question "who has B2-14?" has two answers.
 */

import { Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";

import { schema } from "@watchmygate/db";

import { ConflictError, NotFoundError, ValidationError } from "../../common/errors.js";
import { currentContext, tx } from "../../common/tenant-context.js";

/**
 * Strip everything that is not a letter or digit, and uppercase.
 *
 * Deliberately does not try to validate against Indian plate formats. BH-series,
 * military, diplomatic, dealer-temporary and older state formats all differ, and a
 * regex that rejects a legitimate plate is worse than one that accepts an odd string —
 * the failure mode is a resident who cannot be registered at all.
 */
export function normalisePlate(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface RegisterVehicleInput {
  plate: string;
  unitId?: string | undefined;
  staffId?: string | undefined;
  kind?: "car" | "two_wheeler" | "bicycle" | "commercial" | "other" | undefined;
  makeModel?: string | undefined;
  colour?: string | undefined;
  stickerNo?: string | undefined;
}

@Injectable()
export class ParkingService {
  async registerVehicle(input: RegisterVehicleInput) {
    const plate = normalisePlate(input.plate);
    if (plate.length < 4 || plate.length > 16) {
      throw new ValidationError("That does not look like a number plate.");
    }
    if (!input.unitId && !input.staffId) {
      throw new ValidationError("A vehicle must belong to a flat or to a staff member.");
    }

    return tx(async (db) => {
      const [existing] = await db
        .select({ id: schema.vehicles.id })
        .from(schema.vehicles)
        .where(and(eq(schema.vehicles.plate, plate), eq(schema.vehicles.isActive, true)))
        .limit(1);
      if (existing) {
        throw new ConflictError("That number plate is already registered in this society.");
      }

      const [row] = await db
        .insert(schema.vehicles)
        .values({
          societyId: currentContext().societyId!,
          plate,
          plateDisplay: input.plate.trim().toUpperCase(),
          kind: input.kind ?? "car",
          ...(input.unitId ? { unitId: input.unitId } : {}),
          ...(input.staffId ? { staffId: input.staffId } : {}),
          ...(input.makeModel ? { makeModel: input.makeModel } : {}),
          ...(input.colour ? { colour: input.colour } : {}),
          ...(input.stickerNo ? { stickerNo: input.stickerNo } : {}),
        })
        .returning();
      return row!;
    });
  }

  /**
   * The gate lookup.
   *
   * Called with whatever a camera or a guard produced, normalised before matching. The
   * answer deliberately includes `known: false` rather than a 404 — a guard needs "this
   * is not a registered vehicle" as an ordinary answer they can act on, not an error.
   */
  async lookup(rawPlate: string) {
    const plate = normalisePlate(rawPlate);
    return tx(async (db) => {
      const [row] = await db
        .select({
          id: schema.vehicles.id,
          plate: schema.vehicles.plate,
          plateDisplay: schema.vehicles.plateDisplay,
          kind: schema.vehicles.kind,
          unitId: schema.vehicles.unitId,
          staffId: schema.vehicles.staffId,
          makeModel: schema.vehicles.makeModel,
          colour: schema.vehicles.colour,
        })
        .from(schema.vehicles)
        .where(and(eq(schema.vehicles.plate, plate), eq(schema.vehicles.isActive, true)))
        .limit(1);

      if (!row) return { known: false as const, plate };
      return { known: true as const, ...row };
    });
  }

  async listVehicles(unitId?: string) {
    return tx(async (db) =>
      db
        .select()
        .from(schema.vehicles)
        .where(
          and(
            eq(schema.vehicles.isActive, true),
            unitId ? eq(schema.vehicles.unitId, unitId) : undefined,
          ),
        )
        .orderBy(schema.vehicles.plateDisplay),
    );
  }

  async deregisterVehicle(id: string) {
    return tx(async (db) => {
      // Free the slot in the same transaction, or the space stays unusable because a
      // vehicle nobody can see still holds it.
      await db
        .update(schema.parkingSlots)
        .set({ vehicleId: null, unitId: null, allottedAt: null, updatedAt: new Date() })
        .where(eq(schema.parkingSlots.vehicleId, id));

      const updated = await db
        .update(schema.vehicles)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(schema.vehicles.id, id))
        .returning({ id: schema.vehicles.id });
      if (updated.length === 0) throw new NotFoundError("No such vehicle.");
      return { status: "deregistered" as const };
    });
  }

  async createSlot(input: {
    code: string;
    kind?: "covered" | "open" | "stack" | "visitor" | "accessible" | "ev" | undefined;
    towerId?: string | undefined;
    level?: string | undefined;
    monthlyRate?: string | undefined;
  }) {
    return tx(async (db) => {
      const [row] = await db
        .insert(schema.parkingSlots)
        .values({
          societyId: currentContext().societyId!,
          code: input.code,
          kind: input.kind ?? "open",
          ...(input.towerId ? { towerId: input.towerId } : {}),
          ...(input.level ? { level: input.level } : {}),
          ...(input.monthlyRate ? { monthlyRate: input.monthlyRate } : {}),
        })
        .returning();
      return row!;
    });
  }

  /**
   * Allot a slot.
   *
   * The unique index on (society_id, vehicle_id) is what actually prevents one car
   * holding two spaces; this check turns that into a readable message. Re-allotting an
   * occupied slot is refused rather than silently reassigned — quietly moving someone's
   * parking is the kind of change a committee needs to make deliberately.
   */
  async allot(slotId: string, vehicleId: string, unitId?: string) {
    return tx(async (db) => {
      const [slot] = await db
        .select()
        .from(schema.parkingSlots)
        .where(eq(schema.parkingSlots.id, slotId))
        .limit(1);
      if (!slot) throw new NotFoundError("No such parking slot.");
      if (slot.vehicleId && slot.vehicleId !== vehicleId) {
        throw new ConflictError(
          `Slot ${slot.code} is already allotted. Release it before allotting it again.`,
        );
      }

      const [held] = await db
        .select({ code: schema.parkingSlots.code })
        .from(schema.parkingSlots)
        .where(
          and(
            eq(schema.parkingSlots.vehicleId, vehicleId),
            sql`${schema.parkingSlots.id} <> ${slotId}`,
          ),
        )
        .limit(1);
      if (held) {
        throw new ConflictError(`That vehicle already holds slot ${held.code}.`);
      }

      const [row] = await db
        .update(schema.parkingSlots)
        .set({
          vehicleId,
          allottedAt: new Date(),
          updatedAt: new Date(),
          ...(unitId ? { unitId } : {}),
        })
        .where(eq(schema.parkingSlots.id, slotId))
        .returning();
      return row!;
    });
  }

  async release(slotId: string) {
    return tx(async (db) => {
      const updated = await db
        .update(schema.parkingSlots)
        .set({ vehicleId: null, unitId: null, allottedAt: null, updatedAt: new Date() })
        .where(eq(schema.parkingSlots.id, slotId))
        .returning({ id: schema.parkingSlots.id });
      if (updated.length === 0) throw new NotFoundError("No such parking slot.");
      return { status: "released" as const };
    });
  }

  async slots(onlyFree = false) {
    return tx(async (db) =>
      db
        .select()
        .from(schema.parkingSlots)
        .where(onlyFree ? isNull(schema.parkingSlots.vehicleId) : undefined)
        .orderBy(schema.parkingSlots.code),
    );
  }

  /**
   * Flag a car parked where it should not be.
   *
   * Records the plate as text as well as a vehicle reference, because the commonest
   * offender is a visitor's car that was never registered — a violation that could only
   * point at a known vehicle would miss exactly the cases a committee cares about.
   */
  async flagViolation(input: {
    plate: string;
    reason: string;
    slotId?: string | undefined;
    photoKey?: string | undefined;
  }) {
    const plate = normalisePlate(input.plate);
    return tx(async (db) => {
      const [vehicle] = await db
        .select({ id: schema.vehicles.id })
        .from(schema.vehicles)
        .where(and(eq(schema.vehicles.plate, plate), eq(schema.vehicles.isActive, true)))
        .limit(1);

      const [row] = await db
        .insert(schema.parkingViolations)
        .values({
          societyId: currentContext().societyId!,
          plate,
          reason: input.reason,
          reportedBy: currentContext().personId,
          ...(vehicle ? { vehicleId: vehicle.id } : {}),
          ...(input.slotId ? { slotId: input.slotId } : {}),
          ...(input.photoKey ? { photoKey: input.photoKey } : {}),
        })
        .returning();
      return { ...row!, registeredVehicle: Boolean(vehicle) };
    });
  }

  async openViolations() {
    return tx(async (db) =>
      db
        .select()
        .from(schema.parkingViolations)
        .where(isNull(schema.parkingViolations.resolvedAt))
        .orderBy(schema.parkingViolations.reportedAt),
    );
  }

  async resolveViolation(id: string) {
    return tx(async (db) => {
      const updated = await db
        .update(schema.parkingViolations)
        .set({ resolvedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.parkingViolations.id, id))
        .returning({ id: schema.parkingViolations.id });
      if (updated.length === 0) throw new NotFoundError("No such violation.");
      return { status: "resolved" as const };
    });
  }

  async summary() {
    return tx(async (db) => {
      const [slots] = await db
        .select({
          total: sql<number>`count(*)::int`,
          free: sql<number>`count(*) filter (where vehicle_id is null)::int`,
        })
        .from(schema.parkingSlots);
      const [violations] = await db
        .select({ open: sql<number>`count(*) filter (where resolved_at is null)::int` })
        .from(schema.parkingViolations);
      const [vehicles] = await db
        .select({ active: sql<number>`count(*) filter (where is_active)::int` })
        .from(schema.vehicles);

      return {
        slots: slots?.total ?? 0,
        freeSlots: slots?.free ?? 0,
        vehicles: vehicles?.active ?? 0,
        openViolations: violations?.open ?? 0,
      };
    });
  }
}
