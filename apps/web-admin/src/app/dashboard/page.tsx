"use client";

import { useEffect, useState } from "react";

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

/**
 * The opening page of the register.
 *
 * Ordered by what a committee actually acts on, not by what is easiest to compute:
 * money owed first, then complaints breaching their deadline, then the gate. A
 * dashboard that leads with "total visitors this week" is a dashboard nobody opens
 * twice.
 */
export default function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [gate, setGate] = useState<GateEvent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        // Fetched together: three sequential round trips to Singapore is a visible
        // pause on an Indian connection, and this is the first screen anyone sees.
        const [s, t, g] = await Promise.all([
          api.get<Summary>("/v1/society/summary"),
          api.get<Ticket[]>("/v1/tickets?status=open"),
          api.get<GateEvent[]>("/v1/gate/inside"),
        ]);
        setSummary(s);
        setTickets(t.slice(0, 8));
        setGate(g.slice(0, 8));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <Shell
      title="The Register"
      lede="Where the society stands today — money owed, complaints open, who is inside."
    >
      {error ? <Problem error={error} /> : null}
      {loading ? <Loading /> : null}

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
