"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Banner,
  Check,
  Chip,
  Field,
  Figure,
  Form,
  Loading,
  Modal,
  Problem,
  Shell,
  useAction,
} from "../../components/Shell";
import { api, can, shortDate } from "../../lib/api";

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

interface Tower {
  id: string;
  name: string;
  floors: number | null;
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

const RELATIONSHIPS = ["owner", "tenant", "family_member", "occupant"] as const;

/**
 * Flats and residents.
 *
 * The screen that makes the occupancy model visible, and the reason it is worth having.
 * A flat can hold an owner who votes but does not pay and a tenant who pays but does not
 * vote, at the same time. Competitors collapse this into one "resident" field and then
 * cannot answer "who was liable in June?" — which is the first question every disputed
 * invoice raises.
 */
export default function Units() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [towers, setTowers] = useState<Tower[]>([]);
  const [selected, setSelected] = useState<Unit | null>(null);
  const [occupants, setOccupants] = useState<Occupant[]>([]);
  const [asOf, setAsOf] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingOccupants, setLoadingOccupants] = useState(false);
  const [addingTower, setAddingTower] = useState(false);
  const [addingUnit, setAddingUnit] = useState(false);
  const [movingIn, setMovingIn] = useState(false);

  const mayEdit = can("society_admin", "mc_member");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [unitList, towerList] = await Promise.all([
        api.get<Unit[]>("/v1/society/units"),
        api.get<Tower[]>("/v1/society/towers"),
      ]);
      setUnits(unitList);
      setTowers(towerList);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadOccupants = useCallback(async () => {
    if (!selected) return;
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
  }, [selected, asOf]);

  useEffect(() => {
    void loadOccupants();
  }, [loadOccupants]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return units;
    return units.filter(
      (u) =>
        u.number.toLowerCase().includes(needle) || u.towerName.toLowerCase().includes(needle),
    );
  }, [units, query]);

  const counts = useMemo(
    () => ({
      total: units.length,
      occupied: units.filter((u) => u.status === "occupied").length,
      vacant: units.filter((u) => u.status === "vacant").length,
      towers: towers.length,
    }),
    [units, towers],
  );

  return (
    <Shell
      title="Flats & Residents"
      lede="Select a flat to see who occupies it, and who occupied it on any past date."
      actions={
        mayEdit ? (
          <>
            <button onClick={() => setAddingTower(true)}>Add a tower</button>
            <button
              data-variant="primary"
              disabled={towers.length === 0}
              title={towers.length === 0 ? "Add a tower first — a flat has to sit in one." : undefined}
              onClick={() => setAddingUnit(true)}
            >
              Add flats
            </button>
          </>
        ) : null
      }
    >
      {error ? <Problem error={error} /> : null}

      <dl className="figures settle">
        <Figure label="Flats" value={String(counts.total)} />
        <Figure label="Occupied" value={String(counts.occupied)} tone="settled" />
        <Figure label="Vacant" value={String(counts.vacant)} />
        <Figure label="Towers" value={String(counts.towers)} />
      </dl>

      {!loading && towers.length === 0 ? (
        <Banner tone="warn">
          This society has no towers yet, so it can hold no flats. Add a tower — or, if you
          are moving from another system, use <strong>Import Data</strong> and bring the
          whole register across at once.
        </Banner>
      ) : null}

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
          <p className="empty">
            {query ? "No flats match that." : "No flats on the register yet."}
          </p>
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
                    <td className="strong">{unit.number}</td>
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
                    <td>
                      <div className="row-actions">
                        <button
                          data-size="sm"
                          onClick={() => {
                            setSelected(unit);
                            setAsOf("");
                          }}
                        >
                          Residents
                        </button>
                      </div>
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
            <div>
              {mayEdit ? (
                <button data-size="sm" data-variant="primary" onClick={() => setMovingIn(true)}>
                  Move someone in
                </button>
              ) : null}
              <button data-size="sm" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
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
              <button data-size="sm" onClick={() => setAsOf("")}>
                Back to today
              </button>
            ) : (
              <span className="note">
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
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {occupants.map((o) => (
                    <tr key={o.occupancyId}>
                      <td className="strong">{o.name ?? "—"}</td>
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
                      <td className="muted">{o.validTo ? shortDate(o.validTo) : "present"}</td>
                      <td>
                        {mayEdit && !o.validTo ? (
                          <div className="row-actions">
                            <MoveOutButton occupant={o} onDone={loadOccupants} />
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {addingTower ? (
        <AddTower
          onClose={() => setAddingTower(false)}
          onDone={() => {
            setAddingTower(false);
            void load();
          }}
        />
      ) : null}

      {addingUnit ? (
        <AddFlats
          towers={towers}
          onClose={() => setAddingUnit(false)}
          onDone={() => {
            setAddingUnit(false);
            void load();
          }}
        />
      ) : null}

      {movingIn && selected ? (
        <MoveIn
          unit={selected}
          onClose={() => setMovingIn(false)}
          onDone={() => {
            setMovingIn(false);
            void loadOccupants();
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

/**
 * End an occupancy.
 *
 * The row is not deleted. `validTo` is set, so "who was liable in June?" still answers
 * correctly after the tenant has left — which is the entire reason occupancy is
 * bitemporal rather than a field on the flat.
 */
function MoveOutButton({ occupant, onDone }: { occupant: Occupant; onDone: () => Promise<void> }) {
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [validTo, setValidTo] = useState(new Date().toISOString().slice(0, 10));

  if (!open) {
    return (
      <button data-size="sm" onClick={() => setOpen(true)}>
        Move out
      </button>
    );
  }

  return (
    <Modal
      title={`Move out ${occupant.name ?? occupant.phone}`}
      note="The record stays. Only the end date is set, so past bills still resolve to the right person."
      onClose={() => setOpen(false)}
      footer={
        <>
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            data-variant="danger"
            disabled={action.busy}
            onClick={() =>
              void action.run(
                () =>
                  api.del(
                    `/v1/society/occupancies/${occupant.occupancyId}?validTo=${validTo}`,
                  ),
                {
                  onDone: async () => {
                    setOpen(false);
                    await onDone();
                  },
                },
              )
            }
          >
            {action.busy ? "Saving…" : "Move out"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}
      <Field
        label="Last day of occupancy"
        htmlFor="mvto"
        hint="A past date is fine — say they left on the 3rd and bills regenerate correctly."
      >
        <input
          id="mvto"
          type="date"
          value={validTo}
          onChange={(e) => setValidTo(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

function AddTower({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const [name, setName] = useState("");
  const [floors, setFloors] = useState("");

  return (
    <Modal
      title="Add a tower"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || !name.trim()}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/society/towers", {
                    name: name.trim(),
                    ...(floors ? { floors: Number(floors) } : {}),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Saving…" : "Add tower"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}
      <Form onSubmit={() => undefined}>
        <Field label="Name" htmlFor="tname" hint="Whatever residents call it — Tower B, Wing 2, Block A.">
          <input
            id="tname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="Tower B"
          />
        </Field>
        <Field label="Floors" htmlFor="tfloors" hint="Optional.">
          <input
            id="tfloors"
            type="number"
            min={1}
            max={200}
            value={floors}
            onChange={(e) => setFloors(e.target.value)}
          />
        </Field>
      </Form>
    </Modal>
  );
}

/**
 * Add flats.
 *
 * One at a time, or a whole floor at once. The bulk path is the one that matters: a
 * 400-flat society will not add them one by one, and typing them individually is how a
 * committee gives up halfway and the register stays half true.
 */
function AddFlats({
  towers,
  onClose,
  onDone,
}: {
  towers: Tower[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [towerId, setTowerId] = useState(towers[0]?.id ?? "");
  const [bulk, setBulk] = useState(false);
  const [number, setNumber] = useState("");
  const [floor, setFloor] = useState("");
  const [bhk, setBhk] = useState("");
  const [carpetAreaSqft, setCarpetArea] = useState("");
  const [pattern, setPattern] = useState("");

  const areaOk = carpetAreaSqft === "" || /^\d+(\.\d{1,2})?$/.test(carpetAreaSqft);

  // "101-108" and "101,102,105" both work — the two ways people actually write a floor.
  const expanded = useMemo(() => expandPattern(pattern), [pattern]);

  const ready = bulk ? expanded.length > 0 && Boolean(towerId) : Boolean(number.trim() && towerId);

  function submit() {
    const common = {
      ...(floor ? { floor: Number(floor) } : {}),
      ...(bhk ? { bhk: Number(bhk) } : {}),
      ...(carpetAreaSqft ? { carpetAreaSqft } : {}),
    };

    void action.run(
      () =>
        bulk
          ? api.post("/v1/society/units/bulk", {
              units: expanded.map((n) => ({ towerId, number: n, ...common })),
            })
          : api.post("/v1/society/units", { towerId, number: number.trim(), ...common }),
      { onDone },
    );
  }

  return (
    <Modal
      title={bulk ? "Add a run of flats" : "Add a flat"}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button data-variant="primary" disabled={action.busy || !ready || !areaOk} onClick={submit}>
            {action.busy ? "Saving…" : bulk ? `Add ${expanded.length} flats` : "Add flat"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={submit}>
        <Field label="Tower" htmlFor="utower">
          <select id="utower" value={towerId} onChange={(e) => setTowerId(e.target.value)}>
            {towers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>

        <Check
          label="Add several at once"
          hint="A whole floor, or a whole tower."
          checked={bulk}
          onChange={setBulk}
        />

        {bulk ? (
          <Field
            label="Flat numbers"
            htmlFor="upattern"
            hint={
              expanded.length > 0
                ? `${expanded.length} flats: ${expanded.slice(0, 6).join(", ")}${
                    expanded.length > 6 ? "…" : ""
                  }`
                : "A range like 101-108, or a list like 101,102,105. Both work."
            }
          >
            <input
              id="upattern"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="101-108"
              style={{ fontFamily: "var(--font-figure)" }}
            />
          </Field>
        ) : (
          <Field label="Flat number" htmlFor="unum">
            <input
              id="unum"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              maxLength={32}
              placeholder="A-101"
            />
          </Field>
        )}

        <div className="grid-2">
          <Field label="Floor" htmlFor="ufloor" hint="Optional.">
            <input
              id="ufloor"
              type="number"
              min={-5}
              max={200}
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
            />
          </Field>

          <Field label="BHK" htmlFor="ubhk" hint="Optional.">
            <input
              id="ubhk"
              type="number"
              min={1}
              max={20}
              value={bhk}
              onChange={(e) => setBhk(e.target.value)}
            />
          </Field>

          <Field
            label="Carpet area"
            htmlFor="uarea"
            hint={
              areaOk
                ? "Square feet. Feeds per-sq-ft billing, so it is kept exact."
                : "Digits and up to two decimals."
            }
          >
            <input
              id="uarea"
              inputMode="decimal"
              value={carpetAreaSqft}
              onChange={(e) => setCarpetArea(e.target.value.trim())}
              placeholder="1150.00"
              style={{ fontFamily: "var(--font-figure)" }}
            />
          </Field>
        </div>
      </Form>

      {bulk ? (
        <Banner tone="info">
          Every row is reported individually. A flat that already exists is skipped rather
          than aborting the rest — a single bad number should not cost you the other 399.
        </Banner>
      ) : null}
    </Modal>
  );
}

/**
 * Move someone in.
 *
 * Three checkboxes, not one. Billing liability, voting right and app access genuinely
 * belong to different people — the owner votes while the tenant pays, and both need the
 * app. Defaults follow the relationship, but every one of them can be changed, because
 * the exceptions are common enough that a fixed rule would be wrong weekly.
 */
function MoveIn({ unit, onClose, onDone }: { unit: Unit; onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState<string>("owner");
  const [isBillingLiable, setBillingLiable] = useState(true);
  const [hasVotingRight, setVotingRight] = useState(true);
  const [hasAppAccess, setAppAccess] = useState(true);
  const [validFrom, setValidFrom] = useState(new Date().toISOString().slice(0, 10));

  function pickRelationship(value: string) {
    setRelationship(value);
    // Sensible defaults, all overridable: an owner votes and pays; a tenant pays but does
    // not vote; family gets the app and neither of the other two.
    if (value === "owner") {
      setBillingLiable(true);
      setVotingRight(true);
    } else if (value === "tenant") {
      setBillingLiable(true);
      setVotingRight(false);
    } else {
      setBillingLiable(false);
      setVotingRight(false);
    }
  }

  return (
    <Modal
      title={`Move someone into ${unit.number}`}
      note="Their phone number is their identity. If they already exist in another society, the same person is reused."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || phone.trim().length < 6}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/society/occupancies", {
                    unitId: unit.id,
                    phone: phone.trim(),
                    ...(name.trim() ? { name: name.trim() } : {}),
                    relationship,
                    isBillingLiable,
                    hasVotingRight,
                    hasAppAccess,
                    validFrom,
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Saving…" : "Move in"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={() => undefined}>
        <div className="grid-2">
          <Field label="Phone" htmlFor="ophone">
            <input
              id="ophone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={20}
              placeholder="+91 99000 00001"
            />
          </Field>

          <Field label="Name" htmlFor="oname" hint="Optional if they already have an account.">
            <input
              id="oname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
            />
          </Field>

          <Field label="Relationship" htmlFor="orel">
            <select
              id="orel"
              value={relationship}
              onChange={(e) => pickRelationship(e.target.value)}
            >
              {RELATIONSHIPS.map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="From"
            htmlFor="ofrom"
            hint="A past date is fine. Bills regenerate against the truth, not the entry date."
          >
            <input
              id="ofrom"
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
          </Field>
        </div>

        <Check
          label="Liable for the bill"
          hint="Invoices for this flat are addressed to them."
          checked={isBillingLiable}
          onChange={setBillingLiable}
        />
        <Check
          label="Has a vote"
          hint="Counts in polls and elections for this flat."
          checked={hasVotingRight}
          onChange={setVotingRight}
        />
        <Check
          label="Can use the app"
          hint="Receives visitor approvals and notices."
          checked={hasAppAccess}
          onChange={setAppAccess}
        />
      </Form>

      <Banner tone="info">
        These three are deliberately independent. An owner who has let the flat out still
        votes; the tenant living there pays and needs approvals. One &quot;resident&quot;
        field cannot express that, which is why disputed invoices are hard to settle in
        every other system.
      </Banner>
    </Modal>
  );
}

/** "101-108" → 101…108. "101,102,105" → those three. Anything else → nothing. */
function expandPattern(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const range = /^(\D*)(\d+)\s*[-–]\s*(\D*)(\d+)$/.exec(trimmed);
  if (range) {
    const [, prefix = "", fromRaw = "", , toRaw = ""] = range;
    const from = Number(fromRaw);
    const to = Number(toRaw);
    // Bounded: a typo like 1-9999 should not attempt ten thousand flats.
    if (from <= to && to - from < 500) {
      const width = fromRaw.length;
      return Array.from({ length: to - from + 1 }, (_, i) =>
        `${prefix}${String(from + i).padStart(width, "0")}`,
      );
    }
    return [];
  }

  return trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 500);
}
