/**
 * Staff: maids, cooks, drivers, gardeners, vendor workers — and their attendance.
 *
 * Two things here are not ordinary CRUD, and both exist because the people in this table
 * have the least power of anyone the product touches.
 *
 * **Attendance is a wage record.** It decides what someone is paid, so it cannot be
 * deleted (the database refuses) and an after-the-fact edit is stored as an *override*
 * carrying who changed it and why. An edit that looked identical to a real scan would
 * make a wage dispute unarguable in the employer's favour.
 *
 * **Identification never requires a fingerprint.** `attendance_method` includes biometric
 * because some societies already own the hardware, but a PIN and a card path are always
 * available and `checkIn` accepts any of them. A domestic worker cannot meaningfully
 * refuse an employer's demand for a biometric, which is what makes "opt-in" meaningless
 * unless a real alternative exists in the code.
 *
 * The PIN is stored as an argon2 hash, never in the clear. It is a low-entropy secret
 * that gates a person's pay record, and guards can see the staff list.
 */

import { Injectable } from "@nestjs/common";
import argon2 from "argon2";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";

import { schema } from "@watchmygate/db";

import { ConflictError, NotFoundError, ValidationError } from "../../common/errors.js";
import { currentContext, tx } from "../../common/tenant-context.js";

export interface CreateStaffInput {
  fullName: string;
  phone: string;
  kind: "maid" | "cook" | "nanny" | "driver" | "gardener" | "security" | "vendor_staff" | "other";
  employerUnitId?: string | undefined;
  vendorName?: string | undefined;
  dailyStart?: string | undefined;
  dailyEnd?: string | undefined;
  notes?: string | undefined;
  unitIds?: string[] | undefined;
}

export interface CheckInInput {
  staffId: string;
  method: "gate_scan" | "pin" | "card" | "manual" | "biometric";
  pin?: string | undefined;
  gateId?: string | undefined;
}

export interface OverrideInput {
  attendanceId: string;
  checkedInAt?: string | undefined;
  checkedOutAt?: string | undefined;
  note: string;
}

/** Local calendar date for attendance. Societies operate in one timezone. */
function workDateOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

@Injectable()
export class StaffService {
  async list(status?: string, unitId?: string) {
    return tx(async (db) => {
      const rows = await db
        .select()
        .from(schema.staff)
        .where(
          and(
            status
              ? eq(schema.staff.status, status as "pending" | "active" | "suspended" | "exited")
              : undefined,
            unitId ? eq(schema.staff.employerUnitId, unitId) : undefined,
          ),
        )
        .orderBy(schema.staff.fullName);

      // The PIN hash must never leave the service, even to an admin console.
      return rows.map(({ gatePinHash: _hash, ...rest }) => rest);
    });
  }

  async create(input: CreateStaffInput) {
    return tx(async (db) => {
      const [existing] = await db
        .select({ id: schema.staff.id })
        .from(schema.staff)
        .where(eq(schema.staff.phone, input.phone))
        .limit(1);
      if (existing) {
        throw new ConflictError("Someone with that number is already on the staff register.");
      }

      const [row] = await db
        .insert(schema.staff)
        .values({
          societyId: currentContext().societyId!,
          fullName: input.fullName,
          phone: input.phone,
          kind: input.kind,
          status: "pending",
          ...(input.employerUnitId ? { employerUnitId: input.employerUnitId } : {}),
          ...(input.vendorName ? { vendorName: input.vendorName } : {}),
          ...(input.dailyStart ? { dailyStart: input.dailyStart } : {}),
          ...(input.dailyEnd ? { dailyEnd: input.dailyEnd } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        })
        .returning();

      const staffRow = row!;

      // A maid working six flats is the normal case; assignments carry that.
      for (const unitId of input.unitIds ?? []) {
        await db.insert(schema.staffAssignments).values({
          societyId: currentContext().societyId!,
          staffId: staffRow.id,
          unitId,
        });
      }

      const { gatePinHash: _hash, ...safe } = staffRow;
      return safe;
    });
  }

  /**
   * Set the gate PIN — the always-available alternative to a biometric.
   *
   * Returned to the caller once and never again, because only the hash is stored. An
   * admin who loses it issues a new one rather than reading the old one back.
   */
  async setPin(staffId: string, pin: string) {
    if (!/^\d{4,8}$/.test(pin)) {
      throw new ValidationError("A gate PIN is 4 to 8 digits.");
    }
    return tx(async (db) => {
      const updated = await db
        .update(schema.staff)
        .set({ gatePinHash: await argon2.hash(pin), updatedAt: new Date() })
        .where(eq(schema.staff.id, staffId))
        .returning({ id: schema.staff.id });
      if (updated.length === 0) throw new NotFoundError("No such staff member.");
      return { status: "set" as const };
    });
  }

  async setStatus(staffId: string, status: "pending" | "active" | "suspended" | "exited") {
    return tx(async (db) => {
      const updated = await db
        .update(schema.staff)
        .set({ status, updatedAt: new Date() })
        .where(eq(schema.staff.id, staffId))
        .returning({ id: schema.staff.id, status: schema.staff.status });
      if (updated.length === 0) throw new NotFoundError("No such staff member.");
      return updated[0]!;
    });
  }

  /**
   * Record a verification outcome.
   *
   * Takes a status and at most a masked last-4 — there is deliberately no parameter for
   * a document number, and the table has nowhere to put one. Aadhaar Act §57 was struck
   * down, so a private entity cannot mandate Aadhaar authentication; DigiLocker returns
   * a yes/no and that is all that is kept.
   */
  async recordVerification(
    staffId: string,
    input: {
      status: "submitted" | "verified" | "rejected" | "expired";
      reference?: string | undefined;
      idLast4?: string | undefined;
      policeVerified?: boolean | undefined;
    },
  ) {
    if (input.idLast4 !== undefined && !/^\d{4}$/.test(input.idLast4)) {
      throw new ValidationError("Only the last four digits may be stored, and they must be digits.");
    }
    return tx(async (db) => {
      const updated = await db
        .update(schema.staff)
        .set({
          verification: input.status,
          ...(input.reference ? { verificationRef: input.reference } : {}),
          ...(input.idLast4 ? { idLast4: input.idLast4 } : {}),
          ...(input.status === "verified" ? { verifiedAt: new Date() } : {}),
          ...(input.policeVerified ? { policeVerifiedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.staff.id, staffId))
        .returning({ id: schema.staff.id, verification: schema.staff.verification });
      if (updated.length === 0) throw new NotFoundError("No such staff member.");
      return updated[0]!;
    });
  }

  /**
   * Check in at the gate.
   *
   * The timestamp is server-assigned. A gate handset's clock is routinely hours out, and
   * payroll computed from a wrong clock is a wage dispute nobody can settle.
   *
   * Idempotent for the day: scanning twice does not open a second shift. The partial
   * unique index on (staff_id, work_date) where checked_out_at IS NULL is the real
   * guard — this check just turns a database error into a sensible answer.
   */
  async checkIn(input: CheckInInput) {
    return tx(async (db) => {
      const [member] = await db
        .select()
        .from(schema.staff)
        .where(eq(schema.staff.id, input.staffId))
        .limit(1);
      if (!member) throw new NotFoundError("No such staff member.");
      if (member.status !== "active") {
        throw new ValidationError(`${member.fullName} is not an active staff member.`);
      }

      if (input.method === "pin") {
        if (!member.gatePinHash) {
          throw new ValidationError("No gate PIN has been set for this staff member.");
        }
        if (!input.pin || !(await argon2.verify(member.gatePinHash, input.pin))) {
          throw new ValidationError("That PIN did not match.");
        }
      }

      const now = new Date();
      const workDate = workDateOf(now);

      const [open] = await db
        .select({ id: schema.staffAttendance.id })
        .from(schema.staffAttendance)
        .where(
          and(
            eq(schema.staffAttendance.staffId, input.staffId),
            eq(schema.staffAttendance.workDate, workDate),
            isNull(schema.staffAttendance.checkedOutAt),
          ),
        )
        .limit(1);
      if (open) return { id: open.id, status: "already_in" as const };

      const [row] = await db
        .insert(schema.staffAttendance)
        .values({
          societyId: currentContext().societyId!,
          staffId: input.staffId,
          workDate,
          checkedInAt: now,
          method: input.method,
          ...(input.gateId ? { gateId: input.gateId } : {}),
        })
        .returning({ id: schema.staffAttendance.id });

      return { id: row!.id, status: "checked_in" as const, at: now.toISOString() };
    });
  }

  async checkOut(staffId: string) {
    return tx(async (db) => {
      const now = new Date();
      const updated = await db
        .update(schema.staffAttendance)
        .set({ checkedOutAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.staffAttendance.staffId, staffId),
            isNull(schema.staffAttendance.checkedOutAt),
          ),
        )
        .returning({ id: schema.staffAttendance.id });

      if (updated.length === 0) {
        throw new ValidationError("That staff member is not currently checked in.");
      }
      return { id: updated[0]!.id, status: "checked_out" as const, at: now.toISOString() };
    });
  }

  /**
   * Correct an attendance row.
   *
   * Never a silent edit: `overriddenBy` and a mandatory note are written alongside, so a
   * timesheet always shows which rows a human changed. The row can never be deleted —
   * the database refuses — so the original scan time stays visible in the audit log.
   */
  async override(input: OverrideInput) {
    if (input.note.trim().length < 3) {
      throw new ValidationError("An override needs a reason.");
    }
    return tx(async (db) => {
      const patch: Record<string, unknown> = {
        overriddenBy: currentContext().personId,
        overrideNote: input.note.trim(),
        updatedAt: new Date(),
      };
      if (input.checkedInAt) patch["checkedInAt"] = new Date(input.checkedInAt);
      if (input.checkedOutAt) patch["checkedOutAt"] = new Date(input.checkedOutAt);

      const updated = await db
        .update(schema.staffAttendance)
        .set(patch)
        .where(eq(schema.staffAttendance.id, input.attendanceId))
        .returning({ id: schema.staffAttendance.id });
      if (updated.length === 0) throw new NotFoundError("No such attendance record.");
      return updated[0]!;
    });
  }

  /** Who is inside right now — the question a guard actually asks. */
  async present() {
    return tx(async (db) =>
      db
        .select({
          attendanceId: schema.staffAttendance.id,
          staffId: schema.staff.id,
          fullName: schema.staff.fullName,
          kind: schema.staff.kind,
          checkedInAt: schema.staffAttendance.checkedInAt,
          method: schema.staffAttendance.method,
        })
        .from(schema.staffAttendance)
        .innerJoin(schema.staff, eq(schema.staff.id, schema.staffAttendance.staffId))
        .where(isNull(schema.staffAttendance.checkedOutAt))
        .orderBy(desc(schema.staffAttendance.checkedInAt)),
    );
  }

  /**
   * Payroll-ready timesheet for a month.
   *
   * Minutes are computed in SQL from the stored timestamps rather than in JS, so the
   * number on a payslip comes from the same source as the audit trail. `overrides`
   * is surfaced per row because an accountant approving a timesheet should see which
   * days were edited by a person before signing it off.
   */
  async timesheet(month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new ValidationError("Month must be YYYY-MM.");
    }
    const from = `${month}-01`;
    const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
      .toISOString()
      .slice(0, 10);

    return tx(async (db) =>
      db
        .select({
          staffId: schema.staff.id,
          fullName: schema.staff.fullName,
          kind: schema.staff.kind,
          daysPresent: sql<number>`count(*)::int`,
          minutesWorked: sql<number>`
            coalesce(sum(
              extract(epoch from (
                coalesce(${schema.staffAttendance.checkedOutAt}, ${schema.staffAttendance.checkedInAt})
                - ${schema.staffAttendance.checkedInAt}
              )) / 60
            ), 0)::int`,
          openShifts: sql<number>`
            count(*) filter (where ${schema.staffAttendance.checkedOutAt} is null)::int`,
          overrides: sql<number>`
            count(*) filter (where ${schema.staffAttendance.overriddenBy} is not null)::int`,
        })
        .from(schema.staffAttendance)
        .innerJoin(schema.staff, eq(schema.staff.id, schema.staffAttendance.staffId))
        .where(
          and(
            gte(schema.staffAttendance.workDate, from),
            lte(schema.staffAttendance.workDate, to),
          ),
        )
        .groupBy(schema.staff.id, schema.staff.fullName, schema.staff.kind)
        .orderBy(schema.staff.fullName),
    );
  }
}
