/**
 * Payment endpoints, including the Razorpay webhook.
 *
 * The webhook is the only unauthenticated route in this module and the only one that
 * moves money, so its signature check is the entire security boundary. Everything else
 * is committee work behind a role gate.
 */

import { Body, Controller, Get, Headers, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { AuthenticationError, ForbiddenError, ValidationError } from "../../common/errors.js";
import { hasRole } from "../../common/tenant-context.js";
import { PaymentsService } from "./payments.service.js";

const destinationSchema = z.object({
  payeeType: z.enum(["society", "person"]),
  payeeId: z.string().uuid(),
  mode: z.enum(["route_linked", "direct_merchant"]),
  merchantId: z.string().max(120).optional(),
  credentialsSecretRef: z.string().max(300).optional(),
});

const manualPaymentSchema = z.object({
  unitId: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d{1,4})?$/, "Amount must be a decimal string"),
  method: z.enum(["upi", "card", "netbanking", "neft", "cash", "cheque"]),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().max(120),
});

@Controller("v1/payments")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get("destinations")
  async destinations() {
    this.requireFinance();
    return this.payments.listDestinations();
  }

  /**
   * Register a payout destination.
   *
   * Mode 2 (`direct_merchant`) is the flat owner's own merchant account, so a tenant's
   * rent reaches them with no platform commission. Funds never touch a WatchMyGate
   * account in either mode — that is what keeps us out of RBI Payment Aggregator
   * licensing, not a preference.
   */
  @Post("destinations")
  async createDestination(@Body() body: unknown) {
    this.requireFinance();
    return this.payments.createDestination(destinationSchema.parse(body));
  }

  /**
   * Who is in credit, and by how much (MG-11).
   *
   * The other half of "outstanding". A society always owes somebody — the flat that pays
   * a round figure, the owner who settles the year in April — and until now this product
   * could only answer the question that runs in its favour.
   */
  @Get("credits")
  async credits() {
    this.requireFinance();
    return this.payments.creditBalances();
  }

  /**
   * Set held credit against open invoices, oldest due first.
   *
   * Issuing an invoice does this automatically for that flat. This endpoint exists for
   * the backlog of credit taken before the sweep existed, and for the case where an
   * invoice is voided and its payment needs somewhere to go.
   */
  @Post("credits/apply")
  async applyCredits(@Body() body: unknown) {
    this.requireFinance();
    const input = z.object({ unitId: z.string().uuid().optional() }).parse(body ?? {});
    return this.payments.applyAdvances(input.unitId);
  }

  @Get("outstanding")
  async outstanding() {
    this.requireFinance();
    return this.payments.outstandingByUnit();
  }

  /**
   * Record a payment taken outside the gateway — cash, cheque, or a bank transfer the
   * accountant has confirmed on a statement.
   *
   * Distinct from a resident *claiming* they paid: an unverified UTR is a claim awaiting
   * bank confirmation and must never mark an invoice paid on its own. This endpoint is
   * the accountant asserting they have seen the money.
   */
  @Post("manual")
  async recordManual(@Body() body: unknown) {
    this.requireFinance();
    const input = manualPaymentSchema.parse(body);

    return this.payments.recordPayment({
      // Namespaced so a manual entry can never collide with a gateway event id.
      providerEventId: `manual:${input.reference}`,
      providerPaymentId: input.reference,
      unitId: input.unitId,
      amount: input.amount,
      method: input.method,
      receivedOn: input.receivedOn,
    });
  }

  /**
   * Razorpay webhook.
   *
   * Public by necessity — Razorpay cannot hold a session — so the HMAC signature is the
   * only thing standing between this endpoint and anyone who learns the URL being able
   * to mark every invoice in every society paid.
   *
   * Always answers 200 once the signature verifies, even for events we ignore. A non-2xx
   * makes Razorpay retry indefinitely, and retrying an event we have deliberately
   * skipped achieves nothing but noise.
   */
  @Post("webhook/razorpay")
  async webhook(
    @Req() req: Request & { rawBody?: string },
    @Headers("x-razorpay-signature") signature: string | undefined,
  ) {
    if (!signature) {
      throw new AuthenticationError("Missing webhook signature.");
    }

    // The RAW body, not the parsed one: JSON.parse followed by JSON.stringify does not
    // round-trip byte-for-byte (key order, whitespace, unicode escapes), and the HMAC is
    // over the exact bytes Razorpay sent. Verifying a re-serialised body fails randomly.
    const raw = req.rawBody;
    if (!raw) {
      throw new ValidationError(
        "Raw request body unavailable — the webhook cannot be verified.",
      );
    }

    if (!this.payments.verifyWebhookSignature(raw, signature)) {
      throw new AuthenticationError("Webhook signature did not verify.");
    }

    const event = JSON.parse(raw) as {
      event: string;
      payload?: { payment?: { entity?: Record<string, unknown> } };
    };

    if (event.event !== "payment.captured") {
      return { status: "ignored", event: event.event };
    }

    const payment = event.payload?.payment?.entity;
    if (!payment) return { status: "ignored", reason: "no payment entity" };

    const notes = (payment.notes ?? {}) as Record<string, string>;

    const result = await this.payments.recordPayment({
      providerEventId: String(payment.id),
      providerPaymentId: String(payment.id),
      ...(notes.unitId ? { unitId: notes.unitId } : {}),
      // Razorpay reports paise as an integer. Converting to rupees via division on a
      // float is exactly the bug this codebase exists to avoid, so it is done as string
      // arithmetic: pad to at least 3 digits, then insert a decimal point.
      amount: paiseToRupees(Number(payment.amount)),
      method: mapMethod(String(payment.method ?? "")),
      receivedOn: new Date((Number(payment.created_at) || Date.now() / 1000) * 1000)
        .toISOString()
        .slice(0, 10),
    });

    return { status: result.duplicate ? "already_recorded" : "recorded", ...result };
  }

  private requireFinance(): void {
    if (!hasRole("accountant", "society_admin", "mc_member")) {
      throw new ForbiddenError("Only the committee or accountant can manage payments.");
    }
  }
}

/**
 * Convert integer paise to a rupee decimal string.
 *
 * Returns a string, never a number. Not because `paise / 100` is inexact — for realistic
 * amounts it is exact — but because the result of that division is a **float**, and
 * float error accumulates across a summation. Adding 250 flats' worth of Rs 25.99 as
 * floats yields 6497.499999999964 rather than 6497.50, which is then reconciled against
 * a bank statement that disagrees.
 *
 * `money()` refuses JS numbers outright for the same reason. String manipulation keeps
 * the value exact all the way to Decimal without ever passing through a double.
 */
export function paiseToRupees(paise: number): string {
  if (!Number.isInteger(paise) || paise < 0) {
    throw new ValidationError(`Invalid paise amount from the gateway: ${paise}`);
  }
  const padded = String(paise).padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

/** Razorpay method names to our payment_method enum. */
export function mapMethod(
  method: string,
): "upi" | "card" | "netbanking" | "neft" | "cash" | "cheque" {
  switch (method) {
    case "upi":
      return "upi";
    case "card":
      return "card";
    case "netbanking":
      return "netbanking";
    case "bank_transfer":
      return "neft";
    default:
      // Unknown methods land as netbanking rather than throwing: the money genuinely
      // arrived, and refusing to record it because we do not recognise the rail would
      // leave the books wrong in a worse way than a slightly imprecise label.
      return "netbanking";
  }
}
