/**
 * SOS and amenity booking.
 *
 * Two unrelated features share a module because both are small and both are things a
 * resident does from their phone rather than things a committee administers.
 *
 * **SOS is the one endpoint where latency is the feature.** A resident pressing panic
 * needs the gate to know within seconds. So it writes and returns in a single statement
 * with no lookups, no enrichment and no fan-out on the request path — notification is a
 * worker's job. An SOS route that does five queries first is one that times out exactly
 * when it is needed.
 *
 * **Amenity booking's correctness lives in the database.** The overlap check is a
 * Postgres exclusion constraint, not an application `SELECT ... WHERE` — the latter
 * races under concurrency and eventually double-books the party hall for a wedding and a
 * birthday. The service's job is to turn that constraint violation into a sentence a
 * resident understands.
 */

import { Injectable } from "@nestjs/common";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";

import { schema } from "@watchmygate/db";

import { ConflictError, NotFoundError, ValidationError } from "../../common/errors.js";
import { currentContext, tx } from "../../common/tenant-context.js";

/**
 * Matches the `sos_type` enum exactly. There is deliberately no "other": a category a
 * responder cannot act on differently is not worth a migration, and `note` already
 * carries anything unusual.
 */
export type SosType = "medical" | "fire" | "gas" | "security";

export interface RaiseSosInput {
  type: SosType;
  unitId?: string | undefined;
  latitude?: string | undefined;
  longitude?: string | undefined;
  note?: string | undefined;
}

/** Postgres exclusion-constraint violation. */
const EXCLUSION_VIOLATION = "23P01";

@Injectable()
export class SafetyService {
  /**
   * Raise an alarm.
   *
   * Deliberately does nothing but insert. Every enrichment a reviewer might want here —
   * resolving the flat, looking up on-duty guards, formatting a push — is work done
   * after the row exists, by the worker. The resident's phone gets an acknowledgement in
   * one round trip.
   */
  async raise(input: RaiseSosInput) {
    return tx(async (db) => {
      const [row] = await db
        .insert(schema.sosAlerts)
        .values({
          societyId: currentContext().societyId!,
          personId: currentContext().personId!,
          type: input.type,
          raisedAt: new Date(),
          ...(input.unitId ? { unitId: input.unitId } : {}),
          ...(input.latitude ? { latitude: input.latitude } : {}),
          ...(input.longitude ? { longitude: input.longitude } : {}),
          ...(input.note ? { note: input.note } : {}),
        })
        .returning();
      return row!;
    });
  }

  /** Everything unresolved. The gate's alarm list. */
  async openAlerts() {
    return tx(async (db) =>
      db
        .select()
        .from(schema.sosAlerts)
        .where(isNull(schema.sosAlerts.closedAt))
        .orderBy(desc(schema.sosAlerts.raisedAt)),
    );
  }

  /**
   * Acknowledge.
   *
   * First responder wins; a second acknowledgement does not overwrite the first. Who
   * arrived first is the fact that matters afterwards, and letting a later guard
   * overwrite it would quietly rewrite the response record.
   */
  async acknowledge(id: string) {
    return tx(async (db) => {
      const updated = await db
        .update(schema.sosAlerts)
        .set({
          acknowledgedBy: currentContext().personId,
          acknowledgedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(schema.sosAlerts.id, id), isNull(schema.sosAlerts.acknowledgedAt)),
        )
        .returning();

      if (updated.length === 0) {
        const [existing] = await db
          .select({ acknowledgedAt: schema.sosAlerts.acknowledgedAt })
          .from(schema.sosAlerts)
          .where(eq(schema.sosAlerts.id, id))
          .limit(1);
        if (!existing) throw new NotFoundError("No such alert.");
        return { id, status: "already_acknowledged" as const };
      }
      return { id, status: "acknowledged" as const };
    });
  }

  async close(id: string, note?: string) {
    return tx(async (db) => {
      const updated = await db
        .update(schema.sosAlerts)
        .set({
          closedAt: new Date(),
          updatedAt: new Date(),
          ...(note ? { note } : {}),
        })
        .where(eq(schema.sosAlerts.id, id))
        .returning();
      if (updated.length === 0) throw new NotFoundError("No such alert.");
      return updated[0]!;
    });
  }

  // ------------------------------------------------------------- amenities

  async amenities() {
    return tx(async (db) =>
      db.select().from(schema.amenities).orderBy(schema.amenities.name),
    );
  }

  async createAmenity(input: {
    name: string;
    capacity?: number | undefined;
    slotMinutes?: number | undefined;
    isPaid?: boolean | undefined;
    rate?: string | undefined;
  }) {
    return tx(async (db) => {
      const [row] = await db
        .insert(schema.amenities)
        .values({
          societyId: currentContext().societyId!,
          name: input.name,
          slotMinutes: input.slotMinutes ?? 60,
          isPaid: input.isPaid ?? false,
          ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          ...(input.rate ? { rate: input.rate } : {}),
        })
        .returning();
      return row!;
    });
  }

  /**
   * Book a slot.
   *
   * The overlap check is the database's exclusion constraint. An application-level
   * "is it free?" followed by an insert races: two residents tapping at the same moment
   * both read free and both insert, and the party hall is double-booked for a wedding
   * and a birthday. The constraint cannot be raced; this catch only translates it.
   */
  async book(input: {
    amenityId: string;
    unitId: string;
    startsAt: string;
    endsAt: string;
  }) {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);

    if (endsAt <= startsAt) {
      throw new ValidationError("A booking has to end after it starts.");
    }
    if (startsAt < new Date()) {
      throw new ValidationError("That slot is in the past.");
    }

    return tx(async (db) => {
      try {
        const [row] = await db
          .insert(schema.amenityBookings)
          .values({
            societyId: currentContext().societyId!,
            amenityId: input.amenityId,
            unitId: input.unitId,
            bookedBy: currentContext().personId!,
            startsAt,
            endsAt,
          })
          .returning();
        return row!;
      } catch (error) {
        const code = (error as { code?: string } | undefined)?.code;
        if (code === EXCLUSION_VIOLATION) {
          throw new ConflictError(
            "Someone has already booked that slot. Please pick another time.",
          );
        }
        throw error;
      }
    });
  }

  async bookings(amenityId?: string, from?: string, to?: string) {
    return tx(async (db) =>
      db
        .select()
        .from(schema.amenityBookings)
        .where(
          and(
            amenityId ? eq(schema.amenityBookings.amenityId, amenityId) : undefined,
            from ? gte(schema.amenityBookings.startsAt, new Date(from)) : undefined,
            to ? lte(schema.amenityBookings.startsAt, new Date(to)) : undefined,
          ),
        )
        .orderBy(schema.amenityBookings.startsAt),
    );
  }

  /**
   * Cancel.
   *
   * Sets status rather than deleting, because the exclusion constraint only applies
   * `WHERE status = 'confirmed'` — so a cancelled row frees the slot while the fact that
   * it was booked and cancelled stays in the record. A committee arguing about who keeps
   * cancelling the clubhouse needs that history.
   */
  async cancel(id: string) {
    return tx(async (db) => {
      const updated = await db
        .update(schema.amenityBookings)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(schema.amenityBookings.id, id))
        .returning();
      if (updated.length === 0) throw new NotFoundError("No such booking.");
      return updated[0]!;
    });
  }

  async safetySummary() {
    return tx(async (db) => {
      const [sos] = await db
        .select({
          open: sql<number>`count(*) filter (where closed_at is null)::int`,
          unacknowledged: sql<number>`
            count(*) filter (where closed_at is null and acknowledged_at is null)::int`,
        })
        .from(schema.sosAlerts);
      const [bookings] = await db
        .select({
          upcoming: sql<number>`
            count(*) filter (where status = 'confirmed' and starts_at > now())::int`,
        })
        .from(schema.amenityBookings);

      return {
        openAlerts: sos?.open ?? 0,
        unacknowledgedAlerts: sos?.unacknowledged ?? 0,
        upcomingBookings: bookings?.upcoming ?? 0,
      };
    });
  }
}
