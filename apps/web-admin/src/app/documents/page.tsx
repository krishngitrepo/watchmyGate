"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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
  useAction,
} from "../../components/Shell";
import { api, can, shortDate } from "../../lib/api";

interface Doc {
  id: string;
  title: string;
  category: string;
  description: string | null;
  visibility: string;
  unitId: string | null;
  unitNumber: string | null;
  version: number;
  supersedesId: string | null;
  effectiveFrom: string | null;
  expiresOn: string | null;
  hasFile: boolean;
  contentType: string | null;
  bytes: number | null;
  createdAt: string;
  daysToExpiry: number | null;
  superseded: boolean;
}

interface Unit {
  id: string;
  number: string;
  towerName: string;
}

const CATEGORIES = [
  "bye_laws",
  "registration",
  "agm_minutes",
  "committee_minutes",
  "audited_accounts",
  "insurance",
  "amc_contract",
  "vendor_contract",
  "rental_agreement",
  "noc",
  "floor_plan",
  "other",
] as const;

/**
 * The document repository.
 *
 * Every society keeps the same shelf of paper — bye-laws, AGM minutes, audited accounts,
 * insurance, AMC contracts — and today it lives in one secretary's WhatsApp and leaves
 * with them when the committee turns over. That is the problem being solved, not storage.
 *
 * Two columns carry the design. **Who can see it**, because a repository that shows
 * everything to everyone gets used for bye-laws and nothing else; nobody files a vendor
 * contract with rates in it where four hundred people can read it. And **when it
 * expires**, because an insurance policy that lapsed in March is worse than no policy —
 * everyone believes there is cover.
 */
export default function Documents() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  const mayManage = can("society_admin", "mc_member");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, u] = await Promise.all([
        api.get<Doc[]>(category ? `/v1/documents?category=${category}` : "/v1/documents"),
        api.get<Unit[]>("/v1/society/units").catch(() => []),
      ]);
      setDocs(d);
      setUnits(u);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return docs;
    return docs.filter(
      (d) =>
        d.title.toLowerCase().includes(needle) ||
        d.category.toLowerCase().includes(needle) ||
        (d.description ?? "").toLowerCase().includes(needle),
    );
  }, [docs, query]);

  const lapsed = docs.filter((d) => d.daysToExpiry !== null && d.daysToExpiry < 0 && !d.superseded);
  const soon = docs.filter(
    (d) => d.daysToExpiry !== null && d.daysToExpiry >= 0 && d.daysToExpiry <= 60 && !d.superseded,
  );
  const missingFile = docs.filter((d) => !d.hasFile);

  return (
    <Shell
      title="Documents"
      lede="The society's papers, in one place that survives a change of committee."
      actions={
        mayManage ? (
          <button data-variant="primary" onClick={() => setAdding(true)}>
            Add a document
          </button>
        ) : null
      }
    >
      {error ? <Problem error={error} /> : null}

      {/* A lapsed policy is the one thing on this page that cannot wait, because the
          danger is not the gap — it is everyone believing there is cover. */}
      {lapsed.length > 0 ? (
        <Banner tone="error">
          <strong>
            {lapsed.length} document{lapsed.length === 1 ? " has" : "s have"} expired
          </strong>{" "}
          — {lapsed.map((d) => d.title).join(", ")}. Nothing has replaced them.
        </Banner>
      ) : null}

      <dl className="figures settle">
        <Figure label="Documents" value={String(docs.length)} hint="you can see" />
        <Figure
          label="Expiring soon"
          value={String(soon.length)}
          hint="within 60 days"
          {...(soon.length > 0 ? { tone: "arrears" as const } : {})}
        />
        <Figure
          label="Expired"
          value={String(lapsed.length)}
          hint="not replaced"
          {...(lapsed.length > 0 ? { tone: "arrears" as const } : {})}
        />
        <Figure
          label="Recorded, not scanned"
          value={String(missingFile.length)}
          hint="no file attached yet"
        />
      </dl>

      <section className="ledger settle">
        <div className="toolbar">
          <input
            placeholder="Find a document…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
            aria-label="Search documents"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Filter by category"
          >
            <option value="">Every category</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <Loading />
        ) : visible.length === 0 ? (
          <p className="empty">
            {query || category
              ? "Nothing matches that."
              : "No documents yet. Start with the bye-laws and the last AGM minutes — those are the two a new committee always needs."}
          </p>
        ) : (
          <div className="ledger-scroll">
            <table>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Category</th>
                  <th>Who can see it</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <span className="strong">{d.title}</span>
                      {d.superseded ? (
                        <span style={{ marginLeft: 8 }}>
                          {/* Kept findable, but marked — so nobody quotes last year's
                              bye-laws at a meeting. */}
                          <Chip tone="quiet">superseded</Chip>
                        </span>
                      ) : null}
                      {d.version > 1 ? <span className="sub">version {d.version}</span> : null}
                      {d.description ? <span className="sub">{d.description}</span> : null}
                    </td>
                    <td className="muted">{d.category.replace(/_/g, " ")}</td>
                    <td>
                      {d.visibility === "society" ? (
                        <Chip tone="quiet">everyone</Chip>
                      ) : d.visibility === "committee" ? (
                        <Chip tone="brand">committee only</Chip>
                      ) : (
                        <Chip tone="pending">{d.unitNumber ?? "one flat"}</Chip>
                      )}
                    </td>
                    <td>
                      {d.expiresOn === null ? (
                        <span className="muted">—</span>
                      ) : d.daysToExpiry !== null && d.daysToExpiry < 0 ? (
                        <Chip tone="arrears">expired {shortDate(d.expiresOn)}</Chip>
                      ) : d.daysToExpiry !== null && d.daysToExpiry <= 60 ? (
                        <Chip tone="pending">{d.daysToExpiry} days left</Chip>
                      ) : (
                        <span className="muted">{shortDate(d.expiresOn)}</span>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        {d.hasFile ? (
                          <OpenButton doc={d} />
                        ) : (
                          <Chip tone="quiet">no file</Chip>
                        )}
                        {mayManage ? <RemoveButton doc={d} onDone={load} /> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card settle">
        <div className="card-head">
          <h2>Why a document can be recorded without a file</h2>
        </div>
        <div className="card-body">
          <p>
            A committee that knows the 2019 AGM minutes exist somewhere is better off
            recording that than waiting until someone finds the scan. The row says plainly
            that no file is attached, and the count above shows how many are outstanding —
            which is usually the list a new secretary works down.
          </p>
          <p>
            Replacing a signed document creates a new version rather than overwriting the
            old one. An audited account that can be swapped out is not an audited account.
          </p>
        </div>
      </section>

      {adding ? (
        <AddDocument
          units={units}
          docs={docs}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

/**
 * Open the file.
 *
 * Fetches a freshly signed link rather than holding one in the list. Listing a document
 * is not the same act as opening it, and a permanent URL is one that leaks in a
 * forwarded message.
 */
function OpenButton({ doc }: { doc: Doc }) {
  const action = useAction();
  return (
    <button
      data-size="sm"
      disabled={action.busy}
      title={action.error || undefined}
      onClick={() =>
        void action.run(async () => {
          const { url } = await api.get<{ url: string }>(`/v1/documents/${doc.id}/link`);
          window.open(url, "_blank", "noopener");
        })
      }
    >
      {action.busy ? "…" : "Open"}
    </button>
  );
}

function RemoveButton({ doc, onDone }: { doc: Doc; onDone: () => Promise<void> }) {
  const action = useAction();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button data-size="sm" onClick={() => setConfirming(true)}>
        Remove
      </button>
    );
  }
  return (
    <>
      <button data-size="sm" onClick={() => setConfirming(false)}>
        Keep
      </button>
      <button
        data-size="sm"
        data-variant="danger"
        disabled={action.busy}
        title={action.error || undefined}
        onClick={() => void action.run(() => api.del(`/v1/documents/${doc.id}`), { onDone })}
      >
        {action.busy ? "…" : "Confirm"}
      </button>
    </>
  );
}

/**
 * Add a document, and optionally its file.
 *
 * The record is created first and the upload confirmed against it, so a failed upload
 * leaves a document marked "no file" rather than nothing at all — which is recoverable
 * by anyone, at any time, instead of needing the whole form typed again.
 */
function AddDocument({
  units,
  docs,
  onClose,
  onDone,
}: {
  units: Unit[];
  docs: Doc[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>("bye_laws");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("society");
  const [unitId, setUnitId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [supersedesId, setSupersedes] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const needsUnit = visibility === "unit";
  const ready = title.trim().length > 0 && (!needsUnit || Boolean(unitId));

  // Insurance and contracts almost always have one, so the field is nudged rather than
  // left for someone to remember.
  const expiryExpected = ["insurance", "amc_contract", "vendor_contract", "rental_agreement"].includes(
    category,
  );

  function submit() {
    void action.run(async () => {
      const { id } = await api.post<{ id: string }>("/v1/documents", {
        title: title.trim(),
        category,
        ...(description.trim() ? { description: description.trim() } : {}),
        visibility,
        ...(needsUnit ? { unitId } : {}),
        ...(effectiveFrom ? { effectiveFrom } : {}),
        ...(expiresOn ? { expiresOn } : {}),
        ...(supersedesId ? { supersedesId } : {}),
      });

      if (!file) return;

      const presigned = await api.post<{ objectKey: string; uploadUrl: string }>(
        `/v1/documents/${id}/upload`,
        { contentType: file.type || "application/octet-stream", contentLength: file.size },
      );

      // Straight to storage. The bytes never pass through the API.
      const put = await fetch(presigned.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!put.ok) {
        throw new Error(
          "The document was saved but the file did not upload. Attach it again from the list.",
        );
      }

      await api.post(`/v1/documents/${id}/attach`, {
        objectKey: presigned.objectKey,
        contentType: file.type || "application/octet-stream",
        contentLength: file.size,
      });
    }, { onDone });
  }

  return (
    <Modal
      title="Add a document"
      note="The file goes straight to storage from this browser — it never passes through the server."
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button data-variant="primary" disabled={action.busy || !ready} onClick={submit}>
            {action.busy ? "Saving…" : "Add document"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={submit}>
        <Field label="Title" htmlFor="dt">
          <input
            id="dt"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="Society bye-laws 2024"
          />
        </Field>

        <div className="grid-2">
          <Field label="Category" htmlFor="dc">
            <select id="dc" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Who can see it"
            htmlFor="dv"
            hint={
              visibility === "society"
                ? "Every resident."
                : visibility === "committee"
                  ? "Committee and admin only."
                  : "That flat's occupants, and the committee."
            }
          >
            <select id="dv" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="society">Everyone</option>
              <option value="committee">Committee only</option>
              <option value="unit">One flat</option>
            </select>
          </Field>

          {needsUnit ? (
            <Field label="Flat" htmlFor="du">
              <select id="du" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                <option value="">Choose a flat…</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.number} · {u.towerName}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <Field label="Effective from" htmlFor="def" hint="Optional.">
            <input
              id="def"
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </Field>

          <Field
            label="Expires on"
            htmlFor="dex"
            hint={
              expiryExpected
                ? "This category usually has one. A lapsed policy nobody noticed is the failure this catches."
                : "Optional."
            }
          >
            <input
              id="dex"
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Note" htmlFor="dd" hint="Optional. What this is, for whoever finds it in three years.">
          <input
            id="dd"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
          />
        </Field>

        {docs.length > 0 ? (
          <Field
            label="Replaces"
            htmlFor="ds"
            hint="Optional. The old version stays findable and is marked superseded."
          >
            <select id="ds" value={supersedesId} onChange={(e) => setSupersedes(e.target.value)}>
              <option value="">Nothing — this is new</option>
              {docs
                .filter((d) => !d.superseded)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
            </select>
          </Field>
        ) : null}

        <Field
          label="File"
          htmlFor="df"
          hint="Optional. A document can be recorded now and scanned later."
        >
          <input
            id="df"
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"
          />
        </Field>
      </Form>
    </Modal>
  );
}
