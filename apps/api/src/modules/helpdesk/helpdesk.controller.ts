/**
 * Complaint endpoints.
 *
 * Upload flow for the two lift photos:
 *
 *   1. POST /v1/tickets                          → ticket + ticketNumber
 *   2. POST /v1/tickets/{id}/attachments/presign → { objectKey, uploadUrl }  (×2)
 *   3. PUT  <uploadUrl>                          → phone sends bytes straight to R2
 *   4. POST /v1/tickets/{id}/attachments         → confirm each objectKey
 *
 * Bytes never pass through this API.
 */

import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { schema } from "@watchmygate/db";

import { NotFoundError } from "../../common/errors.js";
import { StorageService } from "../../common/storage.service.js";
import { currentContext, isStaff, tx } from "../../common/tenant-context.js";
import { HelpdeskService } from "./helpdesk.service.js";

const raiseSchema = z.object({
  categoryId: z.string().uuid(),
  title: z.string().min(3).max(200),
  description: z.string().max(5000).optional(),
  locationType: z.enum(["unit", "tower", "floor", "amenity", "common"]),
  unitId: z.string().uuid().optional(),
  locationRef: z.string().uuid().optional(),
  locationNote: z.string().max(200).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  voiceTranscriptLanguage: z.string().max(8).optional(),
});

const presignSchema = z.object({
  contentType: z.string().max(120),
  contentLength: z.number().int().positive(),
  isProofOfFix: z.boolean().optional(),
});

const confirmSchema = z.object({
  objectKey: z.string().max(500),
  contentType: z.string().max(120),
  contentLength: z.number().int().positive(),
  isProofOfFix: z.boolean().optional(),
});

@Controller("v1/tickets")
export class HelpdeskController {
  constructor(
    private readonly helpdesk: HelpdeskService,
    private readonly storage: StorageService,
  ) {}

  @Get("categories")
  async categories() {
    return tx(async (db) =>
      db
        .select()
        .from(schema.ticketCategories)
        .where(eq(schema.ticketCategories.isActive, true))
        .orderBy(schema.ticketCategories.name),
    );
  }

  @Post()
  async raise(@Body() body: unknown) {
    return this.helpdesk.raise(raiseSchema.parse(body));
  }

  @Get()
  async list(@Query("status") status?: string, @Query("mine") mine?: string) {
    return this.helpdesk.list({
      ...(status ? { status } : {}),
      mineOnly: mine === "true",
    });
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    return tx(async (db) => {
      const [ticket] = await db
        .select()
        .from(schema.tickets)
        .where(eq(schema.tickets.id, id))
        .limit(1);
      if (!ticket) throw new NotFoundError("Complaint not found.");
      return ticket;
    });
  }

  @Get(":id/events")
  async events(@Param("id") id: string) {
    return this.helpdesk.events(id);
  }

  @Post(":id/attachments/presign")
  async presign(@Param("id") id: string, @Body() body: unknown) {
    const input = presignSchema.parse(body);
    const { societyId } = currentContext();

    await this.get(id); // 404s if it is not this society's ticket

    return this.storage.presignUpload(
      societyId,
      "ticket",
      id,
      input.contentType,
      input.contentLength,
    );
  }

  @Post(":id/attachments")
  async confirmAttachment(@Param("id") id: string, @Body() body: unknown) {
    const input = confirmSchema.parse(body);
    const { societyId } = currentContext();

    // A key belonging to another society must not be attachable to this ticket.
    if (!this.storage.keyBelongsTo(input.objectKey, societyId)) {
      throw new NotFoundError("Complaint not found.");
    }

    const kind = this.storage.classify(input.contentType);
    const attachment = await this.helpdesk.attach(id, {
      r2Key: input.objectKey,
      contentType: input.contentType,
      bytes: input.contentLength,
      kind,
      ...(input.isProofOfFix !== undefined ? { isProofOfFix: input.isProofOfFix } : {}),
    });

    return {
      ...attachment,
      downloadUrl: this.storage.presignDownload(input.objectKey, societyId),
    };
  }

  @Get(":id/attachments")
  async attachments(@Param("id") id: string) {
    const { societyId } = currentContext();

    return tx(async (db) => {
      const rows = await db
        .select()
        .from(schema.attachments)
        .where(
          and(
            eq(schema.attachments.ownerType, "ticket"),
            eq(schema.attachments.ownerId, id),
          ),
        );

      return rows.map((a) => ({
        id: a.id,
        kind: a.kind,
        contentType: a.contentType,
        bytes: a.bytes,
        isProofOfFix: a.isProofOfFix,
        downloadUrl: this.storage.presignDownload(a.r2Key, societyId),
      }));
    });
  }

  @Post(":id/comments")
  async comment(@Param("id") id: string, @Body() body: unknown) {
    const input = z
      .object({ body: z.string().min(1).max(5000), internal: z.boolean().optional() })
      .parse(body);

    const { societyId, personId } = currentContext();
    // Only staff may write an internal note. A resident asking for one gets a normal
    // comment rather than an error — the distinction is not theirs to make.
    const internal = Boolean(input.internal) && isStaff();

    await tx(async (db) => {
      await db.insert(schema.ticketEvents).values({
        societyId,
        ticketId: id,
        actorId: personId,
        type: internal ? "internal_note" : "comment",
        body: input.body,
        visibility: internal ? "staff_only" : "public",
      });
    });

    return { status: "added" };
  }

  @Post(":id/status")
  async setStatus(@Param("id") id: string, @Body() body: unknown) {
    const input = z
      .object({
        status: z.enum(["open", "in_progress", "resolved", "closed"]),
        note: z.string().max(1000).optional(),
      })
      .parse(body);

    await this.helpdesk.changeStatus(id, input.status, input.note);
    return this.get(id);
  }

  @Post(":id/reopen")
  async reopen(@Param("id") id: string, @Body() body: unknown) {
    const input = z.object({ reason: z.string().min(3).max(1000) }).parse(body);
    await this.helpdesk.reopen(id, input.reason);
    return this.get(id);
  }

  @Post(":id/rating")
  async rate(@Param("id") id: string, @Body() body: unknown) {
    const input = z
      .object({ stars: z.number().int().min(1).max(5), comment: z.string().max(500).optional() })
      .parse(body);

    await this.helpdesk.rate(id, input.stars, input.comment);
    return this.get(id);
  }
}
