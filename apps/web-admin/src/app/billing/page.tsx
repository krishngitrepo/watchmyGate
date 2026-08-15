"use client";

import { useEffect, useMemo, useState } from "react";

import { Chip, Figure, Ledger, Loading, Problem, Shell } from "../../components/Shell";
import { api, rupees, shortDate } from "../../lib/api";

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

/**
 * Dues and billing.
 *
 * The screen a treasurer opens on the 11th of the month. Two jobs: see who has not
 * paid, and chase them.
 *
 * Every figure here is a string end to end — from Postgres `numeric`, through the API,
 * to this table. It is never parsed into a JS number. That is the whole reason the
 * money package exists, and display is exactly where the temptation to "just parseFloat
 * it for the total" is strongest and the consequence least visible.
 */
export default function Billing() {
  const [rows, setRows] = useState<Outstanding[]>([]);
  const [units, setUnits] = useState<Map<string, Unit>>(new Map());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const [dues, unitList] = await Promise.all([
          api.get<Outstanding[]>("/v1/payments/outstanding"),
          api.get<Unit[]>("/v1/society/units"),
        ]);
        setRows(dues);
        setUnits(new Map(unitList.map((u) => [u.id, u])));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
      flats: rows.length,
    };
  }, [rows]);

  const withDue = rows
    .map((row) => ({ ...row, duePaise: toPaise(row.billed) - toPaise(row.paid) }))
    .filter((row) => row.duePaise > 0n)
    .sort((a, b) => (a.oldestDue < b.oldestDue ? -1 : 1));

  return (
    <Shell
      title="Dues & Billing"
      lede="Who owes what, oldest first. Figures come from the ledger, not from a cached total."
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
          const unit = units.get(row.unitId);
          const overdue = row.oldestDue < new Date().toISOString().slice(0, 10);

          return (
            <tr key={row.unitId}>
              <td style={{ fontWeight: 600 }}>{unit?.number ?? "—"}</td>
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

      <section className="ledger settle">
        <div className="ledger-head">
          <h2>How collection works here</h2>
        </div>
        <div style={{ padding: "14px 16px", fontSize: "0.88rem", color: "var(--ink-soft)" }}>
          <p style={{ marginTop: 0 }}>
            Money never passes through a WatchMyGate account. Payments settle directly to
            the society&apos;s own bank account, or — where a flat owner has supplied
            their own merchant ID — straight to the owner with{" "}
            <strong>no WatchMyGate commission</strong>.
          </p>
          <p style={{ marginBottom: 0 }}>
            The payment gateway&apos;s own charges still apply. UPI is 0% by RBI mandate,
            so it is offered first.
          </p>
        </div>
      </section>
    </Shell>
  );
}

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
