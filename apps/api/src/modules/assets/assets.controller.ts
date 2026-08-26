/**
 * The asset and inventory register (MG-7).
 *
 * On every RFP, and for a reason that is not really about inventory. What a committee
 * loses when the register lives in one facility manager's head is not the list — it is
 * knowing which lift is under AMC and until when on the morning it stops between floors,
 * that the DG service was due in March, and what the outgoing committee handed over.
 *
 * ## Who sees what
 *
 * The register is committee and staff work: an admin, an MC member or a member of staff
 * can read it, and staff can record that they did a job because they are the people who
 * did it. Costs and the fixed-asset schedule are narrower — an auditor reads them, and a
 * guard has no business knowing what the society paid for the generator.
 *
 * ## Depreciation
 *
 * Computed here, never stored. A stored written-down value drifts the moment somebody
 * edits a cost or a life, and then the register and the auditor's schedule disagree with
 * no way to tell which one moved. It is also labelled as management information, because
 * a co-operative society's auditor may use the written-down-value method instead and a
 * figure of ours presented as theirs is worse than no figure at all.
 */

import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { ConflictError, ForbiddenError, NotFoundError } from "../../common/errors.js";
import { AuditService } from "../../common/audit.service.js";
import { currentContext, hasRole, isStaff, tx } from "../../common/tenant-context.js";

/**
 * What a society actually owns, as a fixed list.
 *
 * Free text here means one committee files under "Lift" and the next under "lifts", and
 * a register nobody can group by category is a register nobody exports.
 */
export const ASSET_CATEGORIES = [
  "lift",
  "dg_set",
  "pump",
  "water_treatment",
  "sewage_treatment",
  "fire_safety",
  "cctv",
  "access_control",
  "solar",
  "electrical",
  "plumbing",
  "hvac",
  "gym_equipment",
  "playground",
  "furniture",
  "landscaping",
  "vehicle",
  "other",
] as const;

export const MAINTENANCE_KINDS = [
  "service",
  "inspection",
  "amc_visit",
  "statutory",
  "repair",
] as const;

const assetSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(160),
  category: z.enum(ASSET_CATEGORIES),
  towerId: z.string().uuid().optional(),
  location: z.string().max(200).optional(),
  makeModel: z.string().max(160).optional(),
  serialNumber: z.string().max(120).optional(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  purchaseCost: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  supplier: z.string().max(160).optional(),
  invoiceRef: z.string().max(120).optional(),
  warrantyUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expectedLifeYears: z.number().int().min(1).max(60).optional(),
  amcVendor: z.string().max(160).optional(),
  amcUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amcDocumentId: z.string().uuid().optional(),
  condition: z.enum(["good", "fair", "poor", "out_of_service"]).default("good"),
  notes: z.string().max(2000).optional(),
});

const workSchema = z.object({
  kind: z.enum(MAINTENANCE_KINDS).default("service"),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  intervalMonths: z.number().int().min(1).max(120).optional(),
  vendor: z.string().max(160).optional(),
  notes: z.string().max(2000).optional(),
});

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) ?? [];
}

@Controller("v1/assets")
export class AssetsController {
  constructor(private readonly audit: AuditService) {}

  /**
   * The register.
   *
   * Money columns are blanked for anyone who may not see them rather than the row being
   * withheld: a technician needs to find the pump they are servicing, and does not need
   * to know the society paid four lakh for it.
   */
  @Get()
  async list(
    @Query("category") category?: string,
    @Query("status") status?: string,
    @Query("expiringAmc") expiringAmc?: string,
  ) {
    this.requireRead();
    const seesCost = this.maySeeCost();

    return tx(async (db) =>
      rowsOf(
        await db.execute(sql`
          SELECT
            a.id, a.code, a.name, a.category,
            a.tower_id            AS "towerId",
            t.name                AS "towerName",
            a.location,
            a.make_model          AS "makeModel",
            a.serial_number       AS "serialNumber",
            a.purchase_date::text AS "purchaseDate",
            CASE WHEN ${seesCost} THEN a.purchase_cost::text END AS "purchaseCost",
            CASE WHEN ${seesCost} THEN a.supplier END            AS supplier,
            a.warranty_until::text AS "warrantyUntil",
            a.expected_life_years  AS "expectedLifeYears",
            a.amc_vendor           AS "amcVendor",
            a.amc_until::text      AS "amcUntil",
            a.amc_document_id      AS "amcDocumentId",
            a.condition, a.status,
            a.disposed_on::text    AS "disposedOn",
            a.notes,
            -- Answered here so "expiring" means the same thing in the list, the filter
            -- and the count at the top of the page.
            CASE WHEN a.amc_until IS NULL THEN NULL
                 ELSE (a.amc_until - current_date)
            END::int               AS "amcDaysLeft",
            (
              SELECT min(m.due_on)::text FROM asset_maintenance m
              WHERE m.asset_id = a.id AND m.completed_on IS NULL
            )                      AS "nextDue",
            (
              SELECT max(m.completed_on)::text FROM asset_maintenance m
              WHERE m.asset_id = a.id AND m.completed_on IS NOT NULL
            )                      AS "lastServiced",
            EXISTS (
              SELECT 1 FROM asset_maintenance m
              WHERE m.asset_id = a.id AND m.completed_on IS NULL AND m.due_on < current_date
            )                      AS "overdue"
          FROM assets a
          LEFT JOIN towers t ON t.id = a.tower_id
          WHERE (${category ?? null}::text IS NULL OR a.category = ${category ?? null})
            AND (${status ?? null}::text IS NULL OR a.status = ${status ?? null})
            AND (
              ${expiringAmc === "true"} = false
              OR (a.amc_until IS NOT NULL AND a.amc_until <= current_date + 60)
            )
          ORDER BY a.category, a.code
        `),
      ),
    );
  }

  @Get("categories")
  async categories() {
    return {
      assets: ASSET_CATEGORIES.map((code) => ({ code, label: code.replace(/_/g, " ") })),
      maintenance: MAINTENANCE_KINDS.map((code) => ({ code, label: code.replace(/_/g, " ") })),
    };
  }

  /**
   * What is due, overdue, or lapsing.
   *
   * The one query the facility page runs on load. AMC expiry sits alongside maintenance
   * because from a committee's point of view they are the same problem: something is
   * about to stop being covered.
   */
  @Get("due")
  async due(@Query("withinDays") withinDays?: string) {
    this.requireRead();
    const horizon = Math.min(Math.max(Number(withinDays ?? 45) || 45, 1), 365);

    return tx(async (db) => {
      const work = rowsOf(
        await db.execute(sql`
          SELECT
            m.id, m.kind, m.due_on::text AS "dueOn", m.interval_months AS "intervalMonths",
            m.vendor, m.notes,
            (m.due_on - current_date)::int AS "daysLeft",
            m.due_on < current_date        AS overdue,
            a.id AS "assetId", a.code AS "assetCode", a.name AS "assetName",
            a.category, a.location
          FROM asset_maintenance m
          JOIN assets a ON a.id = m.asset_id
          WHERE m.completed_on IS NULL
            AND a.status <> 'disposed'
            AND m.due_on <= current_date + ${horizon}::int
          ORDER BY m.due_on
        `),
      );

      const amc = rowsOf(
        await db.execute(sql`
          SELECT id, code, name, category, amc_vendor AS "amcVendor",
                 amc_until::text AS "amcUntil",
                 (amc_until - current_date)::int AS "daysLeft"
          FROM assets
          WHERE amc_until IS NOT NULL
            AND status <> 'disposed'
            AND amc_until <= current_date + ${horizon}::int
          ORDER BY amc_until
        `),
      );

      return { withinDays: horizon, work, amcExpiring: amc };
    });
  }

  /**
   * The fixed-asset schedule an auditor asks for, by category.
   *
   * **Straight-line, and labelled as management information.** A co-operative society's
   * auditor may use the written-down-value method, and presenting our arithmetic as if it
   * were theirs would be worse than presenting none. Assets with no expected life are
   * carried at cost with nothing depreciated, and counted separately so the omission is
   * visible rather than silently rolled into the total.
   */
  @Get("schedule")
  async schedule(@Query("asOf") asOf?: string) {
    if (!this.maySeeCost()) {
      throw new ForbiddenError("The fixed-asset schedule is committee and auditor work.");
    }
    const on = /^\d{4}-\d{2}-\d{2}$/.test(asOf ?? "")
      ? asOf!
      : new Date().toISOString().slice(0, 10);

    return tx(async (db) => {
      const rows = rowsOf(
        await db.execute(sql`
          WITH computed AS (
            SELECT
              a.id, a.code, a.name, a.category,
              a.purchase_date, a.purchase_cost, a.expected_life_years, a.status,
              CASE
                WHEN a.expected_life_years IS NULL OR a.purchase_date IS NULL THEN NULL
                ELSE LEAST(
                  a.purchase_cost,
                  -- Straight line, prorated by whole days held. Capped at cost so a
                  -- twenty-year-old pump does not depreciate into a negative asset.
                  ROUND(
                    a.purchase_cost
                      * (${on}::date - a.purchase_date)
                      / (a.expected_life_years * 365.25),
                    2
                  )
                )
              END AS accumulated
            FROM assets a
            WHERE a.status <> 'disposed' OR a.disposed_on > ${on}::date
          )
          SELECT
            id, code, name, category,
            purchase_date::text                     AS "purchaseDate",
            purchase_cost::text                     AS "purchaseCost",
            expected_life_years                     AS "expectedLifeYears",
            COALESCE(accumulated, 0)::text          AS "accumulatedDepreciation",
            (purchase_cost - COALESCE(accumulated, 0))::text AS "writtenDownValue",
            accumulated IS NULL                     AS "notDepreciated"
          FROM computed
          ORDER BY category, code
        `),
      ) as Array<{
        category: string;
        purchaseCost: string;
        accumulatedDepreciation: string;
        writtenDownValue: string;
        notDepreciated: boolean;
      }>;

      const byCategory = new Map<
        string,
        { category: string; count: number; cost: bigint; depreciation: bigint; wdv: bigint }
      >();
      for (const row of rows) {
        const bucket = byCategory.get(row.category) ?? {
          category: row.category,
          count: 0,
          cost: 0n,
          depreciation: 0n,
          wdv: 0n,
        };
        bucket.count += 1;
        bucket.cost += toPaise(row.purchaseCost);
        bucket.depreciation += toPaise(row.accumulatedDepreciation);
        bucket.wdv += toPaise(row.writtenDownValue);
        byCategory.set(row.category, bucket);
      }

      const total = rows.reduce(
        (acc, row) => ({
          cost: acc.cost + toPaise(row.purchaseCost),
          depreciation: acc.depreciation + toPaise(row.accumulatedDepreciation),
          wdv: acc.wdv + toPaise(row.writtenDownValue),
        }),
        { cost: 0n, depreciation: 0n, wdv: 0n },
      );

      return {
        asOf: on,
        method: "straight_line",
        // Said out loud on the payload, not only in a comment, because this figure will
        // be read next to an auditor's and somebody has to say they may differ.
        basis:
          "Straight-line over the expected life recorded against each asset, prorated by " +
          "days held. Management information — your auditor's schedule may use the " +
          "written-down-value method and differ.",
        assets: rows,
        byCategory: [...byCategory.values()].map((b) => ({
          category: b.category,
          count: b.count,
          cost: fromPaise(b.cost),
          accumulatedDepreciation: fromPaise(b.depreciation),
          writtenDownValue: fromPaise(b.wdv),
        })),
        totals: {
          cost: fromPaise(total.cost),
          accumulatedDepreciation: fromPaise(total.depreciation),
          writtenDownValue: fromPaise(total.wdv),
        },
        notDepreciated: rows.filter((r) => r.notDepreciated).length,
      };
    });
  }

  @Post()
  async create(@Body() body: unknown) {
    this.requireManage();
    const input = assetSchema.parse(body);
    const { societyId, personId } = currentContext();

    return tx(async (db) => {
      const clash = rowsOf<{ id: string }>(
        await db.execute(sql`SELECT id FROM assets WHERE code = ${input.code}`),
      );
      if (clash.length > 0) {
        throw new ConflictError(
          `Something is already tagged ${input.code}. Two assets with the same tag is the ` +
            "confusion this register exists to prevent.",
        );
      }

      const created = rowsOf<{ id: string }>(
        await db.execute(sql`
          INSERT INTO assets (
            society_id, code, name, category, tower_id, location, make_model,
            serial_number, purchase_date, purchase_cost, supplier, invoice_ref,
            warranty_until, expected_life_years, amc_vendor, amc_until, amc_document_id,
            condition, notes, recorded_by
          ) VALUES (
            ${societyId}, ${input.code}, ${input.name}, ${input.category},
            ${input.towerId ?? null}, ${input.location ?? null}, ${input.makeModel ?? null},
            ${input.serialNumber ?? null}, ${input.purchaseDate ?? null},
            ${input.purchaseCost ?? "0"}, ${input.supplier ?? null},
            ${input.invoiceRef ?? null}, ${input.warrantyUntil ?? null},
            ${input.expectedLifeYears ?? null}, ${input.amcVendor ?? null},
            ${input.amcUntil ?? null}, ${input.amcDocumentId ?? null},
            ${input.condition}, ${input.notes ?? null}, ${personId}
          )
          RETURNING id
        `),
      );
      return { id: created[0]!.id };
    });
  }

  /**
   * Correct the register.
   *
   * Editable on purpose, unlike the maintenance log: a facility manager fixing a serial
   * number they mistyped must not be pushed back to a spreadsheet. What must never be
   * editable is the record that a job was done.
   */
  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: unknown) {
    this.requireManage();
    const input = assetSchema.partial().parse(body);
    await this.mustExist(id);

    return tx(async (db) => {
      await db.execute(sql`
        UPDATE assets SET
          name            = COALESCE(${input.name ?? null}, name),
          category        = COALESCE(${input.category ?? null}, category),
          location        = COALESCE(${input.location ?? null}, location),
          make_model      = COALESCE(${input.makeModel ?? null}, make_model),
          serial_number   = COALESCE(${input.serialNumber ?? null}, serial_number),
          purchase_date   = COALESCE(${input.purchaseDate ?? null}::date, purchase_date),
          purchase_cost   = COALESCE(${input.purchaseCost ?? null}::numeric, purchase_cost),
          supplier        = COALESCE(${input.supplier ?? null}, supplier),
          warranty_until  = COALESCE(${input.warrantyUntil ?? null}::date, warranty_until),
          expected_life_years =
            COALESCE(${input.expectedLifeYears ?? null}::int, expected_life_years),
          amc_vendor      = COALESCE(${input.amcVendor ?? null}, amc_vendor),
          amc_until       = COALESCE(${input.amcUntil ?? null}::date, amc_until),
          amc_document_id = COALESCE(${input.amcDocumentId ?? null}::uuid, amc_document_id),
          condition       = COALESCE(${input.condition ?? null}, condition),
          notes           = COALESCE(${input.notes ?? null}, notes),
          updated_at      = now()
        WHERE id = ${id}
      `);
      return { status: "updated" };
    });
  }

  /**
   * Retire an asset.
   *
   * Never deleted. What the society used to own, and what happened to it, is exactly the
   * question a handover argument turns on — and a row that vanishes takes its maintenance
   * history with it.
   */
  @Post(":id/dispose")
  async dispose(@Param("id") id: string, @Body() body: unknown) {
    if (!hasRole("society_admin", "mc_member")) {
      throw new ForbiddenError("Only the committee can retire an asset.");
    }
    const input = z
      .object({
        disposedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().min(4).max(2000),
      })
      .parse(body);
    await this.mustExist(id);

    return tx(async (db) => {
      await db.execute(sql`
        UPDATE assets
        SET status = 'disposed', disposed_on = ${input.disposedOn},
            disposal_note = ${input.note}, updated_at = now()
        WHERE id = ${id}
      `);
      // Work outstanding on something that no longer exists is noise on every list it
      // appears in, so it goes with the asset rather than nagging forever.
      await db.execute(sql`
        DELETE FROM asset_maintenance WHERE asset_id = ${id} AND completed_on IS NULL
      `);

      // What the society used to own, and on whose word it stopped owning it.
      await this.audit.record(db, {
        action: "asset.disposed",
        entityType: "asset",
        entityId: id,
        after: { disposedOn: input.disposedOn },
        reason: input.note,
      });

      return { status: "disposed" };
    });
  }

  @Post(":id/work")
  async scheduleWork(@Param("id") id: string, @Body() body: unknown) {
    this.requireManage();
    const input = workSchema.parse(body);
    const { societyId, personId } = currentContext();
    await this.mustExist(id);

    return tx(async (db) => {
      const created = rowsOf<{ id: string }>(
        await db.execute(sql`
          INSERT INTO asset_maintenance (
            society_id, asset_id, kind, due_on, interval_months, vendor, notes, recorded_by
          ) VALUES (
            ${societyId}, ${id}, ${input.kind}, ${input.dueOn},
            ${input.intervalMonths ?? null}, ${input.vendor ?? null},
            ${input.notes ?? null}, ${personId}
          )
          RETURNING id
        `),
      );
      return { id: created[0]!.id };
    });
  }

  /**
   * Record that a job was done.
   *
   * Staff can do this, because staff are who did it. The entry is final once written —
   * a maintenance log whose entries can be edited afterwards proves nothing on the day a
   * lift injures somebody and the question is whether it was serviced.
   *
   * A recurring job schedules its own successor here rather than needing anyone to
   * remember, which is the whole point of recording an interval.
   */
  @Post("work/:workId/complete")
  async completeWork(@Param("workId") workId: string, @Body() body: unknown) {
    if (!hasRole("society_admin", "mc_member") && !isStaff()) {
      throw new ForbiddenError("Only the committee or staff can close a maintenance job.");
    }
    const input = z
      .object({
        completedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        vendor: z.string().max(160).optional(),
        cost: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
        notes: z.string().max(2000).optional(),
      })
      .parse(body);
    const { societyId, personId } = currentContext();

    return tx(async (db) => {
      const found = rowsOf<{
        id: string;
        assetId: string;
        kind: string;
        dueOn: string;
        intervalMonths: number | null;
        completedOn: string | null;
        vendor: string | null;
      }>(
        await db.execute(sql`
          SELECT id, asset_id AS "assetId", kind, due_on::text AS "dueOn",
                 interval_months AS "intervalMonths", completed_on::text AS "completedOn",
                 vendor
          FROM asset_maintenance WHERE id = ${workId}
        `),
      );
      if (found.length === 0) throw new NotFoundError("That maintenance job does not exist.");
      const work = found[0]!;
      if (work.completedOn) {
        throw new ConflictError("That job is already recorded as done.");
      }

      await db.execute(sql`
        UPDATE asset_maintenance
        SET completed_on = ${input.completedOn},
            vendor = COALESCE(${input.vendor ?? null}, vendor),
            cost = ${input.cost ?? null},
            notes = COALESCE(${input.notes ?? null}, notes),
            recorded_by = ${personId},
            updated_at = now()
        WHERE id = ${workId}
      `);

      let next: string | null = null;
      if (work.intervalMonths) {
        // Counted from the due date, not from today: a service done three weeks late
        // should not push every future service three weeks later for ever.
        const nextDue = rowsOf<{ due: string }>(
          await db.execute(
            sql`SELECT (${work.dueOn}::date + (${work.intervalMonths} || ' months')::interval)::date::text AS due`,
          ),
        )[0]!.due;

        const created = rowsOf<{ id: string }>(
          await db.execute(sql`
            INSERT INTO asset_maintenance (
              society_id, asset_id, kind, due_on, interval_months, vendor, recorded_by
            ) VALUES (
              ${societyId}, ${work.assetId}, ${work.kind}, ${nextDue},
              ${work.intervalMonths}, ${input.vendor ?? work.vendor}, ${personId}
            )
            RETURNING id
          `),
        );
        next = created[0]!.id;
      }

      return { status: "completed", nextScheduledId: next };
    });
  }

  /** Everything that has ever been done to one asset. */
  @Get(":id/history")
  async history(@Param("id") id: string) {
    this.requireRead();
    await this.mustExist(id);

    return tx(async (db) =>
      rowsOf(
        await db.execute(sql`
          SELECT m.id, m.kind, m.due_on::text AS "dueOn",
                 m.completed_on::text AS "completedOn",
                 m.interval_months AS "intervalMonths", m.vendor, m.notes,
                 CASE WHEN ${this.maySeeCost()} THEN m.cost::text END AS cost,
                 p.name AS "recordedByName"
          FROM asset_maintenance m
          LEFT JOIN persons p ON p.id = m.recorded_by
          WHERE m.asset_id = ${id}
          ORDER BY COALESCE(m.completed_on, m.due_on) DESC
        `),
      ),
    );
  }

  // ------------------------------------------------------------------ parts

  private async mustExist(id: string): Promise<void> {
    await tx(async (db) => {
      const rows = rowsOf(await db.execute(sql`SELECT id FROM assets WHERE id = ${id}`));
      if (rows.length === 0) throw new NotFoundError("That asset is not in the register.");
    });
  }

  /**
   * Staff read it because staff are the people who work on it.
   *
   * `isStaff()` covers the committee, the accountant, the auditor and maintenance staff —
   * deliberately not a guard. A guard reports a broken pump through the helpdesk, which
   * routes it; they have no use for a plant register and no reason to hold one on a
   * society-owned handset that changes hands every shift.
   */
  private requireRead(): void {
    if (!hasRole("society_admin", "mc_member", "accountant", "auditor") && !isStaff()) {
      throw new ForbiddenError("The asset register is committee and staff work.");
    }
  }

  private requireManage(): void {
    if (!hasRole("society_admin", "mc_member")) {
      throw new ForbiddenError("Only the committee can change the asset register.");
    }
  }

  /** What the society paid is not everybody's business. */
  private maySeeCost(): boolean {
    return hasRole("society_admin", "mc_member", "accountant", "auditor");
  }
}

/** A money string to integer paise, without ever creating a float. */
function toPaise(amount: string | null | undefined): bigint {
  if (!amount) return 0n;
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? amount.slice(1) : amount).split(".");
  const paise = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return negative ? -paise : paise;
}

function fromPaise(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
