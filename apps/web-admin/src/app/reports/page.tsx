"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Bar,
  Banner,
  Chip,
  Figure,
  Ledger,
  Loading,
  Problem,
  Shell,
  Tabs,
} from "../../components/Shell";
import { api, rupees, shortDate } from "../../lib/api";

/*
 * These shapes come back from raw SQL, so the keys are snake_case rather than the
 * camelCase the rest of the API returns. Typed as they actually arrive rather than
 * renamed on the way in — a mapping layer here would be one more place for a committee
 * report and the ledger to quietly disagree.
 */

interface Overview {
  units: number;
  entries_today: number;
  open_tickets: number;
  sla_breached: number;
  open_alerts: number;
  parcels_waiting: number;
  staff_inside: number;
  parking_flags: number;
}

interface Collections {
  unpaid_invoices: number;
  total_outstanding: string;
  not_yet_due: string;
  overdue_0_30: string;
  overdue_31_60: string;
  overdue_61_90: string;
  overdue_90_plus: string;
}

interface Defaulter {
  unit_id: string;
  unit_number: string;
  outstanding: string;
  oldest_due: string;
  days_overdue: number;
}

interface Footfall {
  day: string;
  category: string;
  entries: number;
  offline_verified: number;
}

interface HelpdeskRow {
  category: string;
  total: number;
  open: number;
  in_progress: number;
  sla_breached: number;
  avg_hours_to_resolve: number;
}

interface StaffRow {
  kind: string;
  people: number;
  days_worked: number;
  overridden: number;
}

type Tab = "money" | "gate" | "helpdesk" | "staff";

/**
 * Reports for the committee.
 *
 * Two decisions shape this page.
 *
 * **Arrears are shown in ageing buckets, not as one total.** "₹4,20,000 outstanding"
 * tells a committee nothing about whether the position is improving. "₹80,000 of it is
 * over ninety days old" tells them exactly who to call this week.
 *
 * **Every figure is computed in SQL, once.** A number on a committee report and the same
 * number in the ledger must come from the same place — recomputing in the browser is how
 * two screens start disagreeing about arrears, and how a treasurer stops trusting both.
 */
export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>("money");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [collections, setCollections] = useState<Collections | null>(null);
  const [defaulters, setDefaulters] = useState<Defaulter[]>([]);
  const [footfall, setFootfall] = useState<Footfall[]>([]);
  const [helpdesk, setHelpdesk] = useState<HelpdeskRow[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [days, setDays] = useState("30");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [error, setError] = useState("");
  const [moneyDenied, setMoneyDenied] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, f, h, s] = await Promise.all([
        api.get<Overview>("/v1/analytics/overview"),
        api.get<Footfall[]>(`/v1/analytics/footfall?days=${days}`),
        api.get<HelpdeskRow[]>("/v1/analytics/helpdesk"),
        api.get<StaffRow[]>(`/v1/analytics/staff?month=${month}`),
      ]);
      setOverview(o);
      setFootfall(f);
      setHelpdesk(h);
      setStaff(s);

      /*
       * Arrears is a narrower gate than the rest of these reports — it is neighbours'
       * financial data. A committee member without money authority should see the rest of
       * the page working rather than one 403 blanking everything.
       */
      try {
        const [c, d] = await Promise.all([
          api.get<Collections[]>("/v1/analytics/collections"),
          api.get<Defaulter[]>("/v1/analytics/defaulters?limit=25"),
        ]);
        setCollections(c[0] ?? null);
        setDefaulters(d);
        setMoneyDenied(false);
      } catch {
        setMoneyDenied(true);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [days, month]);

  useEffect(() => {
    void load();
  }, [load]);

  const buckets = useMemo(() => {
    if (!collections) return [];
    return [
      { label: "Not yet due", amount: collections.not_yet_due, tone: "settled" as const },
      { label: "1–30 days over", amount: collections.overdue_0_30, tone: undefined },
      { label: "31–60 days over", amount: collections.overdue_31_60, tone: "gold" as const },
      { label: "61–90 days over", amount: collections.overdue_61_90, tone: "gold" as const },
      { label: "Over 90 days", amount: collections.overdue_90_plus, tone: "arrears" as const },
    ];
  }, [collections]);

  // Bar geometry only. The rupee figure beside each bar is the untouched string from the
  // API — this number decides a pixel width and is never displayed.
  const bucketMax = Math.max(1, ...buckets.map((b) => Number(b.amount) || 0));

  const byDay = useMemo(() => {
    const totals = new Map<string, { entries: number; offline: number }>();
    for (const row of footfall) {
      const current = totals.get(row.day) ?? { entries: 0, offline: 0 };
      totals.set(row.day, {
        entries: current.entries + row.entries,
        offline: current.offline + row.offline_verified,
      });
    }
    return [...totals.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 14);
  }, [footfall]);

  const byCategory = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of footfall) {
      totals.set(row.category, (totals.get(row.category) ?? 0) + row.entries);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [footfall]);

  const offlineShare = useMemo(() => {
    const total = footfall.reduce((n, r) => n + r.entries, 0);
    const offline = footfall.reduce((n, r) => n + r.offline_verified, 0);
    return total > 0 ? Math.round((offline / total) * 100) : 0;
  }, [footfall]);

  return (
    <Shell
      title="Reports"
      lede="Where the society stands, computed from the ledger rather than recounted here."
    >
      {error ? <Problem error={error} /> : null}

      {overview ? (
        <dl className="figures settle">
          <Figure label="Flats" value={String(overview.units)} />
          <Figure
            label="Entries today"
            value={String(overview.entries_today)}
            hint="through the gate"
          />
          <Figure
            label="Open complaints"
            value={String(overview.open_tickets)}
            hint={
              overview.sla_breached > 0
                ? `${overview.sla_breached} past deadline`
                : "all within deadline"
            }
            {...(overview.sla_breached > 0 ? { tone: "arrears" as const } : {})}
          />
          <Figure
            label="Open alarms"
            value={String(overview.open_alerts)}
            {...(overview.open_alerts > 0 ? { tone: "arrears" as const } : {})}
          />
          <Figure label="Parcels waiting" value={String(overview.parcels_waiting)} />
          <Figure label="Staff inside" value={String(overview.staff_inside)} />
        </dl>
      ) : null}

      <section className="ledger settle">
        <Tabs
          tabs={[
            { id: "money" as const, label: "Collections" },
            { id: "gate" as const, label: "The gate" },
            { id: "helpdesk" as const, label: "Complaints" },
            { id: "staff" as const, label: "Staff" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {loading ? <Loading /> : null}

        {!loading && tab === "money" ? (
          moneyDenied ? (
            <div style={{ padding: 17 }}>
              <Banner tone="info">
                Arrears are restricted to the committee and the accountant. This is
                neighbours&apos; financial position, and the fastest way to turn a
                maintenance app into a source of neighbourhood conflict is to publish it
                widely.
              </Banner>
            </div>
          ) : collections ? (
            <>
              <div className="bars">
                {buckets.map((bucket) => (
                  <Bar
                    key={bucket.label}
                    label={bucket.label}
                    value={Number(bucket.amount) || 0}
                    max={bucketMax}
                    display={rupees(bucket.amount)}
                    {...(bucket.tone ? { tone: bucket.tone } : {})}
                  />
                ))}
              </div>
              <div style={{ padding: "0 17px 16px" }}>
                <Banner tone="info">
                  {collections.unpaid_invoices} unpaid invoice
                  {collections.unpaid_invoices === 1 ? "" : "s"}, totalling{" "}
                  <strong>{rupees(collections.total_outstanding)}</strong>. The over-90 bucket
                  is the one that decides whether this society has a collection problem or a
                  timing one.
                </Banner>
              </div>
            </>
          ) : (
            <p className="empty">Nothing has been billed yet.</p>
          )
        ) : null}

        {!loading && tab === "gate" ? (
          <>
            <div className="toolbar">
              <label htmlFor="days" style={{ margin: 0, whiteSpace: "nowrap" }}>
                Window
              </label>
              <select
                id="days"
                value={days}
                onChange={(e) => setDays(e.target.value)}
                style={{ width: "auto" }}
              >
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="180">180 days</option>
              </select>
              <span className="note">
                {offlineShare}% of entries verified offline — the gate working without signal
              </span>
            </div>

            {byCategory.length === 0 ? (
              <p className="empty">No entries recorded in this window.</p>
            ) : (
              <>
                <div className="bars">
                  {byCategory.map(([category, entries]) => (
                    <Bar
                      key={category}
                      label={category}
                      value={entries}
                      max={Math.max(1, ...byCategory.map(([, n]) => n))}
                      display={String(entries)}
                    />
                  ))}
                </div>

                <div className="ledger-scroll" style={{ borderTop: "1px solid var(--rule)" }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Day</th>
                        <th style={{ textAlign: "right" }}>Entries</th>
                        <th style={{ textAlign: "right" }}>Offline verified</th>
                        <th style={{ textAlign: "right" }}>Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byDay.map(([day, totals]) => (
                        <tr key={day}>
                          <td className="muted">{shortDate(day)}</td>
                          <td className="num">{totals.entries}</td>
                          <td className="num muted">{totals.offline}</td>
                          <td className="num">
                            {totals.entries > 0
                              ? `${Math.round((totals.offline / totals.entries) * 100)}%`
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        ) : null}

        {!loading && tab === "helpdesk" ? (
          helpdesk.length === 0 ? (
            <p className="empty">No complaints have been raised.</p>
          ) : (
            <div className="ledger-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Category</th>
                    <th style={{ textAlign: "right" }}>Total</th>
                    <th style={{ textAlign: "right" }}>Open</th>
                    <th style={{ textAlign: "right" }}>In progress</th>
                    <th style={{ textAlign: "right" }}>Missed deadline</th>
                    <th style={{ textAlign: "right" }}>Average to resolve</th>
                  </tr>
                </thead>
                <tbody>
                  {helpdesk.map((row) => (
                    <tr key={row.category}>
                      <td className="strong">{row.category}</td>
                      <td className="num">{row.total}</td>
                      <td className="num">{row.open}</td>
                      <td className="num muted">{row.in_progress}</td>
                      {/* Counts late resolutions too, not only currently-overdue tickets —
                          a category that always finishes a day late looks fine otherwise. */}
                      <td
                        className="num"
                        {...(row.sla_breached > 0 ? { "data-tone": "arrears" } : {})}
                      >
                        {row.sla_breached}
                      </td>
                      <td className="num muted">
                        {row.avg_hours_to_resolve > 0
                          ? `${row.avg_hours_to_resolve} hr`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}

        {!loading && tab === "staff" ? (
          <>
            <div className="toolbar">
              <label htmlFor="rmonth" style={{ margin: 0, whiteSpace: "nowrap" }}>
                Month
              </label>
              <input
                id="rmonth"
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                style={{ width: "auto" }}
              />
            </div>

            {staff.length === 0 ? (
              <p className="empty">No active staff on the register.</p>
            ) : (
              <div className="ledger-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Role</th>
                      <th style={{ textAlign: "right" }}>People</th>
                      <th style={{ textAlign: "right" }}>Days worked</th>
                      <th style={{ textAlign: "right" }}>Edited by hand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staff.map((row) => (
                      <tr key={row.kind}>
                        <td className="strong">{row.kind.replace(/_/g, " ")}</td>
                        <td className="num">{row.people}</td>
                        <td className="num">{row.days_worked}</td>
                        <td
                          className="num"
                          {...(row.overridden > 0 ? { "data-tone": "arrears" } : {})}
                        >
                          {row.overridden}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </section>

      {!moneyDenied && defaulters.length > 0 ? (
        <Ledger
          title="Who owes the most"
          note="worst first — the list a committee works down"
          head={["Flat", "~Outstanding", "Oldest due", "~Days overdue"]}
          empty="Nothing outstanding."
          isEmpty={false}
        >
          {defaulters.map((row) => (
            <tr key={row.unit_id}>
              <td className="strong">{row.unit_number}</td>
              <td className="num" data-tone="arrears">
                {rupees(row.outstanding)}
              </td>
              <td className="muted">{shortDate(row.oldest_due)}</td>
              <td className="num">
                {row.days_overdue > 90 ? (
                  <Chip tone="arrears">{row.days_overdue} d</Chip>
                ) : (
                  <span className="muted">{row.days_overdue} d</span>
                )}
              </td>
            </tr>
          ))}
        </Ledger>
      ) : null}
    </Shell>
  );
}
