/**
 * Resident complaints.
 *
 * Built around the worked example: a resident reports *"Light is not working in the
 * lift"* under Common Area → Lift → Lighting with two photos; it routes to the mapped
 * vendor with the committee watching; an SLA timer starts; it escalates if nobody
 * fixes it; resolution requires a proof-of-fix photo; and the resident can rate it or
 * reopen it within seven days.
 */

import { Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";

import { schema, type TenantTx } from "@watchmygate/db";

import { ConflictError, NotFoundError, ValidationError } from "../../common/errors.js";
import { currentContext, isStaff, tx } from "../../common/tenant-context.js";

/** A resident may reopen within this window; after it, a new complaint is required. */
const REOPEN_WINDOW_DAYS = 7;
const MAX_ATTACHMENTS = 5;
/** Window in which a similar report on the same location counts as the same issue. */
const DUPLICATE_WINDOW_HOURS = 48;

const OPEN_STATES = ["open", "in_progress", "reopened"] as const;

const STOPWORDS = new Set([
  "the", "is", "are", "in", "on", "at", "a", "an", "of",
  "not", "no", "and", "to", "for", "my", "working",
]);

export interface RaiseComplaintInput {
  categoryId: string;
  title: string;
  // `| undefined` throughout: tsconfig sets exactOptionalPropertyTypes, so an optional
  // property and a property that may hold undefined are different types.
  description?: string | undefined;
  locationType: "unit" | "tower" | "floor" | "amenity" | "common";
  unitId?: string | undefined;
  locationRef?: string | undefined;
  locationNote?: string | undefined;
  priority?: "low" | "normal" | "high" | "urgent" | undefined;
  voiceTranscriptLanguage?: string | undefined;
}

@Injectable()
export class HelpdeskService {
  /**
   * Raise a complaint, route it, start its SLA clock.
   *
   * If an open common-area complaint already covers the same problem, the existing
   * ticket is returned with the caller subscribed rather than a duplicate created —
   * three residents reporting one dark lift produce one ticket and three notifications.
   */
  async raise(input: RaiseComplaintInput): Promise<{ id: string; ticketNumber: string; merged: boolean }> {
    const { societyId, personId } = currentContext();

    return tx(async (db) => {
      const [category] = await db
        .select()
        .from(schema.ticketCategories)
        .where(eq(schema.ticketCategories.id, input.categoryId))
        .limit(1);

      if (!category) throw new NotFoundError("That complaint category does not exist.");
      if (!category.isActive) {
        throw new ValidationError("That complaint category is no longer in use.");
      }
      if (input.locationType === "unit" && !input.unitId) {
        throw new ValidationError("Select which flat this complaint is about.");
      }

      const duplicate = await this.findDuplicate(db, societyId, input);
      if (duplicate) {
        await this.subscribe(db, societyId, duplicate.id, personId, "co_reporter");
        await db.insert(schema.ticketEvents).values({
          societyId,
          ticketId: duplicate.id,
          actorId: personId,
          type: "comment",
          body: "Also reported by another resident.",
          visibility: "public",
        });
        return {
          id: duplicate.id,
          ticketNumber: duplicate.ticketNumber,
          merged: true,
        };
      }

      const now = new Date();
      const ticketNumber = await this.nextTicketNumber(db, societyId);

      const [ticket] = await db
        .insert(schema.tickets)
        .values({
          societyId,
          ticketNumber,
          raisedBy: personId,
          unitId: input.unitId ?? null,
          locationType: input.locationType,
          locationRef: input.locationRef ?? null,
          locationNote: input.locationNote ?? null,
          categoryId: input.categoryId,
          title: input.title.trim(),
          description: input.description?.trim() ?? null,
          voiceTranscriptLanguage: input.voiceTranscriptLanguage ?? null,
          status: "open",
          priority: input.priority ?? "normal",
          assigneeId: category.defaultAssigneeId,
          vendorId: category.defaultVendorId,
          slaDueAt: new Date(now.getTime() + category.slaHours * 3_600_000),
          escalationDueAt: new Date(now.getTime() + category.escalationHours * 3_600_000),
        })
        .returning({ id: schema.tickets.id });

      if (!ticket) throw new ConflictError("Could not raise the complaint.");

      await this.subscribe(db, societyId, ticket.id, personId, "reporter");
      if (category.defaultAssigneeId) {
        await this.subscribe(db, societyId, ticket.id, category.defaultAssigneeId, "assignee");
      }
      for (const watcher of await this.committeeWatchers(db, societyId)) {
        await this.subscribe(db, societyId, ticket.id, watcher, "committee");
      }

      return { id: ticket.id, ticketNumber, merged: false };
    });
  }

  /**
   * Record a file the client has already uploaded straight to R2.
   *
   * The two lift photos never pass through this API — that is what makes photo
   * attachments affordable at scale.
   */
  async attach(
    ticketId: string,
    input: {
      r2Key: string;
      contentType: string;
      bytes: number;
      kind: "photo" | "video" | "voice" | "document";
      isProofOfFix?: boolean;
    },
  ): Promise<{ id: string }> {
    const { societyId, personId } = currentContext();

    return tx(async (db) => {
      const ticket = await this.getTicket(db, ticketId);

      // count(*) always returns a row, but noUncheckedIndexedAccess cannot know that,
      // so the fallback is stated rather than asserted away with a non-null assertion.
      const [countRow] = await db
        .select({ count: sql<string>`count(*)` })
        .from(schema.attachments)
        .where(
          and(
            eq(schema.attachments.ownerType, "ticket"),
            eq(schema.attachments.ownerId, ticket.id),
            eq(schema.attachments.isProofOfFix, input.isProofOfFix ?? false),
          ),
        );

      if (Number(countRow?.count ?? 0) >= MAX_ATTACHMENTS) {
        throw new ValidationError(
          `A complaint can carry at most ${MAX_ATTACHMENTS} attachments.`,
        );
      }

      const [attachment] = await db
        .insert(schema.attachments)
        .values({
          societyId,
          ownerType: "ticket",
          ownerId: ticket.id,
          r2Key: input.r2Key,
          contentType: input.contentType,
          bytes: input.bytes,
          kind: input.kind,
          uploadedBy: personId,
          isProofOfFix: input.isProofOfFix ?? false,
        })
        .returning({ id: schema.attachments.id });

      if (!attachment) throw new ConflictError("Could not attach the file.");

      await db.insert(schema.ticketEvents).values({
        societyId,
        ticketId: ticket.id,
        actorId: personId,
        type: "attachment",
        body: input.isProofOfFix ? "Proof of fix attached." : "Attachment added.",
        visibility: "public",
      });

      return { id: attachment.id };
    });
  }

  /**
   * Move a complaint through its lifecycle.
   *
   * Resolving requires a proof-of-fix attachment. Without it, "resolved" means only
   * that somebody clicked a button — which is precisely what residents complain about
   * with every incumbent product.
   */
  async changeStatus(
    ticketId: string,
    newStatus: "open" | "in_progress" | "resolved" | "closed",
    note?: string,
  ): Promise<void> {
    const { societyId, personId } = currentContext();

    await tx(async (db) => {
      const ticket = await this.getTicket(db, ticketId);
      if (ticket.status === newStatus) return;

      const now = new Date();
      const patch: Record<string, unknown> = { status: newStatus };

      if (newStatus === "resolved") {
        const [proofRow] = await db
          .select({ count: sql<string>`count(*)` })
          .from(schema.attachments)
          .where(
            and(
              eq(schema.attachments.ownerType, "ticket"),
              eq(schema.attachments.ownerId, ticket.id),
              eq(schema.attachments.isProofOfFix, true),
            ),
          );

        // No proof photo means not resolved. The resident has to be able to see that
        // the light actually works now, not just read that someone says it does.
        if (Number(proofRow?.count ?? 0) === 0) {
          throw new ValidationError(
            "Attach a photo showing the completed repair before marking this resolved.",
          );
        }
        patch.resolvedAt = now;
        patch.resolvedBy = personId;
      }

      if (newStatus === "closed") patch.closedAt = now;

      await db.update(schema.tickets).set(patch).where(eq(schema.tickets.id, ticket.id));

      await db.insert(schema.ticketEvents).values({
        societyId,
        ticketId: ticket.id,
        actorId: personId,
        type: "status_change",
        body: note ?? `Status changed from ${ticket.status} to ${newStatus}.`,
        visibility: "public",
      });
    });
  }

  /** Reopen within seven days of resolution — the lift light is out again. */
  async reopen(ticketId: string, reason: string): Promise<void> {
    const { societyId, personId } = currentContext();

    await tx(async (db) => {
      const ticket = await this.getTicket(db, ticketId);

      if (!["resolved", "closed"].includes(ticket.status) || !ticket.resolvedAt) {
        throw new ConflictError("Only a resolved complaint can be reopened.");
      }

      const daysSince =
        (Date.now() - ticket.resolvedAt.getTime()) / 86_400_000;
      if (daysSince > REOPEN_WINDOW_DAYS) {
        throw new ConflictError(
          `This complaint was resolved more than ${REOPEN_WINDOW_DAYS} days ago. ` +
            "Please raise a new one.",
        );
      }

      const [category] = await db
        .select()
        .from(schema.ticketCategories)
        .where(eq(schema.ticketCategories.id, ticket.categoryId))
        .limit(1);

      const now = new Date();
      await db
        .update(schema.tickets)
        .set({
          status: "reopened",
          resolvedAt: null,
          resolvedBy: null,
          closedAt: null,
          escalatedAt: null,
          reopenCount: ticket.reopenCount + 1,
          // The SLA restarts: a reopened complaint is live work, not history.
          slaDueAt: new Date(now.getTime() + (category?.slaHours ?? 24) * 3_600_000),
          escalationDueAt: new Date(
            now.getTime() + (category?.escalationHours ?? 48) * 3_600_000,
          ),
        })
        .where(eq(schema.tickets.id, ticket.id));

      await db.insert(schema.ticketEvents).values({
        societyId,
        ticketId: ticket.id,
        actorId: personId,
        type: "reopen",
        body: reason,
        visibility: "public",
      });
    });
  }

  async rate(ticketId: string, stars: number, comment?: string): Promise<void> {
    const { societyId, personId } = currentContext();

    if (stars < 1 || stars > 5) {
      throw new ValidationError("Rating must be between 1 and 5.");
    }

    await tx(async (db) => {
      const ticket = await this.getTicket(db, ticketId);

      if (!["resolved", "closed"].includes(ticket.status)) {
        throw new ConflictError("You can rate a complaint once it has been resolved.");
      }
      if (ticket.raisedBy !== personId) {
        throw new ConflictError(
          "Only the resident who raised this complaint can rate it.",
        );
      }

      await db
        .update(schema.tickets)
        .set({ rating: stars, ratingComment: comment ?? null })
        .where(eq(schema.tickets.id, ticket.id));

      await db.insert(schema.ticketEvents).values({
        societyId,
        ticketId: ticket.id,
        actorId: personId,
        type: "rating",
        body: comment ?? `Rated ${stars}/5.`,
        visibility: "public",
      });
    });
  }

  /**
   * The thread, filtered for the viewer.
   *
   * Staff-only notes are removed here rather than in the controller, so no endpoint can
   * forget and leak an internal note to the resident it is about.
   */
  async events(ticketId: string) {
    const staff = isStaff();

    return tx(async (db) => {
      const rows = await db
        .select()
        .from(schema.ticketEvents)
        .where(
          and(
            eq(schema.ticketEvents.ticketId, ticketId),
            staff ? undefined : eq(schema.ticketEvents.visibility, "public"),
          ),
        )
        .orderBy(schema.ticketEvents.createdAt);
      return rows;
    });
  }

  /**
   * List complaints.
   *
   * Residents see their own plus every common-area complaint — that visibility is what
   * stops a fourth person reporting the same lift.
   */
  async list(opts: { status?: string; mineOnly?: boolean } = {}) {
    const { personId } = currentContext();
    const staff = isStaff();

    return tx(async (db) => {
      const conditions = [];

      if (opts.mineOnly) {
        conditions.push(eq(schema.tickets.raisedBy, personId));
      } else if (!staff) {
        conditions.push(
          or(
            eq(schema.tickets.raisedBy, personId),
            ne(schema.tickets.locationType, "unit"),
          ),
        );
      }

      if (opts.status) {
        conditions.push(
          eq(schema.tickets.status, opts.status as (typeof OPEN_STATES)[number]),
        );
      }

      return db
        .select()
        .from(schema.tickets)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.tickets.createdAt))
        .limit(200);
    });
  }

  /** Open tickets past their escalation threshold. Driven by the 15-minute sweep. */
  async dueForEscalation(db: TenantTx, societyId: string, now = new Date()) {
    return db
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.societyId, societyId),
          inArray(schema.tickets.status, [...OPEN_STATES]),
          lte(schema.tickets.escalationDueAt, now),
          isNull(schema.tickets.escalatedAt),
        ),
      );
  }

  // ------------------------------------------------------------- internals

  /**
   * Detect an existing open report of the same problem.
   *
   * Only common-area issues merge. Two residents reporting "lift light is out" in the
   * same tower is one fault; two residents reporting a leaking tap in their own flats
   * is two faults, so unit-scoped tickets are never merged.
   */
  private async findDuplicate(
    db: TenantTx,
    societyId: string,
    input: RaiseComplaintInput,
  ) {
    if (input.locationType === "unit") return null;

    const since = new Date(Date.now() - DUPLICATE_WINDOW_HOURS * 3_600_000);
    const candidates = await db
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.societyId, societyId),
          eq(schema.tickets.categoryId, input.categoryId),
          eq(schema.tickets.locationType, input.locationType),
          inArray(schema.tickets.status, [...OPEN_STATES]),
          isNull(schema.tickets.duplicateOf),
          gte(schema.tickets.createdAt, since),
          input.locationRef
            ? eq(schema.tickets.locationRef, input.locationRef)
            : isNull(schema.tickets.locationRef),
        ),
      );

    const incoming = this.keywords(`${input.title} ${input.description ?? ""}`);
    if (incoming.size === 0) return null;

    for (const candidate of candidates) {
      const existing = this.keywords(
        `${candidate.title} ${candidate.description ?? ""}`,
      );
      if (existing.size === 0) continue;

      const intersection = [...incoming].filter((w) => existing.has(w)).length;
      const union = new Set([...incoming, ...existing]).size;
      if (intersection / union >= 0.5) return candidate;
    }
    return null;
  }

  private keywords(text: string): Set<string> {
    return new Set(
      (text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w)),
    );
  }

  private async subscribe(
    db: TenantTx,
    societyId: string,
    ticketId: string,
    personId: string,
    reason: string,
  ): Promise<void> {
    await db
      .insert(schema.ticketSubscribers)
      .values({ societyId, ticketId, personId, reason })
      .onConflictDoNothing();
  }

  private async committeeWatchers(
    db: TenantTx,
    societyId: string,
  ): Promise<string[]> {
    const rows = await db
      .select({ personId: schema.roleAssignments.personId })
      .from(schema.roleAssignments)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.roleAssignments.roleId))
      .where(
        and(
          eq(schema.roleAssignments.societyId, societyId),
          isNull(schema.roleAssignments.validTo),
          inArray(schema.roles.code, ["mc_member", "society_admin"]),
        ),
      );
    return rows.map((r) => r.personId);
  }

  private async getTicket(db: TenantTx, ticketId: string) {
    const [ticket] = await db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketId))
      .limit(1);

    // RLS already prevents cross-society reads; this turns a policy-filtered miss into
    // a clean 404 rather than a null-reference crash.
    if (!ticket) throw new NotFoundError("Complaint not found.");
    return ticket;
  }

  private async nextTicketNumber(db: TenantTx, societyId: string): Promise<string> {
    const prefix = `C${new Date().getFullYear()}-`;
    const result = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*) AS count FROM tickets
      WHERE society_id = ${societyId} AND ticket_number LIKE ${`${prefix}%`}
    `);
    return `${prefix}${String(Number(result.rows[0]?.count ?? 0) + 1).padStart(5, "0")}`;
  }
}
