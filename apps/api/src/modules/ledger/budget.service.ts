/**
 * Budgets and variance (MG-6).
 *
 * Asked for loudly, once a year, at the AGM — and then quietly every month by whoever
 * has to answer "can we afford the lift repair". Today that lives in a spreadsheet on the
 * treasurer's laptop and leaves with them when the committee turns over.
 *
 * ## Two things this deliberately does not do
 *
 * **It does not store actuals.** Every actual figure is read from `journal_lines` at
 * query time. A budget table carrying its own copy of what was spent will drift from the
 * ledger, and the moment it does the committee has two numbers and no way to tell which
 * one is the society's.
 *
 * **It does not let an approved budget be edited.** The freeze is a trigger in migration
 * 0011, not a check here, because a control that only holds while the calling code is
 * correct is not a control. A genuine change is a revision that supersedes — which is
 * also how the next AGM can see that a revision happened at all.
 *
 * ## The row nobody asks for and everybody needs
 *
 * The variance report includes heads that were **spent on but never budgeted**. A report
 * that only walks the budget lines answers "did we overspend what we planned" and misses
 * "what did we spend that we never planned at all", which is the more interesting
 * question and the one an auditor asks.
 */

import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../common/errors.js";
import { currentContext, hasRole, tx } from "../../common/tenant-context.js";

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) ?? [];
}

/** 1 April to 31 March. Statutory in India, so derived rather than configured. */
export function financialYearBounds(year: number): { start: string; end: string } {
  return { start: `${year}-04-01`, end: `${year + 1}-03-31` };
}

/** The financial year a date falls in: 15 Feb 2027 belongs to FY 2026-27. */
export function financialYearOf(iso: string): number {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return month >= 4 ? year : year - 1;
}

export interface BudgetLineInput {
  accountId: string;
  annualAmount: string;
  notes?: string | undefined;
}

@Injectable()
export class BudgetService {
  async list() {
    return tx(async (db) =>
      rowsOf(
        await db.execute(sql`
          SELECT
            b.id,
            b.financial_year        AS "financialYear",
            b.title, b.notes, b.status, b.version,
            b.approved_ref          AS "approvedRef",
            b.approved_at           AS "approvedAt",
            b.supersedes_id         AS "supersedesId",
            approver.name           AS "approvedByName",
            author.name             AS "createdByName",
            COALESCE(l.lines, 0)::int    AS "lineCount",
            COALESCE(l.total, 0)::text   AS "totalBudgeted"
          FROM budgets b
          LEFT JOIN persons approver ON approver.id = b.approved_by
          LEFT JOIN persons author   ON author.id = b.created_by
          LEFT JOIN LATERAL (
            SELECT count(*) AS lines, sum(annual_amount) AS total
            FROM budget_lines WHERE budget_id = b.id
          ) l ON true
          ORDER BY b.financial_year DESC, b.version DESC
        `),
      ),
    );
  }

  async create(input: {
    financialYear: number;
    title: string;
    notes?: string | undefined;
    lines: BudgetLineInput[];
  }) {
    this.requireDrafting();
    const { societyId, personId } = currentContext();

    return tx(async (db) => {
      const clash = rowsOf<{ id: string }>(
        await db.execute(sql`
          SELECT id FROM budgets
          WHERE financial_year = ${input.financialYear}
            AND status IN ('draft', 'approved')
          LIMIT 1
        `),
      );
      if (clash.length > 0) {
        throw new ConflictError(
          `A budget for ${input.financialYear}-${String((input.financialYear + 1) % 100).padStart(2, "0")} already exists. Revise it rather than starting a second one.`,
        );
      }

      const created = rowsOf<{ id: string }>(
        await db.execute(sql`
          INSERT INTO budgets (society_id, financial_year, title, notes, created_by)
          VALUES (${societyId}, ${input.financialYear}, ${input.title}, ${input.notes ?? null}, ${personId})
          RETURNING id
        `),
      )[0]!;

      await this.writeLines(db, societyId, created.id, input.lines);
      return { id: created.id };
    });
  }

  /** Replace the lines of a draft wholesale. The trigger refuses if it is approved. */
  async setLines(budgetId: string, lines: BudgetLineInput[]) {
    this.requireDrafting();
    const { societyId } = currentContext();

    return tx(async (db) => {
      await this.mustExist(db, budgetId);
      await db.execute(sql`DELETE FROM budget_lines WHERE budget_id = ${budgetId}`);
      await this.writeLines(db, societyId, budgetId, lines);
      return { status: "saved", lines: lines.length };
    });
  }

  /**
   * Pass the budget.
   *
   * **The person who wrote it cannot be the person who passes it.** A budget is a
   * committee decision, and one where the treasurer both drafts and approves is not a
   * decision, it is a memo. Same reasoning as reopening a locked accounting period, and
   * the same rule.
   */
  async approve(budgetId: string, resolutionRef: string) {
    if (!hasRole("society_admin", "mc_member")) {
      throw new ForbiddenError("Only the committee can pass a budget.");
    }
    if (resolutionRef.trim().length < 4) {
      throw new ValidationError(
        "Record the resolution this was passed under — an AGM date or a resolution number.",
      );
    }
    const { personId } = currentContext();

    return tx(async (db) => {
      const budget = await this.mustExist(db, budgetId);
      if (budget.status !== "draft") {
        throw new ConflictError("Only a draft budget can be passed.");
      }
      if (budget.createdBy === personId) {
        throw new ForbiddenError(
          "The person who drafted a budget cannot also pass it. Ask another committee member.",
        );
      }

      const lineCount = rowsOf<{ count: number }>(
        await db.execute(
          sql`SELECT count(*)::int AS count FROM budget_lines WHERE budget_id = ${budgetId}`,
        ),
      )[0]?.count;
      if (!lineCount) {
        throw new ValidationError("A budget with no heads in it is not a budget.");
      }

      await db.execute(sql`
        UPDATE budgets
        SET status = 'approved',
            approved_by = ${personId},
            approved_at = now(),
            approved_ref = ${resolutionRef.trim()},
            updated_at = now()
        WHERE id = ${budgetId}
      `);
      return { status: "approved" };
    });
  }

  /**
   * Raise a revision.
   *
   * The approved budget is superseded rather than edited, and the new draft starts as a
   * copy of it — a revision that made you retype forty heads would be a revision nobody
   * raises, and the committee would edit the old one instead.
   */
  async revise(budgetId: string) {
    this.requireDrafting();
    const { societyId, personId } = currentContext();

    return tx(async (db) => {
      const budget = await this.mustExist(db, budgetId);
      if (budget.status !== "approved") {
        throw new ConflictError("Only an approved budget needs revising; edit a draft directly.");
      }

      // Supersede first: the unique index allows only one live budget per year, so the
      // old one has to step aside before the new one can exist.
      await db.execute(sql`
        UPDATE budgets SET status = 'superseded', updated_at = now() WHERE id = ${budgetId}
      `);

      const created = rowsOf<{ id: string }>(
        await db.execute(sql`
          INSERT INTO budgets (
            society_id, financial_year, title, notes, supersedes_id, version, created_by
          )
          SELECT society_id, financial_year, title, notes, id, version + 1, ${personId}
          FROM budgets WHERE id = ${budgetId}
          RETURNING id
        `),
      )[0]!;

      await db.execute(sql`
        INSERT INTO budget_lines (society_id, budget_id, account_id, annual_amount, notes)
        SELECT ${societyId}, ${created.id}, account_id, annual_amount, notes
        FROM budget_lines WHERE budget_id = ${budgetId}
      `);

      return { id: created.id, version: budget.version + 1 };
    });
  }

  /**
   * Budget against actual, head by head.
   *
   * `asOf` exists because "we are 60% through the budget" means nothing without "and 75%
   * through the year". The report returns both so the committee compares like with like.
   */
  async variance(financialYear?: number, asOf?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const year = financialYear ?? financialYearOf(today);
    const { start, end } = financialYearBounds(year);
    const upTo = asOf && asOf >= start ? (asOf > end ? end : asOf) : today > end ? end : today;

    return tx(async (db) => {
      const budget = rowsOf<{
        id: string;
        title: string;
        status: string;
        version: number;
        approvedRef: string | null;
      }>(
        await db.execute(sql`
          SELECT id, title, status, version, approved_ref AS "approvedRef"
          FROM budgets
          WHERE financial_year = ${year} AND status IN ('draft', 'approved')
          LIMIT 1
        `),
      )[0];

      const rows = rowsOf(
        await db.execute(sql`
          WITH actuals AS (
            SELECT
              l.account_id,
              -- Income is a credit balance, expenditure a debit one. Signing both so
              -- "more is more" keeps every variance reading the same way round.
              CASE WHEN a.type = 'income'
                   THEN SUM(l.credit) - SUM(l.debit)
                   ELSE SUM(l.debit) - SUM(l.credit)
              END AS amount
            FROM journal_lines l
            JOIN journal_entries e ON e.id = l.journal_entry_id
            JOIN ledger_accounts a ON a.id = l.account_id
            WHERE a.type IN ('income', 'expense')
              AND e.entry_date BETWEEN ${start} AND ${upTo}
            GROUP BY l.account_id, a.type
          )
          SELECT
            a.id                                  AS "accountId",
            a.code, a.name,
            a.type::text                          AS type,
            COALESCE(bl.annual_amount, 0)::text   AS budgeted,
            COALESCE(ac.amount, 0)::text          AS actual,
            (COALESCE(bl.annual_amount, 0) - COALESCE(ac.amount, 0))::text AS remaining,
            -- Null rather than zero when there is nothing budgeted: 0% consumed of a head
            -- that was never budgeted is a lie, and it is the row that matters most.
            CASE WHEN COALESCE(bl.annual_amount, 0) = 0 THEN NULL
                 ELSE round(COALESCE(ac.amount, 0) * 100 / bl.annual_amount, 1)
            END::text                             AS "percentUsed",
            bl.id IS NULL                         AS unbudgeted,
            bl.notes
          FROM ledger_accounts a
          LEFT JOIN budget_lines bl ON bl.account_id = a.id AND bl.budget_id = ${budget?.id ?? null}
          LEFT JOIN actuals ac      ON ac.account_id = a.id
          WHERE a.type IN ('income', 'expense')
            -- Heads that were neither budgeted nor touched are noise on this report.
            AND (bl.id IS NOT NULL OR ac.amount IS NOT NULL)
          ORDER BY a.type DESC, a.code
        `),
      ) as Array<{ type: string; budgeted: string; actual: string; unbudgeted: boolean }>;

      // Summed in integer paise. `Number("1234.56") * 100` is 123455.99999999999 for
      // enough values that adding forty heads of a society's budget drifts visibly, and
      // a total that disagrees with the column above it destroys the whole report.
      const sum = (of: (r: (typeof rows)[number]) => string, type: string): bigint =>
        rows
          .filter((r) => r.type === type)
          .reduce((total, r) => total + toPaise(of(r)), 0n);

      // How far through the year we are, which is the only honest denominator for
      // "60% of the budget is gone".
      const elapsed = Math.round(
        ((new Date(upTo).getTime() - new Date(start).getTime()) /
          (new Date(end).getTime() - new Date(start).getTime())) *
          1000,
      ) / 10;

      return {
        financialYear: year,
        label: `${year}-${String((year + 1) % 100).padStart(2, "0")}`,
        from: start,
        to: upTo,
        yearElapsedPercent: Math.max(0, Math.min(100, elapsed)).toFixed(1),
        budget: budget ?? null,
        income: rows.filter((r) => r.type === "income"),
        expenditure: rows.filter((r) => r.type === "expense"),
        totals: {
          incomeBudgeted: paiseToMoney(sum((r) => r.budgeted, "income")),
          incomeActual: paiseToMoney(sum((r) => r.actual, "income")),
          expenditureBudgeted: paiseToMoney(sum((r) => r.budgeted, "expense")),
          expenditureActual: paiseToMoney(sum((r) => r.actual, "expense")),
        },
        unbudgetedHeads: rows.filter((r) => r.unbudgeted).length,
      };
    });
  }

  // ------------------------------------------------------------------ parts

  private async writeLines(
    db: Parameters<Parameters<typeof tx>[0]>[0],
    societyId: string,
    budgetId: string,
    lines: BudgetLineInput[],
  ): Promise<void> {
    for (const line of lines) {
      await db.execute(sql`
        INSERT INTO budget_lines (society_id, budget_id, account_id, annual_amount, notes)
        VALUES (${societyId}, ${budgetId}, ${line.accountId}, ${line.annualAmount}, ${line.notes ?? null})
      `);
    }
  }

  private async mustExist(
    db: Parameters<Parameters<typeof tx>[0]>[0],
    id: string,
  ): Promise<{ id: string; status: string; createdBy: string | null; version: number }> {
    const rows = rowsOf<{
      id: string;
      status: string;
      createdBy: string | null;
      version: number;
    }>(
      await db.execute(
        sql`SELECT id, status, created_by AS "createdBy", version FROM budgets WHERE id = ${id}`,
      ),
    );
    if (rows.length === 0) throw new NotFoundError("That budget does not exist.");
    return rows[0]!;
  }

  private requireDrafting(): void {
    if (!hasRole("society_admin", "accountant")) {
      throw new ForbiddenError("Only an admin or the accountant can draft a budget.");
    }
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

/** Paise back to a money string. Totals are summed in integers, never as floats. */
function paiseToMoney(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
