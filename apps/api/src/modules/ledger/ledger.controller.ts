/**
 * The books.
 *
 * Everything here is committee, accountant or auditor work. A resident has no business
 * reading the society's trial balance, and a neighbour's house statement is their
 * financial position — the fastest way to turn a maintenance app into a source of
 * neighbourhood conflict.
 *
 * Note the split between `requireBooks` and `requireAccounting`: an **auditor can read
 * everything and change nothing**. That is what an auditor is for, and giving them a
 * write path would defeat the point of having the role at all.
 */

import { Body, Controller, Delete, Get, Header, Param, Post, Query } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { schema } from "@watchmygate/db";

import { ForbiddenError, NotFoundError } from "../../common/errors.js";
import { currentContext, hasRole, tx } from "../../common/tenant-context.js";
import { LedgerService } from "./ledger.service.js";
import { BudgetService } from "./budget.service.js";
import { ReportsService } from "./reports.service.js";
import { TallyService } from "./tally.service.js";

const budgetLineSchema = z.object({
  accountId: z.string().uuid(),
  annualAmount: z.string().regex(/^\d+(\.\d{1,4})?$/, "Amounts are decimal strings"),
  notes: z.string().max(500).optional(),
});

const budgetSchema = z.object({
  financialYear: z.number().int().min(2000).max(2100),
  title: z.string().min(1).max(160),
  notes: z.string().max(2000).optional(),
  lines: z.array(budgetLineSchema).default([]),
});

@Controller("v1/ledger")
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly reports: ReportsService,
    private readonly tally: TallyService,
    private readonly budgets: BudgetService,
  ) {}

  @Get("accounts")
  async accounts(@Query("asOf") asOf?: string) {
    this.requireBooks();
    return this.reports.chartOfAccounts(asOf);
  }

  @Get("trial-balance")
  async trialBalance(@Query("asOf") asOf?: string) {
    this.requireBooks();
    return this.reports.trialBalance(asOf);
  }

  @Get("income-expenditure")
  async incomeExpenditure(@Query("from") from?: string, @Query("to") to?: string) {
    this.requireBooks();
    return this.reports.incomeAndExpenditure(from, to);
  }

  @Get("balance-sheet")
  async balanceSheet(@Query("asOf") asOf?: string) {
    this.requireBooks();
    return this.reports.balanceSheet(asOf);
  }

  @Get("cash-flow")
  async cashFlow(@Query("from") from?: string, @Query("to") to?: string) {
    this.requireBooks();
    return this.reports.cashFlow(from, to);
  }

  /** Late fees charged, recovered and still outstanding, with the rule that produced them. */
  @Get("penalties")
  async penalties(@Query("from") from?: string, @Query("to") to?: string) {
    this.requireBooks();
    return this.reports.penalties(from, to);
  }

  @Get("day-book")
  async dayBook(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("accountId") accountId?: string,
  ) {
    this.requireBooks();
    return this.reports.dayBook(from, to, accountId);
  }

  /**
   * One flat's account.
   *
   * A resident may read **their own** statement — that is the whole point of publishing
   * it — but only their own. The check is against their occupancy rather than against a
   * unit id in the query string, because trusting the query string would let any
   * resident read any neighbour's finances.
   */
  @Get("house-statement")
  async houseStatement(
    @Query("unitId") unitId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    if (!unitId) throw new NotFoundError("Which flat?");

    if (!hasRole("society_admin", "mc_member", "accountant", "auditor")) {
      const { personId } = currentContext();
      const occupies = await tx(async (db) =>
        db
          .select({ id: schema.unitOccupancies.id })
          .from(schema.unitOccupancies)
          .where(
            and(
              eq(schema.unitOccupancies.unitId, unitId),
              eq(schema.unitOccupancies.personId, personId!),
            ),
          )
          .limit(1),
      );
      if (occupies.length === 0) {
        // A 404 rather than a 403: telling someone "that flat exists but is not yours"
        // is itself a disclosure they did not need.
        throw new NotFoundError("No statement for that flat.");
      }
    }

    return this.reports.houseStatement(unitId, from, to);
  }

  // ---------------------------------------------------------------- export

  /**
   * The books, as a file Tally will actually import.
   *
   * Restricted to the roles that can already read the books, and no narrower. An
   * accountant who can see the trial balance on screen and cannot export it is being
   * obstructed rather than controlled.
   */
  @Get("export/tally")
  @Header("Content-Type", "application/xml; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="watchmygate-tally.xml"')
  async exportTally(@Query("from") from: string, @Query("to") to: string) {
    this.requireBooks();
    const society = await tx(async (db) =>
      db.select({ name: schema.societies.name }).from(schema.societies).limit(1),
    );
    return this.tally.exportXml(
      society[0]?.name ?? "Society",
      from ?? financialYearStart(),
      to ?? new Date().toISOString().slice(0, 10),
    );
  }

  /** The same books as CSV, for anyone not running Tally. */
  @Get("export/csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="watchmygate-ledger.csv"')
  async exportCsv(@Query("from") from: string, @Query("to") to: string) {
    this.requireBooks();
    return this.tally.exportCsv(
      from ?? financialYearStart(),
      to ?? new Date().toISOString().slice(0, 10),
    );
  }

  // --------------------------------------------------------------- budgets

  @Get("budgets")
  async budgetList() {
    this.requireBooks();
    return this.budgets.list();
  }

  /**
   * Budget against actual, head by head.
   *
   * Includes heads spent on but never budgeted, which is the row an auditor asks about
   * and a report that only walks the budget lines cannot show.
   */
  @Get("budgets/variance")
  async budgetVariance(@Query("year") year?: string, @Query("asOf") asOf?: string) {
    this.requireBooks();
    return this.budgets.variance(year ? Number(year) : undefined, asOf);
  }

  @Post("budgets")
  async createBudget(@Body() body: unknown) {
    return this.budgets.create(budgetSchema.parse(body));
  }

  @Post("budgets/:id/lines")
  async setBudgetLines(@Param("id") id: string, @Body() body: unknown) {
    const input = z.object({ lines: z.array(budgetLineSchema) }).parse(body);
    return this.budgets.setLines(id, input.lines);
  }

  /** Passing a budget is a committee act, and not by whoever drafted it. */
  @Post("budgets/:id/approve")
  async approveBudget(@Param("id") id: string, @Body() body: unknown) {
    const input = z.object({ resolutionRef: z.string().min(4).max(160) }).parse(body);
    return this.budgets.approve(id, input.resolutionRef);
  }

  @Delete("budgets/:id")
  async discardBudget(@Param("id") id: string) {
    return this.budgets.discard(id);
  }

  @Post("budgets/:id/revise")
  async reviseBudget(@Param("id") id: string) {
    return this.budgets.revise(id);
  }

  @Get("invariants")
  async invariants() {
    this.requireBooks();
    const problems = await this.ledger.checkInvariants();
    return { ok: problems.length === 0, problems };
  }

  // --------------------------------------------------------------- periods

  @Get("periods")
  async periods() {
    this.requireBooks();
    return tx(async (db) =>
      db
        .select()
        .from(schema.accountingPeriods)
        .orderBy(schema.accountingPeriods.startsOn),
    );
  }

  /**
   * Lock a period after the committee has signed the accounts off.
   *
   * Nothing can be posted into a locked period. That is the control an auditor is
   * looking for when they ask whether finalised figures can be tampered with — and the
   * honest answer has to be enforced rather than promised.
   */
  @Post("periods/:id/lock")
  async lockPeriod(@Param("id") id: string) {
    this.requireAccounting();
    await this.ledger.lockPeriod(id);
    return { status: "locked" };
  }

  /**
   * Reopen a locked period — deliberately awkward.
   *
   * Requires a *second* named person, because reopening closed books is how fraud is
   * concealed. One committee member acting alone cannot do it, and both names plus the
   * reason go into the audit log.
   */
  @Post("periods/:id/reopen")
  async reopenPeriod(@Param("id") id: string, @Body() body: unknown) {
    if (!hasRole("society_admin")) {
      throw new ForbiddenError("Only a society admin can reopen a closed period.");
    }
    const input = z
      .object({
        approvedByPersonId: z.string().uuid(),
        reason: z.string().min(10).max(500),
      })
      .parse(body);

    const { personId } = currentContext();
    if (input.approvedByPersonId === personId) {
      throw new ForbiddenError(
        "Reopening needs a second person. You cannot approve your own request.",
      );
    }

    // (requestedBy, approvedBy) — the service refuses if they are the same person, and
    // writes both names and the stated reason to the audit log in the same transaction
    // as the reopening itself.
    await this.ledger.reopenPeriod(id, personId!, input.approvedByPersonId, input.reason);
    return { status: "reopened", reason: input.reason };
  }

  /** Committee, accountant and auditor may read the books. */
  private requireBooks(): void {
    if (!hasRole("society_admin", "mc_member", "accountant", "auditor")) {
      throw new ForbiddenError("Only the committee or the accountant can read the books.");
    }
  }

  /** Changing the books is narrower — and never the auditor. */
  private requireAccounting(): void {
    if (!hasRole("society_admin", "accountant")) {
      throw new ForbiddenError("Only the accountant or a society admin can do that.");
    }
  }
}

/** 1 April of the financial year we are currently in. Statutory, so not configurable. */
function financialYearStart(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  return `${now.getUTCMonth() + 1 >= 4 ? year : year - 1}-04-01`;
}
