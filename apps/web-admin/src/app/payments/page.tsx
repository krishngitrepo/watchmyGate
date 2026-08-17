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
import { api, can, rupees, shortDate } from "../../lib/api";

interface Destination {
  id: string;
  payeeType: string;
  payeeId: string;
  mode: string;
  merchantId: string | null;
  status: string;
  virtualAccountNumber: string | null;
  virtualIfsc: string | null;
}

interface Outstanding {
  unitId: string;
  invoices: string;
  billed: string;
  paid: string;
  oldestDue: string;
}

interface Unit {
  id: string;
  number: string;
  towerName: string;
}

const METHODS = ["upi", "neft", "cheque", "cash", "card", "netbanking"] as const;

/**
 * Money coming in.
 *
 * Two distinct things live here, and the split matters. **Destinations** decide where
 * money lands — never in a WatchMyGate account, which is what keeps this company out of
 * RBI payment-aggregator licensing rather than being a preference. **Manual receipts**
 * are the accountant asserting they have seen money that did not come through the
 * gateway: a cheque, a cash payment, an NEFT they matched on a statement.
 *
 * A resident *claiming* they paid is not this. An unverified UTR is a claim awaiting bank
 * confirmation and must never mark an invoice paid on its own.
 */
export default function PaymentsPage() {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [outstanding, setOutstanding] = useState<Outstanding[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [recording, setRecording] = useState(false);
  const [adding, setAdding] = useState(false);

  const mayManage = can("accountant", "society_admin", "mc_member");
  const unitsById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dest, dues, unitList] = await Promise.all([
        api.get<Destination[]>("/v1/payments/destinations"),
        api.get<Outstanding[]>("/v1/payments/outstanding"),
        api.get<Unit[]>("/v1/society/units"),
      ]);
      setDestinations(dest);
      setOutstanding(dues);
      setUnits(unitList);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const smartCollect = destinations.filter((d) => d.virtualAccountNumber).length;
  const direct = destinations.filter((d) => d.mode === "direct_merchant").length;

  return (
    <Shell
      title="Payments"
      lede="Where money settles, and payments taken outside the gateway."
      actions={
        mayManage ? (
          <>
            <button onClick={() => setAdding(true)}>Add a destination</button>
            <button data-variant="primary" onClick={() => setRecording(true)}>
              Record a payment
            </button>
          </>
        ) : null
      }
    >
      {error ? <Problem error={error} /> : null}
      {loading ? <Loading /> : null}

      <dl className="figures settle">
        <Figure label="Destinations" value={String(destinations.length)} hint="payout accounts" />
        <Figure
          label="Virtual accounts"
          value={String(smartCollect)}
          hint="per-unit, auto-reconciling"
          tone="settled"
        />
        <Figure
          label="Owner merchants"
          value={String(direct)}
          hint="rent, no platform commission"
        />
        <Figure
          label="Flats owing"
          value={String(
            outstanding.filter((row) => toPaise(row.billed) - toPaise(row.paid) > 0n).length,
          )}
          hint="see Dues & Billing"
        />
      </dl>

      <Ledger
        title="Payout destinations"
        note="funds settle here directly — never to us"
        head={["Payee", "Mode", "Merchant", "Virtual account", "Status"]}
        empty="No destinations registered yet. Until one exists, online collection cannot be switched on."
        isEmpty={!loading && destinations.length === 0}
      >
        {destinations.map((d) => (
          <tr key={d.id}>
            <td className="strong">
              {d.payeeType === "society" ? "The society" : "A flat owner"}
              <span className="sub">{d.payeeId.slice(0, 8)}…</span>
            </td>
            <td>
              <Chip tone={d.mode === "route_linked" ? "brand" : "quiet"}>
                {d.mode === "route_linked" ? "Route linked" : "Own merchant"}
              </Chip>
            </td>
            <td className="num muted" style={{ textAlign: "left" }}>
              {d.merchantId ?? "—"}
            </td>
            <td className="num muted" style={{ textAlign: "left" }}>
              {d.virtualAccountNumber ? (
                <>
                  {d.virtualAccountNumber}
                  <span className="sub">{d.virtualIfsc}</span>
                </>
              ) : (
                "—"
              )}
            </td>
            <td>
              <Chip tone={d.status === "active" ? "settled" : "pending"}>{d.status}</Chip>
            </td>
          </tr>
        ))}
      </Ledger>

      <Ledger
        title="Outstanding by flat"
        note="what a payment would be applied against"
        head={["Flat", "~Invoices", "~Billed", "~Paid", "~Outstanding", "Oldest due"]}
        empty="Nothing outstanding."
        isEmpty={!loading && outstanding.length === 0}
      >
        {outstanding
          .map((row) => ({ ...row, duePaise: toPaise(row.billed) - toPaise(row.paid) }))
          .filter((row) => row.duePaise > 0n)
          .sort((a, b) => (a.oldestDue < b.oldestDue ? -1 : 1))
          .map((row) => (
            <tr key={row.unitId}>
              <td className="strong">{unitsById.get(row.unitId)?.number ?? "—"}</td>
              <td className="num muted">{row.invoices}</td>
              <td className="num">{rupees(row.billed)}</td>
              <td className="num muted">{rupees(row.paid)}</td>
              <td className="num" data-tone="arrears">
                {rupees(fromPaise(row.duePaise))}
              </td>
              <td className="muted">{shortDate(row.oldestDue)}</td>
            </tr>
          ))}
      </Ledger>

      <section className="card settle">
        <div className="card-head">
          <h2>Why we never hold your money</h2>
        </div>
        <div className="card-body">
          <p>
            Collecting maintenance on a society&apos;s behalf through our own account would
            make this an RBI-regulated payment aggregator. So each society is a Razorpay
            Route linked account and{" "}
            <strong>funds settle straight to the society&apos;s own bank</strong>. Our SaaS
            fee is a separate, ordinary invoice.
          </p>
          <p>
            Where a flat owner supplies their own merchant ID, a tenant&apos;s rent reaches
            the owner with <strong>no WatchMyGate commission</strong>. The gateway&apos;s
            own charges still apply — which is why UPI, at 0% by RBI mandate, is offered
            first.
          </p>
        </div>
      </section>

      {recording ? (
        <RecordPayment
          units={units}
          onClose={() => setRecording(false)}
          onDone={() => {
            setRecording(false);
            void load();
          }}
        />
      ) : null}

      {adding ? (
        <AddDestination
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

/**
 * Record a payment taken outside the gateway.
 *
 * The reference is namespaced into the idempotency key server-side, so submitting the
 * same cheque number twice records one receipt rather than two — which matters because
 * the commonest way this screen is used is "did I already enter this?" followed by
 * entering it again.
 */
function RecordPayment({
  units,
  onClose,
  onDone,
}: {
  units: Unit[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [unitId, setUnitId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>("neft");
  const [receivedOn, setReceivedOn] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");

  // A decimal string, validated by the same shape the API demands. Never parsed to a
  // number here — the string goes to the server exactly as typed.
  const validAmount = /^\d+(\.\d{1,4})?$/.test(amount);
  const ready = Boolean(unitId && validAmount && receivedOn && reference.trim());

  function submit() {
    void action.run(
      () =>
        api.post("/v1/payments/manual", {
          unitId,
          amount,
          method,
          receivedOn,
          reference: reference.trim(),
        }),
      { onDone },
    );
  }

  return (
    <Modal
      title="Record a payment"
      note="For money you have actually seen — a cheque cleared, cash counted, an NEFT matched on the statement."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button data-variant="primary" disabled={action.busy || !ready} onClick={submit}>
            {action.busy ? "Recording…" : "Record it"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={submit}>
        <Field label="Flat" htmlFor="pay-unit">
          <select id="pay-unit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">Choose a flat…</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.number} · {u.towerName}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid-2">
          <Field
            label="Amount"
            htmlFor="amt"
            hint={
              amount && !validAmount
                ? "Digits and up to four decimal places, e.g. 4500.00"
                : "In rupees, e.g. 4500.00"
            }
          >
            <input
              id="amt"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.trim())}
              placeholder="4500.00"
              style={{ fontFamily: "var(--font-figure)" }}
            />
          </Field>

          <Field label="Method" htmlFor="method">
            <select id="method" value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Received on" htmlFor="on">
            <input
              id="on"
              type="date"
              value={receivedOn}
              onChange={(e) => setReceivedOn(e.target.value)}
            />
          </Field>

          <Field
            label="Reference"
            htmlFor="ref"
            hint="Cheque number, UTR, or receipt book number. Recording it twice records one receipt."
          >
            <input
              id="ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="CHQ 004512"
              maxLength={120}
            />
          </Field>
        </div>
      </Form>

      <Banner tone="warn">
        This marks money as received. A resident telling you they have paid is not the same
        thing — wait for the bank.
      </Banner>
    </Modal>
  );
}

function AddDestination({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const [payeeType, setPayeeType] = useState("society");
  const [payeeId, setPayeeId] = useState("");
  const [mode, setMode] = useState("route_linked");
  const [merchantId, setMerchantId] = useState("");

  const ready = Boolean(payeeId.trim());

  function submit() {
    void action.run(
      () =>
        api.post("/v1/payments/destinations", {
          payeeType,
          payeeId: payeeId.trim(),
          mode,
          ...(merchantId.trim() ? { merchantId: merchantId.trim() } : {}),
        }),
      { onDone },
    );
  }

  return (
    <Modal
      title="Add a payout destination"
      note="Where collected money settles. It is never a WatchMyGate account."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button data-variant="primary" disabled={action.busy || !ready} onClick={submit}>
            {action.busy ? "Saving…" : "Add destination"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={submit}>
        <div className="grid-2">
          <Field label="Payee" htmlFor="ptype">
            <select id="ptype" value={payeeType} onChange={(e) => setPayeeType(e.target.value)}>
              <option value="society">The society</option>
              <option value="person">A flat owner</option>
            </select>
          </Field>

          <Field label="Mode" htmlFor="pmode">
            <select id="pmode" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="route_linked">Route linked account</option>
              <option value="direct_merchant">Owner&apos;s own merchant</option>
            </select>
          </Field>
        </div>

        <Field
          label="Payee id"
          htmlFor="pid"
          hint="The society id, or the person id of the flat owner."
        >
          <input
            id="pid"
            value={payeeId}
            onChange={(e) => setPayeeId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            style={{ fontFamily: "var(--font-figure)", fontSize: "0.82rem" }}
          />
        </Field>

        <Field
          label="Merchant id"
          htmlFor="mid"
          hint="Optional. Razorpay account id for this destination."
        >
          <input
            id="mid"
            value={merchantId}
            onChange={(e) => setMerchantId(e.target.value)}
            placeholder="acc_XXXXXXXXXXXX"
            maxLength={120}
          />
        </Field>
      </Form>

      <Banner tone="info">
        Gateway credentials are never typed into this console. They live in Secret Manager
        and are referenced by name, so nothing secret passes through a browser a committee
        laptop happens to be sharing.
      </Banner>
    </Modal>
  );
}

function toPaise(amount: string | null | undefined): bigint {
  if (!amount) return 0n;
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? amount.slice(1) : amount).split(".");
  const paise = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return negative ? -paise : paise;
}

function fromPaise(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  return `${negative ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}
