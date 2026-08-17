import { Body, Controller, Get, Post } from "@nestjs/common";
import { z } from "zod";

import { ForbiddenError } from "../../common/errors.js";
import { hasRole } from "../../common/tenant-context.js";
import { BillingService } from "./billing.service.js";

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
  constructor(private readonly billing: BillingService) {}

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

  private requireAccounting(): void {
    if (!hasRole("accountant", "society_admin")) {
      // Deliberately vague — do not reveal which role would have worked.
      throw new ForbiddenError("You do not have access to this.");
    }
  }
}
