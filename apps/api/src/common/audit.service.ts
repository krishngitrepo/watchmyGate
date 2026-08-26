/**
 * The audit log — the writing half.
 *
 * ## What was wrong
 *
 * `audit_log` has existed since migration 0001, partitioned by month, with `INSERT` and
 * `SELECT` granted to the application role and `UPDATE`/`DELETE` deliberately withheld so
 * a compromised application cannot rewrite history. All of that was correct. **Nothing
 * ever wrote to it.** The table held zero rows.
 *
 * That is worse than not having the table, because two things in this codebase already
 * relied on it. The backlog described the log as "immutable and complete"; it was
 * immutable and empty. And the DPDP erasure response tells a person, in writing, that
 * their audit records are retained under s.8(7) because they are "required to demonstrate
 * compliance, including with this Act" — a statutory claim resting on nothing.
 *
 * ## What gets logged
 *
 * Not everything. A log that records every read is a log nobody can search, and it turns
 * into the thing people mute rather than the thing they consult. What goes in here is:
 *
 *   * **Acts of authority** — granting a role, passing a budget, locking or reopening a
 *     period, revoking a pass, retiring an asset. Things where the question "who decided
 *     this" has an answer that matters months later.
 *   * **Money leaving its normal path** — a manual receipt, a credit sweep, an invoice
 *     issued.
 *   * **Bulk reads of personal data** — exporting the visitor register, exporting a
 *     person's record. One resident's gate entries is a lookup; four hundred residents'
 *     movements in a spreadsheet is a disclosure, and DPDP treats it as one.
 *
 * Ordinary reads are not logged. Neither are failures — a rejected request did not change
 * anything, and filling the log with them buries the entries that matter.
 *
 * ## Writing never breaks the thing being audited
 *
 * `record()` runs inside the caller's transaction, so an audited action and its log entry
 * commit together or not at all. `recordSafely()` exists for the cases where that is the
 * wrong trade — a failure to log must not fail an export the user is waiting on — and it
 * swallows the error after logging it to the application log, where it will be noticed.
 */

import { Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { currentContext, tx } from "./tenant-context.js";

export interface AuditEntry {
  /** Verb, past tense, dot-namespaced: `role.granted`, `budget.approved`. */
  action: string;
  entityType: string;
  entityId?: string | undefined;
  /** State before, for a change. Omit for a creation. */
  before?: unknown;
  /** State after, or the parameters of a read. Omit for a deletion. */
  after?: unknown;
  /**
   * Why. Required by the schema comment for sensitive reads, and required here for the
   * same reason it is required for CCTV: a disclosure with no stated purpose is one
   * nobody can review afterwards.
   */
  reason?: string | undefined;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  /**
   * Record, in the caller's transaction.
   *
   * Takes the transaction explicitly rather than opening its own: under Neon's
   * transaction-mode pooler a nested `tx()` is a separate connection and a separate
   * transaction, so an audit row written that way could survive a rolled-back action —
   * a log claiming something happened that did not.
   */
  async record(
    db: Parameters<Parameters<typeof tx>[0]>[0],
    entry: AuditEntry,
  ): Promise<void> {
    const { societyId, personId } = currentContext();
    await db.execute(sql`
      INSERT INTO audit_log (
        society_id, actor_person_id, action, entity_type, entity_id, before, after, reason
      ) VALUES (
        ${societyId}, ${personId}, ${entry.action}, ${entityType(entry)},
        ${entry.entityId ?? null},
        ${entry.before === undefined ? null : JSON.stringify(entry.before)}::jsonb,
        ${entry.after === undefined ? null : JSON.stringify(entry.after)}::jsonb,
        ${entry.reason ?? null}
      )
    `);
  }

  /** Its own transaction, for an action that has already committed. */
  async write(entry: AuditEntry): Promise<void> {
    await tx(async (db) => this.record(db, entry));
  }

  /**
   * Write, and never throw.
   *
   * For the cases where failing to log must not fail the thing being logged — an export
   * the user is waiting on, a background sweep. The failure still reaches the application
   * log at error level, so it is visible rather than silent.
   */
  async recordSafely(entry: AuditEntry): Promise<void> {
    try {
      await this.write(entry);
    } catch (error) {
      this.log.error(
        `Failed to write an audit entry for ${entry.action}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Read it back (MG-45).
   *
   * Committee work, filtered rather than paged: an audit log is consulted with a question
   * in mind — what happened to this invoice, what did this person do — and a page-by-page
   * scroll through months of entries answers none of them.
   */
  async search(filter: {
    action?: string | undefined;
    entityType?: string | undefined;
    entityId?: string | undefined;
    actorPersonId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    limit?: number | undefined;
  }) {
    const limit = Math.min(filter.limit ?? 200, 500);
    return tx(async (db) => {
      const result = await db.execute(sql`
        SELECT
          a.id, a.created_at AS "createdAt", a.action,
          a.entity_type AS "entityType", a.entity_id AS "entityId",
          a.before, a.after, a.reason,
          a.actor_person_id AS "actorPersonId",
          p.name  AS "actorName",
          p.phone AS "actorPhone"
        FROM audit_log a
        LEFT JOIN persons p ON p.id = a.actor_person_id
        WHERE (${filter.action ?? null}::text IS NULL OR a.action = ${filter.action ?? null})
          AND (${filter.entityType ?? null}::text IS NULL
               OR a.entity_type = ${filter.entityType ?? null})
          AND (${filter.entityId ?? null}::uuid IS NULL
               OR a.entity_id = ${filter.entityId ?? null})
          AND (${filter.actorPersonId ?? null}::uuid IS NULL
               OR a.actor_person_id = ${filter.actorPersonId ?? null})
          AND (${filter.from ?? null}::date IS NULL
               OR a.created_at >= ${filter.from ?? null}::date)
          AND (${filter.to ?? null}::date IS NULL
               OR a.created_at < (${filter.to ?? null}::date + 1))
        ORDER BY a.created_at DESC
        LIMIT ${limit}
      `);
      return ((result as { rows?: unknown[] })?.rows ?? []) as unknown[];
    });
  }

  /** The distinct actions present, so the console filter offers what actually exists. */
  async actions() {
    return tx(async (db) => {
      const result = await db.execute(sql`
        SELECT action, entity_type AS "entityType", count(*)::int AS count,
               max(created_at) AS "lastAt"
        FROM audit_log
        GROUP BY action, entity_type
        ORDER BY count DESC
      `);
      return ((result as { rows?: unknown[] })?.rows ?? []) as unknown[];
    });
  }
}

/** `entity_type` is NOT NULL in the schema; refusing a blank here beats a 500 later. */
function entityType(entry: AuditEntry): string {
  const value = entry.entityType?.trim();
  if (!value) throw new Error(`Audit entry for ${entry.action} has no entity type.`);
  return value;
}
