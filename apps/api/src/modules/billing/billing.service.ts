/**
 * Invoice generation.
 *
 * Every number here comes from `@watchmygate/money` — the same package the admin
 * console and the desktop app import. The preview endpoint runs the identical code
 * path as the real run, so what an accountant sees while editing is what will be
 * issued, and what is issued is what is filed for GST.
 */

import { Injectable } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";

import { schema, type TenantTx } from "@watchmygate/db";
import {
  ZERO,
  applyGst,
  computeLine,
  lateFee,
  money,
  toDbString,
  totalInvoice,
  type ChargeSpec,
  type ComputedLine,
  type GstContext,
  type Money,
  type UnitFacts,
} from "@watchmygate/money";

import { ConflictError, NotFoundError, ValidationError } from "../../common/errors.js";
import { currentContext, tx } from "../../common/tenant-context.js";
import { LedgerService } from "../ledger/ledger.service.js";

export interface PreviewInput {
  unitId: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  /** Meter readings for this period, keyed by charge-type code. */
  meterReadings?: Record<string, string>;
  /** Manual amounts for `manual` charge types, keyed by code. */
  manualAmounts?: Record<string, string>;
}

export interface PreviewResult {
  unitId: string;
  lines: Array<{
    code: string;
    description: string;
    quantity: string;
    rate: string;
    amount: string;
    gstRate: string;
    gstAmount: string;
  }>;
  subtotal: string;
  gstAmount: string;
  lateFee: string;
  total: string;
  gstApplied: boolean;
}

@Injectable()
export class BillingService {
  constructor(private readonly ledger: LedgerService) {}

  /**
   * Compute an invoice without saving it.
   *
   * This is what the admin console calls as an accountant types, so that no client ever
   * needs to do money arithmetic of its own.
   */
  async preview(input: PreviewInput): Promise<PreviewResult> {
    const { societyId } = currentContext();

    return tx(async (db) => {
      const { lines, gstCtx, unitOutstanding } = await this.computeFor(
        db,
        societyId,
        input,
      );

      const withGst = applyGst(lines, gstCtx);
      const rules = await this.gstRules(db, societyId);

      const fee = lateFee(
        unitOutstanding,
        new Date(`${input.dueDate}T00:00:00Z`),
        new Date(),
        {
          percentPerMonth: new Decimal(rules.lateFeePercentPerMonth),
          graceDays: rules.graceDays,
        },
      );

      const totals = totalInvoice(withGst, { lateFeeAmount: fee });

      return {
        unitId: input.unitId,
        lines: withGst.map((l) => ({
          code: l.code,
          description: l.description,
          quantity: l.quantity.toString(),
          rate: l.rate.toFixed(2),
          amount: l.amount.toFixed(2),
          gstRate: l.gstRate.toString(),
          gstAmount: l.gstAmount.toFixed(2),
        })),
        subtotal: totals.subtotal.toFixed(2),
        gstAmount: totals.gstAmount.toFixed(2),
        lateFee: totals.lateFee.toFixed(2),
        total: totals.total.toFixed(2),
        gstApplied: !totals.gstAmount.isZero(),
      };
    });
  }

  /**
   * Issue an invoice and post its journal entry in one transaction.
   *
   * Both or neither: an invoice without a ledger entry is money that exists on a bill
   * but not in the books, which is exactly the discrepancy an auditor finds.
   */
  async issue(input: PreviewInput): Promise<{ invoiceId: string; invoiceNumber: string }> {
    const { societyId } = currentContext();

    return tx(async (db) => {
      const existing = await db
        .select({ id: schema.invoices.id })
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.societyId, societyId),
            eq(schema.invoices.unitId, input.unitId),
            eq(schema.invoices.periodStart, input.periodStart),
            sql`${schema.invoices.status} <> 'void'`,
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        throw new ConflictError(
          "This flat has already been billed for that period. Void the existing " +
            "invoice first if it needs replacing.",
        );
      }

      const { lines, gstCtx, unitOutstanding } = await this.computeFor(
        db,
        societyId,
        input,
      );
      const withGst = applyGst(lines, gstCtx);
      const rules = await this.gstRules(db, societyId);

      const fee = lateFee(
        unitOutstanding,
        new Date(`${input.dueDate}T00:00:00Z`),
        new Date(),
        {
          percentPerMonth: new Decimal(rules.lateFeePercentPerMonth),
          graceDays: rules.graceDays,
        },
      );
      const totals = totalInvoice(withGst, { lateFeeAmount: fee });

      // Who is liable is resolved now and frozen. If the tenant moves out next week,
      // this invoice still belongs to whoever was liable when it was raised.
      const liablePersonId = await this.liablePerson(db, societyId, input.unitId);
      const invoiceNumber = await this.nextInvoiceNumber(
        db,
        societyId,
        issueYear(input.periodStart),
      );

      const [invoice] = await db
        .insert(schema.invoices)
        .values({
          societyId,
          unitId: input.unitId,
          invoiceNumber,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          issueDate: new Date().toISOString().slice(0, 10),
          dueDate: input.dueDate,
          subtotal: toDbString(totals.subtotal),
          gstAmount: toDbString(totals.gstAmount),
          lateFee: toDbString(totals.lateFee),
          total: toDbString(totals.total),
          status: "issued",
          liablePersonId,
        })
        .returning({ id: schema.invoices.id });

      if (!invoice) throw new ConflictError("Could not create the invoice.");

      const chargeTypes = await this.chargeTypes(db, societyId);
      await db.insert(schema.invoiceLines).values(
        withGst.map((l) => ({
          societyId,
          invoiceId: invoice.id,
          chargeTypeId: chargeTypes.find((c) => c.code === l.code)!.id,
          description: l.description,
          quantity: l.quantity.toString(),
          rate: toDbString(l.rate),
          amount: toDbString(l.amount),
          gstRate: l.gstRate.toString(),
          gstAmount: toDbString(l.gstAmount),
        })),
      );

      // Debit the resident's receivable, credit income and GST payable.
      const postings = [
        { accountCode: "1200", debit: totals.total, unitId: input.unitId },
        ...withGst
          .filter((l) => !l.amount.isZero())
          .map((l) => ({
            accountCode: chargeTypes.find((c) => c.code === l.code)!.accountCode,
            credit: l.amount,
            unitId: input.unitId,
          })),
      ];
      if (!totals.gstAmount.isZero()) {
        postings.push({ accountCode: "2300", credit: totals.gstAmount, unitId: input.unitId });
      }
      if (!totals.lateFee.isZero()) {
        postings.push({ accountCode: "4900", credit: totals.lateFee, unitId: input.unitId });
      }

      const entry = await this.ledger.postEntry({
        entryDate: new Date().toISOString().slice(0, 10),
        narration: `Invoice ${invoiceNumber}`,
        sourceType: "invoice",
        sourceId: invoice.id,
        postings,
      });

      await db
        .update(schema.invoices)
        .set({ journalEntryId: entry.id })
        .where(eq(schema.invoices.id, invoice.id));

      return { invoiceId: invoice.id, invoiceNumber };
    });
  }

  // ------------------------------------------------------------- internals

  private async computeFor(
    db: TenantTx,
    societyId: string,
    input: PreviewInput,
  ): Promise<{ lines: ComputedLine[]; gstCtx: GstContext; unitOutstanding: Money }> {
    const [unit] = await db
      .select()
      .from(schema.units)
      .where(eq(schema.units.id, input.unitId))
      .limit(1);

    if (!unit) throw new NotFoundError("That flat does not exist.");

    const charges = await this.chargeTypes(db, societyId);
    if (charges.length === 0) {
      throw new ValidationError(
        "No charge types are configured for this society yet.",
      );
    }

    const lines: ComputedLine[] = [];
    let runningBase = ZERO;

    for (const charge of charges) {
      const spec: ChargeSpec = {
        code: charge.code,
        name: charge.name,
        formula: charge.formula,
        rate: money(charge.rate),
        gstApplicable: charge.gstApplicable,
        gstRate: new Decimal(charge.gstRate),
      };

      const facts: UnitFacts = {
        ...(unit.carpetAreaSqft
          ? { carpetAreaSqft: new Decimal(unit.carpetAreaSqft) }
          : {}),
        ...(unit.bhk !== null ? { bhk: unit.bhk } : {}),
        ...(input.meterReadings?.[charge.code]
          ? { meterReadingUnits: new Decimal(input.meterReadings[charge.code]!) }
          : {}),
        // `percentage` charges (sinking fund) apply to the running total of everything
        // billed before them, so ordering of charge types is significant.
        ...(charge.formula === "percentage"
          ? { baseAmount: runningBase }
          : charge.formula === "manual" && input.manualAmounts?.[charge.code]
            ? { baseAmount: money(input.manualAmounts[charge.code]!) }
            : {}),
      };

      const line = computeLine(spec, facts);
      lines.push(line);
      if (charge.formula !== "percentage") {
        runningBase = runningBase.plus(line.amount) as Money;
      }
    }

    const rules = await this.gstRules(db, societyId);
    const gstCtx: GstContext = {
      monthlyThresholdPerMember: money(rules.monthlyThresholdPerMember),
      annualTurnoverThreshold: money(rules.annualTurnoverThreshold),
      societyTurnover: money(rules.societyTurnover),
      rate: new Decimal(rules.rate),
    };

    const outstanding = await db.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(i.total), 0) - COALESCE((
        SELECT SUM(ra.amount) FROM receipt_allocations ra
        JOIN invoices i2 ON i2.id = ra.invoice_id
        WHERE i2.unit_id = ${input.unitId} AND i2.society_id = ${societyId}
      ), 0) AS total
      FROM invoices i
      WHERE i.society_id = ${societyId} AND i.unit_id = ${input.unitId}
        AND i.status IN ('issued', 'partially_paid')
    `);

    return {
      lines,
      gstCtx,
      unitOutstanding: money(outstanding.rows[0]?.total ?? "0"),
    };
  }

  private async chargeTypes(db: TenantTx, societyId: string) {
    const rows = await db
      .select({
        id: schema.chargeTypes.id,
        code: schema.chargeTypes.code,
        name: schema.chargeTypes.name,
        formula: schema.chargeTypes.formula,
        rate: schema.chargeTypes.rate,
        gstApplicable: schema.chargeTypes.gstApplicable,
        gstRate: schema.chargeTypes.gstRate,
        accountId: schema.chargeTypes.accountId,
        accountCode: schema.ledgerAccounts.code,
      })
      .from(schema.chargeTypes)
      .innerJoin(
        schema.ledgerAccounts,
        eq(schema.ledgerAccounts.id, schema.chargeTypes.accountId),
      )
      .where(
        and(
          eq(schema.chargeTypes.societyId, societyId),
          eq(schema.chargeTypes.isActive, true),
          eq(schema.chargeTypes.isRecurring, true),
        ),
      );
    return rows;
  }

  private async gstRules(db: TenantTx, societyId: string) {
    const [rules] = await db
      .select()
      .from(schema.gstRules)
      .where(eq(schema.gstRules.societyId, societyId))
      .orderBy(sql`effective_from DESC`)
      .limit(1);

    // Statutory defaults if a society has not configured its own.
    return (
      rules ?? {
        monthlyThresholdPerMember: "7500",
        annualTurnoverThreshold: "2000000",
        societyTurnover: "0",
        rate: "18",
        lateFeePercentPerMonth: "0",
        graceDays: 0,
      }
    );
  }

  private async liablePerson(
    db: TenantTx,
    societyId: string,
    unitId: string,
  ): Promise<string | null> {
    const [row] = await db
      .select({ personId: schema.unitOccupancies.personId })
      .from(schema.unitOccupancies)
      .where(
        and(
          eq(schema.unitOccupancies.societyId, societyId),
          eq(schema.unitOccupancies.unitId, unitId),
          eq(schema.unitOccupancies.isBillingLiable, true),
          isNull(schema.unitOccupancies.validTo),
          isNull(schema.unitOccupancies.supersededAt),
        ),
      )
      .limit(1);
    return row?.personId ?? null;
  }

  private async nextInvoiceNumber(
    db: TenantTx,
    societyId: string,
    year: number,
  ): Promise<string> {
    const prefix = `INV${year}-`;
    const result = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*) AS count FROM invoices
      WHERE society_id = ${societyId} AND invoice_number LIKE ${`${prefix}%`}
    `);
    return `${prefix}${String(Number(result.rows[0]?.count ?? 0) + 1).padStart(6, "0")}`;
  }
}

/**
 * The invoice number uses the **billing period's** year, not today's.
 *
 * A December run executed on 2 January must still be numbered as a December invoice,
 * otherwise the sequence jumps a year mid-cycle and the auditor's numbering check fails.
 */
function issueYear(periodStart: string): number {
  return Number(periodStart.slice(0, 4));
}
