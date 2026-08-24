/**
 * Privacy and consent.
 *
 * The role split here is the whole design. **A person may always act on their own data**
 * — read their consents, withdraw one, export everything held about them, ask for
 * erasure — with no committee permission, because those are statutory rights and a right
 * that needs approval is not a right.
 *
 * What is committee work: publishing notice text, carrying out an erasure, setting
 * retention, and reading the CCTV access log.
 */

import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { ForbiddenError, NotFoundError } from "../../common/errors.js";
import { currentContext, hasRole } from "../../common/tenant-context.js";
import {
  CONSENT_PURPOSES,
  PrivacyService,
  RETENTION_DEFAULTS,
} from "./privacy.service.js";

const noticeSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  version: z.string().min(1).max(32),
  language: z.string().max(8).optional(),
  body: z.string().min(20).max(20000),
});

const consentSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  noticeVersion: z.string().min(1).max(32),
  granted: z.boolean(),
});

const cctvSchema = z.object({
  cameraRef: z.string().min(1).max(120),
  fromTs: z.string().datetime(),
  toTs: z.string().datetime(),
  // Ten characters is also enforced by a database constraint. "checking" is not a reason.
  reason: z.string().min(10).max(1000),
});

const retentionSchema = z.object({
  subject: z.string().min(1).max(40),
  days: z.number().int().min(1).max(3650),
  reason: z.string().max(1000).optional(),
});

@Controller("v1/privacy")
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  /**
   * Who to contact, and what this society keeps.
   *
   * Open to every member. A Data Protection Officer nobody can find is not published,
   * and DPDP requires the contact to be reachable.
   */
  @Get("notice")
  async publicNotice() {
    return {
      dataProtectionOfficer: {
        name: "Data Protection Officer, WatchMyGate",
        email: "privacy@watchmygate.in",
        /** Named in-app rather than buried in a policy page nobody opens. */
        respondsWithin: "30 days",
      },
      grievanceRedressal:
        "Write to the address above. If unsatisfied, you may complain to the Data Protection Board of India.",
      yourRights: [
        "Know what is held about you, and get a copy (section 11).",
        "Have it corrected or erased (section 12).",
        "Withdraw consent as easily as you gave it (section 6(6)).",
        "Nominate someone to exercise these rights if you cannot.",
      ],
      whatWeKeepAndForHowLong: Object.entries(RETENTION_DEFAULTS).map(
        ([subject, { days, why }]) => ({ subject, days, why }),
      ),
      whatWeWillNeverDo: [
        "Store an Aadhaar number. Section 57 was struck down; only a verification outcome and a masked last four digits are kept.",
        "Sell or share your data with advertisers.",
        "Use gate records to profile domestic staff or delivery workers.",
      ],
    };
  }

  @Get("notices")
  async notices(@Query("purpose") purpose?: string) {
    return this.privacy.notices(purpose);
  }

  @Post("notices")
  async publishNotice(@Body() body: unknown) {
    this.requireCommittee();
    return this.privacy.publishNotice(noticeSchema.parse(body));
  }

  // ------------------------------------------------------------ consents

  /** Your own standing, or — for the committee — anyone's. */
  @Get("consents")
  async consents(@Query("personId") personId?: string) {
    const { personId: caller } = currentContext();
    const subject = personId ?? caller!;

    if (subject !== caller) this.requireCommittee();
    return this.privacy.standing(subject);
  }

  @Post("consents")
  async record(@Body() body: unknown) {
    // No role check. Recording your own consent is the act the whole Act is built on.
    return this.privacy.record(consentSchema.parse(body));
  }

  /**
   * Withdraw.
   *
   * s.6(6) says withdrawal must be as easy as granting, so this deliberately has no
   * confirmation step, no committee approval and no cooling-off period.
   */
  @Delete("consents/:id")
  async withdraw(@Param("id") id: string) {
    const { personId } = currentContext();
    const standing = await this.privacy.standing(personId!);

    // A person may withdraw their own consent, and the committee may withdraw on
    // someone's behalf when they ask in person — which is how most of this will happen
    // for residents who do not use the app.
    const ownsIt = standing.some((row) => row.consentId === id);
    if (!ownsIt) this.requireCommittee();

    return this.privacy.withdraw(id);
  }

  // -------------------------------------------------------------- export

  /** Everything held about you. Yours by right; anyone else's needs the committee. */
  @Get("export")
  async exportSelf(@Query("personId") personId?: string) {
    const { personId: caller } = currentContext();
    const subject = personId ?? caller!;
    if (subject !== caller) this.requireCommittee();
    return this.privacy.exportPerson(subject);
  }

  // ------------------------------------------------------------- erasure

  @Post("erasure")
  async requestErasure(@Body() body: unknown) {
    const input = z
      .object({ personId: z.string().uuid().optional() })
      .parse(body ?? {});
    const { personId: caller } = currentContext();
    const subject = input.personId ?? caller!;

    if (subject !== caller) this.requireCommittee();
    return this.privacy.requestErasure(subject, caller!);
  }

  @Get("erasure")
  async listErasures() {
    this.requireCommittee();
    return this.privacy.erasureRequests();
  }

  /**
   * Carry it out.
   *
   * Committee work, and the response says what was kept as well as what went. Financial
   * and audit records are retained under s.8(7); a workflow that reported unqualified
   * success while keeping the ledger would be worse than one that says so.
   */
  @Post("erasure/:id/complete")
  async completeErasure(@Param("id") id: string) {
    this.requireCommittee();
    return this.privacy.completeErasure(id);
  }

  @Get("erasure/overdue")
  async overdue() {
    this.requireCommittee();
    return this.privacy.overdueErasures();
  }

  // ----------------------------------------------------------- retention

  @Get("retention")
  async retention() {
    this.requireCommittee();
    return this.privacy.retentionPolicies();
  }

  @Post("retention")
  async setRetention(@Body() body: unknown) {
    if (!hasRole("society_admin")) {
      throw new ForbiddenError("Only a society admin can change retention.");
    }
    const input = retentionSchema.parse(body);
    return this.privacy.setRetention(input.subject, input.days, input.reason);
  }

  @Get("retention/runs")
  async retentionRuns() {
    this.requireCommittee();
    return this.privacy.retentionRuns();
  }

  /**
   * Run the purge now.
   *
   * Normally driven by Cloud Scheduler through the worker. Exposed here so a committee
   * can demonstrate to an auditor that the policy is enforced rather than configured.
   */
  @Post("retention/purge")
  async purge() {
    if (!hasRole("society_admin")) {
      throw new ForbiddenError("Only a society admin can run a purge.");
    }
    return { runs: await this.privacy.purge() };
  }

  // ---------------------------------------------------------------- cctv

  @Post("cctv/access")
  async logCctv(@Body() body: unknown) {
    if (!hasRole("society_admin", "mc_member", "guard")) {
      throw new ForbiddenError("Only a guard or the committee can view footage.");
    }
    return this.privacy.logCctvAccess(cctvSchema.parse(body));
  }

  /**
   * Who has been watching.
   *
   * Committee-readable on purpose. The usual failure with CCTV is not a breach — it is a
   * committee member idly watching who visits whom, and the only thing that reliably
   * stops that is other committee members being able to see them doing it.
   */
  @Get("cctv/access")
  async cctvAccesses() {
    this.requireCommittee();
    return this.privacy.cctvAccesses();
  }

  private requireCommittee(): void {
    if (!hasRole("society_admin", "mc_member")) {
      throw new NotFoundError("Not found.");
    }
  }
}
