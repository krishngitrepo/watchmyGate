"use client";

import { useCallback, useEffect, useState } from "react";

import {
  Banner,
  Chip,
  Field,
  Figure,
  Loading,
  Modal,
  Problem,
  Shell,
  Tabs,
  useAction,
} from "../../components/Shell";
import { api, can, rupees, shortDate } from "../../lib/api";

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  isRestricted: boolean;
  debits: string;
  credits: string;
  balance: string;
}

interface TrialBalance {
  asOf: string;
  rows: { code: string; name: string; type: string; debit: string; credit: string }[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
}

interface Line {
  code: string;
  name: string;
  amount: string;
  isRestricted?: boolean;
}

interface IncomeExpenditure {
  from: string;
  to: string;
  income: Line[];
  expenditure: Line[];
  totalIncome: string;
  totalExpenditure: string;
  surplus: string;
}

interface BalanceSheet {
  asOf: string;
  assets: Line[];
  liabilities: Line[];
  equity: Line[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  accumulatedSurplus: string;
  balanced: boolean;
}

interface CashFlow {
  from: string;
  to: string;
  openingBalance: string;
  accounts: {
    code: string;
    name: string;
    isRestricted: boolean;
    moneyIn: string;
    moneyOut: string;
    netMovement: string;
  }[];
}

interface Entry {
  id: string;
  entryNumber: string;
  entryDate: string;
  narration: string;
  sourceType: string;
  reversesEntryId: string | null;
  lines: { code: string; name: string; debit: string; credit: string }[];
}

interface Period {
  id: string;
  startsOn: string;
  endsOn: string;
  status: string;
  lockedAt: string | null;
}

type Tab = "trial" | "income" | "balance" | "cash" | "daybook" | "accounts" | "periods";

/**
 * The books.
 *
 * The five statements an auditor asks for, computed in SQL off `journal_lines` every
 * time they are opened. Nothing here is stored or cached — a maintained total is a total
 * that can drift from the entries it claims to summarise, and the first time a balance
 * sheet fails to tie to the day book is the last time that committee trusts the software.
 *
 * Which is why `balanced` is printed at the top of two of these rather than left for the
 * reader to add up. Double entry makes it true by construction; showing it is how a
 * treasurer knows the construction held.
 */
export default function Books() {
  const [tab, setTab] = useState<Tab>("trial");
  const [asOf, setAsOf] = useState(today());
  const [from, setFrom] = useState(financialYearStart(today()));

  const [trial, setTrial] = useState<TrialBalance | null>(null);
  const [income, setIncome] = useState<IncomeExpenditure | null>(null);
  const [sheet, setSheet] = useState<BalanceSheet | null>(null);
  const [cash, setCash] = useState<CashFlow | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [invariants, setInvariants] = useState<{ ok: boolean; problems: string[] } | null>(null);

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [locking, setLocking] = useState<Period | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [t, i, b, c, d, a, p, inv] = await Promise.all([
        api.get<TrialBalance>(`/v1/ledger/trial-balance?asOf=${asOf}`),
        api.get<IncomeExpenditure>(`/v1/ledger/income-expenditure?from=${from}&to=${asOf}`),
        api.get<BalanceSheet>(`/v1/ledger/balance-sheet?asOf=${asOf}`),
        api.get<CashFlow>(`/v1/ledger/cash-flow?from=${from}&to=${asOf}`),
        api.get<Entry[]>(`/v1/ledger/day-book?from=${from}&to=${asOf}`),
        api.get<Account[]>(`/v1/ledger/accounts?asOf=${asOf}`),
        api.get<Period[]>("/v1/ledger/periods"),
        api.get<{ ok: boolean; problems: string[] }>("/v1/ledger/invariants"),
      ]);
      setTrial(t);
      setIncome(i);
      setSheet(b);
      setCash(c);
      setEntries(d);
      setAccounts(a);
      setPeriods(p);
      setInvariants(inv);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [asOf, from]);

  useEffect(() => {
    void load();
  }, [load]);

  const mayLock = can("accountant", "society_admin");

  return (
    <Shell
      title="The Books"
      lede="Trial balance, income and expenditure, balance sheet — read off the journal, never off a stored total."
    >
      {error ? <Problem error={error} /> : null}

      {/* A failed invariant means a control has broken and nothing below should be
          believed. It is shown before the figures, not after them. */}
      {invariants && !invariants.ok ? (
        <Banner tone="error">
          <strong>The ledger does not balance.</strong> {invariants.problems[0]} Every
          figure on this page is suspect until that is resolved.
        </Banner>
      ) : null}

      <dl className="figures settle">
        <Figure
          label="Total assets"
          value={rupees(sheet?.totalAssets)}
          hint={`as at ${shortDate(asOf)}`}
        />
        <Figure
          label="Income"
          value={rupees(income?.totalIncome)}
          hint="this financial year"
          tone="settled"
        />
        <Figure label="Expenditure" value={rupees(income?.totalExpenditure)} hint="this financial year" />
        <Figure
          label={surplusLabel(income?.surplus)}
          value={rupees(stripSign(income?.surplus))}
          hint="income less expenditure"
          {...(isNegative(income?.surplus) ? { tone: "arrears" as const } : { tone: "settled" as const })}
        />
        <Figure
          label="Books tie"
          value={sheet?.balanced && trial?.balanced ? "Yes" : "No"}
          hint={sheet?.balanced && trial?.balanced ? "debits equal credits" : "investigate now"}
          {...(sheet?.balanced && trial?.balanced ? {} : { tone: "arrears" as const })}
        />
      </dl>

      <section className="ledger settle">
        <Tabs
          tabs={[
            { id: "trial" as const, label: "Trial balance" },
            { id: "income" as const, label: "Income & expenditure" },
            { id: "balance" as const, label: "Balance sheet" },
            { id: "cash" as const, label: "Cash & bank" },
            { id: "daybook" as const, label: "Day book" },
            { id: "accounts" as const, label: "Chart of accounts" },
            { id: "periods" as const, label: "Period lock" },
          ]}
          active={tab}
          onChange={setTab}
        />

        <div className="toolbar">
          <label htmlFor="from" style={{ margin: 0, whiteSpace: "nowrap" }}>
            From
          </label>
          <input
            id="from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={{ width: "auto" }}
          />
          <label htmlFor="asof" style={{ margin: 0, whiteSpace: "nowrap" }}>
            To
          </label>
          <input
            id="asof"
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            style={{ width: "auto" }}
          />
          <span className="note">
            The Indian financial year runs April to March, so that is the default.
          </span>
        </div>

        {loading ? <Loading /> : null}

        {!loading && tab === "trial" && trial ? (
          <>
            {!trial.balanced ? (
              <div style={{ padding: "12px 17px 0" }}>
                <Banner tone="error">
                  Debits and credits disagree. Double entry makes this impossible unless
                  something has bypassed the journal.
                </Banner>
              </div>
            ) : null}
            <div className="ledger-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Account</th>
                    <th>Type</th>
                    <th style={{ textAlign: "right" }}>Debit</th>
                    <th style={{ textAlign: "right" }}>Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {trial.rows.map((r) => (
                    <tr key={r.code}>
                      <td className="num" style={{ textAlign: "left" }}>
                        {r.code}
                      </td>
                      <td className="strong">{r.name}</td>
                      <td className="muted">{r.type}</td>
                      <td className="num">{isZero(r.debit) ? "—" : rupees(r.debit)}</td>
                      <td className="num">{isZero(r.credit) ? "—" : rupees(r.credit)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td />
                    <td className="strong">Total</td>
                    <td />
                    <td className="num strong">{rupees(trial.totalDebit)}</td>
                    <td className="num strong">{rupees(trial.totalCredit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {!loading && tab === "income" && income ? (
          <div className="ledger-scroll">
            <table>
              <tbody>
                <SectionRows title="Income" lines={income.income} total={income.totalIncome} />
                <SectionRows
                  title="Expenditure"
                  lines={income.expenditure}
                  total={income.totalExpenditure}
                />
                <tr>
                  <td className="strong" style={{ fontSize: "1rem" }}>
                    {surplusLabel(income.surplus)} for the period
                  </td>
                  <td />
                  <td
                    className="num strong"
                    style={{ fontSize: "1rem" }}
                    {...(isNegative(income.surplus) ? { "data-tone": "arrears" } : {})}
                  >
                    {rupees(stripSign(income.surplus))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}

        {!loading && tab === "balance" && sheet ? (
          <>
            {!sheet.balanced ? (
              <div style={{ padding: "12px 17px 0" }}>
                <Banner tone="error">
                  The two sides do not agree. A balance sheet that does not balance is a
                  bug, not a report.
                </Banner>
              </div>
            ) : null}
            <div className="ledger-scroll">
              <table>
                <tbody>
                  <SectionRows title="Assets" lines={sheet.assets} total={sheet.totalAssets} />
                  <SectionRows
                    title="Liabilities"
                    lines={sheet.liabilities}
                    total={sheet.totalLiabilities}
                  />
                  <SectionRows
                    title="Funds"
                    lines={[
                      ...sheet.equity,
                      {
                        code: "—",
                        name: "Accumulated surplus",
                        amount: sheet.accumulatedSurplus,
                      },
                    ]}
                    total={addStrings(sheet.totalEquity, sheet.accumulatedSurplus)}
                  />
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {!loading && tab === "cash" && cash ? (
          <div className="ledger-scroll">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Account</th>
                  <th style={{ textAlign: "right" }}>In</th>
                  <th style={{ textAlign: "right" }}>Out</th>
                  <th style={{ textAlign: "right" }}>Net</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td />
                  <td className="muted">Opening balance</td>
                  <td colSpan={2} />
                  <td className="num muted">{rupees(cash.openingBalance)}</td>
                </tr>
                {cash.accounts.map((a) => (
                  <tr key={a.code}>
                    <td className="num" style={{ textAlign: "left" }}>
                      {a.code}
                    </td>
                    <td>
                      <span className="strong">{a.name}</span>
                      {/* Spending a restricted fund needs committee approval, so it must
                          never be read as ordinary cash. */}
                      {a.isRestricted ? (
                        <span style={{ marginLeft: 8 }}>
                          <Chip tone="pending">restricted</Chip>
                        </span>
                      ) : null}
                    </td>
                    <td className="num">{isZero(a.moneyIn) ? "—" : rupees(a.moneyIn)}</td>
                    <td className="num">{isZero(a.moneyOut) ? "—" : rupees(a.moneyOut)}</td>
                    <td
                      className="num strong"
                      {...(isNegative(a.netMovement) ? { "data-tone": "arrears" } : {})}
                    >
                      {rupees(a.netMovement)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {!loading && tab === "daybook" ? (
          entries.length === 0 ? (
            <p className="empty">No entries posted in this period.</p>
          ) : (
            <div className="ledger-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Entry</th>
                    <th>Date</th>
                    <th>Narration</th>
                    <th>Postings</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="num" style={{ textAlign: "left" }}>
                        {e.entryNumber}
                        {e.reversesEntryId ? (
                          <span style={{ display: "block", marginTop: 3 }}>
                            <Chip tone="arrears">reversal</Chip>
                          </span>
                        ) : null}
                      </td>
                      <td className="muted">{shortDate(e.entryDate)}</td>
                      <td>
                        <span className="strong">{e.narration}</span>
                        <span className="sub">{e.sourceType.replace(/_/g, " ")}</span>
                      </td>
                      <td>
                        {e.lines.map((l, index) => (
                          <span
                            key={index}
                            style={{ display: "block", fontSize: "0.82rem" }}
                          >
                            <span className="muted">{l.code}</span> {l.name}{" "}
                            <span
                              className="num"
                              style={{ display: "inline", marginLeft: 6 }}
                            >
                              {isZero(l.debit) ? `Cr ${rupees(l.credit)}` : `Dr ${rupees(l.debit)}`}
                            </span>
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}

        {!loading && tab === "accounts" ? (
          <div className="ledger-scroll">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Account</th>
                  <th>Type</th>
                  <th style={{ textAlign: "right" }}>Debits</th>
                  <th style={{ textAlign: "right" }}>Credits</th>
                  <th style={{ textAlign: "right" }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="num" style={{ textAlign: "left" }}>
                      {a.code}
                    </td>
                    <td>
                      <span className="strong">{a.name}</span>
                      {a.isRestricted ? (
                        <span style={{ marginLeft: 8 }}>
                          <Chip tone="pending">restricted</Chip>
                        </span>
                      ) : null}
                    </td>
                    <td className="muted">{a.type}</td>
                    <td className="num muted">{isZero(a.debits) ? "—" : rupees(a.debits)}</td>
                    <td className="num muted">{isZero(a.credits) ? "—" : rupees(a.credits)}</td>
                    <td className="num strong">{rupees(a.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {!loading && tab === "periods" ? (
          periods.length === 0 ? (
            <p className="empty">
              No accounting periods defined yet. One is created when the first invoice is
              issued.
            </p>
          ) : (
            <div className="ledger-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Status</th>
                    <th>Locked</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={p.id}>
                      <td className="strong">
                        {shortDate(p.startsOn)} — {shortDate(p.endsOn)}
                      </td>
                      <td>
                        <Chip tone={p.status === "locked" ? "settled" : "quiet"}>
                          {p.status}
                        </Chip>
                      </td>
                      <td className="muted">{p.lockedAt ? shortDate(p.lockedAt) : "—"}</td>
                      <td>
                        {mayLock ? (
                          <div className="row-actions">
                            {p.status === "locked" ? (
                              <button data-size="sm" onClick={() => setLocking(p)}>
                                Reopen
                              </button>
                            ) : (
                              <LockButton period={p} onDone={load} />
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
      </section>

      <section className="card settle">
        <div className="card-head">
          <h2>Where these figures come from</h2>
        </div>
        <div className="card-body">
          <p>
            Every number on this page is computed from the journal at the moment you open
            it. None of it is stored, and no running total is maintained — because a
            maintained total is one that can quietly drift from the entries it claims to
            summarise.
          </p>
          <p>
            Posted entries cannot be edited or deleted. The database revokes both from the
            application, so a correction is a reversing entry that stays visible in the day
            book above. That is what makes these statements worth signing.
          </p>
        </div>
      </section>

      {locking ? (
        <ReopenPeriod
          period={locking}
          onClose={() => setLocking(null)}
          onDone={() => {
            setLocking(null);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

function SectionRows({
  title,
  lines,
  total,
}: {
  title: string;
  lines: Line[];
  total: string;
}) {
  return (
    <>
      <tr>
        <td colSpan={3} style={{ paddingTop: 18 }}>
          <span
            style={{
              fontSize: "0.66rem",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              fontWeight: 800,
              color: "var(--ink-faint)",
            }}
          >
            {title}
          </span>
        </td>
      </tr>
      {lines.length === 0 ? (
        <tr>
          <td colSpan={3} className="muted">
            Nothing recorded.
          </td>
        </tr>
      ) : (
        lines.map((l) => (
          <tr key={`${title}-${l.code}-${l.name}`}>
            <td className="num muted" style={{ textAlign: "left", width: "1%" }}>
              {l.code}
            </td>
            <td>
              {l.name}
              {l.isRestricted ? (
                <span style={{ marginLeft: 8 }}>
                  <Chip tone="pending">restricted</Chip>
                </span>
              ) : null}
            </td>
            <td className="num">{rupees(l.amount)}</td>
          </tr>
        ))
      )}
      <tr>
        <td />
        <td className="strong">Total {title.toLowerCase()}</td>
        <td className="num strong">{rupees(total)}</td>
      </tr>
    </>
  );
}

function LockButton({ period, onDone }: { period: Period; onDone: () => Promise<void> }) {
  const action = useAction();
  return (
    <button
      data-size="sm"
      data-variant="primary"
      disabled={action.busy}
      title={action.error || "Nothing can be posted into a locked period."}
      onClick={() =>
        void action.run(() => api.post(`/v1/ledger/periods/${period.id}/lock`, {}), { onDone })
      }
    >
      {action.busy ? "…" : "Lock"}
    </button>
  );
}

/**
 * Reopening a closed period.
 *
 * Deliberately awkward. Reopening closed books is how fraud is concealed, so it needs a
 * second named person and a written reason — and the person approving cannot be the
 * person asking.
 */
function ReopenPeriod({
  period,
  onClose,
  onDone,
}: {
  period: Period;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [approvedByPersonId, setApprovedBy] = useState("");
  const [reason, setReason] = useState("");

  const ready = approvedByPersonId.trim().length > 20 && reason.trim().length >= 10;

  return (
    <Modal
      title="Reopen a closed period"
      note={`${shortDate(period.startsOn)} to ${shortDate(period.endsOn)}. The committee signed these accounts off.`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="danger"
            disabled={action.busy || !ready}
            onClick={() =>
              void action.run(
                () =>
                  api.post(`/v1/ledger/periods/${period.id}/reopen`, {
                    approvedByPersonId: approvedByPersonId.trim(),
                    reason: reason.trim(),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Reopening…" : "Reopen"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Banner tone="warn">
        Figures an auditor has already seen can change after this. Both names and the
        reason are written to the audit log permanently.
      </Banner>

      <Field
        label="Approved by"
        htmlFor="approver"
        hint="The person id of a second committee member. It cannot be you."
      >
        <input
          id="approver"
          value={approvedByPersonId}
          onChange={(e) => setApprovedBy(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          style={{ fontFamily: "var(--font-figure)", fontSize: "0.82rem" }}
        />
      </Field>

      <Field label="Reason" htmlFor="reason" hint="At least ten characters. An auditor will read this.">
        <textarea
          id="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          placeholder="Water charges for March were posted to the wrong head and must be reallocated."
          style={{ minHeight: 80 }}
        />
      </Field>
    </Modal>
  );
}

// --------------------------------------------------------------------- money

/**
 * These helpers never parse a rupee figure into a number.
 *
 * Everything here is a string test or a string comparison. `rupees()` does the
 * formatting; nothing on this page does arithmetic on money, which is the whole reason
 * the totals below cannot disagree with the API that produced them.
 */
function isZero(amount: string | null | undefined): boolean {
  if (!amount) return true;
  return !/[1-9]/.test(amount);
}

function isNegative(amount: string | null | undefined): boolean {
  return Boolean(amount?.startsWith("-"));
}

function stripSign(amount: string | null | undefined): string {
  if (!amount) return "0";
  return amount.startsWith("-") ? amount.slice(1) : amount;
}

/** A deficit is not a small surplus. It gets its own word. */
function surplusLabel(amount: string | null | undefined): string {
  return isNegative(amount) ? "Deficit" : "Surplus";
}

/**
 * The one addition on this page, done in integer paise with BigInt.
 *
 * Equity plus accumulated surplus is the funds total the balance sheet ties against, and
 * adding it as floats is precisely how a balance sheet ends up out by a paisa.
 */
function addStrings(a: string, b: string): string {
  const paise = toPaise(a) + toPaise(b);
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  return `${negative ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

function toPaise(amount: string | null | undefined): bigint {
  if (!amount) return 0n;
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? amount.slice(1) : amount).split(".");
  const value = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return negative ? -value : value;
}

// --------------------------------------------------------------------- dates

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The Indian financial year starts on 1 April. Statutory, so not configurable. */
function financialYearStart(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return `${month >= 4 ? year : year - 1}-04-01`;
}
