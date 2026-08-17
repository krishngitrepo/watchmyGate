"use client";

import { useCallback, useEffect, useState } from "react";

import {
  Bar,
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
import { api, can, shortDate, timeAgo } from "../../lib/api";

interface Notice {
  id: string;
  kind: string;
  title: string;
  body: string;
  audience: string;
  isPinned: boolean;
  publishAt: string;
  publishedAt: string | null;
  eventAt: string | null;
  eventPlace: string | null;
}

interface PollResult {
  optionId: string;
  label: string;
  votes: number;
}

const KINDS = ["circular", "event", "poll", "emergency"] as const;
const AUDIENCES = ["society", "tower", "owners", "tenants", "committee"] as const;

/**
 * Notices, events and polls.
 *
 * The column worth explaining on the page rather than only in the code is **Can SMS**.
 *
 * TRAI ties DND exemption to the category a template was *registered* under, not to how
 * urgent a committee feels a message is. An emergency is transactional and may reach a
 * number on the DND registry; a Diwali party is promotional and may not. The API refuses
 * the channel rather than silently dropping it, and this column is where a secretary
 * learns that before they write the circular — not after they wonder why half the society
 * never heard.
 */
const CHANNELS: Record<string, { sms: boolean; why: string }> = {
  emergency: { sms: true, why: "Transactional — may reach DND numbers." },
  circular: { sms: true, why: "Service message to existing members." },
  poll: { sms: true, why: "Service message to existing members." },
  event: { sms: false, why: "Promotional — push and email only, by law." },
};

export default function NoticesPage() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [viewing, setViewing] = useState<Notice | null>(null);

  const mayPublish = can("society_admin", "mc_member");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setNotices(await api.get<Notice[]>("/v1/notices"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const published = notices.filter((n) => n.publishedAt).length;
  const drafts = notices.length - published;

  return (
    <Shell
      title="Notices & Polls"
      lede="Circulars, events and polls. Which channels a notice may use is decided by law, not by preference."
      actions={
        mayPublish ? (
          <button data-variant="primary" onClick={() => setComposing(true)}>
            Write a notice
          </button>
        ) : null
      }
    >
      {error ? <Problem error={error} /> : null}

      <dl className="figures settle">
        <Figure label="Notices" value={String(notices.length)} hint="in the feed" />
        <Figure label="Published" value={String(published)} tone="settled" />
        <Figure
          label="Drafts"
          value={String(drafts)}
          hint={drafts > 0 ? "nobody can see these yet" : "nothing unsent"}
          {...(drafts > 0 ? { tone: "arrears" as const } : {})}
        />
        <Figure
          label="Polls"
          value={String(notices.filter((n) => n.kind === "poll").length)}
          hint="open to residents"
        />
      </dl>

      <section className="ledger settle">
        <div className="ledger-head">
          <h2>The feed</h2>
          <span className="note">what residents see, newest first</span>
        </div>

        {loading ? (
          <Loading />
        ) : notices.length === 0 ? (
          <p className="empty">No notices have been written yet.</p>
        ) : (
          <div className="ledger-scroll">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Kind</th>
                  <th>Audience</th>
                  <th>Published</th>
                  <th>Can SMS</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {notices.map((n) => {
                  const channel = CHANNELS[n.kind] ?? { sms: false, why: "Unknown category." };
                  return (
                    <tr key={n.id}>
                      <td>
                        <span className="strong">{n.title}</span>
                        {n.isPinned ? (
                          <span style={{ marginLeft: 8 }}>
                            <Chip tone="pending">pinned</Chip>
                          </span>
                        ) : null}
                        {n.eventAt ? (
                          <span className="sub">
                            {shortDate(n.eventAt)}
                            {n.eventPlace ? ` · ${n.eventPlace}` : ""}
                          </span>
                        ) : null}
                      </td>
                      <td className="muted">{n.kind}</td>
                      <td className="muted">{n.audience}</td>
                      <td className="muted">
                        {n.publishedAt ? timeAgo(n.publishedAt) : <Chip tone="quiet">draft</Chip>}
                      </td>
                      <td title={channel.why}>
                        {channel.sms ? (
                          <Chip tone="settled">yes</Chip>
                        ) : (
                          <Chip tone="arrears">no — promotional</Chip>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button data-size="sm" onClick={() => setViewing(n)}>
                            Open
                          </button>
                          {mayPublish && !n.publishedAt ? (
                            <PublishButton notice={n} onDone={load} />
                          ) : null}
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

      <section className="card settle">
        <div className="card-head">
          <h2>Why some notices cannot be texted</h2>
        </div>
        <div className="card-body">
          <p>
            Every commercial SMS in India needs a DLT-registered header and template, and
            the <strong>category it was registered under</strong> decides whether it may
            reach a number on the Do Not Disturb registry. That is a property of the
            template, not a setting we can flip.
          </p>
          <p>
            So a water-supply notice goes by SMS and a Diwali party does not. We refuse the
            channel rather than sending and hoping — a committee that believes residents
            were told is worse off than one told plainly that we cannot send.
          </p>
        </div>
      </section>

      {composing ? (
        <Compose
          onClose={() => setComposing(false)}
          onDone={() => {
            setComposing(false);
            void load();
          }}
        />
      ) : null}

      {viewing ? (
        <ViewNotice
          notice={viewing}
          canSee={mayPublish}
          onClose={() => setViewing(null)}
          onChanged={load}
        />
      ) : null}
    </Shell>
  );
}

function PublishButton({ notice, onDone }: { notice: Notice; onDone: () => Promise<void> }) {
  const action = useAction();
  return (
    <button
      data-size="sm"
      data-variant="primary"
      disabled={action.busy}
      title={action.error || undefined}
      onClick={() =>
        void action.run(() => api.post(`/v1/notices/${notice.id}/publish`, {}), { onDone })
      }
    >
      {action.busy ? "…" : "Publish"}
    </button>
  );
}

/**
 * Write a notice.
 *
 * Saving and publishing are separate steps on purpose. A circular about a maintenance
 * increase gets drafted, read by two other committee members, and *then* sent — and once
 * it is sent it has reached four hundred phones and cannot be recalled.
 */
function Compose({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const [kind, setKind] = useState<string>("circular");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<string>("society");
  const [isPinned, setIsPinned] = useState(false);
  const [eventAt, setEventAt] = useState("");
  const [eventPlace, setEventPlace] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);

  const isPoll = kind === "poll";
  const isEvent = kind === "event";
  const filledOptions = options.map((o) => o.trim()).filter(Boolean);
  const ready =
    title.trim().length > 0 && body.trim().length > 0 && (!isPoll || filledOptions.length >= 2);

  const channel = CHANNELS[kind] ?? { sms: false, why: "" };

  function submit() {
    void action.run(
      () =>
        api.post("/v1/notices", {
          kind,
          title: title.trim(),
          body: body.trim(),
          audience,
          isPinned,
          ...(isEvent && eventAt ? { eventAt: new Date(eventAt).toISOString() } : {}),
          ...(isEvent && eventPlace.trim() ? { eventPlace: eventPlace.trim() } : {}),
          ...(isPoll ? { options: filledOptions } : {}),
        }),
      { onDone },
    );
  }

  return (
    <Modal
      title="Write a notice"
      note="Saved as a draft. Nothing reaches a resident until you publish it."
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button data-variant="primary" disabled={action.busy || !ready} onClick={submit}>
            {action.busy ? "Saving…" : "Save as draft"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={submit}>
        <div className="grid-2">
          <Field label="Kind" htmlFor="nkind">
            <select id="nkind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Audience" htmlFor="naud">
            <select id="naud" value={audience} onChange={(e) => setAudience(e.target.value)}>
              {AUDIENCES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Banner tone={channel.sms ? "ok" : "warn"}>
          <strong>{channel.sms ? "SMS allowed." : "SMS not allowed."}</strong> {channel.why}
        </Banner>

        <Field label="Title" htmlFor="ntitle">
          <input
            id="ntitle"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="Water supply interrupted on Thursday"
          />
        </Field>

        <Field label="Notice" htmlFor="nbody">
          <textarea
            id="nbody"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={20000}
            style={{ minHeight: 150 }}
          />
        </Field>

        {isEvent ? (
          <div className="grid-2">
            <Field label="When" htmlFor="nwhen">
              <input
                id="nwhen"
                type="datetime-local"
                value={eventAt}
                onChange={(e) => setEventAt(e.target.value)}
              />
            </Field>
            <Field label="Where" htmlFor="nwhere">
              <input
                id="nwhere"
                value={eventPlace}
                onChange={(e) => setEventPlace(e.target.value)}
                maxLength={200}
                placeholder="Clubhouse"
              />
            </Field>
          </div>
        ) : null}

        {isPoll ? (
          <Field
            label="Options"
            hint="At least two. One person, one vote — enforced by the database, not by us checking."
          >
            {options.map((option, index) => (
              <input
                key={index}
                value={option}
                onChange={(e) => {
                  const next = [...options];
                  next[index] = e.target.value;
                  setOptions(next);
                }}
                maxLength={200}
                placeholder={`Option ${index + 1}`}
                style={{ marginBottom: 8 }}
              />
            ))}
            {options.length < 12 ? (
              <button type="button" data-size="sm" onClick={() => setOptions([...options, ""])}>
                Add an option
              </button>
            ) : null}
          </Field>
        ) : null}

        <Check
          label="Pin to the top of the feed"
          hint="Held above everything else until unpinned."
          checked={isPinned}
          onChange={setIsPinned}
        />
      </Form>
    </Modal>
  );
}

function ViewNotice({
  notice,
  canSee,
  onClose,
  onChanged,
}: {
  notice: Notice;
  canSee: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [results, setResults] = useState<PollResult[]>([]);
  const [readers, setReaders] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const work: Promise<unknown>[] = [];
        if (notice.kind === "poll") {
          work.push(
            api
              .get<PollResult[]>(`/v1/notices/${notice.id}/results`)
              .then((r) => setResults(r)),
          );
        }
        if (canSee) {
          work.push(
            api
              .get<{ readers: number }>(`/v1/notices/${notice.id}/reads`)
              .then((r) => setReaders(r.readers))
              // A missing read count must not blank the notice body.
              .catch(() => undefined),
          );
        }
        await Promise.all(work);
      } finally {
        setLoading(false);
      }
    })();
  }, [notice.id, notice.kind, canSee]);

  const totalVotes = results.reduce((sum, r) => sum + r.votes, 0);

  return (
    <Modal
      title={notice.title}
      note={`${notice.kind} · ${notice.audience}${
        notice.publishedAt ? ` · published ${timeAgo(notice.publishedAt)}` : " · draft"
      }`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" onClick={onClose}>
            Close
          </button>
          {canSee && !notice.publishedAt ? (
            <PublishButton
              notice={notice}
              onDone={async () => {
                await onChanged();
                onClose();
              }}
            />
          ) : null}
        </>
      }
    >
      {!notice.publishedAt ? (
        <Banner tone="warn">
          This is a draft. No resident can see it, and no message has gone out.
        </Banner>
      ) : null}

      <p style={{ whiteSpace: "pre-wrap", fontSize: "0.92rem", lineHeight: 1.62 }}>
        {notice.body}
      </p>

      {notice.kind === "poll" ? (
        <div className="card" style={{ marginTop: 18, marginBottom: 0 }}>
          <div className="card-head">
            <h2>Results</h2>
            <span className="note">
              {totalVotes} vote{totalVotes === 1 ? "" : "s"}
            </span>
          </div>
          {loading ? (
            <Loading />
          ) : results.length === 0 ? (
            <p className="empty">This poll has no options.</p>
          ) : (
            <div className="bars">
              {results.map((r) => (
                <Bar
                  key={r.optionId}
                  label={r.label}
                  value={r.votes}
                  max={Math.max(1, ...results.map((x) => x.votes))}
                  display={`${r.votes}${
                    totalVotes > 0 ? ` · ${Math.round((r.votes / totalVotes) * 100)}%` : ""
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {readers !== null ? (
        <Banner tone="info">
          {readers === 0
            ? "Nobody has opened this yet."
            : `${readers} resident${readers === 1 ? " has" : "s have"} opened it.`}{" "}
          A read count is not proof anyone acted on it, only that it was seen.
        </Banner>
      ) : null}
    </Modal>
  );
}
