"use client";

import { useEffect, useMemo, useState } from "react";

import { Chip, Figure, Ledger, Loading, Problem, Shell } from "../../components/Shell";
import { api, timeAgo } from "../../lib/api";

interface StaffMember {
  id: string;
  fullName: string;
  phone: string;
  kind: string;
  status: string;
  verification: string;
  idLast4: string | null;
  verifiedAt: string | null;
  policeVerifiedAt: string | null;
  employerUnitId: string | null;
  vendorName: string | null;
}

interface Present {
  attendanceId: string;
  staffId: string;
  fullName: string;
  kind: string;
  checkedInAt: string;
  method: string;
}

interface TimesheetRow {
  staffId: string;
  fullName: string;
  kind: string;
  daysPresent: number;
  minutesWorked: number;
  openShifts: number;
  overrides: number;
}

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * Staff and attendance.
 *
 * Two things on this page exist for the staff rather than for the committee, and both
 * are deliberately visible rather than buried.
 *
 * **The overrides column.** Attendance decides what someone is paid, so a row a human
 * edited must never look identical to a row a scan produced. An accountant approving a
 * timesheet sees which days were changed before signing it off.
 *
 * **Verification shows a status, never a document.** There is no Aadhaar number on this
 * page because there is none in the database — §57 was struck down, so only the outcome
 * and a masked last-4 are kept.
 */
export default function StaffPage() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [present, setPresent] = useState<Present[]>([]);
  const [sheet, setSheet] = useState<TimesheetRow[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const month = new Date().toISOString().slice(0, 7);

  useEffect(() => {
    void (async () => {
      try {
        const [all, inside, timesheet] = await Promise.all([
          api.get<StaffMember[]>("/v1/staff"),
          api.get<Present[]>("/v1/staff/attendance/present"),
          api.get<TimesheetRow[]>(`/v1/staff/timesheet?month=${month}`),
        ]);
        setStaff(all);
        setPresent(inside);
        setSheet(timesheet);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [month]);

  const stats = useMemo(() => {
    const active = staff.filter((s) => s.status === "active").length;
    const unverified = staff.filter((s) => s.verification !== "verified").length;
    const edited = sheet.reduce((n, r) => n + r.overrides, 0);
    return { active, unverified, edited };
  }, [staff, sheet]);

  return (
    <Shell
      title="Staff & Attendance"
      lede="Maids, cooks, drivers and vendor workers. Attendance times are server times — a gate handset's clock is not trusted with someone's pay."
    >
      {error ? <Problem error={error} /> : null}

      <dl className="figures settle">
        <Figure label="On the register" value={String(staff.length)} hint="all statuses" />
        <Figure label="Active" value={String(stats.active)} tone="settled" />
        <Figure label="Inside now" value={String(present.length)} hint="not checked out" />
        <Figure
          label="Unverified"
          value={String(stats.unverified)}
          hint="no verification on record"
          {...(stats.unverified > 0 ? { tone: "arrears" as const } : {})}
        />
      </dl>

      <Ledger
        title="Inside right now"
        note="checked in, not yet checked out"
        head={["Name", "Role", "Since", "Identified by"]}
        empty="No staff are currently inside."
        isEmpty={!loading && present.length === 0}
      >
        {present.map((p) => (
          <tr key={p.attendanceId}>
            <td style={{ fontWeight: 500 }}>{p.fullName}</td>
            <td className="muted">{p.kind.replace(/_/g, " ")}</td>
            <td className="muted">{timeAgo(p.checkedInAt)}</td>
            <td>
              <Chip tone={p.method === "biometric" ? "pending" : "quiet"}>
                {p.method.replace(/_/g, " ")}
              </Chip>
            </td>
          </tr>
        ))}
      </Ledger>

      <Ledger
        title={`Timesheet — ${month}`}
        note="the input to payroll"
        head={["Name", "Role", "~Days", "~Hours", "~Open shifts", "~Edited"]}
        empty="No attendance recorded this month."
        isEmpty={!loading && sheet.length === 0}
      >
        {sheet.map((r) => (
          <tr key={r.staffId}>
            <td style={{ fontWeight: 500 }}>{r.fullName}</td>
            <td className="muted">{r.kind.replace(/_/g, " ")}</td>
            <td className="num">{r.daysPresent}</td>
            <td className="num">{hours(r.minutesWorked)}</td>
            <td className="num" {...(r.openShifts > 0 ? { "data-tone": "arrears" } : {})}>
              {r.openShifts}
            </td>
            {/* Never hidden. A day a person changed must not look like a day a scan
                produced — that is the difference between a timesheet and an assertion. */}
            <td className="num" {...(r.overrides > 0 ? { "data-tone": "arrears" } : {})}>
              {r.overrides}
            </td>
          </tr>
        ))}
      </Ledger>

      <Ledger
        title="The register"
        note="everyone the society has on record"
        head={["Name", "Role", "Phone", "Status", "Verification"]}
        empty="No staff have been added yet."
        isEmpty={!loading && staff.length === 0}
      >
        {staff.map((s) => (
          <tr key={s.id}>
            <td style={{ fontWeight: 500 }}>{s.fullName}</td>
            <td className="muted">{s.kind.replace(/_/g, " ")}</td>
            <td className="num muted" style={{ textAlign: "left" }}>
              {s.phone}
            </td>
            <td>
              <Chip
                tone={
                  s.status === "active"
                    ? "settled"
                    : s.status === "suspended" || s.status === "exited"
                      ? "arrears"
                      : "pending"
                }
              >
                {s.status}
              </Chip>
            </td>
            <td>
              {s.verification === "verified" ? (
                <>
                  <Chip tone="settled">verified</Chip>
                  {/* Only ever a masked last-4. The full number is not stored anywhere. */}
                  {s.idLast4 ? (
                    <span className="muted" style={{ marginLeft: 6, fontSize: "0.8rem" }}>
                      ••••{s.idLast4}
                    </span>
                  ) : null}
                </>
              ) : (
                <Chip tone={s.verification === "rejected" ? "arrears" : "quiet"}>
                  {s.verification.replace(/_/g, " ")}
                </Chip>
              )}
            </td>
          </tr>
        ))}
      </Ledger>

      {loading ? <Loading /> : null}

      <section className="ledger settle">
        <div className="ledger-head">
          <h2>What this page will never show</h2>
        </div>
        <div style={{ padding: "14px 16px", fontSize: "0.88rem", color: "var(--ink-soft)" }}>
          <p style={{ marginTop: 0 }}>
            No Aadhaar numbers, because none are stored. Section 57 of the Aadhaar Act was
            struck down, so a private company cannot require Aadhaar authentication.
            Verification runs through DigiLocker and only the <strong>result</strong> plus
            the last four digits are kept.
          </p>
          <p style={{ marginBottom: 0 }}>
            Attendance rows cannot be deleted — the database refuses. A correction is
            recorded as an override showing who changed it and why, so the original scan
            time stays in the audit log.
          </p>
        </div>
      </section>
    </Shell>
  );
}
