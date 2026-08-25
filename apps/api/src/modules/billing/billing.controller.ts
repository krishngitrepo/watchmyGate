import { Body, Controller, Get, Param, Post, Query, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";

import { ForbiddenError } from "../../common/errors.js";
import { hasRole } from "../../common/tenant-context.js";
import { BillingService } from "./billing.service.js";
import { BillingDocumentsService, type RenderedDocument } from "./documents.service.js";

const previewSchema = z.object({
  unitId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  meterReadings: z.record(z.string()).optional(),
  manualAmounts: z.record(z.string()).optional(),
});

@Controller("v1/billing")
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly documents: BillingDocumentsService,
  ) {}

  /**
   * What a bill for this society is made of.
   *
   * The console asks for this before showing the invoice form, so a head that needs a
   * meter reading or a manual amount gets a box to type it into. Without it the
   * accountant's only route to that knowledge was submitting a preview and reading the
   * refusal — which, until `BillingError` was mapped, arrived as "Something went wrong."
   */
  @Get("charge-types")
  async chargeTypes() {
    this.requireAccounting();
    return this.billing.listChargeTypes();
  }

  /**
   * Compute an invoice without saving it.
   *
   * This is why no client needs money arithmetic of its own: the admin console calls
   * this as an accountant types, and gets back the exact figures that will be issued.
   */
  @Post("preview")
  async preview(@Body() body: unknown) {
    this.requireAccounting();
    return this.billing.preview(previewSchema.parse(body));
  }

  /** Issue the invoice and post its journal entry, atomically. */
  @Post("issue")
  async issue(@Body() body: unknown) {
    this.requireAccounting();
    return this.billing.issue(previewSchema.parse(body));
  }

  // ------------------------------------------------------------- documents
  //
  // Deliberately not behind `requireAccounting`. A resident must be able to pull their
  // own bill and their own receipt - that is the entire point of MG-5 - so the boundary
  // here is *which rows*, enforced in SQL by the service, not *which roles*.

  @Get("invoices")
  async invoices(
    @Query("unitId") unitId?: string,
    @Query("status") status?: string,
  ) {
    return this.documents.listInvoices({
      ...(unitId ? { unitId } : {}),
      ...(status ? { status } : {}),
    });
  }

  @Get("receipts")
  async receipts(@Query("unitId") unitId?: string) {
    return this.documents.listReceipts(unitId ? { unitId } : {});
  }

  @Get("invoices/:id/pdf")
  async invoicePdf(
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return this.send(response, await this.documents.invoice(id));
  }

  @Get("receipts/:id/pdf")
  async receiptPdf(
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return this.send(response, await this.documents.receipt(id));
  }

  /**
   * Headers set here rather than by `@Header`, because the filename carries the invoice
   * number - a folder of `document.pdf`, `document(1).pdf` is not a filing system.
   */
  private send(response: Response, document: RenderedDocument): StreamableFile {
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${document.filename}"`);
    response.setHeader("Content-Length", String(document.bytes.length));
    return new StreamableFile(document.bytes);
  }

  private requireAccounting(): void {
    if (!hasRole("accountant", "society_admin")) {
      // Deliberately vague — do not reveal which role would have worked.
      throw new ForbiddenError("You do not have access to this.");
    }
  }
}
