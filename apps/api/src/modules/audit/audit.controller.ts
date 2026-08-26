/**
 * Reading the audit log (MG-45).
 *
 * The log has been immutable since migration 0001 — `INSERT` and `SELECT` granted to the
 * application role, `UPDATE` and `DELETE` withheld — and until now it was also empty and
 * unreadable. Both halves mattered: an audit log nobody can read is a compliance artefact
 * rather than a tool, and a committee that cannot answer "who granted that person admin"
 * without a database console will not answer it at all.
 *
 * ## Who reads it
 *
 * Admin, committee and auditor. Not staff, not residents. The log names who did what,
 * which makes it a record of colleagues' actions as much as of events, and a society
 * where every resident can read the committee's every act is a society where the
 * committee stops using the system.
 *
 * The one exception is a person's own entries, which they may always read — a log that
 * records what was done to somebody and hides it from them is the shape DPDP section 11
 * exists to prevent.
 */

import { Controller, Get, Query } from "@nestjs/common";

import { AuditService } from "../../common/audit.service.js";
import { ForbiddenError } from "../../common/errors.js";
import { currentContext, hasRole } from "../../common/tenant-context.js";

@Controller("v1/audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * Search it.
   *
   * Filtered rather than paged, because an audit log is consulted with a question in
   * mind — what happened to this invoice, what did this person do in March — and
   * scrolling months of entries answers none of them.
   */
  @Get()
  async search(
    @Query("action") action?: string,
    @Query("entityType") entityType?: string,
    @Query("entityId") entityId?: string,
    @Query("actorPersonId") actorPersonId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
  ) {
    const { personId } = currentContext();
    const committee = hasRole("society_admin", "mc_member", "auditor");

    // A resident may read their own entries and only their own. Forced here rather than
    // trusted from the query string: a resident asking for somebody else's actor id would
    // otherwise be asking, and receiving.
    const actor = committee ? actorPersonId : personId;
    if (!committee && actorPersonId && actorPersonId !== personId) {
      throw new ForbiddenError("You can only read your own entries in the audit log.");
    }

    return this.audit.search({
      action,
      entityType,
      entityId,
      actorPersonId: actor,
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * What kinds of entry exist, and how many.
   *
   * Drives the console's filter, so it offers what the log actually contains rather than
   * a hardcoded list that drifts from reality the first time an action is added.
   */
  @Get("actions")
  async actions() {
    if (!hasRole("society_admin", "mc_member", "auditor")) {
      throw new ForbiddenError("The audit log is committee and auditor work.");
    }
    return this.audit.actions();
  }
}
