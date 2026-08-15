"use client";

import { useEffect, useMemo, useState } from "react";

import { Chip, Figure, Ledger, Loading, Problem, Shell } from "../../components/Shell";
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

interface Unit {
  id: string;
  number: string;
  towerName: string;
}

/** Drift beyond this means the handset's clock needs attention. */
const DRIFT_ALERT_SECONDS = 300;

/**
 * The gate log.
 *
 * Two columns here exist because of how gates actually work, and both are unusual
 * enough to be worth explaining on the page rather than only in the code:
 *
 * **Offline pass** — a signed pass verified on the guard's handset with no network at
 * all. This is the product's central claim, and showing it per entry is what proves it
 * to a committee rather than asserting it in a sales deck.
 *
 * **Clock drift** — guard handsets are cheap, shared, and nobody owns keeping their
 * clocks right; being hours out is normal. Every figure on this page is server time.
 * The drift column exists so a committee can see which handset needs fixing, and so
 * that an entry timestamp is never quietly wrong.
 */
export default function GateLog() {
  const [inside, setInside] = useState<GateEvent[]>([]);
  const [units, setUnits] = useState<Map<string, Unit>>(new Map());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const [current, unitList] = await Promise.all([
          api.get<GateEvent[]>("/v1/gate/inside"),
          api.get<Unit[]>("/v1/society/units"),
        ]);
        setInside(current);
        setUnits(new Map(unitList.map((u) => [u.id, u])));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
    >
      {error ? <Problem error={error} /> : null}

      <dl className="figures settle">
        <Figure label="Inside now" value={String(inside.length)} hint="no matching exit" />
        <Figure
          label="Offline passes"
          value={String(stats.offline)}
          hint="verified with no network"
          tone="settled"
        />
        <Figure
          label="Overstaying"
          value={String(stats.overstay)}
          hint="in longer than expected"
          {...(stats.overstay > 0 ? { tone: "arrears" as const } : {})}
        />
        <Figure
          label="Clock drift"
          value={String(stats.drifting)}
          hint="handsets needing a time fix"
          {...(stats.drifting > 0 ? { tone: "arrears" as const } : {})}
        />
      </dl>

      <Ledger
        title="Currently inside"
        note="entries with no matching exit"
        head={["Visitor", "Category", "Flat", "Vehicle", "Entered", "Verified", "~Clock drift"]}
        empty="Nobody is signed in at the gate right now."
        isEmpty={!loading && inside.length === 0}
      >
        {inside.map((event) => {
          const unit = event.unitId ? units.get(event.unitId) : undefined;
          const drift = event.clockDriftSeconds;
          const driftBad = drift !== null && Math.abs(drift) > DRIFT_ALERT_SECONDS;

          return (
            <tr key={event.id}>
              <td>
                <span style={{ fontWeight: 500 }}>
                  {event.visitorName ?? <span className="muted">not recorded</span>}
                </span>
                {event.overstayAlertedAt ? (
                  <span style={{ display: "block", marginTop: 3 }}>
                    <Chip tone="arrears">overstay flagged</Chip>
                  </span>
                ) : null}
              </td>
              <td className="muted">{event.category}</td>
              <td>{unit ? `${unit.number}` : <span className="muted">—</span>}</td>
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

      <section className="ledger settle">
        <div className="ledger-head">
          <h2>Why the gate keeps working without signal</h2>
        </div>
        <div style={{ padding: "14px 16px", fontSize: "0.88rem", color: "var(--ink-soft)" }}>
          <p style={{ marginTop: 0 }}>
            A pre-approved visitor&apos;s QR pass is signed by this society&apos;s own key.
            The guard&apos;s handset checks that signature against a cached copy of the
            public key — no network, no lookup, no waiting. Entries queue on the device
            and upload when signal returns.
          </p>
          <p style={{ marginBottom: 0 }}>
            The pass carries a <strong>hash</strong> of the visitor, never their name or
            number, because a QR gets photographed and forwarded on WhatsApp.
          </p>
        </div>
      </section>
    </Shell>
  );
}
