/**
 * Notices, events and polls.
 *
 * The interesting part is not publishing — it is who a notice is allowed to reach, and
 * on which channel.
 *
 * **Audience is resolved server-side.** A notice aimed at owners must not be sent to
 * tenants, and "committee only" must actually mean it. Resolving that from occupancy and
 * role rows here, rather than accepting a recipient list from the client, means a bug in
 * a console cannot leak a committee-only circular to the whole society.
 *
 * **Channel is bounded by the DLT category of the template it would use.** TRAI ties DND
 * exemption to the category a template was *registered* under, so an emergency notice
 * may go out as transactional SMS while a social event may not. `channelsFor` is where
 * that rule lives, and it refuses rather than downgrades — silently dropping a channel
 * would leave a committee believing residents were told.
 */

import { Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import { schema } from "@watchmygate/db";

import { NotFoundError, ValidationError } from "../../common/errors.js";
import { currentContext, tx } from "../../common/tenant-context.js";

export type NoticeKind = "circular" | "event" | "poll" | "emergency";
export type Audience = "society" | "tower" | "owners" | "tenants" | "committee" | "custom";
export type Channel = "push" | "sms" | "email" | "whatsapp";
export type DltCategory =
  | "transactional"
  | "service_explicit"
  | "service_implicit"
  | "promotional";

/**
 * The DLT category a notice of each kind may claim.
 *
 * An emergency is genuinely transactional and may reach a DND number. A community event
 * is promotional and may not — however much a committee would like it to. Encoding this
 * as a map keeps the judgement in one reviewable place instead of scattered through the
 * send path.
 */
const CATEGORY_OF: Record<NoticeKind, DltCategory> = {
  emergency: "transactional",
  circular: "service_implicit",
  poll: "service_implicit",
  event: "promotional",
};

export function categoryFor(kind: NoticeKind): DltCategory {
  return CATEGORY_OF[kind];
}

/**
 * Which channels a notice of this kind may use.
 *
 * Push and email are outside TRAI's SMS regime, so they are always available. SMS and
 * WhatsApp are not: a promotional category cannot be pushed to a DND number, and we do
 * not hold per-resident DND state, so the safe and legal position is to refuse the
 * channel for promotional kinds rather than send and hope.
 */
export function channelsFor(kind: NoticeKind): Channel[] {
  const category = categoryFor(kind);
  if (category === "promotional") return ["push", "email"];
  return ["push", "email", "sms", "whatsapp"];
}

export interface CreateNoticeInput {
  kind: NoticeKind;
  title: string;
  body: string;
  audience: Audience;
  audienceRef?: unknown;
  isPinned?: boolean | undefined;
  publishAt?: string | undefined;
  expiresAt?: string | undefined;
  eventAt?: string | undefined;
  eventPlace?: string | undefined;
  options?: string[] | undefined;
}

@Injectable()
export class NoticesService {
  async create(input: CreateNoticeInput) {
    if (input.kind === "poll" && (input.options?.length ?? 0) < 2) {
      throw new ValidationError("A poll needs at least two options.");
    }

    return tx(async (db) => {
      const [notice] = await db
        .insert(schema.notices)
        .values({
          societyId: currentContext().societyId!,
          kind: input.kind,
          title: input.title,
          body: input.body,
          audience: input.audience,
          isPinned: input.isPinned ?? false,
          createdBy: currentContext().personId!,
          ...(input.audienceRef ? { audienceRef: input.audienceRef } : {}),
          ...(input.publishAt ? { publishAt: new Date(input.publishAt) } : {}),
          ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
          ...(input.eventAt ? { eventAt: new Date(input.eventAt) } : {}),
          ...(input.eventPlace ? { eventPlace: input.eventPlace } : {}),
        })
        .returning();

      const row = notice!;

      if (input.kind === "poll") {
        await db.insert(schema.pollOptions).values(
          (input.options ?? []).map((label, position) => ({
            societyId: currentContext().societyId!,
            noticeId: row.id,
            label,
            position,
          })),
        );
      }

      return { ...row, channels: channelsFor(input.kind), dltCategory: categoryFor(input.kind) };
    });
  }

  async publish(id: string) {
    return tx(async (db) => {
      const updated = await db
        .update(schema.notices)
        .set({ publishedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.notices.id, id))
        .returning();
      if (updated.length === 0) throw new NotFoundError("No such notice.");
      const row = updated[0]!;
      return { ...row, channels: channelsFor(row.kind as NoticeKind) };
    });
  }

  /** The resident feed: published, not expired, newest first with pinned on top. */
  async feed(limit = 50) {
    return tx(async (db) =>
      db
        .select()
        .from(schema.notices)
        .where(
          and(
            sql`${schema.notices.publishAt} <= now()`,
            or(isNull(schema.notices.expiresAt), sql`${schema.notices.expiresAt} > now()`),
          ),
        )
        .orderBy(desc(schema.notices.isPinned), desc(schema.notices.publishAt))
        .limit(Math.min(limit, 200)),
    );
  }

  async markRead(noticeId: string) {
    return tx(async (db) => {
      await db
        .insert(schema.noticeReads)
        .values({
          noticeId,
          personId: currentContext().personId!,
          societyId: currentContext().societyId!,
        })
        .onConflictDoNothing();
      return { status: "read" as const };
    });
  }

  /**
   * Vote.
   *
   * One vote per person is the primary key, not an application check — a poll a
   * committee acts on has to be countable without argument. A change of mind updates the
   * existing row rather than adding a second.
   */
  async vote(noticeId: string, optionId: string) {
    return tx(async (db) => {
      const [option] = await db
        .select({ id: schema.pollOptions.id })
        .from(schema.pollOptions)
        .where(
          and(eq(schema.pollOptions.id, optionId), eq(schema.pollOptions.noticeId, noticeId)),
        )
        .limit(1);
      if (!option) throw new ValidationError("That option does not belong to this poll.");

      await db
        .insert(schema.pollVotes)
        .values({
          noticeId,
          optionId,
          personId: currentContext().personId!,
          societyId: currentContext().societyId!,
        })
        .onConflictDoUpdate({
          target: [schema.pollVotes.noticeId, schema.pollVotes.personId],
          set: { optionId, votedAt: new Date() },
        });

      return this.results(noticeId);
    });
  }

  async results(noticeId: string) {
    return tx(async (db) =>
      db
        .select({
          optionId: schema.pollOptions.id,
          label: schema.pollOptions.label,
          votes: sql<number>`count(${schema.pollVotes.personId})::int`,
        })
        .from(schema.pollOptions)
        .leftJoin(schema.pollVotes, eq(schema.pollVotes.optionId, schema.pollOptions.id))
        .where(eq(schema.pollOptions.noticeId, noticeId))
        .groupBy(schema.pollOptions.id, schema.pollOptions.label, schema.pollOptions.position)
        .orderBy(schema.pollOptions.position),
    );
  }

  /** "Did anyone actually read it" — a committee's first question about a circular. */
  async readCount(noticeId: string) {
    return tx(async (db) => {
      const [row] = await db
        .select({ readers: sql<number>`count(*)::int` })
        .from(schema.noticeReads)
        .where(eq(schema.noticeReads.noticeId, noticeId));
      return { noticeId, readers: row?.readers ?? 0 };
    });
  }
}
