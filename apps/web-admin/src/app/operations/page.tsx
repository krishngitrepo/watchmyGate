"use client";

import { useEffect, useState } from "react";

import { Chip, Figure, Ledger, Loading, Problem, Shell } from "../../components/Shell";
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
}

interface Violation {
  id: string;
  plate: string;
  reason: string;
  reportedAt: string;
  resolvedAt: string | null;
}

interface Alert {
  id: string;
  type: string;
  raisedAt: string;
  acknowledgedAt: string | null;
  closedAt: string | null;
  note: string | null;
}

interface Slot {
  id: string;
  code: string;
  kind: string;
  vehicleId: string | null;
  unitId: string | null;
}

const OPEN_DELIVERY = new Set([
  "at_gate",
  "awaiting_resident",
  "held_at_gate",
  "out_for_doorstep",
]);

/**
 * The day-to-day gate: parcels, alarms and parking.
 *
 * These three sit on one page because a committee member checking on the gate wants all
 * of them at once, and because none is big enough on its own to justify a tab a
 * treasurer has to learn.
 *
 * SOS is placed first and is the only thing on this page allowed to be loud. Everything
 * else is a list; an unacknowledged alarm is a person waiting.
 */
export default function OperationsPage() {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const [d, a, v, s] = await Promise.all([
          api.get<Delivery[]>("/v1/deliveries"),
          api.get<Alert[]>("/v1/safety/sos"),
          api.get<Violation[]>("/v1/parking/violations"),
          api.get<Slot[]>("/v1/parking/slots"),
        ]);
        setDeliveries(d);
        setAlerts(a);
        setViolations(v);
        setSlots(s);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const waiting = deliveries.filter((d) => OPEN_DELIVERY.has(d.status));
  const freeSlots = slots.filter((s) => !s.vehicleId).length;
  const unacked = alerts.filter((a) => !a.acknowledgedAt).length;

  return (
    <Shell
      title="Gate Operations"
      lede="Parcels waiting, alarms raised, and parking. The things a committee member checks on a Sunday."
    >
      {error ? <Problem error={error} /> : null}

      <dl className="figures settle">
        <Figure
          label="Open alarms"
          value={String(alerts.length)}
          hint={unacked > 0 ? `${unacked} not acknowledged` : "all acknowledged"}
          {...(alerts.length > 0 ? { tone: "arrears" as const } : {})}
        />
        <Figure label="Parcels waiting" value={String(waiting.length)} hint="not yet handed over" />
        <Figure label="Free parking" value={`${freeSlots}/${slots.length}`} hint="slots unallotted" />
        <Figure
          label="Parking flags"
          value={String(violations.length)}
          hint="unresolved"
          {...(violations.length > 0 ? { tone: "arrears" as const } : {})}
        />
      </dl>

      <Ledger
        title="SOS alerts"
        note="a person is waiting on each of these"
        head={["Type", "Raised", "Acknowledged", "Note"]}
        empty="No alarms are open. "
        isEmpty={!loading && alerts.length === 0}
      >
        {alerts.map((a) => (
          <tr key={a.id}>
            <td>
              <Chip tone="arrears">{a.type}</Chip>
            </td>
            <td className="muted">{timeAgo(a.raisedAt)}</td>
            <td>
              {a.acknowledgedAt ? (
                <Chip tone="settled">{timeAgo(a.acknowledgedAt)}</Chip>
              ) : (
                /* The only thing on this page that should make someone act now. */
                <Chip tone="arrears">nobody yet</Chip>
              )}
            </td>
            <td className="muted">{a.note ?? "—"}</td>
          </tr>
        ))}
      </Ledger>

      <Ledger
        title="Parcels at the gate"
        note="gate to doorstep"
        head={["Courier", "~Parcels", "Status", "Arrived", "Handed to"]}
        empty="No parcels are waiting."
        isEmpty={!loading && waiting.length === 0}
      >
        {waiting.map((d) => (
          <tr key={d.id}>
            <td style={{ fontWeight: 500 }}>{d.courier}</td>
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
          </tr>
        ))}
      </Ledger>

      <Ledger
        title="Unauthorised parking"
        note="flagged by a guard or by plate recognition"
        head={["Plate", "Reason", "Reported"]}
        empty="Nothing flagged."
        isEmpty={!loading && violations.length === 0}
      >
        {violations.map((v) => (
          <tr key={v.id}>
            <td className="num" style={{ textAlign: "left", fontWeight: 600 }}>
              {v.plate}
            </td>
            <td>{v.reason}</td>
            <td className="muted">{timeAgo(v.reportedAt)}</td>
          </tr>
        ))}
      </Ledger>

      {loading ? <Loading /> : null}
    </Shell>
  );
}
