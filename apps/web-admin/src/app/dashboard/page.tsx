"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Chip, Figure, Ledger, Loading, Problem, Shell } from "../../components/Shell";
import { api, rupees, slaRemaining, timeAgo } from "../../lib/api";

interface Summary {
  units: number;
  occupied: number;
  vacant: number;
  openTickets: number;
  slaBreached: number;
  outstanding: string;
  overdue: string;
}

interface Ticket {
  id: string;
  ticketNumber: string;
  title: string;
  status: string;
  priority: string;
  slaDueAt: string;
  createdAt: string;
}

interface GateEvent {
  id: string;
  visitorName: string | null;
  category: string;
  direction: string;
  serverTs: string;
  verifiedOffline: boolean;
}

interface Alert {
  id: string;
  type: string;
  raisedAt: string;
  acknowledgedAt: string | null;
}

interface Approval {
  id: string;
  visitorName: string | null;
  category: string;
  requestedAt: string;
}

/**
 * The opening page.
 *
 * Ordered by what a committee acts on, not by what is easiest to compute: an alarm
 * nobody has answered, then someone waiting at the barrier, then money owed, then
 * complaints past their deadline. A dashboard that leads with "total visitors this week"
 * is a dashboard nobody opens twice.
 */
export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [gate, setGate] = useState<GateEvent[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [pending, setPending] = useState<Approval[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      // Fetched together: five sequential round trips to Singapore is a visible pause on
      // an Indian connection, and this is the first screen anyone sees.
      const [s, t, g, a, p] = await Promise.all([
        api.get<Summary>("/v1/society/summary"),
        api.get<Ticket[]>("/v1/tickets?status=open"),
        api.get<GateEvent[]>("/v1/gate/inside"),
        // Neither of these is fatal — a guard with no money authority still needs the
        // rest of this page to render.
        api.get<Alert[]>("/v1/safety/sos").catch(() => [] as Alert[]),
        api.get<Approval[]>("/v1/gate/approvals/pending").catch(() => [] as Approval[]),
      ]);
      setSummary(s);
      setTickets(t.slice(0, 8));
      setGate(g.slice(0, 8));
      setAlerts(a);
      setPending(p);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const unacked = alerts.filter((a) => !a.acknowledgedAt);

  return (
    <Shell
      title="Today"
      lede="Where the society stands right now — alarms, the gate, money owed, complaints open."
    >
      {error ? <Problem error={error} /> : null}
      {loading ? <Loading /> : null}

      {/* The only loud thing on any page in this console. */}
      {unacked.length > 0 ? (
        <div className="alarm-band settle">
          <div>
            <h2>
              {unacked.length} SOS alert{unacked.length === 1 ? "" : "s"} nobody has answered
            </h2>
            <p>Raised {timeAgo(unacked[0]!.raisedAt)}. Someone is waiting.</p>
          </div>
          <Link className="btn" href="/operations/">
            Open alerts
          </Link>
        </div>
      ) : null}

      {pending.length > 0 ? (
        <div className="notice" data-tone="warn">
          <strong>
            {pending.length} visitor{pending.length === 1 ? " is" : "s are"} waiting at the gate
          </strong>{" "}
          for a flat to answer. The approval ladder is running — push, then a call, then the
          flat&apos;s standing rule. <Link href="/gate/">Decide from here</Link>.
        </div>
      ) : null}

      {summary ? (
        <dl className="figures settle">
          <Figure
            label="Outstanding"
            value={rupees(summary.outstanding)}
            hint="issued and unpaid"
            tone="arrears"
          />
          <Figure
            label="Past due date"
            value={rupees(summary.overdue)}
            hint="already overdue"
            tone="arrears"
          />
          <Figure
            label="Flats"
            value={String(summary.units)}
            hint={`${summary.occupied} occupied · ${summary.vacant} vacant`}
          />
          <Figure
            label="Open complaints"
            value={String(summary.openTickets)}
            hint={
              summary.slaBreached > 0
                ? `${summary.slaBreached} past deadline`
                : "all within deadline"
            }
            {...(summary.slaBreached > 0 ? { tone: "arrears" as const } : {})}
          />
          <Figure label="Inside now" value={String(gate.length)} hint="visitors not signed out" />
        </dl>
      ) : null}

      <Ledger
        title="Complaints needing attention"
        note="oldest deadline first"
        head={["Ticket", "Complaint", "Raised", "Status", "Deadline"]}
        empty="No open complaints. The register is clear."
        isEmpty={!loading && tickets.length === 0}
        actions={
          <Link className="btn" href="/complaints/" style={{ fontSize: "0.78rem", padding: "4px 10px" }}>
            All complaints
          </Link>
        }
      >
        {tickets.map((ticket) => {
          const sla = slaRemaining(ticket.slaDueAt);
          return (
            <tr key={ticket.id}>
              <td className="num muted" style={{ textAlign: "left" }}>
                {ticket.ticketNumber}
              </td>
              <td>{ticket.title}</td>
              <td className="muted">{timeAgo(ticket.createdAt)}</td>
              <td>
                <Chip tone={ticket.status === "open" ? "pending" : "quiet"}>
                  {ticket.status.replace(/_/g, " ")}
                </Chip>
              </td>
              <td>
                <Chip tone={sla.tone as "arrears" | "pending" | "settled"}>{sla.label}</Chip>
              </td>
            </tr>
          );
        })}
      </Ledger>

      <Ledger
        title="Currently inside"
        note="entries with no matching exit"
        head={["Visitor", "Category", "Entered", "Verified"]}
        empty="Nobody is signed in at the gate."
        isEmpty={!loading && gate.length === 0}
        actions={
          <Link className="btn" href="/gate/" style={{ fontSize: "0.78rem", padding: "4px 10px" }}>
            Gate log
          </Link>
        }
      >
        {gate.map((event) => (
          <tr key={event.id}>
            <td>{event.visitorName ?? <span className="muted">not recorded</span>}</td>
            <td className="muted">{event.category}</td>
            <td className="muted">{timeAgo(event.serverTs)}</td>
            <td>
              {/* Worth surfacing: an offline-verified entry proves the signed-pass path
                  worked with no network, which is the product's core claim. */}
              {event.verifiedOffline ? (
                <Chip tone="settled">offline pass</Chip>
              ) : (
                <Chip tone="quiet">at gate</Chip>
              )}
            </td>
          </tr>
        ))}
      </Ledger>
    </Shell>
  );
}
