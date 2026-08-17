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
  Tabs,
  useAction,
} from "../../components/Shell";
import { api, can, rupees, timeAgo } from "../../lib/api";

interface Vehicle {
  id: string;
  plate: string;
  plateDisplay: string;
  kind: string;
  unitId: string | null;
  staffId: string | null;
  makeModel: string | null;
  colour: string | null;
  stickerNo: string | null;
  isActive: boolean;
}

interface Slot {
  id: string;
  code: string;
  kind: string;
  level: string | null;
  unitId: string | null;
  vehicleId: string | null;
  allottedAt: string | null;
  monthlyRate: string;
}

interface Violation {
  id: string;
  plate: string;
  reason: string;
  reportedAt: string;
  resolvedAt: string | null;
}

interface Unit {
  id: string;
  number: string;
  towerName: string;
}

const VEHICLE_KINDS = ["car", "two_wheeler", "bicycle", "commercial", "other"] as const;
const SLOT_KINDS = ["covered", "open", "stack", "visitor", "accessible", "ev"] as const;

type Tab = "slots" | "vehicles" | "violations";

/**
 * Vehicles and parking.
 *
 * A parking space is the scarcest thing a society owns and the thing residents argue
 * about most, so two decisions are visible here rather than buried.
 *
 * **Allotment lives on the slot, not on the vehicle.** One row holds the space, so two
 * cars can never both be recorded as parked in B-14 — the database will not allow it.
 *
 * **Plates are normalised before they are stored.** `KA-01 AB 1234`, `ka01ab1234` and
 * `KA 01AB1234` are the same car, and a gate lookup that misses because a guard typed a
 * space is a lookup that gets abandoned.
 */
export default function ParkingPage() {
  const [tab, setTab] = useState<Tab>("slots");
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [lookup, setLookup] = useState("");
  const [addingVehicle, setAddingVehicle] = useState(false);
  const [addingSlot, setAddingSlot] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [allotting, setAllotting] = useState<Slot | null>(null);

  const mayManage = can("society_admin", "mc_member");
  const unitsById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const vehiclesById = useMemo(() => new Map(vehicles.map((v) => [v.id, v])), [vehicles]);

  const load = useCallback(async () => {
    try {
      const [v, s, vi, u] = await Promise.all([
        api.get<Vehicle[]>("/v1/parking/vehicles"),
        api.get<Slot[]>("/v1/parking/slots"),
        api.get<Violation[]>("/v1/parking/violations"),
        api.get<Unit[]>("/v1/society/units"),
      ]);
      setVehicles(v);
      setSlots(s);
      setViolations(vi);
      setUnits(u);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const free = slots.filter((s) => !s.vehicleId).length;

  // Matching is done on the normalised plate so a search with spaces or dashes still
  // finds the car — the same normalisation the gate lookup applies server-side.
  const needle = lookup.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const matchedVehicles = needle
    ? vehicles.filter((v) => v.plate.includes(needle))
    : vehicles;

  return (
    <Shell
      title="Parking"
      lede="Slots, registered vehicles, and anything parked where it should not be."
      actions={
        mayManage ? (
          <>
            <button onClick={() => setAddingSlot(true)}>Add a slot</button>
            <button onClick={() => setFlagging(true)}>Flag a vehicle</button>
            <button data-variant="primary" onClick={() => setAddingVehicle(true)}>
              Register a vehicle
            </button>
          </>
        ) : (
          <button onClick={() => setFlagging(true)}>Flag a vehicle</button>
        )
      }
    >
      {error ? <Problem error={error} /> : null}

      <dl className="figures settle">
        <Figure label="Slots" value={String(slots.length)} hint="on the register" />
        <Figure
          label="Free"
          value={`${free}/${slots.length}`}
          hint="unallotted right now"
          {...(free === 0 && slots.length > 0 ? { tone: "arrears" as const } : { tone: "settled" as const })}
        />
        <Figure label="Vehicles" value={String(vehicles.length)} hint="registered to flats" />
        <Figure
          label="Flagged"
          value={String(violations.length)}
          hint="unresolved"
          {...(violations.length > 0 ? { tone: "arrears" as const } : {})}
        />
      </dl>

      <section className="ledger settle">
        <Tabs
          tabs={[
            { id: "slots" as const, label: `Slots (${slots.length})` },
            { id: "vehicles" as const, label: `Vehicles (${vehicles.length})` },
            { id: "violations" as const, label: `Flagged (${violations.length})` },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === "vehicles" ? (
          <div className="toolbar">
            <input
              placeholder="Find a plate — spacing and dashes do not matter…"
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              style={{ flex: 1, minWidth: 240, fontFamily: "var(--font-figure)" }}
              aria-label="Search plates"
            />
            {needle ? (
              <span className="note">
                {matchedVehicles.length} match{matchedVehicles.length === 1 ? "" : "es"} for{" "}
                {needle}
              </span>
            ) : null}
          </div>
        ) : null}

        {loading ? <Loading /> : null}

        {!loading && tab === "slots" ? (
          slots.length === 0 ? (
            <p className="empty">No parking slots on the register yet.</p>
          ) : (
            <div className="ledger-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Slot</th>
                    <th>Type</th>
                    <th>Level</th>
                    <th>Allotted to</th>
                    <th>Vehicle</th>
                    <th>~Monthly</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {slots.map((slot) => (
                    <tr key={slot.id}>
                      <td className="num strong" style={{ textAlign: "left" }}>
                        {slot.code}
                      </td>
                      <td>
                        <Chip tone={slot.kind === "visitor" ? "brand" : "quiet"}>{slot.kind}</Chip>
                      </td>
                      <td className="muted">{slot.level ?? "—"}</td>
                      <td>
                        {slot.unitId ? (
                          unitsById.get(slot.unitId)?.number ?? "—"
                        ) : (
                          <Chip tone="settled">free</Chip>
                        )}
                      </td>
                      <td className="num muted" style={{ textAlign: "left" }}>
                        {slot.vehicleId
                          ? (vehiclesById.get(slot.vehicleId)?.plateDisplay ?? "—")
                          : "—"}
                      </td>
                      <td className="num muted">
                        {slot.monthlyRate === "0" || slot.monthlyRate === "0.0000"
                          ? "—"
                          : rupees(slot.monthlyRate)}
                      </td>
                      <td>
                        {mayManage ? (
                          <div className="row-actions">
                            {slot.vehicleId ? (
                              <ReleaseButton slot={slot} onDone={load} />
                            ) : (
                              <button data-size="sm" onClick={() => setAllotting(slot)}>
                                Allot
                              </button>
                            )}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}

        {!loading && tab === "vehicles" ? (
          matchedVehicles.length === 0 ? (
            <p className="empty">
              {needle ? "No vehicle registered with that plate." : "No vehicles registered."}
            </p>
          ) : (
            <div className="ledger-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Plate</th>
                    <th>Type</th>
                    <th>Flat</th>
                    <th>Vehicle</th>
                    <th>Sticker</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {matchedVehicles.map((v) => (
                    <tr key={v.id}>
                      <td className="num strong" style={{ textAlign: "left" }}>
                        {v.plateDisplay}
                        <span className="sub">{v.plate}</span>
                      </td>
                      <td className="muted">{v.kind.replace(/_/g, " ")}</td>
                      <td>
                        {v.unitId ? (
                          (unitsById.get(v.unitId)?.number ?? "—")
                        ) : v.staffId ? (
                          <Chip tone="quiet">staff</Chip>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="muted">
                        {[v.makeModel, v.colour].filter(Boolean).join(" · ") || "—"}
                      </td>
                      <td className="num muted" style={{ textAlign: "left" }}>
                        {v.stickerNo ?? "—"}
                      </td>
                      <td>
                        {mayManage ? (
                          <div className="row-actions">
                            <DeregisterButton vehicle={v} onDone={load} />
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}

        {!loading && tab === "violations" ? (
          violations.length === 0 ? (
            <p className="empty">Nothing flagged.</p>
          ) : (
            <div className="ledger-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Plate</th>
                    <th>Reason</th>
                    <th>Reported</th>
                    <th>Registered here?</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {violations.map((v) => {
                    const known = vehicles.find(
                      (veh) => veh.plate === v.plate.toUpperCase().replace(/[^A-Z0-9]/g, ""),
                    );
                    return (
                      <tr key={v.id}>
                        <td className="num strong" style={{ textAlign: "left" }}>
                          {v.plate}
                        </td>
                        <td>{v.reason}</td>
                        <td className="muted">{timeAgo(v.reportedAt)}</td>
                        <td>
                          {known ? (
                            <Chip tone="quiet">
                              {known.unitId
                                ? (unitsById.get(known.unitId)?.number ?? "a flat")
                                : "known"}
                            </Chip>
                          ) : (
                            <Chip tone="arrears">outsider</Chip>
                          )}
                        </td>
                        <td>
                          <div className="row-actions">
                            <ResolveButton violation={v} onDone={load} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>

      <section className="card settle">
        <div className="card-head">
          <h2>What we will not do to a vehicle</h2>
        </div>
        <div className="card-body">
          <p>
            There is no remote immobiliser here and there never will be. Disabling a
            stranger&apos;s car can strand someone driving to a hospital, and no society has
            the legal standing to do it. A wrongly parked car gets its owner notified —
            that is the whole intervention.
          </p>
        </div>
      </section>

      {addingVehicle ? (
        <RegisterVehicle
          units={units}
          onClose={() => setAddingVehicle(false)}
          onDone={() => {
            setAddingVehicle(false);
            void load();
          }}
        />
      ) : null}

      {addingSlot ? (
        <AddSlot
          onClose={() => setAddingSlot(false)}
          onDone={() => {
            setAddingSlot(false);
            void load();
          }}
        />
      ) : null}

      {flagging ? (
        <FlagVehicle
          slots={slots}
          onClose={() => setFlagging(false)}
          onDone={() => {
            setFlagging(false);
            void load();
          }}
        />
      ) : null}

      {allotting ? (
        <AllotSlot
          slot={allotting}
          vehicles={vehicles}
          units={units}
          onClose={() => setAllotting(null)}
          onDone={() => {
            setAllotting(null);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

function ReleaseButton({ slot, onDone }: { slot: Slot; onDone: () => Promise<void> }) {
  const action = useAction();
  return (
    <button
      data-size="sm"
      disabled={action.busy}
      title={action.error || undefined}
      onClick={() =>
        void action.run(() => api.post(`/v1/parking/slots/${slot.id}/release`, {}), { onDone })
      }
    >
      {action.busy ? "…" : "Release"}
    </button>
  );
}

function DeregisterButton({ vehicle, onDone }: { vehicle: Vehicle; onDone: () => Promise<void> }) {
  const action = useAction();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button data-size="sm" onClick={() => setConfirming(true)}>
        Remove
      </button>
    );
  }

  return (
    <>
      <button data-size="sm" onClick={() => setConfirming(false)}>
        Keep
      </button>
      <button
        data-size="sm"
        data-variant="danger"
        disabled={action.busy}
        title={action.error || undefined}
        onClick={() =>
          void action.run(() => api.del(`/v1/parking/vehicles/${vehicle.id}`), { onDone })
        }
      >
        {action.busy ? "…" : "Confirm"}
      </button>
    </>
  );
}

function ResolveButton({ violation, onDone }: { violation: Violation; onDone: () => Promise<void> }) {
  const action = useAction();
  return (
    <button
      data-size="sm"
      disabled={action.busy}
      title={action.error || undefined}
      onClick={() =>
        void action.run(() => api.post(`/v1/parking/violations/${violation.id}/resolve`, {}), {
          onDone,
        })
      }
    >
      {action.busy ? "…" : "Resolved"}
    </button>
  );
}

function RegisterVehicle({
  units,
  onClose,
  onDone,
}: {
  units: Unit[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [plate, setPlate] = useState("");
  const [unitId, setUnitId] = useState("");
  const [kind, setKind] = useState<string>("car");
  const [makeModel, setMakeModel] = useState("");
  const [colour, setColour] = useState("");
  const [stickerNo, setStickerNo] = useState("");

  const normalised = plate.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ready = normalised.length >= 4;

  return (
    <Modal
      title="Register a vehicle"
      note="Registering it is what makes the gate lookup answer instead of shrugging."
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
                  api.post("/v1/parking/vehicles", {
                    plate: plate.trim(),
                    ...(unitId ? { unitId } : {}),
                    kind,
                    ...(makeModel.trim() ? { makeModel: makeModel.trim() } : {}),
                    ...(colour.trim() ? { colour: colour.trim() } : {}),
                    ...(stickerNo.trim() ? { stickerNo: stickerNo.trim() } : {}),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Saving…" : "Register"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={() => undefined}>
        <Field
          label="Plate"
          htmlFor="plate"
          hint={
            normalised
              ? `Stored as ${normalised} — spacing and dashes are ignored when matching.`
              : "Type it however it appears on the car."
          }
        >
          <input
            id="plate"
            value={plate}
            onChange={(e) => setPlate(e.target.value.toUpperCase())}
            placeholder="KA-01 AB 1234"
            maxLength={24}
            style={{ fontFamily: "var(--font-figure)", fontSize: "1rem", letterSpacing: "0.06em" }}
          />
        </Field>

        <div className="grid-2">
          <Field label="Flat" htmlFor="vunit">
            <select id="vunit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">Not linked to a flat</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.number} · {u.towerName}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Type" htmlFor="vkind">
            <select id="vkind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {VEHICLE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Make and model" htmlFor="vmm" hint="Optional.">
            <input
              id="vmm"
              value={makeModel}
              onChange={(e) => setMakeModel(e.target.value)}
              maxLength={120}
              placeholder="Maruti Swift"
            />
          </Field>

          <Field label="Colour" htmlFor="vcol" hint="Optional.">
            <input
              id="vcol"
              value={colour}
              onChange={(e) => setColour(e.target.value)}
              maxLength={40}
            />
          </Field>

          <Field label="Sticker number" htmlFor="vst" hint="Optional.">
            <input
              id="vst"
              value={stickerNo}
              onChange={(e) => setStickerNo(e.target.value)}
              maxLength={40}
            />
          </Field>
        </div>
      </Form>
    </Modal>
  );
}

function AddSlot({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<string>("open");
  const [level, setLevel] = useState("");
  const [monthlyRate, setMonthlyRate] = useState("");

  const rateOk = monthlyRate === "" || /^\d+(\.\d{1,4})?$/.test(monthlyRate);

  return (
    <Modal
      title="Add a parking slot"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || !code.trim() || !rateOk}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/parking/slots", {
                    code: code.trim(),
                    kind,
                    ...(level.trim() ? { level: level.trim() } : {}),
                    ...(monthlyRate ? { monthlyRate } : {}),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Saving…" : "Add slot"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={() => undefined}>
        <div className="grid-2">
          <Field label="Code" htmlFor="scode" hint="What is painted on the floor.">
            <input
              id="scode"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={40}
              placeholder="B-14"
              style={{ fontFamily: "var(--font-figure)" }}
            />
          </Field>

          <Field label="Type" htmlFor="skind">
            <select id="skind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {SLOT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Level" htmlFor="slevel" hint="Optional. B1, Ground, Stilt.">
            <input id="slevel" value={level} onChange={(e) => setLevel(e.target.value)} maxLength={20} />
          </Field>

          <Field
            label="Monthly rate"
            htmlFor="srate"
            hint={rateOk ? "Optional. Leave blank if included in maintenance." : "Digits only."}
          >
            <input
              id="srate"
              inputMode="decimal"
              value={monthlyRate}
              onChange={(e) => setMonthlyRate(e.target.value.trim())}
              placeholder="0.00"
              style={{ fontFamily: "var(--font-figure)" }}
            />
          </Field>
        </div>
      </Form>
    </Modal>
  );
}

function AllotSlot({
  slot,
  vehicles,
  units,
  onClose,
  onDone,
}: {
  slot: Slot;
  vehicles: Vehicle[];
  units: Unit[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [vehicleId, setVehicleId] = useState("");
  const [unitId, setUnitId] = useState("");

  return (
    <Modal
      title={`Allot slot ${slot.code}`}
      note="One row holds the space, so two cars can never both be recorded as parked here."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || !vehicleId}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/parking/slots/allot", {
                    slotId: slot.id,
                    vehicleId,
                    ...(unitId ? { unitId } : {}),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Allotting…" : "Allot"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Field label="Vehicle" htmlFor="av">
        <select id="av" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
          <option value="">Choose a registered vehicle…</option>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.plateDisplay} {v.makeModel ? `· ${v.makeModel}` : ""}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Flat" htmlFor="au" hint="Optional. Records which flat the slot belongs to.">
        <select id="au" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          <option value="">Not linked</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.number} · {u.towerName}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

function FlagVehicle({
  slots,
  onClose,
  onDone,
}: {
  slots: Slot[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [plate, setPlate] = useState("");
  const [reason, setReason] = useState("");
  const [slotId, setSlotId] = useState("");

  return (
    <Modal
      title="Flag a vehicle"
      note="The owner is notified if the plate is registered here. Nothing else happens to the car."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || plate.trim().length < 4 || !reason.trim()}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/parking/violations", {
                    plate: plate.trim(),
                    reason: reason.trim(),
                    ...(slotId ? { slotId } : {}),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Saving…" : "Flag it"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Field label="Plate" htmlFor="fplate">
        <input
          id="fplate"
          value={plate}
          onChange={(e) => setPlate(e.target.value.toUpperCase())}
          maxLength={24}
          placeholder="KA-01 AB 1234"
          style={{ fontFamily: "var(--font-figure)", fontSize: "1rem", letterSpacing: "0.06em" }}
        />
      </Field>

      <Field label="Reason" htmlFor="freason">
        <input
          id="freason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={120}
          placeholder="Parked in a visitor slot overnight"
        />
      </Field>

      <Field label="Slot" htmlFor="fslot" hint="Optional. Which space it is blocking.">
        <select id="fslot" value={slotId} onChange={(e) => setSlotId(e.target.value)}>
          <option value="">Not a specific slot</option>
          {slots.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}
