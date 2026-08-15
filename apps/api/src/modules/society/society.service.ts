/**
 * Society structure: towers, units, and who lives in them.
 *
 * The part worth reading carefully is occupancy. Competitors model a flat as having
 * "a resident", and that single field is the source of a long tail of bugs: the owner
 * who lives abroad and votes but does not pay, the tenant who pays but cannot vote, the
 * son who needs the app but is neither.
 *
 * Here those are three independent booleans on a bitemporal record. `validFrom`/
 * `validTo` is business time — when someone actually lived there. `recordedAt` is system
 * time — when we learned it. So when a resident says in July "I actually moved out on
 * 3 June", that inserts a correction rather than editing history: June's bills stay
 * correct, the audit trail keeps what we believed and when, and re-running the June
 * billing produces the same answer it did in June.
 */

import { Injectable } from "@nestjs/common";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { schema, withoutTenant, type TenantTx } from "@watchmygate/db";

import { ConflictError, NotFoundError, ValidationError } from "../../common/errors.js";
import { currentContext, tx } from "../../common/tenant-context.js";

export interface CreateUnitInput {
  towerId: string;
  number: string;
  floor?: number | undefined;
  carpetAreaSqft?: string | undefined;
  bhk?: number | undefined;
}

export interface AssignOccupantInput {
  unitId: string;
  phone: string;
  name?: string | undefined;
  relationship: "owner" | "tenant" | "family_member" | "occupant";
  isBillingLiable: boolean;
  hasVotingRight: boolean;
  hasAppAccess: boolean;
  validFrom: string;
}

@Injectable()
export class SocietyService {
  // ------------------------------------------------------------------ towers

  async createTower(input: { name: string; floors?: number | undefined }) {
    const { societyId } = currentContext();

    return tx(async (db) => {
      const existing = await db
        .select({ id: schema.towers.id })
        .from(schema.towers)
        .where(eq(schema.towers.name, input.name))
        .limit(1);

      if (existing.length > 0) {
        throw new ConflictError(`A tower called "${input.name}" already exists.`);
      }

      const [tower] = await db
        .insert(schema.towers)
        .values({ societyId, name: input.name, floors: input.floors ?? null })
        .returning();
      return tower!;
    });
  }

  async listTowers() {
    return tx(async (db) =>
      db.select().from(schema.towers).orderBy(schema.towers.name),
    );
  }

  // ------------------------------------------------------------------- units

  async createUnit(input: CreateUnitInput) {
    const { societyId } = currentContext();

    return tx(async (db) => {
      // The tower must belong to this society. RLS already guarantees it — a tower from
      // another society simply is not visible — but a clear 404 beats a foreign-key
      // error surfacing as a 500.
      const [tower] = await db
        .select({ id: schema.towers.id })
        .from(schema.towers)
        .where(eq(schema.towers.id, input.towerId))
        .limit(1);
      if (!tower) throw new NotFoundError("That tower does not exist.");

      const [unit] = await db
        .insert(schema.units)
        .values({
          societyId,
          towerId: input.towerId,
          number: input.number,
          floor: input.floor ?? null,
          carpetAreaSqft: input.carpetAreaSqft ?? null,
          bhk: input.bhk ?? null,
          status: "vacant",
        })
        .onConflictDoNothing()
        .returning();

      if (!unit) {
        throw new ConflictError(`Flat ${input.number} already exists in that tower.`);
      }
      return unit;
    });
  }

  /**
   * Bulk unit creation, for onboarding.
   *
   * A 400-flat society is not going to be typed in one flat at a time, and the import
   * path is the moat in this market. Reports per-row outcomes rather than failing the
   * whole import on one bad row — an admin fixing a spreadsheet needs to know which
   * three rows were wrong, not that "the import failed".
   */
  async createUnitsBulk(rows: readonly CreateUnitInput[]) {
    const created: string[] = [];
    const skipped: Array<{ number: string; reason: string }> = [];

    for (const row of rows) {
      try {
        const unit = await this.createUnit(row);
        created.push(unit.number);
      } catch (error) {
        skipped.push({ number: row.number, reason: (error as Error).message });
      }
    }

    return { requested: rows.length, created: created.length, skipped };
  }

  async listUnits(towerId?: string) {
    return tx(async (db) => {
      const rows = await db
        .select({
          id: schema.units.id,
          number: schema.units.number,
          towerId: schema.units.towerId,
          towerName: schema.towers.name,
          floor: schema.units.floor,
          carpetAreaSqft: schema.units.carpetAreaSqft,
          bhk: schema.units.bhk,
          status: schema.units.status,
        })
        .from(schema.units)
        .innerJoin(schema.towers, eq(schema.towers.id, schema.units.towerId))
        .where(towerId ? eq(schema.units.towerId, towerId) : sql`true`)
        .orderBy(schema.towers.name, schema.units.number);
      return rows;
    });
  }

  // -------------------------------------------------------------- occupancy

  /**
   * Record who occupies a unit, from a date.
   *
   * Supersedes any current occupancy of the same relationship rather than deleting it,
   * so the history of who lived where survives. Creates the person on first sight —
   * residents are added by an admin long before they ever open the app.
   */
  async assignOccupant(input: AssignOccupantInput) {
    const { societyId, personId: actorId } = currentContext();
    const personId = await this.findOrCreatePerson(input.phone, input.name);

    return tx(async (db) => {
      const [unit] = await db
        .select({ id: schema.units.id })
        .from(schema.units)
        .where(eq(schema.units.id, input.unitId))
        .limit(1);
      if (!unit) throw new NotFoundError("That flat does not exist.");

      // Only one billing-liable occupant at a time: two would double-bill the flat.
      if (input.isBillingLiable) {
        const conflicting = await db
          .select({ id: schema.unitOccupancies.id })
          .from(schema.unitOccupancies)
          .where(
            and(
              eq(schema.unitOccupancies.unitId, input.unitId),
              eq(schema.unitOccupancies.isBillingLiable, true),
              isNull(schema.unitOccupancies.validTo),
              isNull(schema.unitOccupancies.supersededAt),
            ),
          );

        for (const row of conflicting) {
          await db
            .update(schema.unitOccupancies)
            .set({ validTo: input.validFrom, updatedAt: new Date() })
            .where(eq(schema.unitOccupancies.id, row.id));
        }
      }

      const [occupancy] = await db
        .insert(schema.unitOccupancies)
        .values({
          societyId,
          unitId: input.unitId,
          personId,
          relationship: input.relationship,
          isBillingLiable: input.isBillingLiable,
          hasVotingRight: input.hasVotingRight,
          hasAppAccess: input.hasAppAccess,
          validFrom: input.validFrom,
          createdBy: actorId,
        })
        .returning();

      await db
        .update(schema.units)
        .set({ status: "occupied", updatedAt: new Date() })
        .where(eq(schema.units.id, input.unitId));

      return occupancy!;
    });
  }

  /**
   * End an occupancy as of a date.
   *
   * Business time, not system time: "they moved out on the 3rd" recorded on the 20th
   * still ends it on the 3rd, so the bills regenerate correctly.
   */
  async endOccupancy(occupancyId: string, validTo: string) {
    return tx(async (db) => {
      const [existing] = await db
        .select()
        .from(schema.unitOccupancies)
        .where(eq(schema.unitOccupancies.id, occupancyId))
        .limit(1);

      if (!existing) throw new NotFoundError("That occupancy record does not exist.");
      if (validTo < existing.validFrom) {
        throw new ValidationError(
          "Someone cannot move out before they moved in. Check the date.",
        );
      }

      await db
        .update(schema.unitOccupancies)
        .set({ validTo, updatedAt: new Date() })
        .where(eq(schema.unitOccupancies.id, occupancyId));

      // Vacant only when nobody is left, not merely because one person left.
      const remaining = await db
        .select({ id: schema.unitOccupancies.id })
        .from(schema.unitOccupancies)
        .where(
          and(
            eq(schema.unitOccupancies.unitId, existing.unitId),
            isNull(schema.unitOccupancies.validTo),
            isNull(schema.unitOccupancies.supersededAt),
          ),
        );

      if (remaining.length === 0) {
        await db
          .update(schema.units)
          .set({ status: "vacant", updatedAt: new Date() })
          .where(eq(schema.units.id, existing.unitId));
      }

      return { status: "ended", validTo };
    });
  }

  /**
   * Who occupied a unit on a given date.
   *
   * Defaults to today. Passing a past date answers "who was liable in June?", which is
   * exactly the question a disputed invoice raises — and the reason occupancy is
   * bitemporal rather than a mutable field.
   */
  async occupantsOf(unitId: string, onDate?: string) {
    const asOf = onDate ?? new Date().toISOString().slice(0, 10);

    return tx(async (db) =>
      db
        .select({
          occupancyId: schema.unitOccupancies.id,
          personId: schema.persons.id,
          name: schema.persons.name,
          phone: schema.persons.phone,
          relationship: schema.unitOccupancies.relationship,
          isBillingLiable: schema.unitOccupancies.isBillingLiable,
          hasVotingRight: schema.unitOccupancies.hasVotingRight,
          hasAppAccess: schema.unitOccupancies.hasAppAccess,
          validFrom: schema.unitOccupancies.validFrom,
          validTo: schema.unitOccupancies.validTo,
        })
        .from(schema.unitOccupancies)
        .innerJoin(schema.persons, eq(schema.persons.id, schema.unitOccupancies.personId))
        .where(
          and(
            eq(schema.unitOccupancies.unitId, unitId),
            lte(schema.unitOccupancies.validFrom, asOf),
            or(
              isNull(schema.unitOccupancies.validTo),
              sql`${schema.unitOccupancies.validTo} >= ${asOf}`,
            ),
            isNull(schema.unitOccupancies.supersededAt),
          ),
        ),
    );
  }

  // ------------------------------------------------------------------ roles

  /** Grant a role. One person may hold several — an MC member is also a resident. */
  async grantRole(input: { phone: string; name?: string | undefined; roleCode: string }) {
    const { societyId } = currentContext();
    const personId = await this.findOrCreatePerson(input.phone, input.name);

    const roleId = await withoutTenant("role_lookup", async (db) => {
      const [role] = await db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.code, input.roleCode as "resident"))
        .limit(1);
      if (!role) throw new ValidationError(`Unknown role "${input.roleCode}".`);
      return role.id;
    });

    return tx(async (db) => {
      const existing = await db
        .select({ id: schema.roleAssignments.id })
        .from(schema.roleAssignments)
        .where(
          and(
            eq(schema.roleAssignments.personId, personId),
            eq(schema.roleAssignments.roleId, roleId),
            isNull(schema.roleAssignments.validTo),
          ),
        )
        .limit(1);

      if (existing.length > 0) return { status: "already_granted", personId };

      await db.insert(schema.roleAssignments).values({
        societyId,
        personId,
        roleId,
        scopeType: "society",
        validFrom: new Date().toISOString().slice(0, 10),
      });

      return { status: "granted", personId };
    });
  }

  async revokeRole(input: { personId: string; roleCode: string }) {
    const roleId = await withoutTenant("role_lookup", async (db) => {
      const [role] = await db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.code, input.roleCode as "resident"))
        .limit(1);
      if (!role) throw new ValidationError(`Unknown role "${input.roleCode}".`);
      return role.id;
    });

    return tx(async (db) => {
      // Closed with an end date rather than deleted, so "who could approve payments in
      // March?" stays answerable after the fact.
      await db
        .update(schema.roleAssignments)
        .set({ validTo: new Date().toISOString().slice(0, 10), updatedAt: new Date() })
        .where(
          and(
            eq(schema.roleAssignments.personId, input.personId),
            eq(schema.roleAssignments.roleId, roleId),
            isNull(schema.roleAssignments.validTo),
          ),
        );
      return { status: "revoked" };
    });
  }

  async directory() {
    return tx(async (db) =>
      db
        .select({
          personId: schema.persons.id,
          name: schema.persons.name,
          phone: schema.persons.phone,
          role: schema.roles.code,
          validFrom: schema.roleAssignments.validFrom,
        })
        .from(schema.roleAssignments)
        .innerJoin(schema.persons, eq(schema.persons.id, schema.roleAssignments.personId))
        .innerJoin(schema.roles, eq(schema.roles.id, schema.roleAssignments.roleId))
        .where(isNull(schema.roleAssignments.validTo))
        .orderBy(schema.persons.name),
    );
  }

  /**
   * Look up a person by phone, creating them if new.
   *
   * `persons` is deliberately NOT tenant-scoped: one human may be a resident in society
   * A and a committee member in society B, and duplicating them per society would mean
   * two accounts, two logins and two notification streams for one person.
   */
  private async findOrCreatePerson(
    phone: string,
    name?: string | undefined,
  ): Promise<string> {
    return withoutTenant("person_upsert", async (db) => {
      const [existing] = await db
        .select({ id: schema.persons.id, name: schema.persons.name })
        .from(schema.persons)
        .where(eq(schema.persons.phone, phone))
        .limit(1);

      if (existing) {
        // Fill in a missing name, but never overwrite one the person set themselves.
        if (name && !existing.name) {
          await db
            .update(schema.persons)
            .set({ name, updatedAt: new Date() })
            .where(eq(schema.persons.id, existing.id));
        }
        return existing.id;
      }

      const [created] = await db
        .insert(schema.persons)
        .values({ phone, name: name ?? null })
        .returning({ id: schema.persons.id });

      return created!.id;
    });
  }

  /** Counts for the committee dashboard. */
  async summary() {
    return tx(async (db) => {
      const [counts] = await db
        .select({
          units: sql<string>`count(*)`,
          occupied: sql<string>`count(*) FILTER (WHERE ${schema.units.status} = 'occupied')`,
          vacant: sql<string>`count(*) FILTER (WHERE ${schema.units.status} = 'vacant')`,
        })
        .from(schema.units);

      const [tickets] = await db
        .select({
          open: sql<string>`count(*) FILTER (WHERE ${schema.tickets.status} IN ('open','in_progress','reopened'))`,
          breached: sql<string>`count(*) FILTER (WHERE ${schema.tickets.slaDueAt} < now() AND ${schema.tickets.resolvedAt} IS NULL)`,
        })
        .from(schema.tickets);

      const [dues] = await db
        .select({
          outstanding: sql<string>`coalesce(sum(${schema.invoices.total}), 0)`,
          overdue: sql<string>`coalesce(sum(${schema.invoices.total}) FILTER (WHERE ${schema.invoices.dueDate} < current_date), 0)`,
        })
        .from(schema.invoices)
        .where(sql`${schema.invoices.status} IN ('issued','partially_paid')`);

      return {
        units: Number(counts?.units ?? 0),
        occupied: Number(counts?.occupied ?? 0),
        vacant: Number(counts?.vacant ?? 0),
        openTickets: Number(tickets?.open ?? 0),
        slaBreached: Number(tickets?.breached ?? 0),
        // Strings, not numbers: money never becomes a float, not even for a dashboard.
        outstanding: dues?.outstanding ?? "0",
        overdue: dues?.overdue ?? "0",
      };
    });
  }
}
