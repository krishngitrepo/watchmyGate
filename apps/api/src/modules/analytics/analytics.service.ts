/**
 * Analytics for the committee.
 *
 * Every figure here is computed in SQL rather than by pulling rows into JS and reducing
 * them. Two reasons, and the second is the one that matters: a society with 2M gate
 * events a day cannot stream them to a Node process, and — more importantly — a number
 * on a committee report and the same number in the ledger must come from the same
 * source. Recomputing in JS is how two screens start disagreeing about arrears.
 *
 * Money stays a **string** the whole way. `numeric` arrives from pg as a string, and it
 * leaves as one. The moment a rupee figure becomes a JS number it is a float, and a
 * defaulter list that is off by a paisa is a defaulter list a treasurer stops trusting.
 */

import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { schema } from "@watchmygate/db";

import { ValidationError } from "../../common/errors.js";
import { tx } from "../../common/tenant-context.js";

/** Bounded so a committee cannot ask for a year of gate events by accident. */
const MAX_DAYS = 180;

/**
 * Return the rows, not the driver's envelope.
 *
 * `db.execute` hands back node-postgres' full result — `command`, `rowCount`, `oid` and a
 * `fields` array carrying every column's internal type OID. Serialising that to a client
 * publishes our driver, our column types and our query shape for no benefit, and makes
 * the response several times larger than the data in it. Callers want the rows.
 */
function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) ?? [];
}

function days(input?: string): number {
  const n = Number(input ?? 30);
  if (!Number.isFinite(n) || n < 1 || n > MAX_DAYS) {
    throw new ValidationError(`Choose a window between 1 and ${MAX_DAYS} days.`);
  }
  return Math.floor(n);
}

@Injectable()
export class AnalyticsService {
  /** Footfall by day and category — the shape of who comes through the gate. */
  async footfall(window?: string) {
    const n = days(window);
    return tx(async (db) =>
      rowsOf(await db.execute(sql`
        SELECT
          date_trunc('day', server_ts)::date::text AS day,
          category::text                            AS category,
          count(*)::int                             AS entries,
          count(*) FILTER (WHERE verified_offline)::int AS offline_verified
        FROM gate_events
        WHERE direction = 'entry'
          AND server_ts > now() - (${n} || ' days')::interval
        GROUP BY 1, 2
        ORDER BY 1 DESC, 3 DESC
      `)),
    );
  }

  /**
   * Collections and arrears.
   *
   * Ageing buckets are the report a committee actually acts on — "who owes, and for how
   * long" — rather than a single outstanding total, which tells them nothing about
   * whether the position is getting better or worse.
   */
  async collections() {
    return tx(async (db) =>
      rowsOf(await db.execute(sql`
        WITH balances AS (
          SELECT
            i.unit_id,
            i.due_date,
            i.total::text                                   AS total,
            COALESCE(SUM(ra.amount), 0)::text               AS paid,
            (i.total - COALESCE(SUM(ra.amount), 0))         AS outstanding
          FROM invoices i
          LEFT JOIN receipt_allocations ra ON ra.invoice_id = i.id
          WHERE i.status <> 'void'
          GROUP BY i.id, i.unit_id, i.due_date, i.total
        )
        SELECT
          count(*) FILTER (WHERE outstanding > 0)::int                       AS unpaid_invoices,
          COALESCE(SUM(outstanding) FILTER (WHERE outstanding > 0), 0)::text AS total_outstanding,
          COALESCE(SUM(outstanding) FILTER (
            WHERE outstanding > 0 AND due_date >= current_date), 0)::text    AS not_yet_due,
          COALESCE(SUM(outstanding) FILTER (
            WHERE outstanding > 0 AND due_date < current_date
              AND due_date >= current_date - 30), 0)::text                   AS overdue_0_30,
          COALESCE(SUM(outstanding) FILTER (
            WHERE outstanding > 0 AND due_date < current_date - 30
              AND due_date >= current_date - 60), 0)::text                   AS overdue_31_60,
          COALESCE(SUM(outstanding) FILTER (
            WHERE outstanding > 0 AND due_date < current_date - 60
              AND due_date >= current_date - 90), 0)::text                   AS overdue_61_90,
          COALESCE(SUM(outstanding) FILTER (
            WHERE outstanding > 0 AND due_date < current_date - 90), 0)::text AS overdue_90_plus
        FROM balances
      `)),
    );
  }

  /** Who owes the most, worst first. The list a committee works down. */
  async defaulters(limit = 25) {
    const n = Math.min(Math.max(limit, 1), 200);
    return tx(async (db) =>
      rowsOf(await db.execute(sql`
        SELECT
          u.id                                        AS unit_id,
          u.number                                    AS unit_number,
          SUM(i.total - COALESCE(alloc.paid, 0))::text AS outstanding,
          min(i.due_date)::text                       AS oldest_due,
          (current_date - min(i.due_date))::int       AS days_overdue
        FROM invoices i
        JOIN units u ON u.id = i.unit_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ra.amount), 0) AS paid
          FROM receipt_allocations ra WHERE ra.invoice_id = i.id
        ) alloc ON true
        WHERE i.status <> 'void'
          AND (i.total - COALESCE(alloc.paid, 0)) > 0
        GROUP BY u.id, u.number
        ORDER BY 3 DESC
        LIMIT ${n}
      `)),
    );
  }

  /** Helpdesk: ageing and SLA breaches by category. */
  async helpdesk() {
    return tx(async (db) =>
      rowsOf(await db.execute(sql`
        SELECT
          COALESCE(c.name, 'Uncategorised')                        AS category,
          count(*)::int                                            AS total,
          count(*) FILTER (WHERE t.status IN ('open','reopened'))::int AS open,
          count(*) FILTER (WHERE t.status = 'in_progress')::int    AS in_progress,
          count(*) FILTER (
            WHERE (t.resolved_at IS NULL AND t.sla_due_at < now())
               OR (t.resolved_at IS NOT NULL AND t.resolved_at > t.sla_due_at)
          )::int                                                   AS sla_breached,
          COALESCE(ROUND(AVG(
            EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600
          ) FILTER (WHERE t.resolved_at IS NOT NULL), 1), 0)::float8 AS avg_hours_to_resolve
        FROM tickets t
        LEFT JOIN ticket_categories c ON c.id = t.category_id
        GROUP BY 1
        ORDER BY 2 DESC
      `)),
    );
  }

  /** Staff attendance for the month — the input to payroll, summarised. */
  async staff(month?: string) {
    const m = month ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) {
      throw new ValidationError("Month must be YYYY-MM.");
    }
    return tx(async (db) =>
      rowsOf(await db.execute(sql`
        SELECT
          s.kind::text                                      AS kind,
          count(DISTINCT s.id)::int                         AS people,
          count(a.id)::int                                  AS days_worked,
          count(a.id) FILTER (WHERE a.overridden_by IS NOT NULL)::int AS overridden
        FROM staff s
        LEFT JOIN staff_attendance a
          ON a.staff_id = s.id
         AND to_char(a.work_date, 'YYYY-MM') = ${m}
        WHERE s.status = 'active'
        GROUP BY 1
        ORDER BY 2 DESC
      `)),
    );
  }

  /**
   * One call for the dashboard.
   *
   * A console that fires six requests to paint one screen is six chances to be
   * half-rendered on a committee member's phone on society wifi.
   */
  async overview() {
    return tx(async (db) => {
      const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`
        SELECT
          (SELECT count(*) FROM units)::int                                        AS units,
          (SELECT count(*) FROM gate_events
             WHERE direction = 'entry' AND server_ts > now() - interval '24 hours')::int AS entries_today,
          (SELECT count(*) FROM tickets
             WHERE status IN ('open','in_progress','reopened'))::int              AS open_tickets,
          (SELECT count(*) FROM tickets
             WHERE status IN ('open','in_progress','reopened')
               AND resolved_at IS NULL AND sla_due_at < now())::int               AS sla_breached,
          (SELECT count(*) FROM sos_alerts WHERE closed_at IS NULL)::int           AS open_alerts,
          (SELECT count(*) FROM deliveries
             WHERE status IN ('at_gate','awaiting_resident','held_at_gate'))::int  AS parcels_waiting,
          (SELECT count(*) FROM staff_attendance WHERE checked_out_at IS NULL)::int AS staff_inside,
          (SELECT count(*) FROM parking_violations WHERE resolved_at IS NULL)::int AS parking_flags
      `));
      return rows[0] ?? {};
    });
  }
}
