/**
 * Statutory reports, read straight off the journal.
 *
 * Every figure here is computed in SQL from `journal_lines`. Nothing is stored, nothing
 * is cached, and no total is maintained incrementally — because a maintained total is a
 * total that can drift from the entries it claims to summarise, and the first time an
 * auditor finds a balance sheet that does not tie to the day book is the last time that
 * committee trusts the software.
 *
 * Money stays a **string** the whole way. `numeric` arrives from pg as a string and
 * leaves as one. The moment a rupee figure becomes a JS number it is a float, and a
 * balance sheet out by a paisa is worse than no balance sheet at all.
 *
 * ## The sign convention, stated once
 *
 * Assets and expenses are *debit-natured*: balance = debits − credits.
 * Liabilities, income and equity are *credit-natured*: balance = credits − debits.
 *
 * Every report below applies that rule rather than showing raw debit and credit columns,
 * because a treasurer reading "Corpus fund: −12,00,000" reasonably concludes something
 * is broken.
 */

import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { ValidationError } from "../../common/errors.js";
import { tx } from "../../common/tenant-context.js";

/**
 * Return the rows, not node-postgres' envelope.
 *
 * `db.execute` hands back `command`, `rowCount`, `oid` and a `fields` array carrying
 * every column's internal type OID. Serialising that publishes our driver and query
 * shape for no benefit, and makes the response several times larger than the data in it.
 */
function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) ?? [];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkedDate(value: string | undefined, label: string, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  if (!DATE.test(value)) throw new ValidationError(`${label} must be YYYY-MM-DD.`);
  return value;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The start of the Indian financial year containing `date` — 1 April.
 *
 * Hardcoded rather than configurable because it is statutory: a co-operative housing
 * society files on an April-to-March year, and offering a choice would only let someone
 * pick the wrong one.
 */
function financialYearStart(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return `${month >= 4 ? year : year - 1}-04-01`;
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  debit: string;
  credit: string;
}

@Injectable()
export class ReportsService {
  /**
   * Chart of accounts with running balances.
   *
   * Accounts with no postings are included. An empty account is information — it says
   * the head exists and has not been used — and hiding it makes a new society's chart
   * look broken.
   */
  async chartOfAccounts(asOf?: string) {
    const on = checkedDate(asOf, "asOf", today());

    return tx(async (db) =>
      rowsOf(
        await db.execute(sql`
          SELECT
            a.id,
            a.code,
            a.name,
            a.type::text                     AS type,
            a.is_restricted                  AS "isRestricted",
            COALESCE(SUM(l.debit), 0)::text  AS debits,
            COALESCE(SUM(l.credit), 0)::text AS credits,
            CASE WHEN a.type IN ('asset', 'expense')
                 THEN COALESCE(SUM(l.debit) - SUM(l.credit), 0)
                 ELSE COALESCE(SUM(l.credit) - SUM(l.debit), 0)
            END::text                        AS balance
          FROM ledger_accounts a
          LEFT JOIN journal_lines l ON l.account_id = a.id
          LEFT JOIN journal_entries e
                 ON e.id = l.journal_entry_id AND e.entry_date <= ${on}
          WHERE l.id IS NULL OR e.id IS NOT NULL
          GROUP BY a.id, a.code, a.name, a.type, a.is_restricted
          ORDER BY a.code
        `),
      ),
    );
  }

  /**
   * Trial balance.
   *
   * The first thing an auditor asks for, and the cheapest proof that the books are
   * internally consistent: if the two columns disagree, every report downstream of them
   * is wrong. `balanced` is returned rather than left for the reader to add up, because
   * the whole point is that nobody should have to.
   */
  async trialBalance(asOf?: string) {
    const on = checkedDate(asOf, "asOf", today());

    return tx(async (db) => {
      const rows = rowsOf<TrialBalanceRow>(
        await db.execute(sql`
          SELECT
            a.code,
            a.name,
            a.type::text                                    AS type,
            GREATEST(SUM(l.debit) - SUM(l.credit), 0)::text  AS debit,
            GREATEST(SUM(l.credit) - SUM(l.debit), 0)::text  AS credit
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.journal_entry_id
          JOIN ledger_accounts a ON a.id = l.account_id
          WHERE e.entry_date <= ${on}
          GROUP BY a.id, a.code, a.name, a.type
          HAVING SUM(l.debit) <> 0 OR SUM(l.credit) <> 0
          ORDER BY a.code
        `),
      );

      const totals = rowsOf<{ debit: string; credit: string; balanced: boolean }>(
        await db.execute(sql`
          SELECT
            COALESCE(SUM(l.debit), 0)::text  AS debit,
            COALESCE(SUM(l.credit), 0)::text AS credit,
            COALESCE(SUM(l.debit), 0) = COALESCE(SUM(l.credit), 0) AS balanced
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.journal_entry_id
          WHERE e.entry_date <= ${on}
        `),
      )[0];

      return {
        asOf: on,
        rows,
        totalDebit: totals?.debit ?? "0",
        totalCredit: totals?.credit ?? "0",
        // Double entry makes this true by construction; it is asserted anyway, because a
        // false here means a control has failed and nothing below should be believed.
        balanced: totals?.balanced ?? true,
      };
    });
  }

  /**
   * Income and expenditure.
   *
   * Called that, not "profit and loss". A housing society is not trading and its
   * committee does not think in profit — the statutory format under every state
   * co-operative act is Income and Expenditure, ending in a surplus or a deficit.
   */
  async incomeAndExpenditure(from?: string, to?: string) {
    const end = checkedDate(to, "to", today());
    const start = checkedDate(from, "from", financialYearStart(end));
    if (start > end) throw new ValidationError("The period has to end after it starts.");

    return tx(async (db) => {
      const rows = rowsOf<{ type: string; code: string; name: string; amount: string }>(
        await db.execute(sql`
          SELECT
            a.type::text AS type,
            a.code,
            a.name,
            CASE WHEN a.type = 'income'
                 THEN SUM(l.credit) - SUM(l.debit)
                 ELSE SUM(l.debit) - SUM(l.credit)
            END::text    AS amount
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.journal_entry_id
          JOIN ledger_accounts a ON a.id = l.account_id
          WHERE a.type IN ('income', 'expense')
            AND e.entry_date BETWEEN ${start} AND ${end}
          GROUP BY a.id, a.type, a.code, a.name
          HAVING SUM(l.debit) <> 0 OR SUM(l.credit) <> 0
          ORDER BY a.type DESC, a.code
        `),
      );

      const totals = rowsOf<{ income: string; expense: string; surplus: string }>(
        await db.execute(sql`
          SELECT
            COALESCE(SUM(l.credit - l.debit) FILTER (WHERE a.type = 'income'), 0)::text  AS income,
            COALESCE(SUM(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0)::text AS expense,
            (
              COALESCE(SUM(l.credit - l.debit) FILTER (WHERE a.type = 'income'), 0)
              - COALESCE(SUM(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0)
            )::text AS surplus
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.journal_entry_id
          JOIN ledger_accounts a ON a.id = l.account_id
          WHERE a.type IN ('income', 'expense')
            AND e.entry_date BETWEEN ${start} AND ${end}
        `),
      )[0];

      return {
        from: start,
        to: end,
        income: rows.filter((r) => r.type === "income"),
        expenditure: rows.filter((r) => r.type === "expense"),
        totalIncome: totals?.income ?? "0",
        totalExpenditure: totals?.expense ?? "0",
        /** Positive is a surplus, negative a deficit. Named for what it is. */
        surplus: totals?.surplus ?? "0",
      };
    });
  }

  /**
   * Balance sheet.
   *
   * The accumulated surplus is folded into the funds side rather than left dangling,
   * which is what makes the two sides tie. A balance sheet that does not balance is not
   * a report, it is a bug — so `balanced` is returned and the console shows it loudly.
   */
  async balanceSheet(asOf?: string) {
    const on = checkedDate(asOf, "asOf", today());

    return tx(async (db) => {
      const rows = rowsOf<{
        type: string;
        code: string;
        name: string;
        amount: string;
        isRestricted: boolean;
      }>(
        await db.execute(sql`
          SELECT
            a.type::text    AS type,
            a.code,
            a.name,
            a.is_restricted AS "isRestricted",
            CASE WHEN a.type = 'asset'
                 THEN SUM(l.debit) - SUM(l.credit)
                 ELSE SUM(l.credit) - SUM(l.debit)
            END::text       AS amount
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.journal_entry_id
          JOIN ledger_accounts a ON a.id = l.account_id
          WHERE a.type IN ('asset', 'liability', 'equity')
            AND e.entry_date <= ${on}
          GROUP BY a.id, a.type, a.code, a.name, a.is_restricted
          HAVING SUM(l.debit) <> 0 OR SUM(l.credit) <> 0
          ORDER BY a.type, a.code
        `),
      );

      const totals = rowsOf<{
        assets: string;
        liabilities: string;
        equity: string;
        surplus: string;
        balanced: boolean;
      }>(
        await db.execute(sql`
          WITH t AS (
            SELECT
              COALESCE(SUM(l.debit - l.credit) FILTER (WHERE a.type = 'asset'), 0)     AS assets,
              COALESCE(SUM(l.credit - l.debit) FILTER (WHERE a.type = 'liability'), 0) AS liabilities,
              COALESCE(SUM(l.credit - l.debit) FILTER (WHERE a.type = 'equity'), 0)    AS equity,
              COALESCE(SUM(l.credit - l.debit) FILTER (WHERE a.type = 'income'), 0)
                - COALESCE(SUM(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0) AS surplus
            FROM journal_lines l
            JOIN journal_entries e ON e.id = l.journal_entry_id
            JOIN ledger_accounts a ON a.id = l.account_id
            WHERE e.entry_date <= ${on}
          )
          SELECT
            assets::text      AS assets,
            liabilities::text AS liabilities,
            equity::text      AS equity,
            surplus::text     AS surplus,
            assets = liabilities + equity + surplus AS balanced
          FROM t
        `),
      )[0];

      return {
        asOf: on,
        assets: rows.filter((r) => r.type === "asset"),
        liabilities: rows.filter((r) => r.type === "liability"),
        equity: rows.filter((r) => r.type === "equity"),
        totalAssets: totals?.assets ?? "0",
        totalLiabilities: totals?.liabilities ?? "0",
        totalEquity: totals?.equity ?? "0",
        /** Income less expenditure to date, which belongs on the funds side. */
        accumulatedSurplus: totals?.surplus ?? "0",
        balanced: totals?.balanced ?? true,
      };
    });
  }

  /**
   * The day book — every posted entry in a window, with both sides.
   *
   * An auditor tracing a figure from the balance sheet needs to land on the entry that
   * produced it, and a report that summarises without leaving that path is a report they
   * cannot sign.
   */
  async dayBook(from?: string, to?: string, accountId?: string) {
    const end = checkedDate(to, "to", today());
    const start = checkedDate(from, "from", financialYearStart(end));
    const account = accountId ?? null;

    return tx(async (db) =>
      rowsOf(
        await db.execute(sql`
          SELECT
            e.id,
            e.entry_number      AS "entryNumber",
            e.entry_date::text  AS "entryDate",
            e.narration,
            e.source_type::text AS "sourceType",
            e.reverses_entry_id AS "reversesEntryId",
            json_agg(
              json_build_object(
                'code', a.code,
                'name', a.name,
                'debit', l.debit::text,
                'credit', l.credit::text,
                'unitId', l.unit_id
              ) ORDER BY l.debit DESC
            ) AS lines
          FROM journal_entries e
          JOIN journal_lines l ON l.journal_entry_id = e.id
          JOIN ledger_accounts a ON a.id = l.account_id
          WHERE e.entry_date BETWEEN ${start} AND ${end}
            AND (${account}::uuid IS NULL OR e.id IN (
              SELECT journal_entry_id FROM journal_lines WHERE account_id = ${account}::uuid
            ))
          GROUP BY e.id, e.entry_number, e.entry_date, e.narration, e.source_type,
                   e.reverses_entry_id
          ORDER BY e.entry_date DESC, e.entry_number DESC
          LIMIT 500
        `),
      ),
    );
  }

  /**
   * One flat's account across financial years — what MyGate calls a house statement.
   *
   * The document a resident actually asks for when they dispute a bill: every charge,
   * every payment, and a running balance in one place. Built from `journal_lines`
   * carrying a `unit_id` rather than from invoices, so a manual adjustment posted
   * against the flat appears too — which is usually exactly what the dispute is about.
   */
  async houseStatement(unitId: string, from?: string, to?: string) {
    const end = checkedDate(to, "to", today());
    // Deliberately wide. The point of this report is history, so it defaults to
    // everything rather than to the current year.
    const start = checkedDate(from, "from", "2000-01-01");

    return tx(async (db) => {
      const rows = rowsOf<{ runningBalance: string }>(
        await db.execute(sql`
          SELECT
            e.entry_date::text  AS "entryDate",
            e.entry_number      AS "entryNumber",
            e.narration,
            e.source_type::text AS "sourceType",
            a.code,
            a.name,
            l.debit::text       AS debit,
            l.credit::text      AS credit,
            -- Running balance in the resident's terms: a charge raises what they owe, a
            -- receipt reduces it. Computed in SQL so the figure cannot disagree with the
            -- rows printed above it.
            SUM(l.debit - l.credit) OVER (
              ORDER BY e.entry_date, e.entry_number, l.id
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::text             AS "runningBalance"
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.journal_entry_id
          JOIN ledger_accounts a ON a.id = l.account_id
          WHERE l.unit_id = ${unitId}::uuid
            AND e.entry_date BETWEEN ${start} AND ${end}
          ORDER BY e.entry_date, e.entry_number, l.id
        `),
      );

      return {
        unitId,
        from: start,
        to: end,
        rows,
        closingBalance: rows.length > 0 ? rows[rows.length - 1]!.runningBalance : "0",
      };
    });
  }

  /**
   * Cash and bank movement.
   *
   * Restricted to accounts that actually hold money, so it answers "what came in and
   * what went out" rather than restating Income and Expenditure. Restricted funds —
   * corpus and sinking — are flagged, because spending them needs committee approval and
   * showing them inside general cash invites exactly the mistake that restriction exists
   * to prevent.
   */
  async cashFlow(from?: string, to?: string) {
    const end = checkedDate(to, "to", today());
    const start = checkedDate(from, "from", financialYearStart(end));

    return tx(async (db) => {
      const rows = rowsOf(
        await db.execute(sql`
          SELECT
            a.code,
            a.name,
            a.is_restricted                            AS "isRestricted",
            COALESCE(SUM(l.debit), 0)::text            AS "moneyIn",
            COALESCE(SUM(l.credit), 0)::text           AS "moneyOut",
            COALESCE(SUM(l.debit - l.credit), 0)::text AS "netMovement"
          FROM ledger_accounts a
          JOIN journal_lines l ON l.account_id = a.id
          JOIN journal_entries e ON e.id = l.journal_entry_id
          WHERE a.type = 'asset'
            AND (lower(a.name) LIKE '%cash%' OR lower(a.name) LIKE '%bank%')
            AND e.entry_date BETWEEN ${start} AND ${end}
          GROUP BY a.id, a.code, a.name, a.is_restricted
          ORDER BY a.code
        `),
      );

      const opening = rowsOf<{ amount: string }>(
        await db.execute(sql`
          SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS amount
          FROM ledger_accounts a
          JOIN journal_lines l ON l.account_id = a.id
          JOIN journal_entries e ON e.id = l.journal_entry_id
          WHERE a.type = 'asset'
            AND (lower(a.name) LIKE '%cash%' OR lower(a.name) LIKE '%bank%')
            AND e.entry_date < ${start}
        `),
      )[0];

      return {
        from: start,
        to: end,
        openingBalance: opening?.amount ?? "0",
        accounts: rows,
      };
    });
  }
}
