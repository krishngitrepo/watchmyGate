"use client";

import { useEffect, useMemo, useState } from "react";

import { Chip, Figure, Ledger, Loading, Problem, Shell } from "../../components/Shell";
import { api, shortDate, slaRemaining, timeAgo } from "../../lib/api";

interface Ticket {
  id: string;
  ticketNumber: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  locationType: string;
  slaDueAt: string;
  escalationDueAt: string;
  escalatedAt: string | null;
  resolvedAt: string | null;
  rating: number | null;
  reopenCount: number;
  createdAt: string;
}

const STATUSES = ["open", "in_progress", "resolved", "closed", "reopened"] as const;

/**
 * Complaints.
 *
 * The feature Krishna asked for twice: a resident reports "the light is not working in
 * the lift" with two photos, and the committee sees it here.
 *
 * Sorted by deadline rather than by date raised. A complaint filed this morning with a
 * four-hour lift SLA matters more than one filed last week with a seventy-two-hour
 * gardening SLA, and sorting by date buries exactly the thing that needs acting on.
 */
export default function Complaints() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const path = filter ? `/v1/tickets?status=${filter}` : "/v1/tickets";
        setTickets(await api.get<Ticket[]>(path));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [filter]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? tickets.filter(
          (t) =>
            t.title.toLowerCase().includes(needle) ||
            t.ticketNumber.toLowerCase().includes(needle) ||
            (t.description ?? "").toLowerCase().includes(needle),
        )
      : tickets;

    // Unresolved first, then by deadline. A resolved ticket has no deadline pressure,
    // so it must never sit above an open one however old it is.
    return [...matched].sort((a, b) => {
      const aDone = Boolean(a.resolvedAt);
      const bDone = Boolean(b.resolvedAt);
      if (aDone !== bDone) return aDone ? 1 : -1;
      return a.slaDueAt < b.slaDueAt ? -1 : 1;
    });
  }, [tickets, query]);

  const counts = useMemo(() => {
    const open = tickets.filter((t) => !t.resolvedAt).length;
    const breached = tickets.filter(
      (t) => !t.resolvedAt && new Date(t.slaDueAt).getTime() < Date.now(),
    ).length;
    const escalated = tickets.filter((t) => t.escalatedAt).length;
    const reopened = tickets.filter((t) => t.reopenCount > 0).length;
    return { open, breached, escalated, reopened };
  }, [tickets]);

  return (
    <Shell
      title="Complaints"
      lede="Every issue residents have raised, ordered by how soon it is due rather than when it arrived."
    >
      {error ? <Problem error={error} /> : null}

      <dl className="figures settle">
        <Figure label="Unresolved" value={String(counts.open)} />
        <Figure
          label="Past deadline"
          value={String(counts.breached)}
          {...(counts.breached > 0 ? { tone: "arrears" as const } : {})}
        />
        <Figure label="Escalated" value={String(counts.escalated)} hint="sent to the committee" />
        <Figure
          label="Reopened"
          value={String(counts.reopened)}
          hint="fixed but came back"
          {...(counts.reopened > 0 ? { tone: "arrears" as const } : {})}
        />
      </dl>

      <section className="ledger settle">
        <div className="toolbar">
          <input
            placeholder="Search by ticket number or words in the complaint…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, minWidth: 240 }}
            aria-label="Search complaints"
          />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <Loading />
        ) : visible.length === 0 ? (
          <p className="empty">
            {query || filter
              ? "No complaints match that."
              : "No complaints have been raised. "}
          </p>
        ) : (
          <div className="ledger-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Complaint</th>
                  <th>Where</th>
                  <th>Raised</th>
                  <th>Status</th>
                  <th>Deadline</th>
                  <th>Rating</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((ticket) => {
                  const sla = slaRemaining(ticket.slaDueAt);
                  const done = Boolean(ticket.resolvedAt);

                  return (
                    <tr key={ticket.id}>
                      <td className="num" style={{ textAlign: "left" }}>
                        {ticket.ticketNumber}
                        {ticket.reopenCount > 0 ? (
                          <span
                            className="muted"
                            style={{ display: "block", fontSize: "0.72rem" }}
                          >
                            reopened ×{ticket.reopenCount}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span style={{ fontWeight: 500 }}>{ticket.title}</span>
                        {ticket.description ? (
                          <span
                            className="muted"
                            style={{
                              display: "block",
                              fontSize: "0.8rem",
                              maxWidth: "42ch",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {ticket.description}
                          </span>
                        ) : null}
                      </td>
                      <td className="muted">{ticket.locationType.replace(/_/g, " ")}</td>
                      <td className="muted">{timeAgo(ticket.createdAt)}</td>
                      <td>
                        <Chip
                          tone={
                            done ? "settled" : ticket.status === "reopened" ? "arrears" : "pending"
                          }
                        >
                          {ticket.status.replace(/_/g, " ")}
                        </Chip>
                        {ticket.escalatedAt ? (
                          <span
                            className="muted"
                            style={{ display: "block", fontSize: "0.72rem" }}
                          >
                            escalated {shortDate(ticket.escalatedAt)}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {done ? (
                          <span className="muted">
                            resolved {timeAgo(ticket.resolvedAt)}
                          </span>
                        ) : (
                          <Chip tone={sla.tone as "arrears" | "pending" | "settled"}>
                            {sla.label}
                          </Chip>
                        )}
                      </td>
                      <td className="num muted">
                        {/* Stars as figures, so the column scans. */}
                        {ticket.rating ? `${ticket.rating}/5` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}
