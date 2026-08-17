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
import { api, can, rupees } from "../../lib/api";

interface Amenity {
  id: string;
  name: string;
  capacity: number | null;
  slotMinutes: number;
  isPaid: boolean;
  rate: string;
}

interface Booking {
  id: string;
  amenityId: string;
  unitId: string;
  startsAt: string;
  endsAt: string;
  status: string;
}

interface Unit {
  id: string;
  number: string;
  towerName: string;
}

/**
 * Amenities and bookings.
 *
 * The party hall on a Saturday is where two residents both believe they booked it, and
 * an application-level "is it free?" check followed by an insert is exactly how that
 * happens: two people tap at the same moment, both checks pass, both rows land.
 *
 * So the guarantee lives in Postgres. An `EXCLUDE USING gist` constraint makes an
 * overlapping booking impossible to write at all, and the second tap comes back as a
 * refusal from the database rather than a race the application happened to lose. This
 * page shows that refusal in plain words.
 */
export default function AmenitiesPage() {
  const [amenities, setAmenities] = useState<Amenity[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [booking, setBooking] = useState<Amenity | null>(null);

  const mayManage = can("society_admin", "mc_member");
  const unitsById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const amenitiesById = useMemo(() => new Map(amenities.map((a) => [a.id, a])), [amenities]);

  const load = useCallback(async () => {
    try {
      const [a, b, u] = await Promise.all([
        api.get<Amenity[]>("/v1/safety/amenities"),
        api.get<Booking[]>("/v1/safety/bookings"),
        api.get<Unit[]>("/v1/society/units"),
      ]);
      setAmenities(a);
      setBookings(b);
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

  const upcoming = useMemo(
    () =>
      bookings
        .filter((b) => b.status !== "cancelled" && new Date(b.endsAt).getTime() > Date.now())
        .sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1)),
    [bookings],
  );

  const today = upcoming.filter(
    (b) => new Date(b.startsAt).toDateString() === new Date().toDateString(),
  ).length;

  return (
    <Shell
      title="Amenities"
      lede="The clubhouse, the hall, the courts — and who has them booked."
      actions={
        mayManage ? (
          <button data-variant="primary" onClick={() => setAdding(true)}>
            Add an amenity
          </button>
        ) : null
      }
    >
      {error ? <Problem error={error} /> : null}

      <dl className="figures settle">
        <Figure label="Amenities" value={String(amenities.length)} />
        <Figure label="Upcoming bookings" value={String(upcoming.length)} />
        <Figure label="Today" value={String(today)} hint="starting today" tone="settled" />
        <Figure
          label="Chargeable"
          value={String(amenities.filter((a) => a.isPaid).length)}
          hint="billed to the flat"
        />
      </dl>

      <Ledger
        title="What can be booked"
        note="slot length and charge per booking"
        head={["Amenity", "~Capacity", "~Slot", "~Rate", ""]}
        empty="No amenities have been set up. Until one exists, residents have nothing to book."
        isEmpty={!loading && amenities.length === 0}
      >
        {amenities.map((a) => (
          <tr key={a.id}>
            <td className="strong">{a.name}</td>
            <td className="num muted">{a.capacity ?? "—"}</td>
            <td className="num muted">{a.slotMinutes} min</td>
            <td className="num">
              {a.isPaid ? rupees(a.rate) : <span className="muted">free</span>}
            </td>
            <td>
              <div className="row-actions">
                <button data-size="sm" data-variant="primary" onClick={() => setBooking(a)}>
                  Book it
                </button>
              </div>
            </td>
          </tr>
        ))}
      </Ledger>

      <Ledger
        title="Upcoming bookings"
        note="soonest first"
        head={["Amenity", "Flat", "From", "To", "Status", ""]}
        empty="Nothing is booked."
        isEmpty={!loading && upcoming.length === 0}
      >
        {upcoming.map((b) => (
          <tr key={b.id}>
            <td className="strong">{amenitiesById.get(b.amenityId)?.name ?? "—"}</td>
            <td className="muted">{unitsById.get(b.unitId)?.number ?? "—"}</td>
            <td className="muted">{when(b.startsAt)}</td>
            <td className="muted">{when(b.endsAt)}</td>
            <td>
              <Chip tone={b.status === "confirmed" ? "settled" : "quiet"}>{b.status}</Chip>
            </td>
            <td>
              <div className="row-actions">
                <CancelButton booking={b} onDone={load} />
              </div>
            </td>
          </tr>
        ))}
      </Ledger>

      {loading ? <Loading /> : null}

      <section className="card settle">
        <div className="card-head">
          <h2>Why a double booking is impossible here</h2>
        </div>
        <div className="card-body">
          <p>
            Two residents tapping &quot;book&quot; at the same moment both pass a
            &quot;is it free?&quot; check, and both bookings land. That race is why the hall
            gets double-booked in every system that checks in the application.
          </p>
          <p>
            Here the database itself refuses an overlapping range. The second tap comes back
            as a plain refusal rather than a silent conflict discovered on Saturday morning —
            a control that only holds while the calling code is correct is not a control.
          </p>
        </div>
      </section>

      {adding ? (
        <AddAmenity
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : null}

      {booking ? (
        <BookAmenity
          amenity={booking}
          units={units}
          onClose={() => setBooking(null)}
          onDone={() => {
            setBooking(null);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

/**
 * Cancelling sets a status; it does not remove the row.
 *
 * A committee arguing about who had the hall on the 14th needs to see that it was booked
 * and then cancelled, not an absence that proves nothing.
 */
function CancelButton({ booking, onDone }: { booking: Booking; onDone: () => Promise<void> }) {
  const action = useAction();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button data-size="sm" onClick={() => setConfirming(true)}>
        Cancel
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
          void action.run(() => api.del(`/v1/safety/bookings/${booking.id}`), { onDone })
        }
      >
        {action.busy ? "…" : "Confirm"}
      </button>
    </>
  );
}

function AddAmenity({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("");
  const [slotMinutes, setSlotMinutes] = useState("60");
  const [isPaid, setIsPaid] = useState(false);
  const [rate, setRate] = useState("");

  const rateOk = !isPaid || /^\d+(\.\d{1,4})?$/.test(rate);

  return (
    <Modal
      title="Add an amenity"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || !name.trim() || !rateOk}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/safety/amenities", {
                    name: name.trim(),
                    ...(capacity ? { capacity: Number(capacity) } : {}),
                    slotMinutes: Number(slotMinutes) || 60,
                    isPaid,
                    ...(isPaid && rate ? { rate } : {}),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Saving…" : "Add amenity"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={() => undefined}>
        <Field label="Name" htmlFor="aname">
          <input
            id="aname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="Party hall"
          />
        </Field>

        <div className="grid-2">
          <Field label="Capacity" htmlFor="acap" hint="Optional. People, not bookings.">
            <input
              id="acap"
              type="number"
              min={1}
              max={10000}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
            />
          </Field>

          <Field
            label="Slot length"
            htmlFor="aslot"
            hint="Minutes. The smallest block a resident can book."
          >
            <input
              id="aslot"
              type="number"
              min={15}
              max={1440}
              step={15}
              value={slotMinutes}
              onChange={(e) => setSlotMinutes(e.target.value)}
            />
          </Field>
        </div>

        <Check
          label="Charge for this"
          hint="A booking becomes a line on the flat's next invoice."
          checked={isPaid}
          onChange={setIsPaid}
        />

        {isPaid ? (
          <Field
            label="Rate per booking"
            htmlFor="arate"
            hint={rateOk ? "In rupees." : "Digits and up to four decimals."}
          >
            <input
              id="arate"
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value.trim())}
              placeholder="2000.00"
              style={{ fontFamily: "var(--font-figure)" }}
            />
          </Field>
        ) : null}
      </Form>
    </Modal>
  );
}

function BookAmenity({
  amenity,
  units,
  onClose,
  onDone,
}: {
  amenity: Amenity;
  units: Unit[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [unitId, setUnitId] = useState("");
  const [startsAt, setStartsAt] = useState(nextHour());
  const [endsAt, setEndsAt] = useState(nextHourPlus(amenity.slotMinutes));

  const valid = Boolean(unitId && startsAt && endsAt && startsAt < endsAt);

  return (
    <Modal
      title={`Book ${amenity.name}`}
      note={
        amenity.isPaid
          ? `${rupees(amenity.rate)} per booking, billed to the flat.`
          : "No charge for this amenity."
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || !valid}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/safety/bookings", {
                    amenityId: amenity.id,
                    unitId,
                    startsAt: new Date(startsAt).toISOString(),
                    endsAt: new Date(endsAt).toISOString(),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Booking…" : "Book it"}
          </button>
        </>
      }
    >
      {action.error ? (
        <Banner tone="error">
          {action.error}
          {/* The exclusion constraint's refusal is the useful case, so it is named. */}
          {action.error.toLowerCase().includes("book") ? null : (
            <>
              {" "}
              If someone else holds this slot, the database refused it — not a guess on our
              side.
            </>
          )}
        </Banner>
      ) : null}

      <Field label="Flat" htmlFor="bunit">
        <select id="bunit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          <option value="">Choose a flat…</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.number} · {u.towerName}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid-2">
        <Field label="From" htmlFor="bfrom">
          <input
            id="bfrom"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </Field>

        <Field
          label="To"
          htmlFor="bto"
          hint={
            startsAt >= endsAt && endsAt ? "A booking has to end after it starts." : undefined
          }
        >
          <input
            id="bto"
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `datetime-local` wants local wall-clock time, not an ISO string in UTC. */
function nextHour(): string {
  const then = new Date();
  then.setMinutes(0, 0, 0);
  then.setHours(then.getHours() + 1);
  then.setMinutes(then.getMinutes() - then.getTimezoneOffset());
  return then.toISOString().slice(0, 16);
}

function nextHourPlus(minutes: number): string {
  const then = new Date();
  then.setMinutes(0, 0, 0);
  then.setHours(then.getHours() + 1);
  then.setMinutes(then.getMinutes() + minutes - then.getTimezoneOffset());
  return then.toISOString().slice(0, 16);
}
