"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Banner,
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
import { api, timeAgo } from "../../lib/api";

interface GateEvent {
  id: string;
  unitId: string | null;
  direction: string;
  category: string;
  visitorName: string | null;
  visitorPhone: string | null;
  vehicleNumber: string | null;
  verifiedOffline: boolean;
  deviceTs: string;
  serverTs: string;
  clockDriftSeconds: number | null;
  overstayAlertedAt: string | null;
}

interface Approval {
  id: string;
  unitId: string;
  state: string;
  requestedAt: string;
  visitorName: string | null;
  visitorPhone: string | null;
  category: string;
}

interface Rung {
  id: string;
  rung: string;
  firedAt: string;
  channelResult: string | null;
}

interface Unit {
  id: string;
  number: string;
  towerName: string;
}

interface IssuedPass {
  passId: string;
  qrValue: string;
  validFrom: string;
  validTo: string;
}

const CATEGORIES = ["guest", "delivery", "cab", "courier", "service", "staff"] as const;

/** Drift beyond this means the handset's clock needs attention. */
const DRIFT_ALERT_SECONDS = 300;

/** The ladder, as designed. Shown so a resident can be told exactly what will happen. */
const LADDER = [
  { at: "0s", what: "Push to every device on the flat" },
  { at: "20s", what: "IVR call and SMS to the primary resident" },
  { at: "45s", what: "The flat's standing rule applies" },
  { at: "90s", what: "Escalated to the on-duty committee contact" },
];

/**
 * The gate.
 *
 * Three things at once: who is inside, who is waiting on a decision, and issuing a pass
 * for someone expected.
 *
 * Two columns here exist because of how gates actually work, and both are unusual enough
 * to be worth explaining on the page rather than only in the code:
 *
 * **Offline pass** — a signed pass verified on the guard's handset with no network at
 * all. This is the product's central claim, and showing it per entry is what proves it to
 * a committee rather than asserting it in a sales deck.
 *
 * **Clock drift** — guard handsets are cheap, shared, and nobody owns keeping their
 * clocks right; being hours out is normal. Every figure on this page is server time. The
 * drift column exists so a committee can see which handset needs fixing, and so that an
 * entry timestamp is never quietly wrong.
 */
export default function GateLog() {
  const [inside, setInside] = useState<GateEvent[]>([]);
  const [pending, setPending] = useState<Approval[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [watching, setWatching] = useState<Approval | null>(null);

  const unitsById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);

  const load = useCallback(async () => {
    try {
      const [current, waiting, unitList] = await Promise.all([
        api.get<GateEvent[]>("/v1/gate/inside"),
        api.get<Approval[]>("/v1/gate/approvals/pending"),
        api.get<Unit[]>("/v1/society/units"),
      ]);
      setInside(current);
      setPending(waiting);
      setUnits(unitList);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    /*
     * Pending approvals are a live queue: someone is standing at a barrier while this
     * list is stale. Ten seconds is well inside the ladder's first rung at 20s, so the
     * console never shows a decision as outstanding after the IVR has already gone out.
     */
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const stats = useMemo(() => {
    const offline = inside.filter((e) => e.verifiedOffline).length;
    const overstay = inside.filter((e) => e.overstayAlertedAt).length;
    const drifting = inside.filter(
      (e) => e.clockDriftSeconds !== null && Math.abs(e.clockDriftSeconds) > DRIFT_ALERT_SECONDS,
    ).length;
    return { offline, overstay, drifting };
  }, [inside]);

  return (
    <Shell
      title="Gate Log"
      lede="Everyone currently inside. Times are server times — guard handset clocks are not trusted."
      actions={
        <button data-variant="primary" onClick={() => setIssuing(true)}>
          Issue a visitor pass
        </button>
      }
    >
      {error ? <Problem error={error} /> : null}

      <dl className="figures settle">
        <Figure label="Inside now" value={String(inside.length)} hint="no matching exit" />
        <Figure
          label="Waiting on a flat"
          value={String(pending.length)}
          hint="someone is at the gate"
          {...(pending.length > 0 ? { tone: "arrears" as const } : {})}
        />
        <Figure
          label="Offline passes"
          value={String(stats.offline)}
          hint="verified with no network"
          tone="settled"
        />
        <Figure
          label="Clock drift"
          value={String(stats.drifting)}
          hint="handsets needing a time fix"
          {...(stats.drifting > 0 ? { tone: "arrears" as const } : {})}
        />
      </dl>

      <Ledger
        title="Waiting for a decision"
        note="the approval ladder is running on each of these"
        head={["Visitor", "Category", "Flat", "Waiting", ""]}
        empty="Nobody is waiting at the gate."
        isEmpty={!loading && pending.length === 0}
      >
        {pending.map((approval) => (
          <ApprovalRow
            key={approval.id}
            approval={approval}
            unit={unitsById.get(approval.unitId)}
            onWatch={() => setWatching(approval)}
            onDecided={load}
          />
        ))}
      </Ledger>

      <Ledger
        title="Currently inside"
        note="entries with no matching exit"
        head={["Visitor", "Category", "Flat", "Vehicle", "Entered", "Verified", "~Clock drift"]}
        empty="Nobody is signed in at the gate right now."
        isEmpty={!loading && inside.length === 0}
      >
        {inside.map((event) => {
          const unit = event.unitId ? unitsById.get(event.unitId) : undefined;
          const drift = event.clockDriftSeconds;
          const driftBad = drift !== null && Math.abs(drift) > DRIFT_ALERT_SECONDS;

          return (
            <tr key={event.id}>
              <td>
                <span className="strong">
                  {event.visitorName ?? <span className="muted">not recorded</span>}
                </span>
                {event.overstayAlertedAt ? (
                  <span style={{ display: "block", marginTop: 3 }}>
                    <Chip tone="arrears">overstay flagged</Chip>
                  </span>
                ) : null}
              </td>
              <td className="muted">{event.category}</td>
              <td>{unit ? unit.number : <span className="muted">—</span>}</td>
              <td className="num muted" style={{ textAlign: "left" }}>
                {event.vehicleNumber ?? "—"}
              </td>
              <td className="muted">{timeAgo(event.serverTs)}</td>
              <td>
                {event.verifiedOffline ? (
                  <Chip tone="settled">offline pass</Chip>
                ) : (
                  <Chip tone="quiet">at gate</Chip>
                )}
              </td>
              <td className="num" {...(driftBad ? { "data-tone": "arrears" } : {})}>
                {drift === null
                  ? "—"
                  : Math.abs(drift) < 60
                    ? `${drift}s`
                    : `${Math.round(drift / 60)}m`}
              </td>
            </tr>
          );
        })}
      </Ledger>

      {loading ? <Loading /> : null}

      <section className="card settle">
        <div className="card-head">
          <h2>Why the gate keeps working without signal</h2>
        </div>
        <div className="card-body">
          <p>
            A pre-approved visitor&apos;s QR pass is signed by this society&apos;s own key.
            The guard&apos;s handset checks that signature against a cached copy of the
            public key — no network, no lookup, no waiting. Entries queue on the device and
            upload when signal returns.
          </p>
          <p>
            The pass carries a <strong>hash</strong> of the visitor, never their name or
            number, because a QR gets photographed and forwarded on WhatsApp.
          </p>
        </div>
      </section>

      {issuing ? (
        <IssuePass
          units={units}
          onClose={() => setIssuing(false)}
          onIssued={() => void load()}
        />
      ) : null}

      {watching ? (
        <LadderHistory approval={watching} onClose={() => setWatching(null)} />
      ) : null}
    </Shell>
  );
}

function ApprovalRow({
  approval,
  unit,
  onWatch,
  onDecided,
}: {
  approval: Approval;
  unit: Unit | undefined;
  onWatch: () => void;
  onDecided: () => Promise<void>;
}) {
  const action = useAction();

  function decide(decision: "approved" | "denied") {
    void action.run(() => api.post(`/v1/gate/approvals/${approval.id}/decision`, { decision }), {
      onDone: onDecided,
    });
  }

  const waitingSeconds = Math.round((Date.now() - new Date(approval.requestedAt).getTime()) / 1000);

  return (
    <tr>
      <td className="strong">
        {approval.visitorName ?? <span className="muted">not recorded</span>}
        {approval.visitorPhone ? <span className="sub">{approval.visitorPhone}</span> : null}
        {action.error ? (
          <span className="sub" style={{ color: "var(--arrears)" }}>
            {action.error}
          </span>
        ) : null}
      </td>
      <td className="muted">{approval.category}</td>
      <td>{unit ? `${unit.number} · ${unit.towerName}` : "—"}</td>
      <td>
        {/* The rung already reached, not just elapsed time — a committee member deciding
            from here should know the resident has already had a call. */}
        <Chip tone={waitingSeconds > 45 ? "arrears" : waitingSeconds > 20 ? "pending" : "quiet"}>
          {waitingSeconds < 60 ? `${waitingSeconds}s` : `${Math.round(waitingSeconds / 60)}m`}
        </Chip>
      </td>
      <td>
        <div className="row-actions">
          <button data-size="sm" onClick={onWatch}>
            Ladder
          </button>
          <button data-size="sm" disabled={action.busy} onClick={() => decide("denied")}>
            Deny
          </button>
          <button
            data-size="sm"
            data-variant="primary"
            disabled={action.busy}
            onClick={() => decide("approved")}
          >
            Let in
          </button>
        </div>
      </td>
    </tr>
  );
}

/**
 * Every rung that fired, with timestamps.
 *
 * Deliberately available to the resident too, not only to staff. "I never got a
 * notification" is the argument this product exists to end, and it ends with evidence
 * rather than an apology.
 */
function LadderHistory({ approval, onClose }: { approval: Approval; onClose: () => void }) {
  const [rungs, setRungs] = useState<Rung[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const body = await api.get<{ rungs: Rung[] }>(
          `/v1/gate/approvals/${approval.id}/history`,
        );
        setRungs(body.rungs);
      } finally {
        setLoading(false);
      }
    })();
  }, [approval.id]);

  return (
    <Modal
      title="What we tried"
      note="Every step of the approval ladder, with the time it fired."
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      {loading ? (
        <Loading />
      ) : rungs.length === 0 ? (
        <p className="empty">Nothing has fired yet — the request has only just arrived.</p>
      ) : (
        <div className="thread">
          {rungs.map((rung) => (
            <div key={rung.id} className="thread-item">
              <div className="thread-meta">
                <span>{rung.rung.replace(/_/g, " ")}</span>
                <span>·</span>
                <span>{new Date(rung.firedAt).toLocaleTimeString("en-IN")}</span>
              </div>
              {rung.channelResult ? <p>{rung.channelResult}</p> : null}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 16, marginBottom: 0 }}>
        <div className="card-head">
          <h2>The ladder</h2>
          <span className="note">why nobody waits indefinitely</span>
        </div>
        <div className="ledger-scroll">
          <table>
            <tbody>
              {LADDER.map((step) => (
                <tr key={step.at}>
                  <td className="num strong" style={{ width: "1%" }}>
                    {step.at}
                  </td>
                  <td className="muted">{step.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Issue a pass.
 *
 * The QR value is shown once, here. It is not stored anywhere retrievable in plain form
 * and re-opening the pass will not show it again — the same reason a bank shows a CVV
 * once. Sending it on is the committee's job, over whatever channel the visitor uses.
 */
function IssuePass({
  units,
  onClose,
  onIssued,
}: {
  units: Unit[];
  onClose: () => void;
  onIssued: () => void;
}) {
  const action = useAction();
  const [unitId, setUnitId] = useState("");
  const [visitorName, setVisitorName] = useState("");
  const [visitorPhone, setVisitorPhone] = useState("");
  const [category, setCategory] = useState<string>("guest");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [validFrom, setValidFrom] = useState(localNow());
  const [validTo, setValidTo] = useState(localNowPlusHours(8));
  const [maxUses, setMaxUses] = useState("1");
  const [issued, setIssued] = useState<IssuedPass | null>(null);

  const ready = Boolean(unitId && visitorName.trim() && validFrom && validTo);

  function submit() {
    void action.run(async () => {
      const pass = await api.post<IssuedPass>("/v1/gate/passes", {
        unitId,
        visitorName: visitorName.trim(),
        ...(visitorPhone.trim() ? { visitorPhone: visitorPhone.trim() } : {}),
        category,
        ...(vehicleNumber.trim() ? { vehicleNumber: vehicleNumber.trim() } : {}),
        validFrom: new Date(validFrom).toISOString(),
        validTo: new Date(validTo).toISOString(),
        maxUses: Number(maxUses) || 1,
      });
      setIssued(pass);
      onIssued();
    });
  }

  if (issued) {
    return (
      <Modal
        title="Pass issued"
        note="Send this to the visitor. It verifies at the gate with no network."
        onClose={onClose}
        footer={
          <button data-variant="primary" onClick={onClose}>
            Done
          </button>
        }
      >
        <Banner tone="ok">
          Valid {new Date(issued.validFrom).toLocaleString("en-IN")} to{" "}
          {new Date(issued.validTo).toLocaleString("en-IN")}.
        </Banner>

        <Field label="Pass code" hint="Shown once. Copy it now — it cannot be retrieved later.">
          <textarea
            readOnly
            value={issued.qrValue}
            onFocus={(e) => e.currentTarget.select()}
            style={{
              fontFamily: "var(--font-figure)",
              fontSize: "0.74rem",
              minHeight: 96,
              wordBreak: "break-all",
            }}
          />
        </Field>

        <Banner tone="info">
          The code carries a <strong>hash</strong> of the visitor, never their name or
          number — a QR gets photographed and forwarded on WhatsApp, and a pass should not
          leak who is visiting whom.
        </Banner>
      </Modal>
    );
  }

  return (
    <Modal
      title="Issue a visitor pass"
      note="For someone expected. The guard's handset verifies it offline in under half a second."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button data-variant="primary" disabled={action.busy || !ready} onClick={submit}>
            {action.busy ? "Signing…" : "Issue pass"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={submit}>
        <Field label="Flat" htmlFor="pass-unit">
          <select id="pass-unit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">Choose a flat…</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.number} · {u.towerName}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid-2">
          <Field label="Visitor" htmlFor="vname">
            <input
              id="vname"
              value={visitorName}
              onChange={(e) => setVisitorName(e.target.value)}
              maxLength={120}
              placeholder="Ramesh Kumar"
            />
          </Field>

          <Field label="Phone" htmlFor="vphone" hint="Optional.">
            <input
              id="vphone"
              type="tel"
              value={visitorPhone}
              onChange={(e) => setVisitorPhone(e.target.value)}
              maxLength={16}
            />
          </Field>

          <Field label="Category" htmlFor="vcat">
            <select id="vcat" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Vehicle" htmlFor="vveh" hint="Optional.">
            <input
              id="vveh"
              value={vehicleNumber}
              onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
              maxLength={20}
              placeholder="KA01AB1234"
              style={{ fontFamily: "var(--font-figure)" }}
            />
          </Field>

          <Field label="Valid from" htmlFor="vfrom">
            <input
              id="vfrom"
              type="datetime-local"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
          </Field>

          <Field label="Valid until" htmlFor="vto">
            <input
              id="vto"
              type="datetime-local"
              value={validTo}
              onChange={(e) => setValidTo(e.target.value)}
            />
          </Field>

          <Field
            label="Uses"
            htmlFor="vuses"
            hint="A cleaner visiting daily needs many; a one-off guest needs one."
          >
            <input
              id="vuses"
              type="number"
              min={1}
              max={100}
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
            />
          </Field>
        </div>
      </Form>
    </Modal>
  );
}

/** `datetime-local` wants local wall-clock time, not an ISO string in UTC. */
function localNow(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function localNowPlusHours(hours: number): string {
  const then = new Date(Date.now() + hours * 3_600_000);
  then.setMinutes(then.getMinutes() - then.getTimezoneOffset());
  return then.toISOString().slice(0, 16);
}
