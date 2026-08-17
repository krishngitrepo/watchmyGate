/**
 * Deliveries — gate to doorstep.
 *
 * The state machine is the point. A parcel that a guard marks "delivered" with nothing
 * behind it is an assertion, and the dispute it eventually causes ("I never got it") is
 * unresolvable. So the terminal transitions demand proof: who took it, when, and
 * optionally a photo. `handoverBy` records the guard, `handoverTo` the person who
 * actually received it — those are frequently different people, and conflating them is
 * what makes a log useless a week later.
 *
 * Transitions are validated against an explicit table rather than allowed freely.
 * Without that, a parcel can go from `returned` back to `at_gate` and the timeline stops
 * meaning anything.
 */

import { Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { schema } from "@watchmygate/db";

import { NotFoundError, ValidationError } from "../../common/errors.js";
import { currentContext, tx } from "../../common/tenant-context.js";

export type DeliveryStatus =
  | "at_gate"
  | "awaiting_resident"
  | "held_at_gate"
  | "out_for_doorstep"
  | "delivered"
  | "collected"
  | "returned"
  | "refused";

/**
 * What may follow what.
 *
 * `delivered` and `collected` are both terminal successes and differ in who moved: the
 * parcel went up, or the resident came down. A society's committee asks for that split
 * when it decides whether to staff doorstep delivery at all.
 */
const NEXT: Record<DeliveryStatus, DeliveryStatus[]> = {
  at_gate: ["awaiting_resident", "held_at_gate", "out_for_doorstep", "refused", "returned"],
  awaiting_resident: ["held_at_gate", "out_for_doorstep", "collected", "refused", "returned"],
  held_at_gate: ["out_for_doorstep", "collected", "returned", "refused"],
  out_for_doorstep: ["delivered", "held_at_gate", "returned"],
  delivered: [],
  collected: [],
  returned: [],
  refused: [],
};

/** Transitions that hand the parcel to a person, and therefore need proof. */
const NEEDS_PROOF: ReadonlySet<DeliveryStatus> = new Set(["delivered", "collected"]);

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return NEXT[from].includes(to);
}

export interface LogDeliveryInput {
  courier: string;
  unitId?: string | undefined;
  trackingRef?: string | undefined;
  parcelCount?: number | undefined;
  gateEventId?: string | undefined;
  note?: string | undefined;
}

export interface AdvanceInput {
  id: string;
  status: DeliveryStatus;
  handoverTo?: string | undefined;
  handoverPhotoKey?: string | undefined;
  note?: string | undefined;
}

@Injectable()
export class DeliveriesService {
  async log(input: LogDeliveryInput) {
    return tx(async (db) => {
      const [row] = await db
        .insert(schema.deliveries)
        .values({
          societyId: currentContext().societyId!,
          courier: input.courier,
          status: input.unitId ? "awaiting_resident" : "at_gate",
          parcelCount: input.parcelCount ?? 1,
          ...(input.unitId ? { unitId: input.unitId } : {}),
          ...(input.trackingRef ? { trackingRef: input.trackingRef } : {}),
          ...(input.gateEventId ? { gateEventId: input.gateEventId } : {}),
          ...(input.note ? { note: input.note } : {}),
        })
        .returning();
      return row!;
    });
  }

  async advance(input: AdvanceInput) {
    return tx(async (db) => {
      const [current] = await db
        .select()
        .from(schema.deliveries)
        .where(eq(schema.deliveries.id, input.id))
        .limit(1);
      if (!current) throw new NotFoundError("No such delivery.");

      const from = current.status as DeliveryStatus;
      if (!canTransition(from, input.status)) {
        throw new ValidationError(
          `A delivery cannot go from ${from.replace(/_/g, " ")} to ${input.status.replace(/_/g, " ")}.`,
        );
      }

      // The whole reason this table exists. Without a named recipient, "delivered" is
      // just a claim, and the resident who says it never arrived is unanswerable.
      if (NEEDS_PROOF.has(input.status) && !input.handoverTo) {
        throw new ValidationError(
          "Recording a handover needs the name of the person who received it.",
        );
      }

      const now = new Date();
      const [row] = await db
        .update(schema.deliveries)
        .set({
          status: input.status,
          ...(NEEDS_PROOF.has(input.status)
            ? {
                handoverAt: now,
                handoverBy: currentContext().personId,
                handoverTo: input.handoverTo!,
                ...(input.handoverPhotoKey ? { handoverPhotoKey: input.handoverPhotoKey } : {}),
              }
            : {}),
          ...(input.status === "held_at_gate" ? { heldAtGateAt: now } : {}),
          ...(input.note ? { note: input.note } : {}),
          updatedAt: now,
        })
        .where(eq(schema.deliveries.id, input.id))
        .returning();

      return row!;
    });
  }

  /** Everything still in play. The gate's working list. */
  async open(unitId?: string) {
    const OPEN: DeliveryStatus[] = [
      "at_gate",
      "awaiting_resident",
      "held_at_gate",
      "out_for_doorstep",
    ];
    return tx(async (db) =>
      db
        .select()
        .from(schema.deliveries)
        .where(
          and(
            inArray(schema.deliveries.status, OPEN),
            unitId ? eq(schema.deliveries.unitId, unitId) : undefined,
          ),
        )
        .orderBy(desc(schema.deliveries.arrivedAt)),
    );
  }

  async forUnit(unitId: string, limit = 50) {
    return tx(async (db) =>
      db
        .select()
        .from(schema.deliveries)
        .where(eq(schema.deliveries.unitId, unitId))
        .orderBy(desc(schema.deliveries.arrivedAt))
        .limit(Math.min(limit, 200)),
    );
  }

  /** Ageing, so a committee can see parcels nobody has collected. */
  async summary() {
    return tx(async (db) => {
      const [row] = await db
        .select({
          atGate: sql<number>`count(*) filter (where status = 'at_gate')::int`,
          awaiting: sql<number>`count(*) filter (where status = 'awaiting_resident')::int`,
          held: sql<number>`count(*) filter (where status = 'held_at_gate')::int`,
          outForDoorstep: sql<number>`count(*) filter (where status = 'out_for_doorstep')::int`,
          overOneDay: sql<number>`
            count(*) filter (
              where status in ('at_gate','awaiting_resident','held_at_gate')
                and arrived_at < now() - interval '1 day'
            )::int`,
        })
        .from(schema.deliveries);
      return row ?? { atGate: 0, awaiting: 0, held: 0, outForDoorstep: 0, overOneDay: 0 };
    });
  }
}
