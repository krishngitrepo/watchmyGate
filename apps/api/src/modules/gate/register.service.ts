/**
 * The digital gate register (MG-22).
 *
 * The book on the desk at the gate, replaced. Named specifically for trucks in the sales
 * notes, and that is the giveaway about what it is really for: a society is asked, weeks
 * later, which vehicle came in on the 14th and who let it through, and today the answer
 * is a photograph of a page in somebody's phone — if the book is still there at all.
 *
 * ## A register line is a visit, not an event
 *
 * `gate_events` records entries and exits separately, which is right for the gate and
 * wrong for the register. A register line is what the paper book has always been: one
 * visitor, time in, time out, still inside if the second column is blank. So this pairs
 * the two events back into one row and computes how long they stayed.
 *
 * ## Two columns the paper book never had
 *
 * **Which guard**, by name. The paper book has a signature nobody can read and everybody
 * shares.
 *
 * **Device time and drift.** Guard handsets are routinely hours out, so every business
 * decision here uses `server_ts` — but the register shows the drift, because "the app
 * says 14:05 and the book says 16:30" is exactly the dispute this has to settle.
 *
 * ## Retention bounds what it can show
 *
 * Gate events are purged after the society's retention window (180 days by default, a
 * DPDP obligation as much as a MyGate feature). The register can only ever show what
 * retention has kept, and the payload says so rather than presenting a short history as
 * a complete one.
 */

import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { AuditService } from "../../common/audit.service.js";
import { ValidationError } from "../../common/errors.js";
import { tx } from "../../common/tenant-context.js";

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) ?? [];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkedDate(value: string | undefined, label: string, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  if (!DATE.test(value)) throw new ValidationError(`${label} must be a date like 2026-04-01.`);
  return value;
}

export interface RegisterFilter {
  from?: string | undefined;
  to?: string | undefined;
  category?: string | undefined;
  unitId?: string | undefined;
  /** Free text across visitor name, phone and vehicle number. */
  q?: string | undefined;
  /** Only visits with no recorded exit. */
  insideOnly?: boolean | undefined;
  limit?: number | undefined;
}

export interface RegisterRow {
  id: string;
  serial: number;
  entryAt: string;
  exitAt: string | null;
  minutesInside: number | null;
  direction: string;
  category: string;
  visitorName: string | null;
  visitorPhone: string | null;
  vehicleNumber: string | null;
  unitId: string | null;
  unitNumber: string | null;
  towerName: string | null;
  guardName: string | null;
  verifiedOffline: boolean;
  clockDriftSeconds: number | null;
  stillInside: boolean;
}

@Injectable()
export class RegisterService {
  constructor(private readonly audit: AuditService) {}

  async list(filter: RegisterFilter): Promise<{
    from: string;
    to: string;
    retentionNote: string;
    oldestHeld: string | null;
    rows: RegisterRow[];
  }> {
    const to = checkedDate(filter.to, "to", new Date().toISOString().slice(0, 10));
    const from = checkedDate(
      filter.from,
      "from",
      new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
    );
    if (from > to) throw new ValidationError("The period has to end after it starts.");
    const limit = Math.min(filter.limit ?? 500, 2000);
    const search = filter.q?.trim() ? `%${filter.q.trim()}%` : null;

    return tx(async (db) => {
      const rows = rowsOf<RegisterRow>(
        await db.execute(sql`
          SELECT
            e.id,
            -- Numbered within the result, the way the page in a book is numbered. Not
            -- stored: a serial that survives a filter change would be a serial that lies.
            (row_number() OVER (ORDER BY e.server_ts))::int AS serial,
            e.server_ts                    AS "entryAt",
            x.server_ts                    AS "exitAt",
            CASE WHEN x.server_ts IS NULL THEN NULL
                 ELSE EXTRACT(EPOCH FROM (x.server_ts - e.server_ts)) / 60
            END::int                       AS "minutesInside",
            e.direction::text              AS direction,
            e.category::text               AS category,
            e.visitor_name                 AS "visitorName",
            e.visitor_phone                AS "visitorPhone",
            e.vehicle_number               AS "vehicleNumber",
            e.unit_id                      AS "unitId",
            u.number                       AS "unitNumber",
            t.name                         AS "towerName",
            g.name                         AS "guardName",
            e.verified_offline             AS "verifiedOffline",
            -- Shown, not hidden. "The app says 14:05 and the book says 16:30" is exactly
            -- the dispute this register has to settle.
            e.clock_drift_seconds          AS "clockDriftSeconds",
            x.id IS NULL                   AS "stillInside"
          FROM gate_events e
          LEFT JOIN gate_events x ON x.exit_of_event_id = e.id
          LEFT JOIN units   u ON u.id = e.unit_id
          LEFT JOIN towers  t ON t.id = u.tower_id
          LEFT JOIN persons g ON g.id = e.guard_person_id
          WHERE e.direction = 'entry'
            AND e.server_ts >= ${from}::date
            AND e.server_ts <  (${to}::date + 1)
            AND (${filter.category ?? null}::text IS NULL
                 OR e.category::text = ${filter.category ?? null})
            AND (${filter.unitId ?? null}::uuid IS NULL
                 OR e.unit_id = ${filter.unitId ?? null})
            AND (${search}::text IS NULL
                 OR e.visitor_name   ILIKE ${search}
                 OR e.visitor_phone  ILIKE ${search}
                 OR e.vehicle_number ILIKE ${search})
            AND (${filter.insideOnly === true} = false OR x.id IS NULL)
          ORDER BY e.server_ts DESC
          LIMIT ${limit}
        `),
      );

      // What the register can show at all, so a short history is not mistaken for a
      // complete one.
      const oldest = rowsOf<{ oldest: string | null }>(
        await db.execute(sql`SELECT min(server_ts)::text AS oldest FROM gate_events`),
      )[0]?.oldest;

      return {
        from,
        to,
        oldestHeld: oldest ?? null,
        retentionNote:
          "Gate events are purged once the society's retention window expires, so this " +
          "register shows only what retention has kept.",
        rows,
      };
    });
  }

  /**
   * The same register as a spreadsheet.
   *
   * CSV rather than a real `.xlsx`: Excel opens it, every other tool opens it, and it
   * needs no library. The **UTF-8 byte-order mark is load-bearing** — without it Excel
   * on Windows reads the file as the local code page and a visitor called Sreeja shows up
   * as mojibake, which is the sort of thing that makes a committee stop trusting the
   * export and go back to the book.
   *
   * Four hundred residents' movements, with names, phone numbers and vehicle numbers, in
   * one file. That is a disclosure rather than a read, so it is logged with a reason —
   * the same treatment CCTV footage gets, for the same reason.
   */
  async exportCsv(filter: RegisterFilter, reason: string): Promise<string> {
    if (reason.trim().length < 10) {
      throw new ValidationError(
        "Say why this export is needed. It carries every visitor's name, phone number " +
          "and vehicle for the period, and a disclosure with no stated purpose is one " +
          "nobody can review afterwards.",
      );
    }

    const register = await this.list({ ...filter, limit: 2000 });

    await this.audit.recordSafely({
      action: "register.exported",
      entityType: "gate_register",
      after: {
        from: register.from,
        to: register.to,
        rows: register.rows.length,
        ...(filter.category ? { category: filter.category } : {}),
        ...(filter.unitId ? { unitId: filter.unitId } : {}),
      },
      reason: reason.trim(),
    });

    const header = [
      "S.No",
      "Date",
      "Time in",
      "Time out",
      "Minutes inside",
      "Visitor",
      "Phone",
      "Vehicle",
      "Category",
      "Flat",
      "Tower",
      "Guard",
      "Verified offline",
      "Device clock drift (s)",
      "Status",
    ];

    const lines = [header.map(csv).join(",")];
    for (const row of register.rows) {
      lines.push(
        [
          String(row.serial),
          istDate(row.entryAt),
          istTime(row.entryAt),
          row.exitAt ? istTime(row.exitAt) : "",
          row.minutesInside === null ? "" : String(row.minutesInside),
          row.visitorName ?? "",
          row.visitorPhone ?? "",
          row.vehicleNumber ?? "",
          row.category.replace(/_/g, " "),
          row.unitNumber ?? "",
          row.towerName ?? "",
          row.guardName ?? "",
          row.verifiedOffline ? "yes" : "no",
          row.clockDriftSeconds === null ? "" : String(row.clockDriftSeconds),
          row.stillInside ? "still inside" : "left",
        ]
          .map(csv)
          .join(","),
      );
    }

    // A byte-order mark, then CRLF line endings — the combination Excel on Windows opens
    // without a single question.
    return `﻿${lines.join("\r\n")}\r\n`;
  }
}

/**
 * Quote a field for CSV.
 *
 * The leading-character guard is not decoration: a vehicle number or a name beginning
 * `=`, `+`, `-` or `@` is executed as a formula when the file is opened in Excel. That is
 * CSV injection, and a gate register is a file populated entirely by strangers typing at
 * a guard.
 */
function csv(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Rendered in IST, because the register is read in India and nowhere else. */
function istParts(iso: string): Date {
  return new Date(new Date(iso).getTime() + 5.5 * 3_600_000);
}

function istDate(iso: string): string {
  const d = istParts(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function istTime(iso: string): string {
  const d = istParts(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
