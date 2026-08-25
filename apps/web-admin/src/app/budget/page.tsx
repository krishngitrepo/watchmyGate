"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Banner,
  Bar,
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

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface Budget {
  id: string;
  financialYear: number;
  title: string;
  notes: string | null;
  status: string;
  version: number;
  approvedRef: string | null;
  approvedAt: string | null;
  supersedesId: string | null;
  approvedByName: string | null;
  createdByName: string | null;
  lineCount: number;
  totalBudgeted: string;
}

interface VarianceRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  budgeted: string;
  actual: string;
  remaining: string;
  percentUsed: string | null;
  unbudgeted: boolean;
  notes: string | null;
}

interface Variance {
  financialYear: number;
  label: string;
  from: string;
  to: string;
  yearElapsedPercent: string;
  budget: { id: string; title: string; status: string; version: number; approvedRef: string | null } | null;
  income: VarianceRow[];
  expenditure: VarianceRow[];
  totals: {
    incomeBudgeted: string;
    incomeActual: string;
    expenditureBudgeted: string;
    expenditureActual: string;
  };
  unbudgetedHeads: number;
}

/**
 * The budget, and whether the society is inside it.
 *
 * Two numbers make this page useful and one of them is easy to leave out: **how much of
 * the budget is spent**, and **how far through the year we are**. "62% of the maintenance
 * head is gone" is alarming in June and unremarkable in February, and a page that shows
 * only the first invites the wrong reaction at an AGM.
 *
 * Nothing here is stored twice. Budgeted figures come from `budget_lines`; every actual
 * is read from the ledger at query time, so this page and the Income & Expenditure
 * statement cannot disagree.
 */
export default function BudgetPage() {
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [variance, setVariance] = useState<Variance | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [year, setYear] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [approving, setApproving] = useState<Budget | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const mayDraft = can("society_admin", "accountant");
  const mayPass = can("society_admin", "mc_member");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, report] = await Promise.all([
        api.get<Budget[]>("/v1/ledger/budgets"),
        api.get<Variance>(`/v1/ledger/budgets/variance${year ? `?year=${year}` : ""}`),
      ]);
      setBudgets(list);
      setVariance(report);
      setError("");

      try {
        const chart = await api.get<{ accounts?: Account[] } | Account[]>("/v1/ledger/accounts");
        setAccounts(Array.isArray(chart) ? chart : (chart.accounts ?? []));
      } catch {
        setAccounts([]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  const years = useMemo(
    () => [...new Set(budgets.map((b) => b.financialYear))].sort((a, b) => b - a),
    [budgets],
  );

  const rows = [...(variance?.expenditure ?? []), ...(variance?.income ?? [])];
  const worst = rows
    .filter((r) => toPaise(r.budgeted) > 0n)
    .sort((a, b) => Number(b.percentUsed ?? 0) - Number(a.percentUsed ?? 0))
    .slice(0, 8);
  const ceiling = worst.reduce((max, r) => Math.max(max, Number(r.percentUsed ?? 0)), 100);

  return (
    <Shell
      title="Budget"
      lede="What was passed, what has been spent, and how much of the year is left to spend it in."
      actions={
        mayDraft ? (
          <button data-variant="primary" onClick={() => setDrafting(true)}>
            Draft a budget
          </button>
        ) : null
      }
    >
      {error ? <Problem error={error} /> : null}
      {loading ? <Loading /> : null}

      {variance ? (
        <>
          <dl className="figures settle">
            <Figure
              label="Budgeted expenditure"
              value={rupees(variance.totals.expenditureBudgeted)}
              hint={`FY ${variance.label}`}
            />
            <Figure
              label="Spent so far"
              value={rupees(variance.totals.expenditureActual)}
              hint={`to ${shortDate(variance.to)}`}
            />
            <Figure
              label="Year elapsed"
              value={`${variance.yearElapsedPercent}%`}
              hint="the only honest denominator"
            />
            <Figure
              label="Income received"
              value={rupees(variance.totals.incomeActual)}
              hint={`against ${rupees(variance.totals.incomeBudgeted)} budgeted`}
              tone="settled"
            />
          </dl>

          {!variance.budget ? (
            <Banner tone="info">
              No budget has been raised for {variance.label}. The figures below are what the
              ledger says was actually earned and spent — every head is marked unbudgeted
              because there is nothing yet to compare them against.
            </Banner>
          ) : null}

          {variance.unbudgetedHeads > 0 && variance.budget ? (
            <Banner tone="warn">
              {variance.unbudgetedHeads} head{variance.unbudgetedHeads === 1 ? " has" : "s have"}{" "}
              money against {variance.unbudgetedHeads === 1 ? "it" : "them"} and{" "}
              {variance.unbudgetedHeads === 1 ? "was" : "were"} never budgeted. That is the
              first thing an auditor asks about.
            </Banner>
          ) : null}
        </>
      ) : null}

      {worst.length > 0 ? (
        <section className="card settle">
          <div className="card-head">
            <h2>Consumed against budget</h2>
            <span className="note">
              {variance?.yearElapsedPercent}% of the year has passed
            </span>
          </div>
          <div className="card-body bars">
            {worst.map((row) => (
              <Bar
                key={row.accountId}
                label={`${row.code} ${row.name}`}
                value={Number(row.percentUsed ?? 0)}
                max={ceiling}
                display={`${row.percentUsed ?? "0"}%`}
                {...(Number(row.percentUsed ?? 0) > 100
                  ? { tone: "arrears" as const }
                  : Number(row.percentUsed ?? 0) > Number(variance?.yearElapsedPercent ?? 0)
                    ? { tone: "gold" as const }
                    : {})}
              />
            ))}
          </div>
        </section>
      ) : null}

      <Ledger
        title={`Budget against actual — FY ${variance?.label ?? ""}`}
        note={
          variance?.budget
            ? `${variance.budget.title} · v${variance.budget.version} · ${variance.budget.status}`
            : "no budget raised for this year"
        }
        head={["Head", "Type", "~Budgeted", "~Actual", "~Remaining", "~Used"]}
        empty="Nothing budgeted and nothing spent."
        isEmpty={!loading && rows.length === 0}
        {...(years.length > 1
          ? {
              actions: (
                <select value={year} onChange={(e) => setYear(e.target.value)}>
                  <option value="">This financial year</option>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      FY {y}-{String((y + 1) % 100).padStart(2, "0")}
                    </option>
                  ))}
                </select>
              ),
            }
          : {})}
      >
        {rows.map((row) => {
          const used = Number(row.percentUsed ?? 0);
          return (
            <tr key={`${row.type}-${row.accountId}`}>
              <td className="strong">
                {row.name}
                <span className="sub">{row.code}</span>
              </td>
              <td>
                {row.unbudgeted ? (
                  <Chip tone="pending">unbudgeted</Chip>
                ) : (
                  <span className="muted">{row.type}</span>
                )}
              </td>
              <td className="num muted">{toPaise(row.budgeted) > 0n ? rupees(row.budgeted) : "—"}</td>
              <td className="num">{rupees(row.actual)}</td>
              <td
                className="num"
                data-tone={toPaise(row.remaining) < 0n ? "arrears" : undefined}
              >
                {toPaise(row.budgeted) > 0n ? rupees(row.remaining) : "—"}
              </td>
              <td className="num">
                {/* Null, not zero. 0% consumed of a head that was never budgeted is a
                    lie, and it is the row that matters most on this page. */}
                {row.percentUsed === null ? (
                  <span className="muted">—</span>
                ) : used > 100 ? (
                  <Chip tone="arrears">{row.percentUsed}%</Chip>
                ) : (
                  <span>{row.percentUsed}%</span>
                )}
              </td>
            </tr>
          );
        })}
      </Ledger>

      <Ledger
        title="Budgets raised"
        note="a passed budget is superseded, never edited"
        head={["Year", "Title", "Status", "~Heads", "~Total", "Passed under"]}
        empty="No budget has been raised yet."
        isEmpty={!loading && budgets.length === 0}
      >
        {budgets.map((budget) => (
          <tr key={budget.id}>
            <td className="strong">
              {budget.financialYear}-{String((budget.financialYear + 1) % 100).padStart(2, "0")}
              {budget.version > 1 ? <span className="sub">revision {budget.version}</span> : null}
            </td>
            <td>{budget.title}</td>
            <td>
              <Chip
                tone={
                  budget.status === "approved"
                    ? "settled"
                    : budget.status === "draft"
                      ? "pending"
                      : "quiet"
                }
              >
                {budget.status}
              </Chip>
              {budget.status === "draft" && mayPass ? (
                <button className="link" onClick={() => setApproving(budget)}>
                  Pass it
                </button>
              ) : null}
            </td>
            <td className="num muted">{budget.lineCount}</td>
            <td className="num">{rupees(budget.totalBudgeted)}</td>
            <td className="muted">
              {budget.approvedRef ? (
                <>
                  {budget.approvedRef}
                  <span className="sub">
                    {budget.approvedByName ?? "—"}
                    {budget.approvedAt ? ` · ${shortDate(budget.approvedAt)}` : ""}
                  </span>
                </>
              ) : (
                <>
                  drafted by {budget.createdByName ?? "—"}
                  <span className="sub">not yet passed</span>
                </>
              )}
            </td>
          </tr>
        ))}
      </Ledger>

      <section className="card settle">
        <div className="card-head">
          <h2>Why a passed budget cannot be edited</h2>
        </div>
        <div className="card-body">
          <p>
            Once the committee passes a budget its heads are frozen{" "}
            <strong>by the database</strong>, not by this screen. A budget a treasurer can
            quietly amend afterwards is a running commentary, not a decision the AGM took.
          </p>
          <p>
            A real change is a <strong>revision</strong>: the passed budget is superseded and
            a new draft starts as a copy of it, so next year&apos;s committee can see that a
            revision happened and what it changed.
          </p>
        </div>
      </section>

      {drafting ? (
        <DraftBudget
          accounts={accounts}
          onClose={() => setDrafting(false)}
          onDone={() => {
            setDrafting(false);
            void load();
          }}
        />
      ) : null}

      {approving ? (
        <PassBudget
          budget={approving}
          onClose={() => setApproving(null)}
          onDone={() => {
            setApproving(null);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

/** Draft a budget: one row per ledger head, annual figures. */
function DraftBudget({
  accounts,
  onClose,
  onDone,
}: {
  accounts: Account[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const thisYear = financialYearNow();
  const [year, setYear] = useState(String(thisYear));
  const [title, setTitle] = useState(
    `Annual budget ${thisYear}-${String((thisYear + 1) % 100).padStart(2, "0")}`,
  );
  const [notes, setNotes] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const heads = accounts.filter((a) => a.type === "expense" || a.type === "income");
  const decimalsOk = Object.values(amounts).every((v) => !v || /^\d+(\.\d{1,4})?$/.test(v));
  const filled = Object.entries(amounts).filter(([, v]) => v && v !== "0");

  function submit() {
    void action.run(
      () =>
        api.post("/v1/ledger/budgets", {
          financialYear: Number(year),
          title,
          ...(notes ? { notes } : {}),
          lines: filled.map(([accountId, annualAmount]) => ({ accountId, annualAmount })),
        }),
      { onDone },
    );
  }

  return (
    <Modal
      title="Draft a budget"
      note="Annual figures per head. It is a draft until another committee member passes it."
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            data-variant="primary"
            disabled={!title || !decimalsOk || filled.length === 0 || action.busy}
            onClick={submit}
          >
            Save draft
          </button>
        </>
      }
    >
      {action.error ? <Problem error={action.error} /> : null}
      <Form onSubmit={submit}>
        <Field label="Financial year" hint="1 April to 31 March — the Indian year, not the calendar one">
          <input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Notes" hint="optional">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </Form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Head</th>
              <th>Type</th>
              <th className="num">Annual amount</th>
            </tr>
          </thead>
          <tbody>
            {heads.map((account) => (
              <tr key={account.id}>
                <td className="strong">
                  {account.name}
                  <span className="sub">{account.code}</span>
                </td>
                <td className="muted">{account.type}</td>
                <td className="num">
                  <input
                    value={amounts[account.id] ?? ""}
                    placeholder="0.00"
                    inputMode="decimal"
                    onChange={(e) =>
                      setAmounts((prev) => ({ ...prev, [account.id]: e.target.value }))
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!decimalsOk ? (
        <Banner tone="warn">Amounts are plain decimals, like 120000.00.</Banner>
      ) : null}
    </Modal>
  );
}

/**
 * Pass a budget.
 *
 * The API refuses if the person passing it is the person who drafted it, and the reason
 * is stated here rather than left to be discovered — a treasurer who both writes and
 * approves the budget has not made a committee decision.
 */
function PassBudget({
  budget,
  onClose,
  onDone,
}: {
  budget: Budget;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [ref, setRef] = useState("");

  return (
    <Modal
      title={`Pass ${budget.title}`}
      note="Record the resolution. This freezes the heads — a change afterwards is a revision."
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            data-variant="primary"
            disabled={ref.trim().length < 4 || action.busy}
            onClick={() =>
              void action.run(
                () =>
                  api.post(`/v1/ledger/budgets/${budget.id}/approve`, {
                    resolutionRef: ref.trim(),
                  }),
                { onDone },
              )
            }
          >
            Pass the budget
          </button>
        </>
      }
    >
      {action.error ? <Problem error={action.error} /> : null}
      <Banner tone="info">
        Drafted by {budget.createdByName ?? "someone else"}. Whoever drafted a budget cannot
        also pass it — ask another committee member if that is you.
      </Banner>
      <Form
        onSubmit={() =>
          void action.run(
            () =>
              api.post(`/v1/ledger/budgets/${budget.id}/approve`, {
                resolutionRef: ref.trim(),
              }),
            { onDone },
          )
        }
      >
        <Field label="Resolution" hint="an AGM date or a resolution number">
          <input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="AGM 12 Apr 2026, resolution 4"
          />
        </Field>
      </Form>
    </Modal>
  );
}

/** 1 April to 31 March: February 2027 still belongs to FY 2026-27. */
function financialYearNow(): number {
  const now = new Date();
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
}

/** Money as integer paise. Never parsed into a JS number. */
function toPaise(amount: string | null | undefined): bigint {
  if (!amount) return 0n;
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? amount.slice(1) : amount).split(".");
  const paise = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return negative ? -paise : paise;
}
