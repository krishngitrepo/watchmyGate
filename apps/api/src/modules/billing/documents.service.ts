/**
 * Invoice and receipt PDFs (MG-5), with the penalty summary an invoice footer needs
 * (the second half of MG-12).
 *
 * ## Why a PDF at all, when the figures are on screen
 *
 * A resident who cannot download a receipt does not believe they paid. That is not a
 * technical problem and it is not solved by a better screen: the receipt is what gets
 * forwarded to a spouse, attached to an email about a disputed dues notice, and shown to
 * the next owner during a flat sale two years later. It has to be a file that outlives
 * this application.
 *
 * The same logic runs the other way for an invoice. A society that cannot hand a
 * chartered accountant a stack of PDFs at year end will keep issuing bills in Word, and
 * then the books here and the bills on the noticeboard disagree.
 *
 * ## Nothing here computes money
 *
 * Every figure is read from `invoices`, `invoice_lines` and `receipt_allocations` exactly
 * as stored. The one arithmetic operation is `total - allocated = balance`, and it goes
 * through the money package like everything else - a display balance computed with `-`
 * on two floats is exactly the bug that package exists to make unavailable.
 *
 * ## Access
 *
 * A resident may download their own flat's documents and nobody else's. The predicate is
 * evaluated in SQL against the caller's occupancies, never against a parameter they send
 * - the same rule the document repository uses, for the same reason.
 */

import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { amountInWords, format, money, subtract } from "@watchmygate/money";

import { NotFoundError } from "../../common/errors.js";
import { PAGE_WIDTH, Pdf, textWidth } from "../../common/pdf.js";
import { currentContext, hasRole, tx } from "../../common/tenant-context.js";

/** The landing page's palette, so a printed invoice looks like the product. */
const BRAND: [number, number, number] = [0.431, 0.141, 0.212];
const INK: [number, number, number] = [0.227, 0.18, 0.141];
const MUTED: [number, number, number] = [0.45, 0.4, 0.36];
const RULE: [number, number, number] = [0.85, 0.82, 0.78];
const ARREARS: [number, number, number] = [0.753, 0.204, 0.114];

const MARGIN = 42;
const RIGHT = PAGE_WIDTH - MARGIN;

export interface RenderedDocument {
  filename: string;
  bytes: Buffer;
}

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  periodStart: string;
  periodEnd: string;
  issueDate: string;
  dueDate: string;
  subtotal: string;
  gstAmount: string;
  lateFee: string;
  total: string;
  status: string;
  unitNumber: string;
  towerName: string;
  liableName: string | null;
  liablePhone: string | null;
  allocated: string;
}

interface LineRow {
  description: string;
  quantity: string;
  rate: string;
  amount: string;
  gstRate: string;
  gstAmount: string;
}

interface ReceiptRow {
  id: string;
  receiptNumber: string;
  receivedOn: string;
  amount: string;
  method: string;
  providerPaymentId: string | null;
  unverifiedUtr: string | null;
  verifiedAt: string | null;
  unitNumber: string | null;
  towerName: string | null;
  payerName: string | null;
}

interface AllocationRow {
  invoiceNumber: string;
  periodStart: string;
  periodEnd: string;
  amount: string;
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) ?? [];
}

/** `12,000.00` in Indian grouping. The `Rs.` prefix is added by the caller where wanted. */
function amount(value: string): string {
  return format(money(value), false);
}

/** `01 Apr 2026`. Unambiguous in a country where both DD/MM and MM/DD appear. */
function longDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const [year, month, day] = iso.slice(0, 10).split("-");
  return `${day} ${months[Number(month) - 1] ?? "?"} ${year}`;
}

@Injectable()
export class BillingDocumentsService {
  /**
   * The invoices this caller may see, newest first.
   *
   * There was no way to list invoices at all before this - the console showed dues by
   * flat and the money pages worked off outstanding balances, which is fine until someone
   * wants the bill for last March. A resident gets their own flats; the committee gets
   * every flat.
   */
  async listInvoices(filter: { unitId?: string; status?: string; limit?: number } = {}) {
    const limit = Math.min(filter.limit ?? 200, 500);
    return tx(async (db) =>
      rowsOf(
        await db.execute(sql`
          SELECT
            i.id,
            i.invoice_number       AS "invoiceNumber",
            i.unit_id              AS "unitId",
            u.number               AS "unitNumber",
            t.name                 AS "towerName",
            i.period_start::text   AS "periodStart",
            i.period_end::text     AS "periodEnd",
            i.issue_date::text     AS "issueDate",
            i.due_date::text       AS "dueDate",
            i.total, i.status,
            i.late_fee             AS "lateFee",
            COALESCE((
              SELECT sum(ra.amount) FROM receipt_allocations ra WHERE ra.invoice_id = i.id
            ), 0)::text            AS "allocated",
            (i.total - COALESCE((
              SELECT sum(ra.amount) FROM receipt_allocations ra WHERE ra.invoice_id = i.id
            ), 0))::text           AS "balance",
            i.due_date < current_date
              AND i.status IN ('issued', 'partially_paid') AS overdue
          FROM invoices i
          JOIN units u  ON u.id = i.unit_id
          JOIN towers t ON t.id = u.tower_id
          WHERE ${this.unitPredicate("i.unit_id")}
            AND (${filter.unitId ?? null}::uuid IS NULL OR i.unit_id = ${filter.unitId ?? null})
            AND (${filter.status ?? null}::text IS NULL OR i.status::text = ${filter.status ?? null})
          ORDER BY i.issue_date DESC, i.invoice_number DESC
          LIMIT ${limit}
        `),
      ),
    );
  }

  /** The receipts this caller may see, newest first. Same visibility rule. */
  async listReceipts(filter: { unitId?: string; limit?: number } = {}) {
    const limit = Math.min(filter.limit ?? 200, 500);
    return tx(async (db) =>
      rowsOf(
        await db.execute(sql`
          SELECT
            r.id,
            r.receipt_number      AS "receiptNumber",
            r.unit_id             AS "unitId",
            u.number              AS "unitNumber",
            t.name                AS "towerName",
            r.received_on::text   AS "receivedOn",
            r.amount, r.method,
            r.verified_at IS NOT NULL AS verified,
            COALESCE((
              SELECT sum(ra.amount) FROM receipt_allocations ra WHERE ra.receipt_id = r.id
            ), 0)::text           AS "allocated"
          FROM receipts r
          LEFT JOIN units u  ON u.id = r.unit_id
          LEFT JOIN towers t ON t.id = u.tower_id
          WHERE ${this.unitPredicate("r.unit_id")}
            AND (${filter.unitId ?? null}::uuid IS NULL OR r.unit_id = ${filter.unitId ?? null})
          ORDER BY r.received_on DESC, r.receipt_number DESC
          LIMIT ${limit}
        `),
      ),
    );
  }

  /** The tax invoice, as a resident or an auditor would file it. */
  async invoice(id: string): Promise<RenderedDocument> {
    const { societyName, gstin } = await this.societyHeader();

    const { invoice, lines, receipts } = await tx(async (db) => {
      const found = rowsOf<InvoiceRow>(
        await db.execute(sql`
          SELECT
            i.id,
            i.invoice_number          AS "invoiceNumber",
            i.period_start::text      AS "periodStart",
            i.period_end::text        AS "periodEnd",
            i.issue_date::text        AS "issueDate",
            i.due_date::text          AS "dueDate",
            i.subtotal, i.gst_amount  AS "gstAmount",
            i.late_fee                AS "lateFee",
            i.total, i.status,
            u.number                  AS "unitNumber",
            t.name                    AS "towerName",
            p.name                    AS "liableName",
            p.phone                   AS "liablePhone",
            -- Read rather than stored: an invoice's paid figure is the sum of what has
            -- actually been allocated to it, and there is only one place that can be true.
            COALESCE((
              SELECT sum(ra.amount) FROM receipt_allocations ra WHERE ra.invoice_id = i.id
            ), 0)::text                AS "allocated"
          FROM invoices i
          JOIN units u  ON u.id = i.unit_id
          JOIN towers t ON t.id = u.tower_id
          LEFT JOIN persons p ON p.id = i.liable_person_id
          WHERE i.id = ${id}
            AND ${this.unitPredicate("i.unit_id")}
        `),
      );
      if (found.length === 0) throw new NotFoundError("Invoice not found.");

      const lineRows = rowsOf<LineRow>(
        await db.execute(sql`
          SELECT description, quantity, rate, amount,
                 gst_rate   AS "gstRate",
                 gst_amount AS "gstAmount"
          FROM invoice_lines WHERE invoice_id = ${id} ORDER BY description
        `),
      );

      const receiptRows = rowsOf<AllocationRow & { receiptNumber: string; receivedOn: string }>(
        await db.execute(sql`
          SELECT r.receipt_number     AS "receiptNumber",
                 r.received_on::text  AS "receivedOn",
                 ra.amount
          FROM receipt_allocations ra
          JOIN receipts r ON r.id = ra.receipt_id
          WHERE ra.invoice_id = ${id}
          ORDER BY r.received_on
        `),
      );

      return { invoice: found[0]!, lines: lineRows, receipts: receiptRows };
    });

    const balance = subtract(money(invoice.total), money(invoice.allocated)).toFixed(2);
    const doc = new Pdf({
      title: `Invoice ${invoice.invoiceNumber}`,
      subject: `${invoice.towerName} ${invoice.unitNumber}`,
    });

    let y = this.letterhead(doc, societyName, gstin, "TAX INVOICE");

    // --- who and when ------------------------------------------------------
    doc.text("BILL TO", MARGIN, y, { font: "bold", size: 8, colour: MUTED });
    doc.text(`${invoice.towerName} ${invoice.unitNumber}`, MARGIN, y + 14, {
      font: "bold",
      size: 11,
    });
    if (invoice.liableName) {
      doc.text(invoice.liableName, MARGIN, y + 28, { size: 10 });
    }

    const factY = this.facts(doc, y, [
      ["Invoice no.", invoice.invoiceNumber],
      ["Issued", longDate(invoice.issueDate)],
      ["Due", longDate(invoice.dueDate)],
      ["Period", `${longDate(invoice.periodStart)} - ${longDate(invoice.periodEnd)}`],
    ]);

    y = Math.max(y + 46, factY + 8);

    // --- the lines ---------------------------------------------------------
    y = this.tableHead(doc, y, ["Description", "Qty", "Rate", "Amount", "GST", "Total"]);

    for (const line of lines) {
      const lineTotal = money(line.amount).plus(money(line.gstAmount)).toFixed(2);
      const afterWrap = doc.wrap(line.description, MARGIN, y, 200, { size: 9 });
      doc.textRight(amount(line.quantity), MARGIN + 250, y, { font: "mono", size: 8 });
      doc.textRight(amount(line.rate), MARGIN + 320, y, { font: "mono", size: 8 });
      doc.textRight(amount(line.amount), MARGIN + 390, y, { font: "mono", size: 8 });
      doc.textRight(
        money(line.gstAmount).isZero() ? "-" : `${amount(line.gstAmount)}`,
        MARGIN + 452,
        y,
        { font: "mono", size: 8 },
      );
      doc.textRight(amount(lineTotal), RIGHT, y, { font: "mono", size: 8 });
      y = Math.max(afterWrap, y + 14);
      doc.line(MARGIN, y - 3, RIGHT, y - 3, { colour: [0.93, 0.91, 0.88] });
    }

    if (lines.length === 0) {
      // Migrated opening balances arrive without line detail. Saying so beats an empty
      // table, which reads as a rendering fault rather than as the truth about the data.
      doc.text("No itemised charges were recorded for this invoice.", MARGIN, y, {
        size: 9,
        colour: MUTED,
      });
      y += 16;
    }

    // --- totals ------------------------------------------------------------
    y += 8;
    const totals: [string, string, boolean][] = [
      ["Subtotal", invoice.subtotal, false],
      ["GST", invoice.gstAmount, false],
      ["Late fee", invoice.lateFee, false],
      ["Total", invoice.total, true],
    ];
    for (const [label, value, strong] of totals) {
      // A zero GST line is meaningful on an Indian invoice - it says the society is below
      // the threshold, not that someone forgot. A zero late fee is just noise.
      if (label === "Late fee" && money(value).isZero()) continue;
      if (strong) {
        doc.line(RIGHT - 200, y - 4, RIGHT, y - 4, { colour: RULE, width: 0.8 });
        y += 6;
      }
      doc.text(label, RIGHT - 200, y, {
        size: strong ? 10 : 9,
        font: strong ? "bold" : "regular",
        colour: strong ? INK : MUTED,
      });
      doc.textRight(`Rs. ${amount(value)}`, RIGHT, y, {
        font: "mono",
        size: strong ? 10 : 9,
      });
      y += strong ? 18 : 14;
    }

    if (receipts.length > 0) {
      doc.text("Received", RIGHT - 200, y, { size: 9, colour: MUTED });
      doc.textRight(`Rs. ${amount(invoice.allocated)}`, RIGHT, y, { font: "mono", size: 9 });
      y += 16;
      doc.text("Balance due", RIGHT - 200, y, { size: 10, font: "bold" });
      doc.textRight(`Rs. ${amount(balance)}`, RIGHT, y, {
        font: "mono",
        size: 10,
        colour: money(balance).isZero() ? INK : ARREARS,
      });
      y += 20;

      doc.text("PAYMENTS AGAINST THIS INVOICE", MARGIN, y, {
        font: "bold",
        size: 8,
        colour: MUTED,
      });
      y += 13;
      for (const receipt of receipts) {
        doc.text(
          `${receipt.receiptNumber} on ${longDate(receipt.receivedOn)}`,
          MARGIN,
          y,
          { size: 9 },
        );
        doc.textRight(`Rs. ${amount(receipt.amount)}`, MARGIN + 250, y, {
          font: "mono",
          size: 9,
        });
        y += 13;
      }
      y += 6;
    }

    doc.text(amountInWords(money(invoice.total)), MARGIN, y, { size: 9, font: "bold" });
    y += 22;

    // --- the penalty summary (MG-12) ---------------------------------------
    if (!money(invoice.lateFee).isZero()) {
      y = await this.penaltyFooter(doc, y, invoice.lateFee);
    }

    this.footer(doc, "This is a computer-generated invoice and needs no signature.");
    return { filename: `invoice-${invoice.invoiceNumber}.pdf`, bytes: doc.build() };
  }

  /** The receipt. Shorter, and the one a resident actually keeps. */
  async receipt(id: string): Promise<RenderedDocument> {
    const { societyName, gstin } = await this.societyHeader();

    const { receipt, allocations } = await tx(async (db) => {
      const found = rowsOf<ReceiptRow>(
        await db.execute(sql`
          SELECT
            r.id,
            r.receipt_number        AS "receiptNumber",
            r.received_on::text     AS "receivedOn",
            r.amount, r.method,
            r.provider_payment_id   AS "providerPaymentId",
            r.unverified_utr        AS "unverifiedUtr",
            r.verified_at::text     AS "verifiedAt",
            u.number                AS "unitNumber",
            t.name                  AS "towerName",
            p.name                  AS "payerName"
          FROM receipts r
          LEFT JOIN units u  ON u.id = r.unit_id
          LEFT JOIN towers t ON t.id = u.tower_id
          LEFT JOIN persons p ON p.id = r.payer_person_id
          WHERE r.id = ${id}
            AND ${this.unitPredicate("r.unit_id")}
        `),
      );
      if (found.length === 0) throw new NotFoundError("Receipt not found.");

      const allocationRows = rowsOf<AllocationRow>(
        await db.execute(sql`
          SELECT i.invoice_number     AS "invoiceNumber",
                 i.period_start::text AS "periodStart",
                 i.period_end::text   AS "periodEnd",
                 ra.amount
          FROM receipt_allocations ra
          JOIN invoices i ON i.id = ra.invoice_id
          WHERE ra.receipt_id = ${id}
          ORDER BY i.period_start
        `),
      );
      return { receipt: found[0]!, allocations: allocationRows };
    });

    const doc = new Pdf({
      title: `Receipt ${receipt.receiptNumber}`,
      ...(receipt.unitNumber ? { subject: `${receipt.towerName} ${receipt.unitNumber}` } : {}),
    });

    let y = this.letterhead(doc, societyName, gstin, "RECEIPT");

    doc.text("RECEIVED FROM", MARGIN, y, { font: "bold", size: 8, colour: MUTED });
    doc.text(
      receipt.unitNumber ? `${receipt.towerName} ${receipt.unitNumber}` : "Society",
      MARGIN,
      y + 14,
      { font: "bold", size: 11 },
    );
    if (receipt.payerName) doc.text(receipt.payerName, MARGIN, y + 28, { size: 10 });

    const factY = this.facts(doc, y, [
      ["Receipt no.", receipt.receiptNumber],
      ["Received on", longDate(receipt.receivedOn)],
      ["Method", receipt.method.replace(/_/g, " ")],
    ]);

    y = Math.max(y + 46, factY + 14);

    // The amount, given the space it deserves - this is the line the resident is
    // looking for and everything else on the page is supporting detail.
    doc.rect(MARGIN, y, RIGHT - MARGIN, 44, [0.98, 0.96, 0.93]);
    doc.text("AMOUNT RECEIVED", MARGIN + 14, y + 16, { size: 8, colour: MUTED });
    doc.textRight(`Rs. ${amount(receipt.amount)}`, RIGHT - 14, y + 32, {
      font: "mono",
      size: 16,
      colour: BRAND,
    });
    y += 58;

    doc.text(amountInWords(money(receipt.amount)), MARGIN, y, { size: 9, font: "bold" });
    y += 22;

    if (allocations.length > 0) {
      doc.text("APPLIED TO", MARGIN, y, { font: "bold", size: 8, colour: MUTED });
      y += 14;
      for (const allocation of allocations) {
        doc.text(
          `${allocation.invoiceNumber}  ${longDate(allocation.periodStart)} - ${longDate(allocation.periodEnd)}`,
          MARGIN,
          y,
          { size: 9 },
        );
        doc.textRight(`Rs. ${amount(allocation.amount)}`, RIGHT, y, { font: "mono", size: 9 });
        y += 13;
      }
      y += 10;
    } else {
      // Worth saying out loud rather than leaving a blank space. An unallocated receipt
      // is money the society holds against nothing in particular - usually an advance.
      doc.text("Held as an advance; not yet applied to an invoice.", MARGIN, y, {
        size: 9,
        colour: MUTED,
      });
      y += 22;
    }

    // Provenance. A receipt whose reference cannot be traced back to a bank statement is
    // the thing an auditor queries first.
    const reference = receipt.providerPaymentId ?? receipt.unverifiedUtr;
    if (reference) {
      doc.text("Reference", MARGIN, y, { size: 8, colour: MUTED });
      doc.text(reference, MARGIN + 60, y, { font: "mono", size: 8 });
      y += 13;
    }
    if (!receipt.verifiedAt) {
      // Said plainly, because a manually keyed UTR is a claim until the bank confirms it,
      // and a receipt that hides that distinction is worse than no receipt.
      doc.text(
        "Reference entered manually and not yet confirmed against the bank.",
        MARGIN,
        y,
        { size: 8, colour: ARREARS },
      );
      y += 13;
    }

    this.footer(doc, "This is a computer-generated receipt and needs no signature.");
    return { filename: `receipt-${receipt.receiptNumber}.pdf`, bytes: doc.build() };
  }

  // ------------------------------------------------------------------ parts

  /**
   * The masthead both documents share.
   *
   * Returns the y the body should start at, so a longer society name pushes the content
   * down rather than being overprinted by it.
   */
  private letterhead(doc: Pdf, societyName: string, gstin: string | null, kind: string): number {
    doc.rect(0, 0, PAGE_WIDTH, 5, BRAND);
    doc.text(societyName, MARGIN, 48, { font: "bold", size: 15, colour: BRAND });
    doc.textRight(kind, RIGHT, 48, { font: "bold", size: 11, colour: MUTED });
    if (gstin) doc.text(`GSTIN ${gstin}`, MARGIN, 63, { size: 8, colour: MUTED });
    doc.line(MARGIN, 74, RIGHT, 74, { colour: RULE });
    return 96;
  }

  /**
   * The label/value block in the top right, and where it ends.
   *
   * Values are right-aligned against the margin with the label on the left of the same
   * line - until the pair will not fit, at which point the value drops to its own line.
   * Migrated societies carry invoice numbers like `OPEN-M82102601-2026-08-25`, and without
   * this the number printed straight through its own label.
   */
  private facts(doc: Pdf, top: number, rows: [string, string][]): number {
    const WIDTH = 190;
    const labelX = RIGHT - WIDTH;
    let y = top;
    for (const [label, value] of rows) {
      doc.text(label, labelX, y, { size: 8, colour: MUTED });
      const fits =
        textWidth(label, "regular", 8) + textWidth(value, "regular", 9) + 10 <= WIDTH;
      if (fits) {
        doc.textRight(value, RIGHT, y, { size: 9 });
        y += 13;
      } else {
        y += 11;
        doc.textRight(value, RIGHT, y, { size: 9 });
        y += 13;
      }
    }
    return y;
  }

  private tableHead(doc: Pdf, y: number, headings: string[]): number {
    const columns = [MARGIN, MARGIN + 250, MARGIN + 320, MARGIN + 390, MARGIN + 452, RIGHT];
    headings.forEach((heading, index) => {
      const x = columns[index] ?? MARGIN;
      if (index === 0) doc.text(heading, x, y, { font: "bold", size: 8, colour: MUTED });
      else doc.textRight(heading, x, y, { font: "bold", size: 8, colour: MUTED });
    });
    doc.line(MARGIN, y + 5, RIGHT, y + 5, { colour: RULE, width: 0.8 });
    return y + 18;
  }

  /**
   * The invoice-footer penalty summary (MG-12).
   *
   * A late fee that appears as a number with no explanation is the single most common
   * cause of a maintenance dispute, and the committee always ends up explaining the rule
   * by hand. Printing the rule next to the charge settles it on the page.
   */
  private async penaltyFooter(doc: Pdf, y: number, lateFee: string): Promise<number> {
    const rule = await tx(async (db) =>
      rowsOf<{ percent: string; graceDays: number }>(
        await db.execute(sql`
          SELECT late_fee_percent_per_month::text AS "percent", grace_days AS "graceDays"
          FROM gst_rules
          WHERE effective_from <= current_date
          ORDER BY effective_from DESC
          LIMIT 1
        `),
      ),
    );

    doc.rect(MARGIN, y, RIGHT - MARGIN, 40, [0.99, 0.94, 0.92]);
    doc.text("LATE PAYMENT CHARGE", MARGIN + 12, y + 15, { font: "bold", size: 8, colour: ARREARS });
    const policy = rule[0];
    const explanation = policy
      ? `Rs. ${amount(lateFee)} charged at ${policy.percent}% per month on the overdue balance, ` +
        `after a grace period of ${policy.graceDays} day${policy.graceDays === 1 ? "" : "s"} from the due date.`
      : `Rs. ${amount(lateFee)} charged on the overdue balance under the society's late payment policy.`;
    doc.wrap(explanation, MARGIN + 12, y + 28, RIGHT - MARGIN - 24, { size: 8, colour: INK });
    return y + 54;
  }

  private footer(doc: Pdf, note: string): void {
    doc.line(MARGIN, 790, RIGHT, 790, { colour: RULE });
    doc.text(note, MARGIN, 803, { size: 8, colour: MUTED });
    doc.textRight("Issued through WatchMyGate", RIGHT, 803, { size: 8, colour: MUTED });
  }

  private async societyHeader(): Promise<{ societyName: string; gstin: string | null }> {
    return tx(async (db) => {
      const rows = rowsOf<{ name: string }>(
        await db.execute(sql`SELECT name FROM societies LIMIT 1`),
      );
      // GSTIN is not modelled yet; the field is here so the letterhead does not have to
      // change when it is. See MG-14.
      return { societyName: rows[0]?.name ?? "Society", gstin: null };
    });
  }

  /**
   * "...and this row's unit is one this caller may see."
   *
   * Committee, accountant and auditor see every flat. Everyone else sees the flats they
   * currently occupy, and the check is a subquery on their own occupancies rather than
   * anything they can influence.
   */
  private unitPredicate(column: string) {
    const { personId } = currentContext();
    if (hasRole("society_admin", "mc_member", "accountant", "auditor")) {
      return sql`true`;
    }
    return sql`${sql.raw(column)} IN (
      SELECT unit_id FROM unit_occupancies
      WHERE person_id = ${personId}
        AND (valid_to IS NULL OR valid_to >= current_date)
    )`;
  }
}
