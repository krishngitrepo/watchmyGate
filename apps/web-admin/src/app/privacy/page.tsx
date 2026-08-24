"use client";

import { useCallback, useEffect, useState } from "react";

import {
  Banner,
  Chip,
  Field,
  Figure,
  Form,
  Loading,
  Modal,
  Problem,
  Shell,
  Tabs,
  useAction,
} from "../../components/Shell";
import { api, can, download, shortDate, timeAgo } from "../../lib/api";

interface Standing {
  purpose: string;
  granted: boolean;
  decidedAt: string | null;
  withdrawnAt: string | null;
  consentId: string | null;
  noticeVersion: string | null;
  essential: boolean;
}

interface Notice {
  id: string;
  purpose: string;
  version: string;
  language: string;
  body: string;
  bodyHash: string;
  effectiveFrom: string;
  retiredAt: string | null;
}

interface Retention {
  subject: string;
  days: number;
  defaultDays: number;
  isDefault: boolean;
  why: string;
  reason: string | null;
  updatedAt: string | null;
}

interface RetentionRun {
  id: string;
  subject: string;
  cutoff: string;
  rowsRemoved: number;
  ranAt: string;
}

interface Erasure {
  id: string;
  personId: string;
  requestedAt: string;
  status: string;
  dueBy: string;
  completedAt: string | null;
  retained: Record<string, string> | null;
  retentionBasis: string | null;
}

interface CctvAccess {
  id: string;
  personId: string;
  cameraRef: string;
  fromTs: string;
  toTs: string;
  reason: string;
  accessedAt: string;
}

type Tab = "consents" | "retention" | "erasure" | "cctv" | "notices";

/**
 * Privacy.
 *
 * The DPDP Act 2023 becomes fully enforceable on **13 May 2027**, with penalties to
 * ₹250 crore. This page is where a society demonstrates it complies rather than claims
 * it — which is why almost everything here is a record of something that happened, not a
 * setting.
 *
 * Two things are deliberately uncomfortable. **Withdrawing a consent takes one click**,
 * with no confirmation, because section 6(6) requires withdrawal to be as easy as giving
 * it and a confirmation dialogue is friction added on purpose. And **the CCTV log is
 * visible to the whole committee**, because the usual failure with footage is not a
 * breach — it is a committee member idly watching who visits whom, and the only thing
 * that reliably stops that is other people being able to see them doing it.
 */
export default function Privacy() {
  const [tab, setTab] = useState<Tab>("consents");
  const [standing, setStanding] = useState<Standing[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [retention, setRetention] = useState<Retention[]>([]);
  const [runs, setRuns] = useState<RetentionRun[]>([]);
  const [erasures, setErasures] = useState<Erasure[]>([]);
  const [cctv, setCctv] = useState<CctvAccess[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [editing, setEditing] = useState<Retention | null>(null);

  const isAdmin = can("society_admin");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, n, r, ru, e, c] = await Promise.all([
        api.get<Standing[]>("/v1/privacy/consents"),
        api.get<Notice[]>("/v1/privacy/notices"),
        api.get<Retention[]>("/v1/privacy/retention").catch(() => []),
        api.get<RetentionRun[]>("/v1/privacy/retention/runs").catch(() => []),
        api.get<Erasure[]>("/v1/privacy/erasure").catch(() => []),
        api.get<CctvAccess[]>("/v1/privacy/cctv/access").catch(() => []),
      ]);
      setStanding(s);
      setNotices(n);
      setRetention(r);
      setRuns(ru);
      setErasures(e);
      setCctv(c);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const overdue = erasures.filter(
    (e) => !e.completedAt && new Date(e.dueBy).getTime() < Date.now(),
  ).length;
  const openErasures = erasures.filter((e) => !e.completedAt).length;

  return (
    <Shell
      title="Privacy"
      lede="Consent, retention and erasure. What this society holds, for how long, and who has looked at it."
      actions={<ExportSelfButton />}
    >
      {error ? <Problem error={error} /> : null}

      {/* An erasure past its stated deadline is a breach of a statutory duty, not a
          backlog item, so it is the loudest thing on the page. */}
      {overdue > 0 ? (
        <Banner tone="error">
          <strong>
            {overdue} erasure request{overdue === 1 ? " is" : "s are"} past the 30-day
            deadline.
          </strong>{" "}
          The Act sets this period; missing it is the breach, not the request.
        </Banner>
      ) : null}

      <dl className="figures settle">
        <Figure
          label="Consents held"
          value={String(standing.filter((s) => s.granted).length)}
          hint={`of ${standing.length} purposes`}
        />
        <Figure
          label="Erasure requests"
          value={String(openErasures)}
          hint={overdue > 0 ? `${overdue} overdue` : "all within deadline"}
          {...(overdue > 0 ? { tone: "arrears" as const } : {})}
        />
        <Figure
          label="Gate records kept"
          value={`${retention.find((r) => r.subject === "gate_events")?.days ?? 180} days`}
          hint="then the visitor's identity is stripped"
        />
        <Figure
          label="Footage views"
          value={String(cctv.length)}
          hint="each with a stated reason"
        />
        <Figure
          label="Compliance due"
          value="13 May 2027"
          hint="DPDP, penalties to ₹250 cr"
        />
      </dl>

      <section className="ledger settle">
        <Tabs
          tabs={[
            { id: "consents" as const, label: "Your consents" },
            { id: "retention" as const, label: "Retention" },
            { id: "erasure" as const, label: `Erasure (${openErasures})` },
            { id: "cctv" as const, label: "Who watched footage" },
            { id: "notices" as const, label: "Notice text" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {loading ? <Loading /> : null}

        {!loading && tab === "consents" ? (
          <div className="ledger-scroll">
            <table>
              <thead>
                <tr>
                  <th>Purpose</th>
                  <th>Standing</th>
                  <th>Decided</th>
                  <th>Notice</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {standing.map((s) => (
                  <tr key={s.purpose}>
                    <td>
                      <span className="strong">{s.purpose.replace(/_/g, " ")}</span>
                      {s.essential ? (
                        <span className="sub">
                          the gate cannot record your visitors without this
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {s.granted ? (
                        <Chip tone="settled">given</Chip>
                      ) : s.withdrawnAt ? (
                        <Chip tone="arrears">withdrawn</Chip>
                      ) : (
                        <Chip tone="quiet">never asked</Chip>
                      )}
                    </td>
                    <td className="muted">
                      {s.decidedAt ? shortDate(s.decidedAt) : "—"}
                    </td>
                    <td className="num muted" style={{ textAlign: "left" }}>
                      {s.noticeVersion ?? "—"}
                    </td>
                    <td>
                      <div className="row-actions">
                        {s.granted && s.consentId ? (
                          <WithdrawButton consentId={s.consentId} onDone={load} />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {!loading && tab === "retention" ? (
          <>
            <div className="ledger-scroll">
              <table>
                <thead>
                  <tr>
                    <th>What</th>
                    <th style={{ textAlign: "right" }}>Kept for</th>
                    <th>Why</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {retention.map((r) => (
                    <tr key={r.subject}>
                      <td className="strong">{r.subject.replace(/_/g, " ")}</td>
                      <td className="num">
                        {r.days} d
                        {!r.isDefault ? (
                          <span className="sub">default {r.defaultDays}</span>
                        ) : null}
                      </td>
                      <td className="muted" style={{ maxWidth: "52ch" }}>
                        {r.why}
                        {r.reason ? (
                          <span className="sub">Changed because: {r.reason}</span>
                        ) : null}
                      </td>
                      <td>
                        {isAdmin ? (
                          <div className="row-actions">
                            <button data-size="sm" onClick={() => setEditing(r)}>
                              Change
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card-body" style={{ borderTop: "1px solid var(--rule)" }}>
              <p>
                <strong>Purges that have actually run.</strong> A retention policy nobody
                runs is a lie with a number in it, so every run is recorded whether or not
                it removed anything.
              </p>
              {isAdmin ? <PurgeButton onDone={load} /> : null}
            </div>

            {runs.length > 0 ? (
              <div className="ledger-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>What</th>
                      <th>Cutoff</th>
                      <th style={{ textAlign: "right" }}>Rows cleared</th>
                      <th>Ran</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.slice(0, 20).map((r) => (
                      <tr key={r.id}>
                        <td className="muted">{r.subject.replace(/_/g, " ")}</td>
                        <td className="muted">{shortDate(r.cutoff)}</td>
                        <td className="num">{r.rowsRemoved}</td>
                        <td className="muted">{timeAgo(r.ranAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : null}

        {!loading && tab === "erasure" ? (
          erasures.length === 0 ? (
            <p className="empty">Nobody has asked to be erased.</p>
          ) : (
            <div className="ledger-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Requested</th>
                    <th>Status</th>
                    <th>Due</th>
                    <th>What was kept</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {erasures.map((e) => {
                    const late = !e.completedAt && new Date(e.dueBy).getTime() < Date.now();
                    return (
                      <tr key={e.id}>
                        <td className="muted">{shortDate(e.requestedAt)}</td>
                        <td>
                          <Chip
                            tone={
                              e.status === "completed"
                                ? "settled"
                                : late
                                  ? "arrears"
                                  : "pending"
                            }
                          >
                            {e.status}
                          </Chip>
                        </td>
                        <td>
                          {late ? (
                            <Chip tone="arrears">overdue</Chip>
                          ) : (
                            <span className="muted">{shortDate(e.dueBy)}</span>
                          )}
                        </td>
                        <td className="muted" style={{ maxWidth: "46ch" }}>
                          {e.retained
                            ? Object.keys(e.retained).join(", ").replace(/([A-Z])/g, " $1")
                            : "—"}
                          {e.retentionBasis ? (
                            <span className="sub">{e.retentionBasis}</span>
                          ) : null}
                        </td>
                        <td>
                          {!e.completedAt && can("society_admin", "mc_member") ? (
                            <div className="row-actions">
                              <CompleteErasureButton request={e} onDone={load} />
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : null}

        {!loading && tab === "cctv" ? (
          cctv.length === 0 ? (
            <p className="empty">Nobody has viewed footage.</p>
          ) : (
            <div className="ledger-scroll">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Camera</th>
                    <th>Window viewed</th>
                    <th>Reason given</th>
                  </tr>
                </thead>
                <tbody>
                  {cctv.map((a) => (
                    <tr key={a.id}>
                      <td className="muted">{timeAgo(a.accessedAt)}</td>
                      <td className="strong">{a.cameraRef}</td>
                      <td className="muted">
                        {shortDate(a.fromTs)}
                        <span className="sub">
                          {new Date(a.fromTs).toLocaleTimeString("en-IN")} –{" "}
                          {new Date(a.toTs).toLocaleTimeString("en-IN")}
                        </span>
                      </td>
                      <td style={{ maxWidth: "48ch" }}>{a.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}

        {!loading && tab === "notices" ? (
          <>
            {can("society_admin", "mc_member") ? (
              <div className="toolbar">
                <button data-variant="primary" onClick={() => setPublishing(true)}>
                  Publish a notice
                </button>
                <span className="note">
                  Text is immutable once published. Correcting it means a new version.
                </span>
              </div>
            ) : null}
            {notices.length === 0 ? (
              <p className="empty">
                No notice text published. Until there is, no consent can be collected —
                agreeing to words nobody can produce later is agreeing to nothing.
              </p>
            ) : (
              <div className="ledger-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Purpose</th>
                      <th>Version</th>
                      <th>Language</th>
                      <th>Text</th>
                      <th>From</th>
                    </tr>
                  </thead>
                  <tbody>
                    {notices.map((n) => (
                      <tr key={n.id}>
                        <td className="strong">{n.purpose.replace(/_/g, " ")}</td>
                        <td className="num" style={{ textAlign: "left" }}>
                          {n.version}
                        </td>
                        <td className="muted">{n.language}</td>
                        <td style={{ maxWidth: "52ch" }}>
                          {n.body}
                          {/* The hash is what ties a consent record to these exact
                              words, so it is shown rather than hidden. */}
                          <span className="sub">{n.bodyHash.slice(0, 16)}…</span>
                        </td>
                        <td className="muted">{shortDate(n.effectiveFrom)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </section>

      <section className="card settle">
        <div className="card-head">
          <h2>What this product will never do</h2>
        </div>
        <div className="card-body">
          <p>
            Store an Aadhaar number — section 57 was struck down, so only a verification
            outcome and a masked last four digits are kept. Sell or share resident data
            with advertisers. Use gate records to profile domestic staff or delivery
            workers, who are the people least able to object.
          </p>
          <p>
            Erasure never erases the books. A society must keep its accounts and a
            resident cannot erase an invoice they owe, so the response says exactly what
            was kept and under which exemption — an unqualified &quot;done&quot; would be
            a lie.
          </p>
        </div>
      </section>

      {publishing ? (
        <PublishNotice
          onClose={() => setPublishing(false)}
          onDone={() => {
            setPublishing(false);
            void load();
          }}
        />
      ) : null}

      {editing ? (
        <EditRetention
          policy={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

/**
 * Withdraw.
 *
 * One click, no confirmation dialogue. Section 6(6) requires withdrawal to be as easy as
 * giving consent, and "are you sure?" is friction added deliberately — which is the thing
 * the section exists to prevent.
 */
function WithdrawButton({
  consentId,
  onDone,
}: {
  consentId: string;
  onDone: () => Promise<void>;
}) {
  const action = useAction();
  return (
    <button
      data-size="sm"
      disabled={action.busy}
      title={action.error || undefined}
      onClick={() =>
        void action.run(() => api.del(`/v1/privacy/consents/${consentId}`), { onDone })
      }
    >
      {action.busy ? "…" : "Withdraw"}
    </button>
  );
}

function ExportSelfButton() {
  const action = useAction();
  return (
    <button
      disabled={action.busy}
      title={action.error || undefined}
      onClick={() =>
        void action.run(async () => {
          const data = await api.get<unknown>("/v1/privacy/export");
          await download(
            "/v1/privacy/export",
            `my-data-${new Date().toISOString().slice(0, 10)}.json`,
          ).catch(() => {
            // The API returns JSON rather than a file, so fall back to saving what was
            // already fetched instead of failing in front of someone exercising a right.
            const blob = new Blob([JSON.stringify(data, null, 2)], {
              type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `my-data-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            URL.revokeObjectURL(url);
          });
        })
      }
    >
      {action.busy ? "Preparing…" : "Download my data"}
    </button>
  );
}

function PurgeButton({ onDone }: { onDone: () => Promise<void> }) {
  const action = useAction();
  return (
    <>
      <button
        disabled={action.busy}
        onClick={() =>
          void action.run(() => api.post("/v1/privacy/retention/purge", {}), {
            success: "Purge complete.",
            onDone,
          })
        }
      >
        {action.busy ? "Purging…" : "Run the purge now"}
      </button>
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}
      {action.done ? <Banner tone="ok">{action.done}</Banner> : null}
    </>
  );
}

function CompleteErasureButton({
  request,
  onDone,
}: {
  request: Erasure;
  onDone: () => Promise<void>;
}) {
  const action = useAction();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button data-size="sm" onClick={() => setConfirming(true)}>
        Carry out
      </button>
    );
  }

  return (
    <>
      <button data-size="sm" onClick={() => setConfirming(false)}>
        Cancel
      </button>
      <button
        data-size="sm"
        data-variant="danger"
        disabled={action.busy}
        title={action.error || "Contact details go. The books stay."}
        onClick={() =>
          void action.run(
            () => api.post(`/v1/privacy/erasure/${request.id}/complete`, {}),
            { onDone },
          )
        }
      >
        {action.busy ? "…" : "Erase"}
      </button>
    </>
  );
}

function PublishNotice({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const [purpose, setPurpose] = useState("gate_photos");
  const [version, setVersion] = useState("");
  const [language, setLanguage] = useState("en");
  const [body, setBody] = useState("");

  const ready = version.trim().length > 0 && body.trim().length >= 20;

  return (
    <Modal
      title="Publish notice text"
      note="The exact words a resident agrees to. Immutable once saved."
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || !ready}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/privacy/notices", {
                    purpose,
                    version: version.trim(),
                    language,
                    body: body.trim(),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Publishing…" : "Publish"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={() => undefined}>
        <div className="grid-2">
          <Field label="Purpose" htmlFor="np">
            <select id="np" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {[
                "gate_photos",
                "visitor_records",
                "staff_biometrics",
                "community_directory",
                "marketing",
                "cctv",
              ].map((p) => (
                <option key={p} value={p}>
                  {p.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Version" htmlFor="nv" hint="e.g. v1. A correction is a new version.">
            <input
              id="nv"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              maxLength={32}
              placeholder="v1"
            />
          </Field>

          <Field
            label="Language"
            htmlFor="nl"
            hint="DPDP entitles a person to notice in English or any Eighth Schedule language."
          >
            <select id="nl" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {["en", "hi", "kn", "ta", "te", "mr", "bn", "ml"].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label="Notice"
          htmlFor="nb"
          hint="What is collected, why, and for how long. Plain words — this is read by residents, not lawyers."
        >
          <textarea
            id="nb"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={20000}
            style={{ minHeight: 150 }}
            placeholder="We photograph visitors at the gate and keep the photograph for six months, so you can confirm who called at your flat."
          />
        </Field>
      </Form>

      <Banner tone="info">
        Once saved these words cannot be changed — the database refuses. That is what makes
        &quot;they agreed to v1&quot; something anyone can check later.
      </Banner>
    </Modal>
  );
}

function EditRetention({
  policy,
  onClose,
  onDone,
}: {
  policy: Retention;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [days, setDays] = useState(String(policy.days));
  const [reason, setReason] = useState(policy.reason ?? "");

  const value = Number(days);
  const longer = value > policy.defaultDays;
  const ready = Number.isInteger(value) && value >= 1 && (!longer || reason.trim().length > 0);

  return (
    <Modal
      title={`Keep ${policy.subject.replace(/_/g, " ")} for how long?`}
      note={policy.why}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            data-variant="primary"
            disabled={action.busy || !ready}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/privacy/retention", {
                    subject: policy.subject,
                    days: value,
                    ...(reason.trim() ? { reason: reason.trim() } : {}),
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Field label="Days" htmlFor="rd" hint={`The default is ${policy.defaultDays}.`}>
        <input
          id="rd"
          type="number"
          min={1}
          max={3650}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
      </Field>

      {longer ? (
        <>
          <Banner tone="warn">
            Longer than the default. Storage limitation is a principle of the Act, not a
            preference — &quot;we might need it&quot; is not a purpose.
          </Banner>
          <Field label="Purpose for keeping it longer" htmlFor="rr">
            <textarea
              id="rr"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              style={{ minHeight: 70 }}
              placeholder="Ongoing police investigation into the December break-in, ref XYZ."
            />
          </Field>
        </>
      ) : null}
    </Modal>
  );
}
