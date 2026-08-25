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
import { api, can, download, rupees, shortDate } from "../../lib/api";

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

interface PreviewLine {
  code: string;
  description: string;
  quantity: string;
  rate: string;
  amount: string;
  gstRate: string;
  gstAmount: string;
}

interface Preview {
  unitId: string;
  lines: PreviewLine[];
  subtotal: string;
  gstAmount: string;
  lateFee: string;
  total: string;
  gstApplied: boolean;
}

interface Credit {
  unitId: string;
  unitNumber: string;
  towerName: string;
  received: string;
  allocated: string;
  advance: string;
  outstanding: string;
  net: string;
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  unitId: string;
  unitNumber: string;
  towerName: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  total: string;
  balance: string;
  status: string;
  overdue: boolean;
}

interface ChargeType {
  code: string;
  name: string;
  formula: string;
  rate: string;
  needsMeterReading: boolean;
  needsManualAmount: boolean;
}

/**
 * Dues and billing.
 *
 * The screen a treasurer opens on the 11th of the month. Three jobs: see who has not
 * paid, chase them, and raise next month's bill.
 *
 * Every figure here is a string end to end — from Postgres `numeric`, through the API,
 * to this table. It is never parsed into a JS number. That is the whole reason the money
 * package exists, and display is exactly where the temptation to "just parseFloat it for
 * the total" is strongest and the consequence least visible.
 */
export default function Billing() {
  const [rows, setRows] = useState<Outstanding[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [charges, setCharges] = useState<ChargeType[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [credits, setCredits] = useState<Credit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [billing, setBilling] = useState(false);

  const unitsById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const mayBill = can("accountant", "society_admin");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dues, unitList, invoiceList] = await Promise.all([
        api.get<Outstanding[]>("/v1/payments/outstanding"),
        api.get<Unit[]>("/v1/society/units"),
        api.get<Invoice[]>("/v1/billing/invoices"),
      ]);
      setRows(dues);
      setUnits(unitList);
      setInvoices(invoiceList);

      // Credit is committee-and-accountant only, like arrears. A reader without money
      // authority should see the rest of the page rather than one 403 blanking it.
      try {
        setCredits(await api.get<Credit[]>("/v1/payments/credits"));
      } catch {
        setCredits([]);
      }

      // Charge heads decide which extra boxes the invoice form needs. A reader without
      // money authority is refused here, and that must not blank the arrears table.
      try {
        setCharges(await api.get<ChargeType[]>("/v1/billing/charge-types"));
      } catch {
        setCharges([]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Sum the outstanding column.
   *
   * Deliberately done in integer paise rather than by adding floats. Adding 250 flats'
   * worth of `parseFloat` values drifts — 6497.499999999964 instead of 6497.50 — and a
   * total that disagrees with the column above it destroys trust in the whole page.
   */
  const totals = useMemo(() => {
    let billedPaise = 0n;
    let paidPaise = 0n;

    for (const row of rows) {
      billedPaise += toPaise(row.billed);
      paidPaise += toPaise(row.paid);
    }

    return {
      billed: fromPaise(billedPaise),
      paid: fromPaise(paidPaise),
      due: fromPaise(billedPaise - paidPaise),
    };
  }, [rows]);

  // The mirror image of arrears. A flat that paid a round figure, or settled the year in
  // April, is holding credit — and issuing its next invoice sets that credit against the
  // bill automatically, so this list should shrink on its own rather than needing a
  // button. It is here because a treasurer asked "whose money are we sitting on".
  const inCredit = credits
    .filter((row) => toPaise(row.advance) > 0n)
    .sort((a, b) => (toPaise(b.advance) > toPaise(a.advance) ? 1 : -1));

  const withDue = rows
    .map((row) => ({ ...row, duePaise: toPaise(row.billed) - toPaise(row.paid) }))
    .filter((row) => row.duePaise > 0n)
    .sort((a, b) => (a.oldestDue < b.oldestDue ? -1 : 1));

  return (
    <Shell
      title="Dues & Billing"
      lede="Who owes what, oldest first. Figures come from the ledger, not from a cached total."
      actions={
        mayBill ? (
          <button data-variant="primary" onClick={() => setBilling(true)}>
            Raise an invoice
          </button>
        ) : null
      }
    >
      {error ? <Problem error={error} /> : null}
      {loading ? <Loading /> : null}

      <dl className="figures settle">
        <Figure label="Billed" value={rupees(totals.billed)} hint="issued, this cycle onward" />
        <Figure label="Collected" value={rupees(totals.paid)} tone="settled" />
        <Figure
          label="Still owed"
          value={rupees(totals.due)}
          hint={`${withDue.length} flat${withDue.length === 1 ? "" : "s"} in arrears`}
          tone="arrears"
        />
      </dl>

      <Ledger
        title="Flats in arrears"
        note="oldest due date first"
        head={["Flat", "Tower", "~Invoices", "~Billed", "~Paid", "~Outstanding", "Oldest due"]}
        empty="Nothing outstanding. Every flat is settled."
        isEmpty={!loading && withDue.length === 0}
      >
        {withDue.map((row) => {
          const unit = unitsById.get(row.unitId);
          const overdue = row.oldestDue < new Date().toISOString().slice(0, 10);

          return (
            <tr key={row.unitId}>
              <td className="strong">{unit?.number ?? "—"}</td>
              <td className="muted">{unit?.towerName ?? "—"}</td>
              <td className="num muted">{row.invoices}</td>
              <td className="num">{rupees(row.billed)}</td>
              <td className="num muted">{rupees(row.paid)}</td>
              <td className="num" data-tone="arrears">
                {rupees(fromPaise(row.duePaise))}
              </td>
              <td>
                {overdue ? (
                  <Chip tone="arrears">{shortDate(row.oldestDue)}</Chip>
                ) : (
                  <span className="muted">{shortDate(row.oldestDue)}</span>
                )}
              </td>
            </tr>
          );
        })}
      </Ledger>

      <Ledger
        title="Flats in credit"
        note="money the society is holding that has not met a bill yet"
        head={["Flat", "Tower", "~Received", "~Applied", "~Held as credit", "~Still owed"]}
        empty="No flat is in credit."
        isEmpty={!loading && inCredit.length === 0}
      >
        {inCredit.map((row) => (
          <tr key={row.unitId}>
            <td className="strong">{row.unitNumber}</td>
            <td className="muted">{row.towerName}</td>
            <td className="num muted">{rupees(row.received)}</td>
            <td className="num muted">{rupees(row.allocated)}</td>
            <td className="num" data-tone="settled">
              {rupees(row.advance)}
            </td>
            <td className="num muted">{rupees(row.outstanding)}</td>
          </tr>
        ))}
      </Ledger>

      <Ledger
        title="Invoices issued"
        note="newest first"
        head={["Invoice", "Flat", "Period", "Due", "~Total", "~Balance", "Status", "PDF"]}
        empty="No invoice has been raised yet."
        isEmpty={!loading && invoices.length === 0}
      >
        {invoices.map((invoice) => (
          <tr key={invoice.id}>
            <td className="strong">{invoice.invoiceNumber}</td>
            <td>
              {invoice.unitNumber}
              <span className="muted"> · {invoice.towerName}</span>
            </td>
            <td className="muted">
              {shortDate(invoice.periodStart)} – {shortDate(invoice.periodEnd)}
            </td>
            <td>
              {invoice.overdue ? (
                <Chip tone="arrears">{shortDate(invoice.dueDate)}</Chip>
              ) : (
                <span className="muted">{shortDate(invoice.dueDate)}</span>
              )}
            </td>
            <td className="num">{rupees(invoice.total)}</td>
            <td className="num" data-tone={toPaise(invoice.balance) > 0n ? "arrears" : undefined}>
              {rupees(invoice.balance)}
            </td>
            <td>
              <Chip tone={invoice.status === "paid" ? "settled" : "quiet"}>
                {invoice.status.replace(/_/g, " ")}
              </Chip>
            </td>
            <td>
              <button
                onClick={() =>
                  void download(
                    `/v1/billing/invoices/${invoice.id}/pdf`,
                    `invoice-${invoice.invoiceNumber}.pdf`,
                  )
                }
              >
                Download
              </button>
            </td>
          </tr>
        ))}
      </Ledger>

      <section className="card settle">
        <div className="card-head">
          <h2>How collection works here</h2>
        </div>
        <div className="card-body">
          <p>
            Money never passes through a WatchMyGate account. Payments settle directly to
            the society&apos;s own bank account, or — where a flat owner has supplied their
            own merchant ID — straight to the owner with{" "}
            <strong>no WatchMyGate commission</strong>.
          </p>
          <p>
            The payment gateway&apos;s own charges still apply. UPI is 0% by RBI mandate, so
            it is offered first.
          </p>
        </div>
      </section>

      {billing ? (
        <RaiseInvoice
          units={units}
          charges={charges}
          onClose={() => setBilling(false)}
          onDone={() => {
            setBilling(false);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

/**
 * Raise an invoice.
 *
 * Preview is a separate, mandatory step and the figures shown are computed by the
 * **server** — the same code that will issue the invoice, not a copy of the rules
 * reimplemented here. That is the entire reason no client in this product does money
 * arithmetic: the number the treasurer approves and the number filed for GST cannot
 * differ by a paisa if only one of them is ever calculated.
 */
function RaiseInvoice({
  units,
  charges,
  onClose,
  onDone,
}: {
  units: Unit[];
  charges: ChargeType[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [unitId, setUnitId] = useState("");
  const [periodStart, setPeriodStart] = useState(firstOfThisMonth());
  const [periodEnd, setPeriodEnd] = useState(lastOfThisMonth());
  const [dueDate, setDueDate] = useState(tenthOfNextMonth());
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);

  const metered = charges.filter((c) => c.needsMeterReading);
  const manual = charges.filter((c) => c.needsManualAmount);

  /*
   * Readings and manual amounts travel as **strings**, keyed by charge code, exactly as
   * the API expects. Nothing here is parsed to a number: a water reading feeds a rupee
   * figure, and this is the last point before the server where a float could get in.
   */
  const meterReadings = Object.fromEntries(
    metered.map((c) => [c.code, inputs[c.code] ?? ""]).filter(([, v]) => v !== ""),
  );
  const manualAmounts = Object.fromEntries(
    manual.map((c) => [c.code, inputs[c.code] ?? ""]).filter(([, v]) => v !== ""),
  );

  const body = {
    unitId,
    periodStart,
    periodEnd,
    dueDate,
    ...(Object.keys(meterReadings).length > 0 ? { meterReadings } : {}),
    ...(Object.keys(manualAmounts).length > 0 ? { manualAmounts } : {}),
  };

  const decimalsOk = [...metered, ...manual].every((c) => {
    const value = inputs[c.code];
    return !value || /^\d+(\.\d{1,4})?$/.test(value);
  });

  // Every metered head needs a reading; a bill cannot be computed without one, and the
  // API refuses rather than guessing zero — a guessed water bill is worse than no bill.
  const readingsComplete = metered.every((c) => (inputs[c.code] ?? "").length > 0);
  const ready =
    Boolean(unitId && periodStart && periodEnd && dueDate) && decimalsOk && readingsComplete;

  function runPreview() {
    void action.run(async () => {
      setPreview(await api.post<Preview>("/v1/billing/preview", body));
    });
  }

  function issue() {
    void action.run(() => api.post("/v1/billing/issue", body), { onDone });
  }

  // Changing any input invalidates the preview: approving figures computed for a
  // different period is the one mistake this screen must make impossible.
  function change<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPreview(null);
    };
  }

  return (
    <Modal
      title="Raise an invoice"
      note="Preview first. The figures below are computed by the server — the same code that issues the invoice."
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button disabled={action.busy || !ready} onClick={runPreview}>
            {action.busy && !preview ? "Computing…" : "Preview"}
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || !preview}
            title={preview ? undefined : "Preview the figures before issuing."}
            onClick={issue}
          >
            {action.busy && preview ? "Issuing…" : "Issue invoice"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={runPreview}>
        <Field label="Flat" htmlFor="bill-unit">
          <select
            id="bill-unit"
            value={unitId}
            onChange={(e) => change(setUnitId)(e.target.value)}
          >
            <option value="">Choose a flat…</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.number} · {u.towerName}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid-2">
          <Field label="Period from" htmlFor="ps">
            <input
              id="ps"
              type="date"
              value={periodStart}
              onChange={(e) => change(setPeriodStart)(e.target.value)}
            />
          </Field>
          <Field label="Period to" htmlFor="pe">
            <input
              id="pe"
              type="date"
              value={periodEnd}
              onChange={(e) => change(setPeriodEnd)(e.target.value)}
            />
          </Field>
          <Field
            label="Due date"
            htmlFor="dd"
            hint="Late-fee interest accrues from the day after this."
          >
            <input
              id="dd"
              type="date"
              value={dueDate}
              onChange={(e) => change(setDueDate)(e.target.value)}
            />
          </Field>
        </div>

        {metered.length > 0 || manual.length > 0 ? (
          <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 14, marginTop: 4 }}>
            {[...metered, ...manual].map((charge) => (
              <Field
                key={charge.code}
                label={charge.name}
                htmlFor={`charge-${charge.code}`}
                hint={
                  charge.needsMeterReading
                    ? `Units consumed this period, at ${rupees(charge.rate)} per unit. Required.`
                    : "Amount for this head, in rupees."
                }
              >
                <input
                  id={`charge-${charge.code}`}
                  inputMode="decimal"
                  value={inputs[charge.code] ?? ""}
                  onChange={(e) => {
                    setInputs({ ...inputs, [charge.code]: e.target.value.trim() });
                    setPreview(null);
                  }}
                  placeholder={charge.needsMeterReading ? "18" : "0.00"}
                  style={{ fontFamily: "var(--font-figure)" }}
                />
              </Field>
            ))}
          </div>
        ) : null}
      </Form>

      {preview ? (
        <div className="ledger" style={{ marginTop: 6, marginBottom: 0 }}>
          <div className="ledger-head">
            <h2>What will be issued</h2>
            <span className="note">
              {preview.gstApplied ? "GST applies" : "below the GST threshold"}
            </span>
          </div>
          <div className="ledger-scroll">
            <table>
              <thead>
                <tr>
                  <th>Head</th>
                  <th>~Qty</th>
                  <th>~Rate</th>
                  <th>~Amount</th>
                  <th>~GST</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((line) => (
                  <tr key={line.code}>
                    <td>
                      <span className="strong">{line.description}</span>
                      <span className="sub">{line.code}</span>
                    </td>
                    <td className="num muted">{line.quantity}</td>
                    <td className="num muted">{rupees(line.rate)}</td>
                    <td className="num">{rupees(line.amount)}</td>
                    <td className="num muted">
                      {line.gstRate === "0" ? "—" : rupees(line.gstAmount)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="strong">Subtotal</td>
                  <td colSpan={2} />
                  <td className="num">{rupees(preview.subtotal)}</td>
                  <td className="num muted">{rupees(preview.gstAmount)}</td>
                </tr>
                {preview.lateFee !== "0" && preview.lateFee !== "0.00" ? (
                  <tr>
                    <td className="strong">Late fee</td>
                    <td colSpan={2} />
                    <td className="num" data-tone="arrears">
                      {rupees(preview.lateFee)}
                    </td>
                    <td />
                  </tr>
                ) : null}
                <tr>
                  <td className="strong">Total</td>
                  <td colSpan={2} />
                  <td className="num strong" style={{ fontSize: "1rem" }}>
                    {rupees(preview.total)}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <Banner tone="info">
          GST applies only where maintenance exceeds ₹7,500 per member per month{" "}
          <em>and</em> the society&apos;s turnover exceeds ₹20 lakh. That rule is evaluated
          on the server against this society&apos;s own figures, not assumed here.
        </Banner>
      )}
    </Modal>
  );
}

// --------------------------------------------------------------------- dates

function firstOfThisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function lastOfThisMonth(): string {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return toIsoDate(last);
}

function tenthOfNextMonth(): string {
  const now = new Date();
  return toIsoDate(new Date(now.getFullYear(), now.getMonth() + 1, 10));
}

function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

// --------------------------------------------------------------------- money

/**
 * Decimal string to integer paise, exactly.
 *
 * BigInt, not Number: a society's annual collection in paise exceeds what a double can
 * hold exactly (2^53), and this is the one place every flat's figure is added together.
 */
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
  const whole = abs / 100n;
  const rest = abs % 100n;
  return `${negative ? "-" : ""}${whole}.${String(rest).padStart(2, "0")}`;
}
