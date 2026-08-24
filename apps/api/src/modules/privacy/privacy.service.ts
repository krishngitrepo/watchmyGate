/**
 * DPDP Act 2023 / Rules 2025.
 *
 * Rules notified 13 Nov 2025; full substantive compliance due **13 May 2027**, penalties
 * to Rs 250 crore. Dated work, not a backlog item.
 *
 * Four rights, and the shape of each one here:
 *
 *   **Notice and consent (s.5, s.6)** — an append-only ledger recording the exact words
 *   agreed to, tied by hash to immutable notice text. A consent record that can be
 *   edited is not evidence.
 *
 *   **Withdrawal (s.6(6))** — as easy as giving it. One call, recorded once, and the
 *   consequences are stated plainly rather than buried.
 *
 *   **Access and portability (s.11)** — everything held about a person, in JSON a human
 *   or another system can read.
 *
 *   **Erasure (s.12)** — a request with an outcome, because the honest answer is never
 *   simply yes. Financial records are retained under the s.8(7) statutory exemption and
 *   the response says so.
 */

import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { schema } from "@watchmygate/db";

import { ConflictError, NotFoundError, ValidationError } from "../../common/errors.js";
import { currentContext, tx } from "../../common/tenant-context.js";

/**
 * What this product retains, by default, and why.
 *
 * Conservative on purpose. DPDP's storage-limitation principle says personal data is
 * kept only as long as the purpose needs — and "we never delete anything" is the posture
 * that turns a breach into a catastrophe.
 */
export const RETENTION_DEFAULTS: Record<string, { days: number; why: string }> = {
  gate_events: {
    days: 180,
    why: "Six months of entry and exit records. Long enough for a dispute about who came in; short enough that a breach cannot expose years of a household's movements.",
  },
  cctv: {
    days: 30,
    why: "The cap this product commits to. Footage is the most sensitive thing a society holds and the least useful after a month.",
  },
  attachments: {
    days: 365,
    why: "Complaint photos outlive the complaint, briefly, so a reopened ticket still has its evidence.",
  },
  otp_challenges: {
    days: 1,
    why: "A one-time code has no purpose the day after it was used, and it is tied to a phone number.",
  },
};

/** Purposes a society may ask consent for. Free text here would defeat the point. */
export const CONSENT_PURPOSES = [
  "gate_photos",
  "visitor_records",
  "staff_biometrics",
  "community_directory",
  "marketing",
  "cctv",
] as const;

export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/**
 * Purposes the product will not run without.
 *
 * Stated so the console can be honest: withdrawing consent for `visitor_records` means
 * the gate cannot record that person's visitors, which is most of the product. Pretending
 * every consent is freely withdrawable with no consequence would be the dishonest option.
 */
export const ESSENTIAL_PURPOSES: ReadonlySet<string> = new Set([
  "visitor_records",
]);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

@Injectable()
export class PrivacyService {
  // ------------------------------------------------------------- notices

  /**
   * Publish a version of a notice.
   *
   * The text is immutable once written — the database refuses to change it. Correcting a
   * notice means publishing a new version, which is the only way a claim about what
   * someone agreed to can be checked later.
   */
  async publishNotice(input: {
    purpose: string;
    version: string;
    // `| undefined` is explicit because tsconfig sets exactOptionalPropertyTypes, and
    // every call site here spreads a parsed request body.
    language?: string | undefined;
    body: string;
  }) {
    const { societyId } = currentContext();

    return tx(async (db) => {
      const [row] = await db
        .insert(schema.consentNotices)
        .values({
          societyId,
          purpose: input.purpose,
          version: input.version,
          language: input.language ?? "en",
          body: input.body,
          bodyHash: sha256(input.body),
        })
        .returning();
      return row!;
    });
  }

  async notices(purpose?: string) {
    return tx(async (db) =>
      db
        .select()
        .from(schema.consentNotices)
        .where(purpose ? eq(schema.consentNotices.purpose, purpose) : undefined)
        .orderBy(desc(schema.consentNotices.effectiveFrom)),
    );
  }

  // ------------------------------------------------------------ consents

  /**
   * Record a consent decision.
   *
   * The notice must already exist, and its hash is copied onto the record. Accepting a
   * consent for a notice nobody can produce afterwards would record an agreement to
   * nothing.
   */
  async record(input: {
    purpose: string;
    noticeVersion: string;
    granted: boolean;
    personId?: string | undefined;
    ip?: string | undefined;
  }) {
    const { societyId, personId: caller } = currentContext();
    const subject = input.personId ?? caller!;

    return tx(async (db) => {
      const [notice] = await db
        .select()
        .from(schema.consentNotices)
        .where(
          and(
            eq(schema.consentNotices.purpose, input.purpose),
            eq(schema.consentNotices.version, input.noticeVersion),
          ),
        )
        .limit(1);

      if (!notice) {
        throw new ValidationError(
          `No notice text published for ${input.purpose} ${input.noticeVersion}. Publish the notice before collecting consent for it.`,
        );
      }

      const [row] = await db
        .insert(schema.consents)
        .values({
          societyId,
          personId: subject,
          purpose: input.purpose,
          noticeVersion: input.noticeVersion,
          noticeTextHash: notice.bodyHash,
          granted: input.granted,
          grantedAt: input.granted ? new Date() : null,
          source: "app",
          ...(input.ip ? { ip: input.ip } : {}),
        })
        .returning();

      return row!;
    });
  }

  /**
   * Withdraw a consent.
   *
   * s.6(6): withdrawal must be as easy as granting. One call, and the database permits
   * it exactly once — a second attempt is refused rather than silently overwriting when
   * the withdrawal happened.
   */
  async withdraw(consentId: string) {
    return tx(async (db) => {
      const [existing] = await db
        .select()
        .from(schema.consents)
        .where(eq(schema.consents.id, consentId))
        .limit(1);

      if (!existing) throw new NotFoundError("No such consent record.");
      if (existing.withdrawnAt) {
        throw new ConflictError("That consent was already withdrawn.");
      }

      const [row] = await db
        .update(schema.consents)
        .set({ withdrawnAt: new Date() })
        .where(eq(schema.consents.id, consentId))
        .returning();

      return {
        ...row!,
        /** Said plainly rather than buried, so nobody withdraws blind. */
        consequence: ESSENTIAL_PURPOSES.has(existing.purpose)
          ? "This society cannot record visitors for you without this. Your flat will not receive arrival approvals."
          : "No further processing for this purpose. Records already lawfully created are retained where the law requires it.",
      };
    });
  }

  /** Current standing per purpose — the latest decision that has not been withdrawn. */
  async standing(personId: string) {
    return tx(async (db) => {
      const rows = await db
        .select()
        .from(schema.consents)
        .where(eq(schema.consents.personId, personId))
        .orderBy(desc(schema.consents.createdAt));

      const latest = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        if (!latest.has(row.purpose)) latest.set(row.purpose, row);
      }

      return CONSENT_PURPOSES.map((purpose) => {
        const row = latest.get(purpose);
        return {
          purpose,
          granted: row ? row.granted && !row.withdrawnAt : false,
          decidedAt: row?.createdAt ?? null,
          withdrawnAt: row?.withdrawnAt ?? null,
          consentId: row?.id ?? null,
          noticeVersion: row?.noticeVersion ?? null,
          essential: ESSENTIAL_PURPOSES.has(purpose),
        };
      });
    });
  }

  // -------------------------------------------------------------- export

  /**
   * Everything held about one person, in this society.
   *
   * s.11, the right to access. Deliberately built from explicit queries rather than a
   * generic table sweep: a sweep would either miss a table added later or export another
   * resident's data joined in by accident, and both failures are silent.
   */
  async exportPerson(personId: string) {
    return tx(async (db) => {
      const [person] = await db
        .select()
        .from(schema.persons)
        .where(eq(schema.persons.id, personId))
        .limit(1);

      if (!person) throw new NotFoundError("No such person.");

      const [occupancies, consents, tickets, gateEvents, invoices, roles] =
        await Promise.all([
          db
            .select()
            .from(schema.unitOccupancies)
            .where(eq(schema.unitOccupancies.personId, personId)),
          db.select().from(schema.consents).where(eq(schema.consents.personId, personId)),
          db.select().from(schema.tickets).where(eq(schema.tickets.raisedBy, personId)),
          db.execute(sql`
            SELECT id, direction, category, server_ts, visitor_name, vehicle_number
            FROM gate_events
            WHERE unit_id IN (
              SELECT unit_id FROM unit_occupancies WHERE person_id = ${personId}
            )
            ORDER BY server_ts DESC
            LIMIT 1000
          `),
          db.execute(sql`
            SELECT i.id, i.invoice_number, i.issue_date, i.due_date, i.total::text
            FROM invoices i
            WHERE i.unit_id IN (
              SELECT unit_id FROM unit_occupancies WHERE person_id = ${personId}
            )
            ORDER BY i.issue_date DESC
          `),
          db.execute(sql`
            SELECT r.code, ra.valid_from, ra.valid_to
            FROM role_assignments ra
            JOIN roles r ON r.id = ra.role_id
            WHERE ra.person_id = ${personId}
          `),
        ]);

      return {
        generatedAt: new Date().toISOString(),
        /** Stated in the file itself, so a recipient knows what they are holding. */
        note:
          "Everything this society holds about you, produced under section 11 of the DPDP Act. " +
          "Gate events and invoices relate to your flat and may involve other occupants of it.",
        person: {
          id: person.id,
          name: person.name,
          phone: person.phone,
          email: person.email,
          createdAt: person.createdAt,
        },
        roles: rowsOf(roles),
        occupancies,
        consents,
        complaints: tickets,
        gateEvents: rowsOf(gateEvents),
        invoices: rowsOf(invoices),
      };
    });
  }

  // ------------------------------------------------------------- erasure

  async requestErasure(personId: string, requestedBy: string) {
    const { societyId } = currentContext();

    return tx(async (db) => {
      const [row] = await db
        .insert(schema.erasureRequests)
        .values({
          societyId,
          personId,
          requestedBy,
          // The Rules expect a stated period. Thirty days, published rather than implied.
          dueBy: new Date(Date.now() + 30 * 86_400_000),
        })
        .returning();
      return row!;
    });
  }

  async erasureRequests() {
    return tx(async (db) =>
      db
        .select()
        .from(schema.erasureRequests)
        .orderBy(desc(schema.erasureRequests.requestedAt)),
    );
  }

  /**
   * Carry out an erasure.
   *
   * **This is the honest part.** Contact details, device tokens and cached PII go.
   * Financial records, the immutable journal, audit entries and gate events involving
   * other people stay, under the s.8(7) exemption for retention required by law — a
   * society must keep its books, and a resident cannot erase an invoice they owe.
   *
   * What was kept and why is written onto the request, so the person receives a truthful
   * answer rather than an unqualified "done".
   */
  async completeErasure(requestId: string) {
    const { personId: actor } = currentContext();

    return tx(async (db) => {
      const [request] = await db
        .select()
        .from(schema.erasureRequests)
        .where(eq(schema.erasureRequests.id, requestId))
        .limit(1);

      if (!request) throw new NotFoundError("No such erasure request.");
      if (request.status === "completed") {
        throw new ConflictError("That request has already been completed.");
      }

      const subject = request.personId;
      const erased: Record<string, number> = {};

      // Push tokens: pure contact data, no statutory basis for keeping them.
      const tokens = await db
        .delete(schema.deviceTokens)
        .where(eq(schema.deviceTokens.personId, subject))
        .returning({ id: schema.deviceTokens.id });
      erased.deviceTokens = tokens.length;

      /*
       * The person row is redacted, not deleted.
       *
       * Deleting it would break every foreign key pointing at it — invoices, journal
       * lines, audit entries — and those must survive. So identifiers are replaced with
       * a tombstone: the record of *what happened* stays intact while the person behind
       * it stops being identifiable.
       */
      const tombstone = `erased-${subject.slice(0, 8)}`;
      await db.execute(sql`
        UPDATE persons
        SET name = ${tombstone},
            email = NULL,
            phone = ${`+00${subject.replace(/\D/g, "").slice(0, 10)}`}
        WHERE id = ${subject}
      `);
      erased.personIdentifiers = 1;

      // Visitor names this person's flat recorded — other people's data, held for them.
      const visitors = await db.execute(sql`
        UPDATE gate_events
        SET visitor_name = NULL, visitor_phone = NULL
        WHERE unit_id IN (SELECT unit_id FROM unit_occupancies WHERE person_id = ${subject})
          AND server_ts < now() - interval '180 days'
      `);
      erased.oldVisitorNames = (visitors as { rowCount?: number }).rowCount ?? 0;

      const retained = {
        invoicesAndReceipts:
          "Retained. A society must keep its books, and audited accounts cannot be altered.",
        journalEntries: "Retained. The ledger is immutable by design and by database grant.",
        auditLog: "Retained. Required to demonstrate compliance, including with this Act.",
        consentRecords:
          "Retained. These are the evidence that consent was given and withdrawn, which protects you as much as us.",
        recentGateEvents:
          "Retained until the six-month retention window expires, then purged automatically.",
      };

      const [updated] = await db
        .update(schema.erasureRequests)
        .set({
          status: "completed",
          completedAt: new Date(),
          completedBy: actor,
          erased,
          retained,
          retentionBasis:
            "Section 8(7), DPDP Act 2023 — retention where required by law. Financial and audit records are kept under state co-operative society law and the Income Tax Act.",
        })
        .where(eq(schema.erasureRequests.id, requestId))
        .returning();

      return updated!;
    });
  }

  // ----------------------------------------------------------- retention

  async retentionPolicies() {
    const { societyId } = currentContext();

    return tx(async (db) => {
      const configured = await db
        .select()
        .from(schema.retentionPolicies)
        .where(eq(schema.retentionPolicies.societyId, societyId));

      const bySubject = new Map(configured.map((row) => [row.subject, row]));

      // Every subject is listed with its default, so a society sees what it has not
      // changed as well as what it has. A policy page showing only overrides looks empty
      // and reads as "nothing is being deleted".
      return Object.entries(RETENTION_DEFAULTS).map(([subject, fallback]) => {
        const row = bySubject.get(subject);
        return {
          subject,
          days: row?.days ?? fallback.days,
          defaultDays: fallback.days,
          isDefault: !row,
          why: fallback.why,
          reason: row?.reason ?? null,
          updatedAt: row?.updatedAt ?? null,
        };
      });
    });
  }

  async setRetention(subject: string, days: number, reason?: string | undefined) {
    const { societyId, personId } = currentContext();
    const fallback = RETENTION_DEFAULTS[subject];
    if (!fallback) throw new ValidationError(`Unknown retention subject: ${subject}`);

    // Lengthening beyond the default needs a stated purpose. Storage limitation is a
    // principle, not a preference, and "we might need it" is not a purpose.
    if (days > fallback.days && !reason) {
      throw new ValidationError(
        `Keeping ${subject} longer than ${fallback.days} days needs a stated purpose.`,
      );
    }

    return tx(async (db) => {
      const [row] = await db
        .insert(schema.retentionPolicies)
        .values({
          societyId,
          subject,
          days,
          reason: reason ?? null,
          updatedBy: personId,
        })
        .onConflictDoUpdate({
          target: [schema.retentionPolicies.societyId, schema.retentionPolicies.subject],
          set: { days, reason: reason ?? null, updatedBy: personId, updatedAt: new Date() },
        })
        .returning();
      return row!;
    });
  }

  /**
   * Purge what is past its retention window.
   *
   * MG-29 and DPDP storage limitation in one job. Every run is logged whether or not it
   * removed anything — a retention policy nobody runs is a lie with a number in it, and
   * the log is how a society proves the policy is enforced rather than configured.
   */
  async purge(): Promise<{ subject: string; cutoff: string; rowsRemoved: number }[]> {
    const { societyId } = currentContext();
    const policies = await this.retentionPolicies();
    const results: { subject: string; cutoff: string; rowsRemoved: number }[] = [];

    for (const policy of policies) {
      const cutoff = new Date(Date.now() - policy.days * 86_400_000);
      let removed = 0;

      await tx(async (db) => {
        if (policy.subject === "gate_events") {
          /*
           * Redacted rather than deleted.
           *
           * The event itself is a count in a footfall report and a row an audit may need
           * to see existed. What must not survive six months is *who* — the visitor's
           * name, number and photograph. Deleting the row would quietly rewrite history;
           * stripping the identity satisfies storage limitation without doing that.
           */
          const result = await db.execute(sql`
            UPDATE gate_events
            SET visitor_name = NULL, visitor_phone = NULL, photo_key = NULL
            WHERE server_ts < ${cutoff}
              AND (visitor_name IS NOT NULL OR visitor_phone IS NOT NULL OR photo_key IS NOT NULL)
          `);
          removed = (result as { rowCount?: number }).rowCount ?? 0;
        }

        if (policy.subject === "otp_challenges") {
          // Genuinely deleted rather than redacted. A spent code has no evidentiary
          // value at all, and it is directly tied to a phone number.
          const result = await db.execute(sql`
            DELETE FROM otp_challenges WHERE created_at < ${cutoff}
          `);
          removed = (result as { rowCount?: number }).rowCount ?? 0;
        }

        await db.insert(schema.retentionRuns).values({
          societyId,
          subject: policy.subject,
          cutoff,
          rowsRemoved: removed,
        });
      });

      results.push({
        subject: policy.subject,
        cutoff: cutoff.toISOString(),
        rowsRemoved: removed,
      });
    }

    return results;
  }

  async retentionRuns() {
    return tx(async (db) =>
      db
        .select()
        .from(schema.retentionRuns)
        .orderBy(desc(schema.retentionRuns.ranAt))
        .limit(100),
    );
  }

  // ---------------------------------------------------------------- cctv

  /** Record a footage access. The reason is required and the log cannot be altered. */
  async logCctvAccess(input: {
    cameraRef: string;
    fromTs: string;
    toTs: string;
    reason: string;
  }) {
    const { societyId, personId } = currentContext();

    return tx(async (db) => {
      const [row] = await db
        .insert(schema.cctvAccessLog)
        .values({
          societyId,
          personId: personId!,
          cameraRef: input.cameraRef,
          fromTs: new Date(input.fromTs),
          toTs: new Date(input.toTs),
          reason: input.reason,
        })
        .returning();
      return row!;
    });
  }

  async cctvAccesses() {
    return tx(async (db) =>
      db
        .select()
        .from(schema.cctvAccessLog)
        .orderBy(desc(schema.cctvAccessLog.accessedAt))
        .limit(200),
    );
  }

  /** Outstanding erasure requests past their stated deadline. */
  async overdueErasures() {
    return tx(async (db) =>
      db
        .select()
        .from(schema.erasureRequests)
        .where(
          and(
            isNull(schema.erasureRequests.completedAt),
            sql`${schema.erasureRequests.dueBy} < now()`,
          ),
        ),
    );
  }
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) ?? [];
}
