"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Banner,
  Check,
  Chip,
  Field,
  Figure,
  Form,
  Ledger,
  Loading,
  Modal,
  Problem,
  Shell,
  useAction,
} from "../../components/Shell";
import { api, can, timeAgo } from "../../lib/api";

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

interface Unit {
  id: string;
  number: string;
  towerName: string;
}

const KINDS = [
  "maid",
  "cook",
  "nanny",
  "driver",
  "gardener",
  "security",
  "vendor_staff",
  "other",
] as const;

const STATUSES = ["pending", "active", "suspended", "exited"] as const;

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * Staff and attendance.
 *
 * Three things on this page exist for the staff rather than for the committee, and all
 * three are deliberately visible rather than buried.
 *
 * **The overrides column.** Attendance decides what someone is paid, so a row a human
 * edited must never look identical to a row a scan produced. An accountant approving a
 * timesheet sees which days were changed before signing it off.
 *
 * **Verification shows a status, never a document.** There is no Aadhaar number on this
 * page because there is none in the database — §57 was struck down, so only the outcome
 * and a masked last-4 are kept.
 *
 * **A PIN is always offered.** Biometric attendance is opt-in and a domestic worker
 * cannot meaningfully refuse an employer's demand, so the non-biometric route has to be
 * present and working, not theoretical.
 */
export default function StaffPage() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [present, setPresent] = useState<Present[]>([]);
  const [sheet, setSheet] = useState<TimesheetRow[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<StaffMember | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));

  const mayManage = can("society_admin", "mc_member");
  const mayGate = can("society_admin", "mc_member", "guard");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [all, inside, timesheet, unitList] = await Promise.all([
        api.get<StaffMember[]>("/v1/staff"),
        api.get<Present[]>("/v1/staff/attendance/present"),
        api.get<TimesheetRow[]>(`/v1/staff/timesheet?month=${month}`),
        api.get<Unit[]>("/v1/society/units"),
      ]);
      setStaff(all);
      setPresent(inside);
      setSheet(timesheet);
      setUnits(unitList);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const active = staff.filter((s) => s.status === "active").length;
    const unverified = staff.filter((s) => s.verification !== "verified").length;
    return { active, unverified };
  }, [staff]);

  const presentIds = useMemo(() => new Set(present.map((p) => p.staffId)), [present]);

  return (
    <Shell
      title="Staff & Attendance"
      lede="Maids, cooks, drivers and vendor workers. Attendance times are server times — a gate handset's clock is not trusted with someone's pay."
      actions={
        mayManage ? (
          <button data-variant="primary" onClick={() => setAdding(true)}>
            Add someone
          </button>
        ) : null
      }
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
        head={["Name", "Role", "Since", "Identified by", ""]}
        empty="No staff are currently inside."
        isEmpty={!loading && present.length === 0}
      >
        {present.map((p) => (
          <tr key={p.attendanceId}>
            <td className="strong">{p.fullName}</td>
            <td className="muted">{p.kind.replace(/_/g, " ")}</td>
            <td className="muted">{timeAgo(p.checkedInAt)}</td>
            <td>
              <Chip tone={p.method === "biometric" ? "pending" : "quiet"}>
                {p.method.replace(/_/g, " ")}
              </Chip>
            </td>
            <td>
              {mayGate ? (
                <div className="row-actions">
                  <CheckOutButton staffId={p.staffId} onDone={load} />
                </div>
              ) : null}
            </td>
          </tr>
        ))}
      </Ledger>

      <section className="ledger settle">
        <div className="ledger-head">
          <h2>Timesheet</h2>
          <div>
            <span className="note">the input to payroll</span>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              style={{ width: "auto" }}
              aria-label="Timesheet month"
            />
          </div>
        </div>

        {loading ? (
          <Loading />
        ) : sheet.length === 0 ? (
          <p className="empty">No attendance recorded in {month}.</p>
        ) : (
          <div className="ledger-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th style={{ textAlign: "right" }}>Days</th>
                  <th style={{ textAlign: "right" }}>Hours</th>
                  <th style={{ textAlign: "right" }}>Open shifts</th>
                  <th style={{ textAlign: "right" }}>Edited</th>
                </tr>
              </thead>
              <tbody>
                {sheet.map((r) => (
                  <tr key={r.staffId}>
                    <td className="strong">{r.fullName}</td>
                    <td className="muted">{r.kind.replace(/_/g, " ")}</td>
                    <td className="num">{r.daysPresent}</td>
                    <td className="num">{hours(r.minutesWorked)}</td>
                    <td className="num" {...(r.openShifts > 0 ? { "data-tone": "arrears" } : {})}>
                      {r.openShifts}
                    </td>
                    {/* Never hidden. A day a person changed must not look like a day a
                        scan produced — that is the difference between a timesheet and an
                        assertion. */}
                    <td className="num" {...(r.overrides > 0 ? { "data-tone": "arrears" } : {})}>
                      {r.overrides}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Ledger
        title="The register"
        note="everyone the society has on record"
        head={["Name", "Role", "Phone", "Status", "Verification", ""]}
        empty="No staff have been added yet."
        isEmpty={!loading && staff.length === 0}
      >
        {staff.map((s) => (
          <tr key={s.id}>
            <td className="strong">
              {s.fullName}
              {s.vendorName ? <span className="sub">{s.vendorName}</span> : null}
            </td>
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
            <td>
              <div className="row-actions">
                {mayGate && !presentIds.has(s.id) && s.status === "active" ? (
                  <CheckInButton staffId={s.id} onDone={load} />
                ) : null}
                {mayManage ? (
                  <button data-size="sm" onClick={() => setManaging(s)}>
                    Manage
                  </button>
                ) : null}
              </div>
            </td>
          </tr>
        ))}
      </Ledger>

      {loading ? <Loading /> : null}

      <section className="card settle">
        <div className="card-head">
          <h2>What this page will never show</h2>
        </div>
        <div className="card-body">
          <p>
            No Aadhaar numbers, because none are stored. Section 57 of the Aadhaar Act was
            struck down, so a private company cannot require Aadhaar authentication.
            Verification runs through DigiLocker and only the <strong>result</strong> plus
            the last four digits are kept.
          </p>
          <p>
            Attendance rows cannot be deleted — the database refuses. A correction is
            recorded as an override showing who changed it and why, so the original scan
            time stays in the audit log.
          </p>
        </div>
      </section>

      {adding ? (
        <AddStaff
          units={units}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : null}

      {managing ? (
        <ManageStaff
          member={managing}
          onClose={() => setManaging(null)}
          onDone={() => {
            setManaging(null);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

function CheckInButton({ staffId, onDone }: { staffId: string; onDone: () => Promise<void> }) {
  const action = useAction();
  return (
    <button
      data-size="sm"
      disabled={action.busy}
      title={action.error || undefined}
      onClick={() =>
        void action.run(
          () => api.post("/v1/staff/attendance/check-in", { staffId, method: "manual" }),
          { onDone },
        )
      }
    >
      {action.busy ? "…" : "Check in"}
    </button>
  );
}

function CheckOutButton({ staffId, onDone }: { staffId: string; onDone: () => Promise<void> }) {
  const action = useAction();
  return (
    <button
      data-size="sm"
      disabled={action.busy}
      title={action.error || undefined}
      onClick={() =>
        void action.run(() => api.post("/v1/staff/attendance/check-out", { staffId }), { onDone })
      }
    >
      {action.busy ? "…" : "Check out"}
    </button>
  );
}

function AddStaff({
  units,
  onClose,
  onDone,
}: {
  units: Unit[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [kind, setKind] = useState<string>("maid");
  const [employerUnitId, setEmployerUnitId] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [dailyStart, setDailyStart] = useState("");
  const [dailyEnd, setDailyEnd] = useState("");

  const ready = fullName.trim().length > 0 && phone.trim().length >= 6;

  return (
    <Modal
      title="Add someone to the register"
      note="Their phone number is their identity across every society they work in — one person, one record."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || !ready}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/staff", {
                    fullName: fullName.trim(),
                    phone: phone.trim(),
                    kind,
                    ...(employerUnitId ? { employerUnitId } : {}),
                    ...(vendorName.trim() ? { vendorName: vendorName.trim() } : {}),
                    ...(dailyStart ? { dailyStart } : {}),
                    ...(dailyEnd ? { dailyEnd } : {}),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Saving…" : "Add to register"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={() => undefined}>
        <div className="grid-2">
          <Field label="Full name" htmlFor="sname">
            <input
              id="sname"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              maxLength={160}
            />
          </Field>

          <Field label="Phone" htmlFor="sphone">
            <input
              id="sphone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={20}
              placeholder="+91 99000 00001"
            />
          </Field>

          <Field label="Role" htmlFor="skind">
            <select id="skind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Works for" htmlFor="sunit" hint="The flat that employs them, if any.">
            <select
              id="sunit"
              value={employerUnitId}
              onChange={(e) => setEmployerUnitId(e.target.value)}
            >
              <option value="">The society</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.number} · {u.towerName}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Starts at" htmlFor="sstart" hint="Optional.">
            <input
              id="sstart"
              type="time"
              value={dailyStart}
              onChange={(e) => setDailyStart(e.target.value)}
            />
          </Field>

          <Field label="Ends at" htmlFor="send" hint="Optional.">
            <input
              id="send"
              type="time"
              value={dailyEnd}
              onChange={(e) => setDailyEnd(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Vendor" htmlFor="svendor" hint="If they come through an agency.">
          <input
            id="svendor"
            value={vendorName}
            onChange={(e) => setVendorName(e.target.value)}
            maxLength={160}
          />
        </Field>
      </Form>

      <Banner tone="info">
        Adding someone does not verify them. Verification is recorded separately, as an
        outcome — this product never stores an identity document.
      </Banner>
    </Modal>
  );
}

/** Status, PIN and verification for one person. */
function ManageStaff({
  member,
  onClose,
  onDone,
}: {
  member: StaffMember;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [status, setStatus] = useState(member.status);
  const [pin, setPin] = useState("");
  const [verification, setVerification] = useState(member.verification);
  const [reference, setReference] = useState("");
  const [idLast4, setIdLast4] = useState(member.idLast4 ?? "");
  const [policeVerified, setPoliceVerified] = useState(Boolean(member.policeVerifiedAt));

  const pinValid = /^\d{4,8}$/.test(pin);
  const last4Valid = idLast4 === "" || /^\d{4}$/.test(idLast4);

  return (
    <Modal
      title={member.fullName}
      note={`${member.kind.replace(/_/g, " ")} · ${member.phone}`}
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose}>
          Done
        </button>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}
      {action.done ? <Banner tone="ok">{action.done}</Banner> : null}

      <Field label="Status" htmlFor="mstatus">
        <select id="mstatus" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </Field>
      <button
        disabled={action.busy || status === member.status}
        onClick={() =>
          void action.run(() => api.post(`/v1/staff/${member.id}/status`, { status }), {
            success: "Status saved.",
            onDone,
          })
        }
      >
        Save status
      </button>

      <hr style={{ margin: "20px 0", border: 0, borderTop: "1px solid var(--rule)" }} />

      <Field
        label="Attendance PIN"
        htmlFor="mpin"
        hint="4 to 8 digits. Stored hashed — it cannot be read back, only replaced."
      >
        <input
          id="mpin"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          maxLength={8}
          placeholder="••••"
          style={{ fontFamily: "var(--font-figure)", letterSpacing: "0.3em" }}
        />
      </Field>
      <button
        disabled={action.busy || !pinValid}
        onClick={() =>
          void action.run(() => api.post(`/v1/staff/${member.id}/pin`, { pin }), {
            success: "PIN set.",
            onDone: async () => setPin(""),
          })
        }
      >
        Set PIN
      </button>
      <Banner tone="info">
        The PIN is the alternative to biometrics, and it is always offered. A domestic
        worker cannot meaningfully refuse an employer&apos;s demand for a fingerprint, so
        the non-biometric route has to actually work.
      </Banner>

      <hr style={{ margin: "20px 0", border: 0, borderTop: "1px solid var(--rule)" }} />

      <Field label="Verification" htmlFor="mver">
        <select id="mver" value={verification} onChange={(e) => setVerification(e.target.value)}>
          {["submitted", "verified", "rejected", "expired"].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid-2">
        <Field label="Reference" htmlFor="mref" hint="DigiLocker reference, if any.">
          <input
            id="mref"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            maxLength={120}
          />
        </Field>

        <Field
          label="ID last 4"
          htmlFor="mlast4"
          hint={last4Valid ? "Four digits only — the full number is never stored." : "Four digits."}
        >
          <input
            id="mlast4"
            inputMode="numeric"
            value={idLast4}
            onChange={(e) => setIdLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
            maxLength={4}
            style={{ fontFamily: "var(--font-figure)" }}
          />
        </Field>
      </div>

      <Check
        label="Police verification on file"
        checked={policeVerified}
        onChange={setPoliceVerified}
      />

      <button
        data-variant="primary"
        disabled={action.busy || !last4Valid}
        onClick={() =>
          void action.run(
            () =>
              api.post(`/v1/staff/${member.id}/verification`, {
                status: verification,
                ...(reference.trim() ? { reference: reference.trim() } : {}),
                ...(idLast4 ? { idLast4 } : {}),
                policeVerified,
              }),
            { success: "Verification recorded.", onDone },
          )
        }
      >
        Record verification
      </button>
    </Modal>
  );
}
