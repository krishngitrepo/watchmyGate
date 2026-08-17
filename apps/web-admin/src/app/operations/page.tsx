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

interface Delivery {
  id: string;
  courier: string;
  unitId: string | null;
  parcelCount: number;
  status: string;
  arrivedAt: string;
  handoverTo: string | null;
  handoverAt: string | null;
  trackingRef: string | null;
}

interface Alert {
  id: string;
  type: string;
  unitId: string | null;
  raisedAt: string;
  acknowledgedAt: string | null;
  closedAt: string | null;
  note: string | null;
}

interface Unit {
  id: string;
  number: string;
  towerName: string;
}

const OPEN_DELIVERY = new Set([
  "at_gate",
  "awaiting_resident",
  "held_at_gate",
  "out_for_doorstep",
]);

/**
 * The transitions the API will accept, mirrored so the console only ever offers a legal
 * one. The server is still the authority — this table exists to keep a guard from
 * choosing something that will be refused, not to enforce anything.
 */
const NEXT: Record<string, string[]> = {
  at_gate: ["awaiting_resident", "held_at_gate", "out_for_doorstep", "refused", "returned"],
  awaiting_resident: ["held_at_gate", "out_for_doorstep", "collected", "refused", "returned"],
  held_at_gate: ["out_for_doorstep", "collected", "returned", "refused"],
  out_for_doorstep: ["delivered", "held_at_gate", "returned"],
  delivered: [],
  collected: [],
  returned: [],
  refused: [],
};

/** Handing a parcel to a person requires naming them. A handover with nobody named is an
    assertion, not a record. */
const NEEDS_PROOF = new Set(["delivered", "collected"]);

/**
 * The day-to-day gate: alarms and parcels.
 *
 * SOS is placed first and is the only thing on this page allowed to be loud. Everything
 * else is a list; an unacknowledged alarm is a person waiting.
 */
export default function OperationsPage() {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [logging, setLogging] = useState(false);
  const [advancing, setAdvancing] = useState<Delivery | null>(null);
  const [closing, setClosing] = useState<Alert | null>(null);

  const unitsById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);

  const load = useCallback(async () => {
    try {
      const [d, a, u] = await Promise.all([
        api.get<Delivery[]>("/v1/deliveries"),
        api.get<Alert[]>("/v1/safety/sos"),
        api.get<Unit[]>("/v1/society/units"),
      ]);
      setDeliveries(d);
      setAlerts(a);
      setUnits(u);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // An open alarm is the one thing on this page that cannot wait for a manual refresh.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const waiting = deliveries.filter((d) => OPEN_DELIVERY.has(d.status));
  const unacked = alerts.filter((a) => !a.acknowledgedAt);

  return (
    <Shell
      title="Gate Operations"
      lede="Alarms raised and parcels waiting. The things a committee member checks on a Sunday."
      actions={
        <button data-variant="primary" onClick={() => setLogging(true)}>
          Log a parcel
        </button>
      }
    >
      {error ? <Problem error={error} /> : null}

      {/* Nothing else on this page is allowed to be this loud. */}
      {unacked.length > 0 ? (
        <div className="alarm-band settle">
          <div>
            <h2>
              {unacked.length} alarm{unacked.length === 1 ? "" : "s"} nobody has answered
            </h2>
            <p>
              Raised {timeAgo(unacked[0]!.raisedAt)}. Acknowledging tells the person help is
              coming — it does not close the alert.
            </p>
          </div>
          <AcknowledgeButton alert={unacked[0]!} onDone={load} />
        </div>
      ) : null}

      <dl className="figures settle">
        <Figure
          label="Open alarms"
          value={String(alerts.length)}
          hint={unacked.length > 0 ? `${unacked.length} not acknowledged` : "all acknowledged"}
          {...(alerts.length > 0 ? { tone: "arrears" as const } : {})}
        />
        <Figure label="Parcels waiting" value={String(waiting.length)} hint="not yet handed over" />
        <Figure
          label="Held at gate"
          value={String(deliveries.filter((d) => d.status === "held_at_gate").length)}
          hint="resident not reachable"
        />
        <Figure
          label="Handed over today"
          value={String(
            deliveries.filter(
              (d) =>
                d.handoverAt &&
                new Date(d.handoverAt).toDateString() === new Date().toDateString(),
            ).length,
          )}
          tone="settled"
        />
      </dl>

      <Ledger
        title="SOS alerts"
        note="a person is waiting on each of these"
        head={["Type", "Flat", "Raised", "Acknowledged", "Note", ""]}
        empty="No alarms are open."
        isEmpty={!loading && alerts.length === 0}
      >
        {alerts.map((a) => (
          <tr key={a.id}>
            <td>
              <Chip tone="arrears">{a.type}</Chip>
            </td>
            <td className="muted">
              {a.unitId ? (unitsById.get(a.unitId)?.number ?? "—") : "—"}
            </td>
            <td className="muted">{timeAgo(a.raisedAt)}</td>
            <td>
              {a.acknowledgedAt ? (
                <Chip tone="settled">{timeAgo(a.acknowledgedAt)}</Chip>
              ) : (
                <Chip tone="arrears">nobody yet</Chip>
              )}
            </td>
            <td className="muted">{a.note ?? "—"}</td>
            <td>
              <div className="row-actions">
                {!a.acknowledgedAt ? <AcknowledgeButton alert={a} onDone={load} small /> : null}
                <button data-size="sm" onClick={() => setClosing(a)}>
                  Close
                </button>
              </div>
            </td>
          </tr>
        ))}
      </Ledger>

      <Ledger
        title="Parcels at the gate"
        note="gate to doorstep"
        head={["Courier", "Flat", "~Parcels", "Status", "Arrived", "Handed to", ""]}
        empty="No parcels are waiting."
        isEmpty={!loading && waiting.length === 0}
      >
        {waiting.map((d) => (
          <tr key={d.id}>
            <td>
              <span className="strong">{d.courier}</span>
              {d.trackingRef ? <span className="sub">{d.trackingRef}</span> : null}
            </td>
            <td className="muted">{d.unitId ? (unitsById.get(d.unitId)?.number ?? "—") : "—"}</td>
            <td className="num">{d.parcelCount}</td>
            <td>
              <Chip tone={d.status === "held_at_gate" ? "pending" : "quiet"}>
                {d.status.replace(/_/g, " ")}
              </Chip>
            </td>
            <td className="muted">{timeAgo(d.arrivedAt)}</td>
            {/* Blank until someone actually took it — that is the whole point of the
                column. A "delivered" with nobody named is an assertion, not a record. */}
            <td className="muted">{d.handoverTo ?? "—"}</td>
            <td>
              <div className="row-actions">
                <button data-size="sm" onClick={() => setAdvancing(d)}>
                  Move on
                </button>
              </div>
            </td>
          </tr>
        ))}
      </Ledger>

      {loading ? <Loading /> : null}

      {logging ? (
        <LogParcel
          units={units}
          onClose={() => setLogging(false)}
          onDone={() => {
            setLogging(false);
            void load();
          }}
        />
      ) : null}

      {advancing ? (
        <AdvanceParcel
          delivery={advancing}
          onClose={() => setAdvancing(null)}
          onDone={() => {
            setAdvancing(null);
            void load();
          }}
        />
      ) : null}

      {closing ? (
        <CloseAlert
          alert={closing}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

/**
 * Acknowledge.
 *
 * First responder wins — a second acknowledgement does not overwrite the first, so two
 * committee members tapping at once cannot rewrite who actually responded.
 */
function AcknowledgeButton({
  alert,
  onDone,
  small,
}: {
  alert: Alert;
  onDone: () => Promise<void>;
  small?: boolean;
}) {
  const action = useAction();
  return (
    <button
      {...(small ? { "data-size": "sm" } : {})}
      disabled={action.busy}
      onClick={() =>
        void action.run(() => api.post(`/v1/safety/sos/${alert.id}/acknowledge`, {}), {
          onDone,
        })
      }
      title={action.error || undefined}
    >
      {action.busy ? "…" : "I am responding"}
    </button>
  );
}

function CloseAlert({
  alert,
  onClose,
  onDone,
}: {
  alert: Alert;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [note, setNote] = useState("");

  return (
    <Modal
      title={`Close the ${alert.type} alert`}
      note="Closing records what happened. The alert itself stays in the log permanently."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy}
            onClick={() =>
              void action.run(
                () =>
                  api.post(`/v1/safety/sos/${alert.id}/close`, {
                    ...(note.trim() ? { note: note.trim() } : {}),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Closing…" : "Close alert"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}
      <Field label="What happened" hint="Optional, but this is what an audit reads later.">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
          placeholder="Ambulance arrived at 21:14. Resident taken to Manipal."
        />
      </Field>
    </Modal>
  );
}

function LogParcel({
  units,
  onClose,
  onDone,
}: {
  units: Unit[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [courier, setCourier] = useState("");
  const [unitId, setUnitId] = useState("");
  const [trackingRef, setTrackingRef] = useState("");
  const [parcelCount, setParcelCount] = useState("1");
  const [note, setNote] = useState("");

  return (
    <Modal
      title="Log a parcel"
      note="Recorded at the gate. The resident is notified as soon as it is saved."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || !courier.trim()}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/deliveries", {
                    courier: courier.trim(),
                    ...(unitId ? { unitId } : {}),
                    ...(trackingRef.trim() ? { trackingRef: trackingRef.trim() } : {}),
                    parcelCount: Number(parcelCount) || 1,
                    ...(note.trim() ? { note: note.trim() } : {}),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Saving…" : "Log it"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={() => undefined}>
        <div className="grid-2">
          <Field label="Courier" htmlFor="courier">
            <input
              id="courier"
              value={courier}
              onChange={(e) => setCourier(e.target.value)}
              placeholder="Amazon"
              maxLength={120}
            />
          </Field>

          <Field label="Parcels" htmlFor="count">
            <input
              id="count"
              type="number"
              min={1}
              max={200}
              value={parcelCount}
              onChange={(e) => setParcelCount(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Flat" htmlFor="dunit" hint="Leave blank if the label is unreadable.">
          <select id="dunit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">Not known</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.number} · {u.towerName}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Tracking reference" htmlFor="track" hint="Optional.">
          <input
            id="track"
            value={trackingRef}
            onChange={(e) => setTrackingRef(e.target.value)}
            maxLength={120}
            style={{ fontFamily: "var(--font-figure)", fontSize: "0.82rem" }}
          />
        </Field>

        <Field label="Note" htmlFor="dnote" hint="Optional. Anything the resident should know.">
          <input id="dnote" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </Field>
      </Form>
    </Modal>
  );
}

function AdvanceParcel({
  delivery,
  onClose,
  onDone,
}: {
  delivery: Delivery;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const options = NEXT[delivery.status] ?? [];
  const [status, setStatus] = useState(options[0] ?? "");
  const [handoverTo, setHandoverTo] = useState("");
  const [note, setNote] = useState("");

  const needsName = NEEDS_PROOF.has(status);
  const ready = Boolean(status) && (!needsName || handoverTo.trim().length > 0);

  return (
    <Modal
      title={`${delivery.courier} · ${delivery.parcelCount} parcel${
        delivery.parcelCount === 1 ? "" : "s"
      }`}
      note={`Currently ${delivery.status.replace(/_/g, " ")}.`}
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
                  api.post("/v1/deliveries/advance", {
                    id: delivery.id,
                    status,
                    ...(handoverTo.trim() ? { handoverTo: handoverTo.trim() } : {}),
                    ...(note.trim() ? { note: note.trim() } : {}),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      {options.length === 0 ? (
        <Banner tone="info">
          This parcel has reached its final state. Nothing further can be recorded against
          it — the history stays as it is.
        </Banner>
      ) : (
        <Form onSubmit={() => undefined}>
          <Field label="Move to" htmlFor="dstatus">
            <select id="dstatus" value={status} onChange={(e) => setStatus(e.target.value)}>
              {options.map((option) => (
                <option key={option} value={option}>
                  {option.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>

          {needsName ? (
            <Field
              label="Handed to"
              htmlFor="hto"
              hint="Required. A handover with nobody named is an assertion, not a record."
            >
              <input
                id="hto"
                value={handoverTo}
                onChange={(e) => setHandoverTo(e.target.value)}
                maxLength={160}
                placeholder="Mrs Sharma, A-402"
              />
            </Field>
          ) : null}

          <Field label="Note" htmlFor="anote" hint="Optional.">
            <input id="anote" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
        </Form>
      )}
    </Modal>
  );
}
