/**
 * The document repository.
 *
 * MG-30, with rental agreements (MG-32) as a category rather than a separate feature —
 * they are a document with an expiry date and a flat attached, and building a second
 * system for them would mean two places to look.
 *
 * Bytes never pass through this API. The browser presigns, uploads straight to R2, then
 * confirms the key here — the same flow complaint photos already use.
 *
 * ## The visibility rule, which is the whole design
 *
 * A repository that shows everything to everyone gets used for bye-laws and nothing
 * else, because a secretary will not put a vendor contract with rates in it, or a
 * resident's rental agreement, somewhere four hundred people can read. So:
 *
 *   `society`    everyone
 *   `committee`  committee and admin only
 *   `unit`       that flat's occupants, plus the committee
 *
 * The filter is applied in SQL against the caller's own occupancy, never against a
 * parameter they send.
 */

import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { ForbiddenError, NotFoundError } from "../../common/errors.js";
import { StorageService } from "../../common/storage.service.js";
import { currentContext, hasRole, tx } from "../../common/tenant-context.js";

/**
 * The shelf every society actually keeps.
 *
 * A fixed list rather than free text: a repository where one committee files under
 * "Bye-laws" and the next under "byelaws" is a repository nobody can search.
 */
export const DOCUMENT_CATEGORIES = [
  "bye_laws",
  "registration",
  "agm_minutes",
  "committee_minutes",
  "audited_accounts",
  "insurance",
  "amc_contract",
  "vendor_contract",
  "rental_agreement",
  "noc",
  "floor_plan",
  "other",
] as const;

const createSchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(DOCUMENT_CATEGORIES),
  description: z.string().max(2000).optional(),
  visibility: z.enum(["society", "committee", "unit"]).default("society"),
  unitId: z.string().uuid().optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  supersedesId: z.string().uuid().optional(),
});

const attachSchema = z.object({
  objectKey: z.string().max(500),
  contentType: z.string().max(120),
  contentLength: z.number().int().positive(),
});

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) ?? [];
}

@Controller("v1/documents")
export class DocumentsController {
  constructor(private readonly storage: StorageService) {}

  /**
   * What this caller may see.
   *
   * The visibility predicate is evaluated in SQL against the caller's occupancies. A
   * resident asking for `?visibility=committee` gets committee documents excluded by the
   * query rather than by a check someone has to remember to write.
   */
  @Get()
  async list(
    @Query("category") category?: string,
    @Query("expiring") expiring?: string,
  ) {
    const { personId } = currentContext();
    const committee = hasRole("society_admin", "mc_member", "accountant", "auditor");

    return tx(async (db) => {
      const rows = rowsOf(
        await db.execute(sql`
          SELECT
            d.id, d.title, d.category, d.description, d.visibility, d.unit_id AS "unitId",
            u.number                AS "unitNumber",
            d.version, d.supersedes_id AS "supersedesId",
            d.effective_from::text  AS "effectiveFrom",
            d.expires_on::text      AS "expiresOn",
            d.r2_key IS NOT NULL    AS "hasFile",
            d.content_type          AS "contentType",
            d.bytes,
            d.created_at            AS "createdAt",
            -- Answered here rather than in the client, so "expiring" means the same
            -- thing in the list, the filter and the count on the page.
            CASE WHEN d.expires_on IS NULL THEN NULL
                 ELSE (d.expires_on - current_date)
            END::int                AS "daysToExpiry",
            -- Superseded documents stay findable but are marked, so nobody quotes last
            -- year's bye-laws at a meeting.
            EXISTS (
              SELECT 1 FROM documents newer WHERE newer.supersedes_id = d.id
            )                       AS "superseded"
          FROM documents d
          LEFT JOIN units u ON u.id = d.unit_id
          WHERE (
            d.visibility = 'society'
            OR (${committee} AND d.visibility = 'committee')
            OR (
              d.visibility = 'unit'
              AND (
                ${committee}
                OR d.unit_id IN (
                  SELECT unit_id FROM unit_occupancies
                  WHERE person_id = ${personId}
                    AND (valid_to IS NULL OR valid_to >= current_date)
                )
              )
            )
          )
          AND (${category ?? null}::text IS NULL OR d.category = ${category ?? null})
          AND (
            ${expiring === "true"} = false
            OR (d.expires_on IS NOT NULL AND d.expires_on <= current_date + 60)
          )
          ORDER BY d.created_at DESC
          LIMIT 500
        `),
      );
      return rows;
    });
  }

  /**
   * What is about to lapse.
   *
   * The one query a committee should be shown without asking. An insurance policy that
   * expired in March is worse than no policy, because everyone believes there is cover.
   */
  @Get("expiring")
  async expiring() {
    this.requireCommittee();
    return tx(async (db) =>
      rowsOf(
        await db.execute(sql`
          SELECT id, title, category, expires_on::text AS "expiresOn",
                 (expires_on - current_date)::int AS "daysToExpiry"
          FROM documents
          WHERE expires_on IS NOT NULL
            AND expires_on <= current_date + 60
            AND NOT EXISTS (SELECT 1 FROM documents n WHERE n.supersedes_id = documents.id)
          ORDER BY expires_on
        `),
      ),
    );
  }

  @Get("categories")
  async categories() {
    return DOCUMENT_CATEGORIES.map((code) => ({ code, label: code.replace(/_/g, " ") }));
  }

  @Post()
  async create(@Body() body: unknown) {
    this.requireCommittee();
    const input = createSchema.parse(body);
    const { societyId, personId } = currentContext();

    if (input.visibility === "unit" && !input.unitId) {
      throw new NotFoundError("A flat-specific document needs a flat.");
    }

    return tx(async (db) => {
      const rows = rowsOf<{ id: string }>(
        await db.execute(sql`
          INSERT INTO documents (
            society_id, title, category, description, visibility, unit_id,
            effective_from, expires_on, supersedes_id,
            version, uploaded_by
          )
          VALUES (
            ${societyId}, ${input.title}, ${input.category},
            ${input.description ?? null}, ${input.visibility}, ${input.unitId ?? null},
            ${input.effectiveFrom ?? null}, ${input.expiresOn ?? null},
            ${input.supersedesId ?? null},
            -- One past whatever it replaces, so the chain reads correctly.
            COALESCE(
              (SELECT version + 1 FROM documents WHERE id = ${input.supersedesId ?? null}),
              1
            ),
            ${personId}
          )
          RETURNING id
        `),
      );
      return { id: rows[0]!.id };
    });
  }

  /** Presign an upload. The bytes go straight from the browser to R2. */
  @Post(":id/upload")
  async presign(@Param("id") id: string, @Body() body: unknown) {
    this.requireCommittee();
    const input = z
      .object({ contentType: z.string().max(120), contentLength: z.number().int().positive() })
      .parse(body);
    const { societyId } = currentContext();

    await this.mustExist(id);
    return this.storage.presignUpload(
      societyId,
      "document",
      id,
      input.contentType,
      input.contentLength,
    );
  }

  /** Confirm the upload landed. */
  @Post(":id/attach")
  async attach(@Param("id") id: string, @Body() body: unknown) {
    this.requireCommittee();
    const input = attachSchema.parse(body);
    const { societyId } = currentContext();

    // A key belonging to another society must not be attachable to this document.
    if (!this.storage.keyBelongsTo(input.objectKey, societyId)) {
      throw new NotFoundError("Document not found.");
    }

    await this.mustExist(id);

    return tx(async (db) => {
      await db.execute(sql`
        UPDATE documents
        SET r2_key = ${input.objectKey},
            content_type = ${input.contentType},
            bytes = ${input.contentLength},
            updated_at = now()
        WHERE id = ${id}
      `);
      return { status: "attached" };
    });
  }

  /**
   * A short-lived link to the file.
   *
   * Separate from the listing on purpose: listing a document is not the same act as
   * opening it, and the URL is signed for minutes rather than being a permanent address
   * that leaks in a forwarded message.
   */
  @Get(":id/link")
  async link(@Param("id") id: string) {
    const { societyId } = currentContext();
    const visible = await this.list();
    const allowed = (visible as { id: string }[]).some((d) => d.id === id);
    if (!allowed) throw new NotFoundError("Document not found.");

    const row = await this.mustExist(id);
    if (!row.r2Key) throw new NotFoundError("No file has been attached to this document.");

    return { url: this.storage.presignDownload(row.r2Key, societyId) };
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    if (!hasRole("society_admin", "mc_member")) {
      throw new ForbiddenError("Only the committee can remove a document.");
    }
    await this.mustExist(id);

    return tx(async (db) => {
      await db.execute(sql`DELETE FROM documents WHERE id = ${id}`);
      return { status: "removed" };
    });
  }

  private async mustExist(id: string): Promise<{ id: string; r2Key: string | null }> {
    return tx(async (db) => {
      const rows = rowsOf<{ id: string; r2Key: string | null }>(
        await db.execute(sql`SELECT id, r2_key AS "r2Key" FROM documents WHERE id = ${id}`),
      );
      if (rows.length === 0) throw new NotFoundError("Document not found.");
      return rows[0]!;
    });
  }

  private requireCommittee(): void {
    if (!hasRole("society_admin", "mc_member")) {
      throw new ForbiddenError("Only the committee can manage documents.");
    }
  }
}
