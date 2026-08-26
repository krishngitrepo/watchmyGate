/**
 * Gate endpoints — guard app and resident app.
 *
 * The guard app's normal day, in three calls:
 *
 *   GET  /v1/gate/keys        once per shift, so passes verify with no network
 *   POST /v1/gate/sync        drains the outbox whenever there is signal
 *   POST /v1/gate/approvals   only for visitors with no pre-approved pass
 *
 * Note what is absent: there is no "check this pass" endpoint on the hot path. A
 * pre-approved visitor is verified entirely on the handset against a cached public key.
 * That is the point of the whole design — the gate keeps working when the network does
 * not, which at an Indian apartment gate is most of the time.
 */

import { Body, Controller, Get, Header, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { ForbiddenError } from "../../common/errors.js";
import { hasRole } from "../../common/tenant-context.js";
import { ApprovalService } from "./approval.service.js";
import { GateService, type OutboxEvent } from "./gate.service.js";
import { RegisterService } from "./register.service.js";

const categories = ["guest", "delivery", "cab", "courier", "service", "staff"] as const;

const outboxEventSchema = z.object({
  id: z.string().uuid(),
  gateId: z.string().uuid().optional(),
  unitId: z.string().uuid().optional(),
  passId: z.string().uuid().optional(),
  direction: z.enum(["entry", "exit"]),
  category: z.enum(categories),
  visitorName: z.string().max(120).optional(),
  visitorPhone: z.string().max(16).optional(),
  vehicleNumber: z.string().max(20).optional(),
  photoKey: z.string().max(500).optional(),
  verifiedOffline: z.boolean().optional(),
  deviceTs: z.string(),
});

const syncSchema = z.object({
  events: z.array(outboxEventSchema).max(500),
});

const issuePassSchema = z.object({
  unitId: z.string().uuid(),
  visitorName: z.string().min(1).max(120),
  visitorPhone: z.string().max(16).optional(),
  category: z.enum(categories),
  vehicleNumber: z.string().max(20).optional(),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date(),
  maxUses: z.number().int().min(1).max(100).optional(),
  /**
   * The resident device's Ed25519 public key, base64url raw, 32 bytes.
   *
   * Supplying it issues a v2 pass whose displayed QR carries a 30-second proof, so a
   * forwarded screenshot stops working. Omitting it issues v1, which is genuine and
   * reproducible from a photograph — the honest default for a device that has not
   * enrolled rather than a silent downgrade.
   */
  holderPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
});

const approvalRequestSchema = z.object({
  unitId: z.string().uuid(),
  category: z.enum(categories),
  visitorName: z.string().max(120).optional(),
  visitorPhone: z.string().max(16).optional(),
  photoKey: z.string().max(500).optional(),
  gateEventId: z.string().uuid().optional(),
});

@Controller("v1/gate")
export class GateController {
  constructor(
    private readonly gate: GateService,
    private readonly approvals: ApprovalService,
    private readonly registerService: RegisterService,
  ) {}

  /**
   * Public keys for offline verification, newest first.
   *
   * Several, not one: a pass signed just before a key rotation must still verify on a
   * handset that has not synced since. Returning only the current key would lock out
   * every offline device on rotation day.
   */
  @Get("keys")
  async keys() {
    this.requireGuard();
    return { keys: await this.gate.publicKeysForDevice() };
  }

  /**
   * Drain the guard app's offline outbox.
   *
   * Idempotent on the client-generated event id, so the app can retry the same batch on
   * a flaky connection without duplicating entries. Per-event results let it clear only
   * what actually landed.
   */
  @Post("sync")
  async sync(@Body() body: unknown) {
    this.requireGuard();
    const { events } = syncSchema.parse(body);
    return this.gate.sync(events as OutboxEvent[]);
  }

  @Post("passes")
  async issuePass(@Body() body: unknown) {
    const input = issuePassSchema.parse(body);
    return this.gate.issuePass(input);
  }

  @Get("passes/:id")
  async getPass(@Param("id") id: string) {
    return this.gate.getPass(id);
  }

  @Post("passes/:id/revoke")
  async revokePass(@Param("id") id: string) {
    await this.gate.revokePass(id);
    return { status: "revoked" };
  }

  /** Guard has an unexpected visitor. Starts the approval ladder. */
  @Post("approvals")
  async requestApproval(@Body() body: unknown) {
    this.requireGuard();
    return this.approvals.request(approvalRequestSchema.parse(body));
  }

  @Get("approvals/pending")
  async pending() {
    return this.approvals.pending();
  }

  @Get("approvals/:id")
  async approval(@Param("id") id: string) {
    return this.approvals.get(id);
  }

  /**
   * Every ladder step that fired, with timestamps.
   *
   * Deliberately exposed to the resident, not just to staff. "I never got a
   * notification" is the argument this product exists to end, and it ends with evidence
   * rather than an apology.
   */
  @Get("approvals/:id/history")
  async history(@Param("id") id: string) {
    return { rungs: await this.approvals.history(id) };
  }

  @Post("approvals/:id/decision")
  async decide(@Param("id") id: string, @Body() body: unknown) {
    const { decision } = z
      .object({ decision: z.enum(["approved", "denied"]) })
      .parse(body);
    return this.approvals.resolve(id, decision);
  }

  /**
   * The register — the book on the desk at the gate, replaced (MG-22).
   *
   * Committee work: it is every visitor's name, phone number and vehicle for the period,
   * which is not something a neighbour gets to browse.
   */
  @Get("register")
  async register(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("category") category?: string,
    @Query("unitId") unitId?: string,
    @Query("q") q?: string,
    @Query("insideOnly") insideOnly?: string,
  ) {
    this.requireCommittee();
    return this.registerService.list({
      from,
      to,
      category,
      unitId,
      q,
      insideOnly: insideOnly === "true",
    });
  }

  /**
   * The register as a spreadsheet.
   *
   * A `reason` is required and recorded, because four hundred residents' movements in one
   * file is a disclosure rather than a read. Same treatment as CCTV footage.
   */
  @Get("register/export")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="gate-register.csv"')
  async exportRegister(
    @Query("reason") reason: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("category") category?: string,
    @Query("unitId") unitId?: string,
    @Query("q") q?: string,
  ) {
    this.requireCommittee();
    return this.registerService.exportCsv({ from, to, category, unitId, q }, reason ?? "");
  }

  @Get("events")
  async events(@Query("unitId") unitId: string, @Query("limit") limit?: string) {
    return this.gate.recentForUnit(unitId, limit ? Number(limit) : 50);
  }

  @Get("inside")
  async inside() {
    return this.gate.stillInside();
  }

  /**
   * Guard devices are society property and shared between shifts, so they hold a
   * different and narrower authority than a resident's phone.
   */
  /** The register names and tracks people. It is not a neighbourhood noticeboard. */
  private requireCommittee(): void {
    if (!hasRole("society_admin", "mc_member")) {
      throw new ForbiddenError("The gate register is committee work.");
    }
  }

  private requireGuard(): void {
    if (!hasRole("guard", "society_admin")) {
      throw new ForbiddenError("This endpoint is for gate devices.");
    }
  }
}
