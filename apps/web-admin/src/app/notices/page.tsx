"use client";

import { useEffect, useState } from "react";

import { Chip, Figure, Ledger, Loading, Problem, Shell } from "../../components/Shell";
import { api, shortDate, timeAgo } from "../../lib/api";

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
}

/**
 * Notices, events and polls.
 *
 * The column worth explaining on the page rather than only in the code is **Can SMS**.
 *
 * TRAI ties DND exemption to the category a template was *registered* under, not to how
 * urgent a committee feels a message is. An emergency is transactional and may reach a
 * number on the DND registry; a Diwali party is promotional and may not. The API refuses
 * the channel rather than silently dropping it, and this column is where a secretary
 * learns that before they write the circular — not after they wonder why half the
 * society never heard.
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

  useEffect(() => {
    void (async () => {
      try {
        setNotices(await api.get<Notice[]>("/v1/notices"));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const published = notices.filter((n) => n.publishedAt).length;
  const polls = notices.filter((n) => n.kind === "poll").length;

  return (
    <Shell
      title="Notices & Polls"
      lede="Circulars, events and polls. Which channels a notice may use is decided by law, not by preference."
    >
      {error ? <Problem error={error} /> : null}

      <dl className="figures settle">
        <Figure label="Notices" value={String(notices.length)} hint="in the feed" />
        <Figure label="Published" value={String(published)} tone="settled" />
        <Figure label="Polls" value={String(polls)} hint="open to residents" />
        <Figure
          label="Pinned"
          value={String(notices.filter((n) => n.isPinned).length)}
          hint="held at the top"
        />
      </dl>

      <Ledger
        title="The feed"
        note="what residents see, newest first"
        head={["Title", "Kind", "Audience", "Published", "Can SMS"]}
        empty="No notices have been published yet."
        isEmpty={!loading && notices.length === 0}
      >
        {notices.map((n) => {
          const channel = CHANNELS[n.kind] ?? { sms: false, why: "Unknown category." };
          return (
            <tr key={n.id}>
              <td>
                <span style={{ fontWeight: 500 }}>{n.title}</span>
                {n.isPinned ? (
                  <span style={{ marginLeft: 8 }}>
                    <Chip tone="pending">pinned</Chip>
                  </span>
                ) : null}
                {n.eventAt ? (
                  <span className="muted" style={{ display: "block", fontSize: "0.8rem" }}>
                    {shortDate(n.eventAt)}
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
            </tr>
          );
        })}
      </Ledger>

      {loading ? <Loading /> : null}

      <section className="ledger settle">
        <div className="ledger-head">
          <h2>Why some notices cannot be texted</h2>
        </div>
        <div style={{ padding: "14px 16px", fontSize: "0.88rem", color: "var(--ink-soft)" }}>
          <p style={{ marginTop: 0 }}>
            Every commercial SMS in India needs a DLT-registered header and template, and
            the <strong>category it was registered under</strong> decides whether it may
            reach a number on the Do Not Disturb registry. That is a property of the
            template, not a setting we can flip.
          </p>
          <p style={{ marginBottom: 0 }}>
            So a water-supply notice goes by SMS and a Diwali party does not. We refuse the
            channel rather than sending and hoping — a committee that believes residents
            were told is worse off than one told plainly that we cannot send.
          </p>
        </div>
      </section>
    </Shell>
  );
}
