/**
 * Payments.
 *
 * ## The constraint that shapes everything here
 *
 * **Money must never enter a WatchMyGate account.** Collecting maintenance on behalf of
 * a society is money movement for a third party, and doing that through our own account
 * requires an RBI Payment Aggregator licence — a regime this company cannot satisfy and
 * should not try to.
 *
 * So funds always settle directly to the payee, in one of two modes:
 *
 *   `route_linked`    Razorpay Route. The society is a linked account; Razorpay settles
 *                     to the society's own bank. We never take custody.
 *
 *   `direct_merchant` The flat owner supplies their own Razorpay merchant ID, so a
 *                     tenant's rent lands in the owner's account with **zero platform
 *                     commission**. We hold the merchant id and a reference to their
 *                     credentials in Secret Manager — never the credentials themselves.
 *
 * Our own SaaS fee is billed separately as an ordinary B2B invoice. That single decision
 * is what keeps the company outside the licensing regime.
 *
 * Note for the UI: in Mode 2 the gateway's own MDR still applies. Default to UPI, which
 * is genuinely 0% by RBI mandate, and label it "no WatchMyGate fee" rather than "free" —
 * because the second claim is false and the first is exactly true.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";

import { schema } from "@watchmygate/db";
import { money, toDbString, ZERO } from "@watchmygate/money";

import { loadConfig } from "../../common/config.js";
import { ConflictError, NotFoundError, ValidationError } from "../../common/errors.js";
import { currentContext, tx } from "../../common/tenant-context.js";
import { LedgerService } from "../ledger/ledger.service.js";

export interface RecordPaymentInput {
  /** Provider event id — the idempotency key. Razorpay retries webhooks aggressively. */
  providerEventId: string;
  providerPaymentId: string;
  unitId?: string | undefined;
  amount: string;
  method: "upi" | "card" | "netbanking" | "neft" | "cash" | "cheque";
  receivedOn: string;
  payerPersonId?: string | undefined;
  destinationId?: string | undefined;
  /** Invoices to settle, oldest first if not given. */
  allocateTo?: Array<{ invoiceId: string; amount: string }> | undefined;
}

@Injectable()
export class PaymentsService {
  private readonly config = loadConfig();

  constructor(private readonly ledger: LedgerService) {}

  // ------------------------------------------------------------ destinations

  /**
   * Register where money for a payee should land.
   *
   * Credentials are **references to Secret Manager paths**, never secrets. A gateway
   * key in our database is a breach waiting to be someone else's problem — and in Mode 2
   * those keys belong to an individual flat owner who trusted us with them.
   */
  async createDestination(input: {
    payeeType: "society" | "person";
    payeeId: string;
    mode: "route_linked" | "direct_merchant";
    merchantId?: string | undefined;
    credentialsSecretRef?: string | undefined;
  }) {
    const { societyId } = currentContext();

    if (input.credentialsSecretRef && !/^(projects|secret):/.test(input.credentialsSecretRef)) {
      throw new ValidationError(
        "credentialsSecretRef must be a Secret Manager reference, not a credential. " +
          "Store the key in Secret Manager and pass its path.",
      );
    }

    return tx(async (db) => {
      const [destination] = await db
        .insert(schema.paymentDestinations)
        .values({
          societyId,
          payeeType: input.payeeType,
          payeeId: input.payeeId,
          mode: input.mode,
          provider: "razorpay",
          merchantId: input.merchantId ?? null,
          credentialsSecretRef: input.credentialsSecretRef ?? null,
          status: "pending",
        })
        .returning();
      return destination!;
    });
  }

  async listDestinations() {
    return tx(async (db) =>
      db
        .select({
          id: schema.paymentDestinations.id,
          payeeType: schema.paymentDestinations.payeeType,
          payeeId: schema.paymentDestinations.payeeId,
          mode: schema.paymentDestinations.mode,
          merchantId: schema.paymentDestinations.merchantId,
          status: schema.paymentDestinations.status,
          virtualAccountNumber: schema.paymentDestinations.virtualAccountNumber,
          virtualIfsc: schema.paymentDestinations.virtualIfsc,
          // credentialsSecretRef deliberately not selected — it does not need to travel.
        })
        .from(schema.paymentDestinations)
        .orderBy(desc(schema.paymentDestinations.createdAt)),
    );
  }

  /**
   * Which destination collects a given charge for a given unit.
   *
   * Unit-specific routing wins over society-wide, which is what makes Mode 2 work: rent
   * for flat B-101 goes to that owner's merchant account while maintenance for the same
   * flat goes to the society.
   */
  async resolveDestination(chargeTypeCode: string, unitId: string) {
    return tx(async (db) => {
      const rows = await db
        .select()
        .from(schema.chargeTypeRouting)
        .where(eq(schema.chargeTypeRouting.chargeTypeCode, chargeTypeCode));

      const specific = rows.find((r) => r.unitId === unitId);
      const societyWide = rows.find((r) => r.unitId === null);
      const chosen = specific ?? societyWide;
      if (!chosen) return null;

      const [destination] = await db
        .select()
        .from(schema.paymentDestinations)
        .where(eq(schema.paymentDestinations.id, chosen.destinationId))
        .limit(1);

      return destination ?? null;
    });
  }

  // ---------------------------------------------------------------- webhooks

  /**
   * Verify a Razorpay webhook signature.
   *
   * Rejecting unsigned callbacks is the whole security boundary here: without it,
   * anyone who learns the URL can mark every invoice in every society paid.
   *
   * Constant-time comparison — a plain `===` leaks the expected digest a byte at a time
   * to anyone who can measure response latency.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const secret = this.config.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      // No secret configured means we cannot verify, and an unverifiable payment
      // notification must be refused rather than trusted.
      return false;
    }

    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Record a payment and allocate it against invoices.
   *
   * **Idempotent by provider event id.** Razorpay retries until it gets a 2xx, so the
   * same payment arrives several times as a matter of course. A duplicate returns the
   * original receipt rather than creating a second one — recording a payment twice would
   * show a resident as having paid double and corrupt the society's books.
   *
   * The receipt, its allocations and the journal entry are one transaction. A receipt
   * without a ledger entry is money that exists on a statement but not in the books.
   */
  async recordPayment(input: RecordPaymentInput) {
    const { societyId } = currentContext();
    const amount = money(input.amount);

    if (amount.lte(ZERO)) {
      throw new ValidationError("A payment must be for a positive amount.");
    }

    // Fast path for the common retry: already recorded, nothing to do.
    const existing = await tx(async (db) =>
      db
        .select({ id: schema.receipts.id, receiptNumber: schema.receipts.receiptNumber })
        .from(schema.receipts)
        .where(eq(schema.receipts.providerEventId, input.providerEventId))
        .limit(1),
    );

    if (existing.length > 0) {
      return { ...existing[0]!, duplicate: true as const };
    }

    return tx(async (db) => {
      const receiptNumber = await this.nextReceiptNumber(db, societyId);

      let receiptId: string;
      try {
        const [receipt] = await db
          .insert(schema.receipts)
          .values({
            societyId,
            unitId: input.unitId ?? null,
            receiptNumber,
            receivedOn: input.receivedOn,
            amount: toDbString(amount),
            method: input.method,
            providerPaymentId: input.providerPaymentId,
            providerEventId: input.providerEventId,
            destinationId: input.destinationId ?? null,
            payerPersonId: input.payerPersonId ?? null,
            verifiedAt: new Date(),
          })
          .returning({ id: schema.receipts.id });
        receiptId = receipt!.id;
      } catch (error) {
        // Two deliveries racing: the unique index on provider_event_id is the arbiter,
        // and losing that race is the correct outcome rather than an error.
        if (/duplicate key|unique/i.test((error as Error).message)) {
          const [already] = await db
            .select({ id: schema.receipts.id, receiptNumber: schema.receipts.receiptNumber })
            .from(schema.receipts)
            .where(eq(schema.receipts.providerEventId, input.providerEventId))
            .limit(1);
          if (already) return { ...already, duplicate: true as const };
        }
        throw error;
      }

      const allocations = input.allocateTo
        ? input.allocateTo
        : await this.allocateOldestFirst(db, societyId, input.unitId, amount);

      let allocated = ZERO;
      for (const allocation of allocations) {
        const allocationAmount = money(allocation.amount);
        allocated = allocated.plus(allocationAmount) as typeof allocated;

        await db.insert(schema.receiptAllocations).values({
          societyId,
          receiptId,
          invoiceId: allocation.invoiceId,
          amount: toDbString(allocationAmount),
        });

        await this.refreshInvoiceStatus(db, allocation.invoiceId);
      }

      if (allocated.gt(amount)) {
        throw new ConflictError(
          "Allocations exceed the payment amount. Refusing to over-apply a receipt.",
        );
      }

      // Debit bank, credit the resident's receivable. The unallocated remainder sits as
      // an advance against the unit rather than vanishing.
      const entry = await this.ledger.postEntry({
        entryDate: input.receivedOn,
        narration: `Receipt ${receiptNumber} — ${input.method.toUpperCase()}`,
        sourceType: "receipt",
        sourceId: receiptId,
        postings: [
          { accountCode: "1000", debit: amount, unitId: input.unitId },
          { accountCode: "1200", credit: amount, unitId: input.unitId },
        ],
      });

      await db
        .update(schema.receipts)
        .set({ journalEntryId: entry.id, updatedAt: new Date() })
        .where(eq(schema.receipts.id, receiptId));

      return {
        id: receiptId,
        receiptNumber,
        allocated: toDbString(allocated),
        unallocated: toDbString(amount.minus(allocated) as typeof amount),
        duplicate: false as const,
      };
    });
  }

  /**
   * Apply a payment to the oldest outstanding invoices first.
   *
   * The convention residents expect and the one that minimises late fees for them. Doing
   * it newest-first would quietly maximise our customers' interest charges, which is
   * both wrong and the kind of thing that gets noticed.
   */
  private async allocateOldestFirst(
    db: Parameters<Parameters<typeof tx>[0]>[0],
    societyId: string,
    unitId: string | undefined,
    amount: ReturnType<typeof money>,
  ): Promise<Array<{ invoiceId: string; amount: string }>> {
    if (!unitId) return [];

    const outstanding = await db
      .select({
        id: schema.invoices.id,
        total: schema.invoices.total,
        paid: sql<string>`coalesce((
          SELECT sum(a.amount) FROM receipt_allocations a WHERE a.invoice_id = ${schema.invoices.id}
        ), 0)`,
      })
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.unitId, unitId),
          sql`${schema.invoices.status} IN ('issued','partially_paid')`,
        ),
      )
      .orderBy(schema.invoices.dueDate);

    const plan: Array<{ invoiceId: string; amount: string }> = [];
    let remaining = amount;

    for (const invoice of outstanding) {
      if (remaining.lte(ZERO)) break;

      const due = money(invoice.total).minus(money(invoice.paid));
      if (due.lte(ZERO)) continue;

      const applied = remaining.lt(due) ? remaining : due;
      plan.push({ invoiceId: invoice.id, amount: toDbString(applied as typeof amount) });
      remaining = remaining.minus(applied) as typeof amount;
    }

    return plan;
  }

  /** Recompute paid / partially_paid from allocations, never from a running total. */
  private async refreshInvoiceStatus(
    db: Parameters<Parameters<typeof tx>[0]>[0],
    invoiceId: string,
  ): Promise<void> {
    const [invoice] = await db
      .select({
        total: schema.invoices.total,
        paid: sql<string>`coalesce((
          SELECT sum(a.amount) FROM receipt_allocations a WHERE a.invoice_id = ${invoiceId}
        ), 0)`,
      })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoiceId))
      .limit(1);

    if (!invoice) throw new NotFoundError("That invoice does not exist.");

    const total = money(invoice.total);
    const paid = money(invoice.paid);
    const status = paid.gte(total) ? "paid" : paid.gt(ZERO) ? "partially_paid" : "issued";

    await db
      .update(schema.invoices)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.invoices.id, invoiceId));
  }

  private async nextReceiptNumber(
    db: Parameters<Parameters<typeof tx>[0]>[0],
    societyId: string,
  ): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = `R${year}-`;

    const [last] = await db
      .select({ number: schema.receipts.receiptNumber })
      .from(schema.receipts)
      .where(sql`${schema.receipts.receiptNumber} LIKE ${prefix + "%"}`)
      .orderBy(desc(schema.receipts.receiptNumber))
      .limit(1);

    const next = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(next).padStart(5, "0")}`;
  }

  /** Outstanding dues per unit — the defaulter list. */
  async outstandingByUnit() {
    return tx(async (db) =>
      db
        .select({
          unitId: schema.invoices.unitId,
          invoices: sql<string>`count(*)`,
          billed: sql<string>`coalesce(sum(${schema.invoices.total}), 0)`,
          paid: sql<string>`coalesce(sum((
            SELECT coalesce(sum(a.amount), 0) FROM receipt_allocations a
             WHERE a.invoice_id = ${schema.invoices.id}
          )), 0)`,
          oldestDue: sql<string>`min(${schema.invoices.dueDate})`,
        })
        .from(schema.invoices)
        .where(sql`${schema.invoices.status} IN ('issued','partially_paid')`)
        .groupBy(schema.invoices.unitId),
    );
  }
}
