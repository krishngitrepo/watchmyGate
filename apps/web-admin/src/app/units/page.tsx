"use client";

import { useEffect, useMemo, useState } from "react";

import { Chip, Figure, Ledger, Loading, Problem, Shell } from "../../components/Shell";
import { api, shortDate } from "../../lib/api";

interface Unit {
  id: string;
  number: string;
  towerId: string;
  towerName: string;
  floor: number | null;
  carpetAreaSqft: string | null;
  bhk: number | null;
  status: string;
}

interface Occupant {
  occupancyId: string;
  personId: string;
  name: string | null;
  phone: string;
  relationship: string;
  isBillingLiable: boolean;
  hasVotingRight: boolean;
  hasAppAccess: boolean;
  validFrom: string;
  validTo: string | null;
}

/**
 * Flats and residents.
 *
 * The screen that makes the occupancy model visible, and the reason it is worth having.
 * A flat can hold an owner who votes but does not pay and a tenant who pays but does
 * not vote, at the same time. Competitors collapse this into one "resident" field and
 * then cannot answer "who was liable in June?" — which is the first question every
 * disputed invoice raises.
 */
export default function Units() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [selected, setSelected] = useState<Unit | null>(null);
  const [occupants, setOccupants] = useState<Occupant[]>([]);
  const [asOf, setAsOf] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingOccupants, setLoadingOccupants] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setUnits(await api.get<Unit[]>("/v1/society/units"));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selected) return;
    void (async () => {
      setLoadingOccupants(true);
      try {
        const suffix = asOf ? `?on=${asOf}` : "";
        setOccupants(
          await api.get<Occupant[]>(`/v1/society/units/${selected.id}/occupants${suffix}`),
        );
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoadingOccupants(false);
      }
    })();
  }, [selected, asOf]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return units;
    return units.filter(
      (u) =>
        u.number.toLowerCase().includes(needle) ||
        u.towerName.toLowerCase().includes(needle),
    );
  }, [units, query]);

  const counts = useMemo(
    () => ({
      total: units.length,
      occupied: units.filter((u) => u.status === "occupied").length,
      vacant: units.filter((u) => u.status === "vacant").length,
      towers: new Set(units.map((u) => u.towerName)).size,
    }),
    [units],
  );

  return (
    <Shell
      title="Flats & Residents"
      lede="Select a flat to see who occupies it, and who occupied it on any past date."
    >
      {error ? <Problem error={error} /> : null}

      <dl className="figures settle">
        <Figure label="Flats" value={String(counts.total)} />
        <Figure label="Occupied" value={String(counts.occupied)} tone="settled" />
        <Figure label="Vacant" value={String(counts.vacant)} />
        <Figure label="Towers" value={String(counts.towers)} />
      </dl>

      <section className="ledger settle">
        <div className="toolbar">
          <input
            placeholder="Find a flat or tower…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
            aria-label="Search flats"
          />
        </div>

        {loading ? (
          <Loading />
        ) : visible.length === 0 ? (
          <p className="empty">No flats match that.</p>
        ) : (
          <div className="ledger-scroll">
            <table>
              <thead>
                <tr>
                  <th>Flat</th>
                  <th>Tower</th>
                  <th>Floor</th>
                  <th>Type</th>
                  <th style={{ textAlign: "right" }}>Carpet area</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((unit) => (
                  <tr key={unit.id}>
                    <td style={{ fontWeight: 600 }}>{unit.number}</td>
                    <td className="muted">{unit.towerName}</td>
                    <td className="num muted">{unit.floor ?? "—"}</td>
                    <td className="muted">{unit.bhk ? `${unit.bhk} BHK` : "—"}</td>
                    <td className="num">
                      {unit.carpetAreaSqft ? `${unit.carpetAreaSqft} sq ft` : "—"}
                    </td>
                    <td>
                      <Chip tone={unit.status === "occupied" ? "settled" : "quiet"}>
                        {unit.status.replace(/_/g, " ")}
                      </Chip>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        onClick={() => {
                          setSelected(unit);
                          setAsOf("");
                        }}
                      >
                        Residents
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected ? (
        <section className="ledger settle">
          <div className="ledger-head">
            <h2>
              {selected.number} · {selected.towerName}
            </h2>
            <button onClick={() => setSelected(null)}>Close</button>
          </div>

          <div className="toolbar">
            <label htmlFor="asof" style={{ margin: 0, whiteSpace: "nowrap" }}>
              Who lived here on
            </label>
            <input
              id="asof"
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              style={{ width: "auto" }}
            />
            {asOf ? (
              <button onClick={() => setAsOf("")}>Back to today</button>
            ) : (
              <span className="note muted">
                Leave blank for today. Past dates answer &quot;who was liable then?&quot;
              </span>
            )}
          </div>

          {loadingOccupants ? (
            <Loading />
          ) : occupants.length === 0 ? (
            <p className="empty">
              {asOf
                ? `Nobody was recorded as occupying this flat on ${shortDate(asOf)}.`
                : "No residents recorded for this flat."}
            </p>
          ) : (
            <div className="ledger-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Resident</th>
                    <th>Phone</th>
                    <th>Relationship</th>
                    <th>Pays</th>
                    <th>Votes</th>
                    <th>App</th>
                    <th>From</th>
                    <th>Until</th>
                  </tr>
                </thead>
                <tbody>
                  {occupants.map((o) => (
                    <tr key={o.occupancyId}>
                      <td style={{ fontWeight: 500 }}>{o.name ?? "—"}</td>
                      <td className="num muted" style={{ textAlign: "left" }}>
                        {o.phone}
                      </td>
                      <td>
                        <Chip tone="quiet">{o.relationship.replace(/_/g, " ")}</Chip>
                      </td>
                      {/* These three are the whole point of the model: they vary
                          independently, and a single "resident" flag cannot express it. */}
                      <td>{o.isBillingLiable ? <Chip tone="arrears">liable</Chip> : "—"}</td>
                      <td>{o.hasVotingRight ? <Chip tone="settled">votes</Chip> : "—"}</td>
                      <td>{o.hasAppAccess ? <Chip tone="quiet">access</Chip> : "—"}</td>
                      <td className="muted">{shortDate(o.validFrom)}</td>
                      <td className="muted">
                        {o.validTo ? shortDate(o.validTo) : <span>present</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </Shell>
  );
}
