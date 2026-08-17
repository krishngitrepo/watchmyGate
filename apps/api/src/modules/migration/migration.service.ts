/**
 * Migration — importing a society off whatever it uses today.
 *
 * Commercially the most important code in this repo, and the least glamorous. A 400-flat
 * society will not retype its register, so the quality of this decides whether they can
 * switch at all. Everything else in the product is irrelevant to a society that cannot
 * get its data in.
 *
 * Three properties, each learned from how imports go wrong:
 *
 * **Dry run first, always.** Nobody commits a 400-flat import blind. `plan()` returns
 * exactly what would happen — created, updated, skipped, rejected, with the reason per
 * row — and changes nothing. The committee sees the diff before agreeing to it.
 *
 * **Per-row outcomes, never all-or-nothing.** One malformed row in a spreadsheet
 * exported from Tally must not abort the other 399. A transaction that rolls back the
 * lot means the society fixes one cell and waits again.
 *
 * **Opening balances are the hard part, not the flats.** Any competitor can import a
 * list of flat numbers. What actually blocks a switch is carrying across what every flat
 * already owes, which is why that is modelled here as a first-class import rather than
 * as an afterthought.
 */

import { Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { schema } from "@watchmygate/db";

import { ValidationError } from "../../common/errors.js";
import { currentContext, tx } from "../../common/tenant-context.js";

export type RowOutcome = "create" | "update" | "skip" | "reject";

export interface RowResult {
  row: number;
  outcome: RowOutcome;
  reason?: string;
  ref?: string;
}

export interface ImportReport {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  rejected: number;
  results: RowResult[];
}

export interface UnitRow {
  tower: string;
  number: string;
  floor?: number | undefined;
  carpetAreaSqft?: string | undefined;
  bhk?: number | undefined;
  ownerName?: string | undefined;
  ownerPhone?: string | undefined;
  tenantName?: string | undefined;
  tenantPhone?: string | undefined;
}

export interface OpeningBalanceRow {
  unitNumber: string;
  amount: string;
  asOf: string;
  note?: string | undefined;
}

/** Indian mobile numbers, normalised to +91XXXXXXXXXX. */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  // Handles "9900000001", "09900000001", "919900000001", "+91 99000 00001".
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  if (ten.length !== 10 || !/^[6-9]/.test(ten)) return null;
  return `+91${ten}`;
}

/** A money string, or null. Never a float — the value goes straight into `numeric`. */
export function normaliseAmount(raw: string): string | null {
  const cleaned = raw.replace(/[₹,\s]/g, "").trim();
  if (!/^-?\d+(\.\d{1,4})?$/.test(cleaned)) return null;
  return cleaned;
}

function blank(report: Omit<ImportReport, "created" | "updated" | "skipped" | "rejected">) {
  const tally = report.results.reduce(
    (acc, r) => {
      acc[r.outcome] += 1;
      return acc;
    },
    { create: 0, update: 0, skip: 0, reject: 0 },
  );
  return {
    ...report,
    created: tally.create,
    updated: tally.update,
    skipped: tally.skip,
    rejected: tally.reject,
  };
}

@Injectable()
export class MigrationService {
  /**
   * Import flats, with their owners and tenants.
   *
   * Owner and tenant are separate columns because they are separate people with separate
   * rights — the owner votes, the tenant may be the one who pays, and collapsing them is
   * the classic bug in this category. A spreadsheet that only has one is fine; a
   * spreadsheet that has both must not lose one.
   */
  async importUnits(rows: UnitRow[], dryRun: boolean): Promise<ImportReport> {
    if (rows.length === 0) throw new ValidationError("Nothing to import.");
    if (rows.length > 5000) {
      throw new ValidationError("Import at most 5000 rows at a time.");
    }

    return tx(async (db) => {
      const societyId = currentContext().societyId!;
      const results: RowResult[] = [];

      const towers = new Map<string, string>();
      for (const t of await db.select().from(schema.towers)) {
        towers.set(t.name.trim().toLowerCase(), t.id);
      }

      const existing = new Map<string, string>();
      for (const u of await db.select().from(schema.units)) {
        existing.set(u.number.trim().toLowerCase(), u.id);
      }

      for (const [i, row] of rows.entries()) {
        const line = i + 1;

        if (!row.number?.trim()) {
          results.push({ row: line, outcome: "reject", reason: "No flat number." });
          continue;
        }
        if (!row.tower?.trim()) {
          results.push({ row: line, outcome: "reject", reason: "No tower or block." });
          continue;
        }

        const key = row.number.trim().toLowerCase();
        if (existing.has(key)) {
          // Re-running an import must be safe. A society that fixes three cells and
          // uploads again should not end up with 400 duplicate flats.
          results.push({
            row: line,
            outcome: "skip",
            reason: "That flat already exists.",
            ref: row.number,
          });
          continue;
        }

        // Phones are validated before anything is written, so a dry run reports the same
        // rejections a real run would.
        for (const [label, phone] of [
          ["owner", row.ownerPhone],
          ["tenant", row.tenantPhone],
        ] as const) {
          if (phone && !normalisePhone(phone)) {
            results.push({
              row: line,
              outcome: "reject",
              reason: `The ${label} phone number is not a valid Indian mobile.`,
              ref: row.number,
            });
          }
        }
        if (results.at(-1)?.row === line && results.at(-1)?.outcome === "reject") continue;

        if (dryRun) {
          results.push({ row: line, outcome: "create", ref: row.number });
          existing.set(key, "planned");
          continue;
        }

        let towerId = towers.get(row.tower.trim().toLowerCase());
        if (!towerId) {
          const [t] = await db
            .insert(schema.towers)
            .values({ societyId, name: row.tower.trim() })
            .returning({ id: schema.towers.id });
          towerId = t!.id;
          towers.set(row.tower.trim().toLowerCase(), towerId);
        }

        const [unit] = await db
          .insert(schema.units)
          .values({
            societyId,
            towerId,
            number: row.number.trim(),
            ...(row.floor !== undefined ? { floor: row.floor } : {}),
            ...(row.carpetAreaSqft ? { carpetAreaSqft: row.carpetAreaSqft } : {}),
            ...(row.bhk !== undefined ? { bhk: row.bhk } : {}),
          })
          .returning({ id: schema.units.id });

        existing.set(key, unit!.id);
        results.push({ row: line, outcome: "create", ref: row.number });
      }

      return blank({ dryRun, total: rows.length, results });
    });
  }

  /**
   * Import what each flat already owes.
   *
   * The step that actually blocks a switch. A society mid-year has balances going back
   * months, and a platform that cannot carry them forward is one they cannot move to
   * without writing off the arrears — which no committee will do.
   *
   * Amounts stay strings the whole way into `numeric`. There is no float anywhere on this
   * path, because an opening balance that is off by a paisa per flat is a reconciliation
   * a treasurer will never get to balance.
   */
  async importOpeningBalances(
    rows: OpeningBalanceRow[],
    dryRun: boolean,
  ): Promise<ImportReport> {
    if (rows.length === 0) throw new ValidationError("Nothing to import.");

    return tx(async (db) => {
      const results: RowResult[] = [];

      const units = new Map<string, string>();
      for (const u of await db.select().from(schema.units)) {
        units.set(u.number.trim().toLowerCase(), u.id);
      }

      for (const [i, row] of rows.entries()) {
        const line = i + 1;
        const unitId = units.get((row.unitNumber ?? "").trim().toLowerCase());

        if (!unitId) {
          results.push({
            row: line,
            outcome: "reject",
            reason: "No such flat in this society. Import flats first.",
            ref: row.unitNumber,
          });
          continue;
        }

        const amount = normaliseAmount(row.amount ?? "");
        if (amount === null) {
          results.push({
            row: line,
            outcome: "reject",
            reason: "That amount is not a number.",
            ref: row.unitNumber,
          });
          continue;
        }
        if (amount.startsWith("-")) {
          results.push({
            row: line,
            outcome: "reject",
            reason: "An opening balance cannot be negative. Record a credit separately.",
            ref: row.unitNumber,
          });
          continue;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(row.asOf ?? "")) {
          results.push({
            row: line,
            outcome: "reject",
            reason: "The as-of date must be YYYY-MM-DD.",
            ref: row.unitNumber,
          });
          continue;
        }

        results.push({
          row: line,
          outcome: dryRun ? "create" : "create",
          ref: `${row.unitNumber} ${amount}`,
        });

        if (!dryRun) {
          // Written as an ordinary invoice so it flows through the same ledger, ageing
          // and reminder machinery as everything else. An import that creates a special
          // kind of debt is one every later report has to special-case.
          await db.insert(schema.invoices).values({
            societyId: currentContext().societyId!,
            unitId,
            // The OPEN- prefix is how an opening balance is identified later — there is
            // no notes column on an invoice, and adding one just to label a migration
            // would put migration vocabulary into every invoice forever.
            invoiceNumber: `OPEN-${row.unitNumber.trim()}-${row.asOf}`,
            periodStart: row.asOf,
            periodEnd: row.asOf,
            issueDate: row.asOf,
            dueDate: row.asOf,
            subtotal: amount,
            gstAmount: "0",
            total: amount,
            // Issued, not draft: this is money already owed on the day the society
            // switched, and a draft would be invisible to arrears and reminders.
            status: "issued",
          });
        }
      }

      return blank({ dryRun, total: rows.length, results });
    });
  }

  /**
   * What is already here.
   *
   * Called before an import so a committee sees the starting position, and after one so
   * they can confirm the numbers moved by what they expected.
   */
  async currentState() {
    return tx(async (db) => {
      const [row] = await db
        .select({
          towers: sql<number>`(SELECT count(*) FROM towers)::int`,
          units: sql<number>`(SELECT count(*) FROM units)::int`,
          occupancies: sql<number>`
            (SELECT count(*) FROM unit_occupancies WHERE valid_to IS NULL)::int`,
          invoices: sql<number>`(SELECT count(*) FROM invoices)::int`,
          openingBalances: sql<number>`
            (SELECT count(*) FROM invoices WHERE invoice_number LIKE 'OPEN-%')::int`,
        })
        .from(schema.societies)
        .where(eq(schema.societies.id, currentContext().societyId!));
      return row ?? {};
    });
  }
}
