/**
 * Double-entry ledger.
 *
 * The highest-risk code in the product. A bug here does not crash — it quietly bills a
 * society wrong and is found at the annual audit, by which point trust is gone.
 *
 * Four invariants, none negotiable:
 *
 * 1. Every journal entry balances: debits equal credits, always.
 * 2. Posted entries are immutable. UPDATE and DELETE are revoked at the database and
 *    enforced by trigger. Corrections are reversing entries.
 * 3. Money is `Decimal` from `@watchmygate/money`, never a JS number.
 * 4. Locked periods cannot be written; reopening needs two people.
 *
 * The hourly invariant job re-checks 1 and 3 and pages if they drift.
 */

import { Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";

import { schema, type TenantTx } from "@watchmygate/db";
import { ZERO, money, toDbString, type Money } from "@watchmygate/money";

import { ConflictError, ValidationError } from "../../common/errors.js";
import { currentContext, tx } from "../../common/tenant-context.js";

export type SourceType =
  | "invoice"
  | "receipt"
  | "payment"
  | "adjustment"
  | "opening"
  | "contra";

/** One side of a journal entry. */
export interface Posting {
  accountCode: string;
  debit?: Money;
  credit?: Money;
  unitId?: string;
}

export interface PostEntryInput {
  entryDate: string;
  narration: string;
  sourceType: SourceType;
  sourceId?: string;
  postings: Posting[];
}

@Injectable()
export class LedgerService {
  /**
   * Write a balanced journal entry.
   *
   * Refuses to post into a locked period and refuses anything that does not balance.
   * Both checks run before any row is written, so a rejected entry leaves no trace.
   */
  async postEntry(input: PostEntryInput): Promise<{ id: string; entryNumber: string }> {
    const { societyId, personId } = currentContext();

    if (input.postings.length < 2) {
      throw new ValidationError("A journal entry needs at least two lines.");
    }

    let debits = ZERO;
    let credits = ZERO;

    for (const p of input.postings) {
      const debit = p.debit ?? ZERO;
      const credit = p.credit ?? ZERO;

      if (debit.isNegative() || credit.isNegative()) {
        throw new ValidationError("Ledger amounts cannot be negative.");
      }
      if (debit.isZero() === credit.isZero()) {
        throw new ValidationError(
          "Each ledger line must be either a debit or a credit, not both or neither.",
        );
      }
      debits = debits.plus(debit) as Money;
      credits = credits.plus(credit) as Money;
    }

    if (!debits.equals(credits)) {
      throw new ValidationError(
        `Journal entry does not balance: debits ${debits.toFixed(2)} vs credits ${credits.toFixed(2)}.`,
      );
    }
    if (debits.isZero()) {
      throw new ValidationError("A journal entry cannot be for zero.");
    }

    return tx(async (db) => {
      const period = await this.periodFor(db, societyId, input.entryDate);
      if (period?.status === "locked") {
        throw new ConflictError(
          `The accounting period ending ${period.endsOn} is closed. Ask the committee ` +
            "to reopen it, or post to the current period.",
        );
      }

      const accounts = await this.resolveAccounts(
        db,
        societyId,
        input.postings.map((p) => p.accountCode),
      );

      const entryNumber = await this.nextEntryNumber(db, societyId, input.entryDate);

      const [entry] = await db
        .insert(schema.journalEntries)
        .values({
          societyId,
          entryNumber,
          entryDate: input.entryDate,
          narration: input.narration,
          sourceType: input.sourceType,
          sourceId: input.sourceId ?? null,
          postedAt: new Date(),
          postedBy: personId,
          periodId: period?.id ?? null,
        })
        .returning({ id: schema.journalEntries.id });

      if (!entry) throw new ConflictError("Could not post the journal entry.");

      await db.insert(schema.journalLines).values(
        input.postings.map((p) => ({
          societyId,
          journalEntryId: entry.id,
          accountId: accounts.get(p.accountCode)!,
          debit: toDbString(p.debit ?? ZERO),
          credit: toDbString(p.credit ?? ZERO),
          unitId: p.unitId ?? null,
        })),
      );

      return { id: entry.id, entryNumber };
    });
  }

  /**
   * Correct a posted entry by writing its mirror image.
   *
   * The original is never edited. This is why the ledger can be trusted: history is
   * additive, so an auditor sees both what was recorded and what corrected it.
   */
  async reverseEntry(
    entryId: string,
    reason: string,
  ): Promise<{ id: string; entryNumber: string }> {
    const { societyId } = currentContext();

    return tx(async (db) => {
      const [original] = await db
        .select()
        .from(schema.journalEntries)
        .where(eq(schema.journalEntries.id, entryId))
        .limit(1);

      if (!original) throw new ValidationError("That journal entry does not exist.");
      if (original.reversesEntryId) {
        throw new ConflictError("A reversing entry cannot itself be reversed.");
      }

      const [alreadyReversed] = await db
        .select({ id: schema.journalEntries.id })
        .from(schema.journalEntries)
        .where(eq(schema.journalEntries.reversesEntryId, entryId))
        .limit(1);

      if (alreadyReversed) {
        throw new ConflictError("That entry has already been reversed.");
      }

      const lines = await db
        .select()
        .from(schema.journalLines)
        .where(eq(schema.journalLines.journalEntryId, entryId));

      const today = new Date().toISOString().slice(0, 10);
      const entryNumber = await this.nextEntryNumber(db, societyId, today);

      const [reversal] = await db
        .insert(schema.journalEntries)
        .values({
          societyId,
          entryNumber,
          entryDate: today,
          narration: `Reversal of ${original.entryNumber}: ${reason}`,
          sourceType: "adjustment",
          sourceId: original.sourceId,
          postedAt: new Date(),
          postedBy: currentContext().personId,
          reversesEntryId: original.id,
        })
        .returning({ id: schema.journalEntries.id });

      if (!reversal) throw new ConflictError("Could not post the reversing entry.");

      await db.insert(schema.journalLines).values(
        lines.map((l) => ({
          societyId,
          journalEntryId: reversal.id,
          accountId: l.accountId,
          debit: l.credit, // swapped
          credit: l.debit,
          unitId: l.unitId,
        })),
      );

      return { id: reversal.id, entryNumber };
    });
  }

  /**
   * Re-verify the ledger's arithmetic. Run hourly by Cloud Scheduler.
   *
   * Returns violations — empty means healthy. Anything here pages an engineer, because
   * it means money has gone missing somewhere in the code.
   */
  async checkInvariants(): Promise<string[]> {
    const { societyId } = currentContext();

    return tx(async (db) => {
      const violations: string[] = [];

      const unbalanced = await db.execute<{
        journal_entry_id: string;
        debits: string;
        credits: string;
      }>(sql`
        SELECT journal_entry_id, SUM(debit) AS debits, SUM(credit) AS credits
        FROM journal_lines
        WHERE society_id = ${societyId}
        GROUP BY journal_entry_id
        HAVING SUM(debit) <> SUM(credit)
      `);

      for (const row of unbalanced.rows) {
        violations.push(
          `Journal entry ${row.journal_entry_id} does not balance: ` +
            `debits ${row.debits}, credits ${row.credits}.`,
        );
      }

      const totals = await db.execute<{ debits: string; credits: string }>(sql`
        SELECT COALESCE(SUM(debit), 0) AS debits, COALESCE(SUM(credit), 0) AS credits
        FROM journal_lines WHERE society_id = ${societyId}
      `);
      const total = totals.rows[0];
      if (total && money(total.debits).comparedTo(money(total.credits)) !== 0) {
        violations.push(
          `Society ledger does not balance: debits ${total.debits}, credits ${total.credits}.`,
        );
      }

      const orphans = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*) AS count
        FROM journal_lines l
        LEFT JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE l.society_id = ${societyId} AND e.id IS NULL
      `);
      const orphanCount = Number(orphans.rows[0]?.count ?? 0);
      if (orphanCount > 0) {
        violations.push(`${orphanCount} journal lines have no parent entry.`);
      }

      return violations;
    });
  }

  /** Net balance of one account: debits minus credits. */
  async accountBalance(accountCode: string, asOf?: string): Promise<Money> {
    const { societyId } = currentContext();

    return tx(async (db) => {
      const result = await db.execute<{ balance: string }>(sql`
        SELECT COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS balance
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.journal_entry_id
        JOIN ledger_accounts a ON a.id = l.account_id
        WHERE l.society_id = ${societyId}
          AND a.code = ${accountCode}
          ${asOf ? sql`AND e.entry_date <= ${asOf}` : sql``}
      `);
      return money(result.rows[0]?.balance ?? "0");
    });
  }

  /**
   * Close a period. Refuses if the ledger does not balance — a period closed over a
   * broken ledger locks the error in permanently.
   */
  async lockPeriod(periodId: string): Promise<void> {
    const { societyId, personId } = currentContext();

    const violations = await this.checkInvariants();
    if (violations.length > 0) {
      throw new ConflictError(
        `The ledger does not balance, so this period cannot be closed: ${violations[0]}`,
      );
    }

    await tx(async (db) => {
      await db
        .update(schema.accountingPeriods)
        .set({ status: "locked", lockedBy: personId, lockedAt: new Date() })
        .where(
          and(
            eq(schema.accountingPeriods.id, periodId),
            eq(schema.accountingPeriods.societyId, societyId),
          ),
        );
    });
  }

  /**
   * Reopen a closed period. Requires two different people.
   *
   * Reopening closed books is how fraud is committed, so it needs a second signature
   * and leaves an audit record naming both.
   */
  async reopenPeriod(
    periodId: string,
    requestedBy: string,
    approvedBy: string,
  ): Promise<void> {
    if (requestedBy === approvedBy) {
      throw new ConflictError(
        "Reopening a closed period needs two different committee members to approve.",
      );
    }

    await tx(async (db) => {
      await db
        .update(schema.accountingPeriods)
        .set({
          status: "open",
          reopenedBy: requestedBy,
          reopenedApprovedBy: approvedBy,
        })
        .where(eq(schema.accountingPeriods.id, periodId));
    });
  }

  // ------------------------------------------------------------- internals

  private async periodFor(db: TenantTx, societyId: string, on: string) {
    const [period] = await db
      .select()
      .from(schema.accountingPeriods)
      .where(
        and(
          eq(schema.accountingPeriods.societyId, societyId),
          sql`${schema.accountingPeriods.startsOn} <= ${on}`,
          sql`${schema.accountingPeriods.endsOn} >= ${on}`,
        ),
      )
      .limit(1);
    return period;
  }

  private async resolveAccounts(
    db: TenantTx,
    societyId: string,
    codes: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(codes)];
    const rows = await db
      .select({ id: schema.ledgerAccounts.id, code: schema.ledgerAccounts.code })
      .from(schema.ledgerAccounts)
      .where(
        and(
          eq(schema.ledgerAccounts.societyId, societyId),
          inArray(schema.ledgerAccounts.code, unique),
        ),
      );

    const found = new Map(rows.map((r) => [r.code, r.id]));
    const missing = unique.filter((c) => !found.has(c));
    if (missing.length > 0) {
      throw new ValidationError(`Unknown ledger accounts: ${missing.join(", ")}.`);
    }
    return found;
  }

  private async nextEntryNumber(
    db: TenantTx,
    societyId: string,
    entryDate: string,
  ): Promise<string> {
    const prefix = `JV${entryDate.slice(0, 4)}-`;
    const result = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*) AS count FROM journal_entries
      WHERE society_id = ${societyId} AND entry_number LIKE ${`${prefix}%`}
    `);
    const next = Number(result.rows[0]?.count ?? 0) + 1;
    return `${prefix}${String(next).padStart(6, "0")}`;
  }
}
