import { Controller, Get, Query } from "@nestjs/common";

import { ForbiddenError } from "../../common/errors.js";
import { hasRole } from "../../common/tenant-context.js";
import { AnalyticsService } from "./analytics.service.js";

/**
 * Reports.
 *
 * Everything here is committee or accountant work. A resident has no business seeing a
 * defaulter list — that is their neighbours' financial position, and the fastest way to
 * turn a maintenance app into a source of neighbourhood conflict.
 */
@Controller("v1/analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get("overview")
  async overview() {
    this.requireCommittee();
    return this.analytics.overview();
  }

  @Get("footfall")
  async footfall(@Query("days") days?: string) {
    this.requireCommittee();
    return this.analytics.footfall(days);
  }

  @Get("collections")
  async collections() {
    this.requireMoney();
    return this.analytics.collections();
  }

  @Get("defaulters")
  async defaulters(@Query("limit") limit?: string) {
    this.requireMoney();
    return this.analytics.defaulters(limit ? Number(limit) : undefined);
  }

  @Get("helpdesk")
  async helpdesk() {
    this.requireCommittee();
    return this.analytics.helpdesk();
  }

  @Get("staff")
  async staff(@Query("month") month?: string) {
    this.requireCommittee();
    return this.analytics.staff(month);
  }

  private requireCommittee(): void {
    if (!hasRole("society_admin", "mc_member", "accountant", "auditor")) {
      throw new ForbiddenError("Only the committee can view reports.");
    }
  }

  /** Arrears is neighbours' financial data — a narrower list than the rest. */
  private requireMoney(): void {
    if (!hasRole("society_admin", "mc_member", "accountant", "auditor")) {
      throw new ForbiddenError("Only the committee or the accountant can view arrears.");
    }
  }
}
