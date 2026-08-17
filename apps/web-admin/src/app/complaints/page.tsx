"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Banner,
  Check,
  Chip,
  Field,
  Figure,
  Form,
  Loading,
  Modal,
  Problem,
  Shell,
  useAction,
} from "../../components/Shell";
import { api, can, shortDate, slaRemaining, timeAgo } from "../../lib/api";

interface Ticket {
  id: string;
  ticketNumber: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  locationType: string;
  unitId: string | null;
  categoryId: string | null;
  slaDueAt: string;
  escalationDueAt: string;
  escalatedAt: string | null;
  resolvedAt: string | null;
  rating: number | null;
  reopenCount: number;
  createdAt: string;
}

interface Category {
  id: string;
  name: string;
}

interface Unit {
  id: string;
  number: string;
  towerName: string;
}

interface TicketEvent {
  id: string;
  type: string;
  body: string | null;
  visibility: string;
  createdAt: string;
}

interface Attachment {
  id: string;
  kind: string;
  contentType: string;
  isProofOfFix: boolean;
  downloadUrl: string;
}

const STATUSES = ["open", "in_progress", "resolved", "closed", "reopened"] as const;
const LOCATIONS = ["unit", "tower", "floor", "amenity", "common"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

/**
 * Complaints.
 *
 * A resident reports "the light is not working in the lift" with two photos, and the
 * committee works it from here: comment, reassign a status, close it, or reopen it when
 * the light is still out.
 *
 * Sorted by deadline rather than by date raised. A complaint filed this morning with a
 * four-hour lift SLA matters more than one filed last week with a seventy-two-hour
 * gardening SLA, and sorting by date buries exactly the thing that needs acting on.
 */
export default function Complaints() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [raising, setRaising] = useState(false);
  const [openTicket, setOpenTicket] = useState<Ticket | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const path = filter ? `/v1/tickets?status=${filter}` : "/v1/tickets";
      setTickets(await api.get<Ticket[]>(path));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const [cats, unitList] = await Promise.all([
          api.get<Category[]>("/v1/tickets/categories"),
          api.get<Unit[]>("/v1/society/units"),
        ]);
        setCategories(cats);
        setUnits(unitList);
      } catch {
        // Non-fatal: the list still renders, only the raise form is unavailable.
      }
    })();
  }, []);

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

    // Unresolved first, then by deadline. A resolved ticket has no deadline pressure, so
    // it must never sit above an open one however old it is.
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
      actions={
        <button data-variant="primary" onClick={() => setRaising(true)}>
          Raise a complaint
        </button>
      }
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
            {query || filter ? "No complaints match that." : "No complaints have been raised."}
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
                  <th />
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
                          <span className="sub">reopened ×{ticket.reopenCount}</span>
                        ) : null}
                      </td>
                      <td>
                        <span className="strong">{ticket.title}</span>
                        {ticket.description ? (
                          <span
                            className="sub"
                            style={{
                              maxWidth: "40ch",
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
                            done
                              ? "settled"
                              : ticket.status === "reopened"
                                ? "arrears"
                                : "pending"
                          }
                        >
                          {ticket.status.replace(/_/g, " ")}
                        </Chip>
                        {ticket.escalatedAt ? (
                          <span className="sub">escalated {shortDate(ticket.escalatedAt)}</span>
                        ) : null}
                      </td>
                      <td>
                        {done ? (
                          <span className="muted">resolved {timeAgo(ticket.resolvedAt)}</span>
                        ) : (
                          <Chip tone={sla.tone as "arrears" | "pending" | "settled"}>
                            {sla.label}
                          </Chip>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button data-size="sm" onClick={() => setOpenTicket(ticket)}>
                            Open
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {raising ? (
        <RaiseComplaint
          categories={categories}
          units={units}
          onClose={() => setRaising(false)}
          onDone={() => {
            setRaising(false);
            void load();
          }}
        />
      ) : null}

      {openTicket ? (
        <TicketThread
          ticket={openTicket}
          onClose={() => setOpenTicket(null)}
          onChanged={(updated) => {
            setOpenTicket(updated);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

/** Raising a complaint on someone's behalf — the committee taking a phone call. */
function RaiseComplaint({
  categories,
  units,
  onClose,
  onDone,
}: {
  categories: Category[];
  units: Unit[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [categoryId, setCategoryId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [locationType, setLocationType] = useState<string>("common");
  const [unitId, setUnitId] = useState("");
  const [priority, setPriority] = useState("normal");

  function submit() {
    void action.run(
      () =>
        api.post("/v1/tickets", {
          categoryId,
          title,
          ...(description ? { description } : {}),
          locationType,
          // A flat-specific complaint without a flat is a complaint nobody can route.
          ...(locationType === "unit" && unitId ? { unitId } : {}),
          priority,
        }),
      { onDone },
    );
  }

  return (
    <Modal
      title="Raise a complaint"
      note="The SLA clock starts the moment this is saved, and the category decides who it reaches."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || !categoryId || title.trim().length < 3}
            onClick={submit}
          >
            {action.busy ? "Saving…" : "Raise it"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={submit}>
        <Field
          label="Category"
          hint="Routing and the deadline both come from this, so it is not cosmetic."
          htmlFor="cat"
        >
          <select id="cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose a category…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="What is wrong" htmlFor="title">
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Light is not working in the lift"
            maxLength={200}
          />
        </Field>

        <Field label="Detail" hint="Optional. What a plumber or electrician would need to know.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={5000}
            placeholder="Tower B lift, ground floor. Has been out since Tuesday."
          />
        </Field>

        <div className="grid-2">
          <Field label="Where" htmlFor="loc">
            <select id="loc" value={locationType} onChange={(e) => setLocationType(e.target.value)}>
              {LOCATIONS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Priority" htmlFor="pri">
            <select id="pri" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {locationType === "unit" ? (
          <Field label="Flat" htmlFor="unit">
            <select id="unit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">Choose a flat…</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.number} · {u.towerName}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </Form>

      <Banner tone="info">
        Photos are attached from the resident&apos;s phone, which uploads them straight to
        storage — the bytes never pass through this console.
      </Banner>
    </Modal>
  );
}

/**
 * The thread.
 *
 * A complaint is a conversation, so it is laid out as one. Two things here are load
 * bearing rather than decorative: an **internal note** is tinted and marked so it can
 * never be mistaken for something the resident can see, and **resolving requires a
 * proof-of-fix photo** to already be attached — a "resolved" with no evidence is how a
 * lift stays broken for three weeks while the ticket says otherwise.
 */
function TicketThread({
  ticket,
  onClose,
  onChanged,
}: {
  ticket: Ticket;
  onClose: () => void;
  onChanged: (updated: Ticket) => void;
}) {
  const action = useAction();
  const [events, setEvents] = useState<TicketEvent[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [comment, setComment] = useState("");
  const [internal, setInternal] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [loading, setLoading] = useState(true);

  const staff = can("society_admin", "mc_member", "guard", "staff", "accountant");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [e, a] = await Promise.all([
        api.get<TicketEvent[]>(`/v1/tickets/${ticket.id}/events`),
        api.get<Attachment[]>(`/v1/tickets/${ticket.id}/attachments`),
      ]);
      setEvents(e);
      setAttachments(a);
    } finally {
      setLoading(false);
    }
  }, [ticket.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasProof = attachments.some((a) => a.isProofOfFix);
  const sla = slaRemaining(ticket.slaDueAt);

  function postComment() {
    if (comment.trim().length === 0) return;
    void action.run(
      () =>
        api.post(`/v1/tickets/${ticket.id}/comments`, {
          body: comment,
          ...(internal ? { internal: true } : {}),
        }),
      {
        onDone: async () => {
          setComment("");
          await load();
        },
      },
    );
  }

  function setStatus(status: string) {
    void action.run(
      async () => {
        const updated = await api.post<Ticket>(`/v1/tickets/${ticket.id}/status`, { status });
        onChanged(updated);
      },
      { onDone: load },
    );
  }

  function reopen() {
    if (reopenReason.trim().length < 3) return;
    void action.run(
      async () => {
        const updated = await api.post<Ticket>(`/v1/tickets/${ticket.id}/reopen`, {
          reason: reopenReason,
        });
        onChanged(updated);
      },
      {
        onDone: async () => {
          setReopenReason("");
          await load();
        },
      },
    );
  }

  return (
    <Modal
      title={`${ticket.ticketNumber} · ${ticket.title}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" onClick={onClose}>
            Close
          </button>
          {ticket.status !== "in_progress" && !ticket.resolvedAt ? (
            <button disabled={action.busy} onClick={() => setStatus("in_progress")}>
              Mark in progress
            </button>
          ) : null}
          {!ticket.resolvedAt ? (
            <button
              data-variant="primary"
              disabled={action.busy || !hasProof}
              title={
                hasProof
                  ? undefined
                  : "A proof-of-fix photo has to be attached before this can be resolved."
              }
              onClick={() => setStatus("resolved")}
            >
              Resolve
            </button>
          ) : (
            <button disabled={action.busy} onClick={() => setStatus("closed")}>
              Close the ticket
            </button>
          )}
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Status</dt>
        <dd>
          <Chip tone={ticket.resolvedAt ? "settled" : "pending"}>
            {ticket.status.replace(/_/g, " ")}
          </Chip>
        </dd>
        <dt>Deadline</dt>
        <dd>
          {ticket.resolvedAt ? (
            <span className="muted">resolved {timeAgo(ticket.resolvedAt)}</span>
          ) : (
            <Chip tone={sla.tone as "arrears" | "pending" | "settled"}>{sla.label}</Chip>
          )}
        </dd>
        <dt>Raised</dt>
        <dd className="muted">{shortDate(ticket.createdAt)}</dd>
        {ticket.description ? (
          <>
            <dt>Detail</dt>
            <dd>{ticket.description}</dd>
          </>
        ) : null}
      </dl>

      {!hasProof && !ticket.resolvedAt ? (
        <Banner tone="warn">
          No proof-of-fix photo yet. Resolving stays unavailable until whoever did the work
          attaches one — a resolution nobody can see is how a lift stays broken while the
          ticket says otherwise.
        </Banner>
      ) : null}

      {attachments.length > 0 ? (
        <div className="shots">
          {attachments.map((a) => (
            <a key={a.id} href={a.downloadUrl} target="_blank" rel="noreferrer">
              {a.kind === "photo" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.downloadUrl} alt={a.isProofOfFix ? "Proof of fix" : "Attachment"} />
              ) : (
                <span style={{ display: "block", padding: 12, fontSize: "0.8rem" }}>
                  {a.kind}
                </span>
              )}
            </a>
          ))}
        </div>
      ) : null}

      <h3 style={{ margin: "18px 0 10px", fontSize: "0.95rem" }}>History</h3>

      {loading ? (
        <Loading />
      ) : events.length === 0 ? (
        <p className="empty">Nothing has happened on this ticket yet.</p>
      ) : (
        <div className="thread">
          {events.map((event) => (
            <div
              key={event.id}
              className="thread-item"
              data-internal={event.visibility === "staff_only" ? "true" : "false"}
            >
              <div className="thread-meta">
                <span>{event.type.replace(/_/g, " ")}</span>
                <span>·</span>
                <span>{timeAgo(event.createdAt)}</span>
                {event.visibility === "staff_only" ? (
                  <Chip tone="pending">not visible to the resident</Chip>
                ) : null}
              </div>
              {event.body ? <p>{event.body}</p> : null}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <Field label="Add an update">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Electrician is booked for tomorrow morning."
            maxLength={5000}
            style={{ minHeight: 80 }}
          />
        </Field>
        {staff ? (
          <Check
            label="Internal note"
            hint="Visible to the committee and staff only. The resident never sees it."
            checked={internal}
            onChange={setInternal}
          />
        ) : null}
        <button
          data-variant="primary"
          disabled={action.busy || comment.trim().length === 0}
          onClick={postComment}
        >
          {action.busy ? "Posting…" : "Post update"}
        </button>
      </div>

      {ticket.resolvedAt ? (
        <div style={{ marginTop: 20, borderTop: "1px solid var(--rule)", paddingTop: 16 }}>
          <Field
            label="Reopen"
            hint="Within 7 days of resolution. The original ticket keeps its number and its history."
          >
            <input
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="The light went out again on Thursday."
              maxLength={1000}
            />
          </Field>
          <button
            data-variant="danger"
            disabled={action.busy || reopenReason.trim().length < 3}
            onClick={reopen}
          >
            Reopen this complaint
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
