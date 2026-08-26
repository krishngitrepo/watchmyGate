"use client";

import { useCallback, useEffect, useState } from "react";

import {
  Banner,
  Chip,
  Field,
  Figure,
  Form,
  Ledger,
  Loading,
  Problem,
  Shell,
} from "../../components/Shell";
import { api, can, shortDate } from "../../lib/api";

interface Entry {
  id: string;
  createdAt: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  actorPersonId: string | null;
  actorName: string | null;
  actorPhone: string | null;
}

interface ActionSummary {
  action: string;
  entityType: string;
  count: number;
  lastAt: string;
}

/**
 * The audit log (MG-45).
 *
 * The table has been immutable since the first migration — insert and select granted,
 * update and delete withheld — and until recently it was also **empty**, which made the
 * immutability a guarantee about nothing. Both halves are now real: the acts that matter
 * are written, and this is where they are read.
 *
 * Filtered rather than paged, deliberately. An audit log is opened with a question in
 * mind — who gave that person admin, what happened to this invoice, who exported the
 * register and why — and scrolling months of entries answers none of them.
 */
export default function AuditPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [summary, setSummary] = useState<ActionSummary[]>([]);
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const committee = can("society_admin", "mc_member", "auditor");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (action) query.set("action", action);
      if (from) query.set("from", from);
      if (to) query.set("to", to);
      const suffix = query.toString() ? `?${query}` : "";

      setEntries(await api.get<Entry[]>(`/v1/audit${suffix}`));
      setError("");

      // The filter offers what the log actually holds, not a hardcoded list that drifts
      // the first time an action is added.
      if (committee) {
        try {
          setSummary(await api.get<ActionSummary[]>("/v1/audit/actions"));
        } catch {
          setSummary([]);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [action, from, to, committee]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = summary.reduce((sum, row) => sum + row.count, 0);
  const withReason = entries.filter((e) => e.reason).length;

  return (
    <Shell
      title="Audit Log"
      lede="Who did what, and when. Written where it cannot be edited or removed — not by this application, and not by anyone using it."
    >
      {error ? <Problem error={error} /> : null}
      {loading ? <Loading /> : null}

      {!committee ? (
        <Banner tone="info">
          You are seeing your own entries. The full log names every committee member&apos;s
          actions, which is a record of colleagues as much as of events.
        </Banner>
      ) : null}

      {committee ? (
        <dl className="figures settle">
          <Figure label="Entries held" value={String(total)} hint="across all time" />
          <Figure label="Kinds of act" value={String(summary.length)} />
          <Figure
            label="Shown"
            value={String(entries.length)}
            hint={action ? action : "most recent first"}
          />
          <Figure
            label="With a stated reason"
            value={String(withReason)}
            hint="disclosures and reversals"
          />
        </dl>
      ) : null}

      <section className="card settle">
        <div className="card-head">
          <h2>Ask it something</h2>
        </div>
        <div className="card-body">
          <Form onSubmit={() => void load()}>
            <Field label="Act" hint="what kind of thing happened">
              <select value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="">Everything</option>
                {summary.map((row) => (
                  <option key={row.action} value={row.action}>
                    {readable(row.action)} ({row.count})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="From" hint="optional">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To" hint="optional">
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </Form>
        </div>
      </section>

      <Ledger
        title="What happened"
        note="newest first — the log cannot be edited or deleted, by anyone"
        head={["When", "Act", "Who", "What", "Why"]}
        empty="Nothing matches. Try widening the dates or clearing the act."
        isEmpty={!loading && entries.length === 0}
      >
        {entries.map((entry) => (
          <tr key={entry.id}>
            <td className="muted">
              {shortDate(entry.createdAt)}
              <span className="sub">{timeOf(entry.createdAt)}</span>
            </td>
            <td className="strong">
              {readable(entry.action)}
              <span className="sub">{entry.entityType.replace(/_/g, " ")}</span>
            </td>
            <td>
              {entry.actorName ?? <span className="muted">system</span>}
              {entry.actorPhone ? <span className="sub">{entry.actorPhone}</span> : null}
            </td>
            <td className="muted">{detail(entry)}</td>
            <td>
              {/* A disclosure with no stated purpose is one nobody can review afterwards,
                  so where a reason is required its absence should be visible. */}
              {entry.reason ? (
                <span className="muted">{entry.reason}</span>
              ) : (
                <Chip tone="quiet">—</Chip>
              )}
            </td>
          </tr>
        ))}
      </Ledger>

      <section className="card settle">
        <div className="card-head">
          <h2>What is in here, and what is not</h2>
        </div>
        <div className="card-body">
          <p>
            <strong>Acts of authority</strong> — granting a role, passing a budget, locking
            or reopening a period, retiring an asset. <strong>Money leaving its normal
            path</strong> — a receipt taken outside the gateway, a credit applied.{" "}
            <strong>Bulk reads of personal data</strong> — exporting the visitor register,
            exporting somebody&apos;s record.
          </p>
          <p>
            Ordinary reads are not here. A log that records everything is a log nobody can
            search, and it becomes the thing people mute rather than the thing they
            consult.
          </p>
        </div>
      </section>
    </Shell>
  );
}

/** `budget.approved` reads as "budget approved" to everyone except a programmer. */
function readable(action: string): string {
  return action.replace(/\./g, " ").replace(/_/g, " ");
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The payload, in a line.
 *
 * The structured `before`/`after` is what makes an entry answerable months later, but a
 * raw JSON blob in a table cell is unreadable. This picks the fields worth showing and
 * leaves the rest in the record.
 */
function detail(entry: Entry): string {
  const payload = { ...(entry.before ?? {}), ...(entry.after ?? {}) } as Record<string, unknown>;
  const parts = Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .slice(0, 4)
    .map(([key, value]) => `${key.replace(/([A-Z])/g, " $1").toLowerCase()} ${format(value)}`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function format(value: unknown): string {
  if (Array.isArray(value)) return value.length > 3 ? `${value.length} items` : value.join(", ");
  if (typeof value === "object") return "…";
  return String(value);
}
