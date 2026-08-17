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

interface DirectoryRow {
  personId: string;
  name: string | null;
  phone: string;
  role: string;
  validFrom: string;
}

/**
 * The eight roles, in the order they appear on a committee's own org chart.
 *
 * `society_admin` is listed last deliberately — it is the one that can grant roles, and
 * it should never be the option a finger lands on by accident.
 */
const ROLES = [
  "resident",
  "guard",
  "staff",
  "accountant",
  "auditor",
  "mc_member",
  "society_admin",
] as const;

const ROLE_MEANING: Record<string, string> = {
  resident: "Sees their own flat: approvals, dues, complaints.",
  guard: "Gate device. Records entries and attendance, sees no money.",
  staff: "Works on complaints assigned to them.",
  accountant: "Raises invoices, records receipts, reads the ledger.",
  auditor: "Reads everything financial. Changes nothing.",
  mc_member: "Committee. Runs the society day to day.",
  society_admin: "Everything, including granting roles. Keep this list short.",
};

/**
 * Who holds which role.
 *
 * Granting a role is restricted to a society admin — narrower than the rest of the
 * committee's powers, and deliberately so. Role assignment is precisely how someone would
 * escalate their own privileges, so a committee member cannot hand themselves the
 * accountant's authority over a weekend.
 *
 * Revoking does not delete anything: `validTo` is set, so an audit six months later can
 * still answer "who was the accountant in June?"
 */
export default function DirectoryPage() {
  const [rows, setRows] = useState<DirectoryRow[]>([]);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [granting, setGranting] = useState(false);

  const mayGrant = can("society_admin");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.get<DirectoryRow[]>("/v1/society/directory"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (roleFilter && row.role !== roleFilter) return false;
      if (!needle) return true;
      return (
        (row.name ?? "").toLowerCase().includes(needle) || row.phone.toLowerCase().includes(needle)
      );
    });
  }, [rows, query, roleFilter]);

  const counts = useMemo(() => {
    const byRole = new Map<string, number>();
    for (const row of rows) byRole.set(row.role, (byRole.get(row.role) ?? 0) + 1);
    return {
      people: new Set(rows.map((r) => r.personId)).size,
      admins: byRole.get("society_admin") ?? 0,
      committee: byRole.get("mc_member") ?? 0,
      guards: byRole.get("guard") ?? 0,
    };
  }, [rows]);

  return (
    <Shell
      title="Directory & Roles"
      lede="Everyone with access to this society, and what that access lets them do."
      actions={
        mayGrant ? (
          <button data-variant="primary" onClick={() => setGranting(true)}>
            Grant a role
          </button>
        ) : null
      }
    >
      {error ? <Problem error={error} /> : null}

      <dl className="figures settle">
        <Figure label="People" value={String(counts.people)} hint="with any access" />
        <Figure label="Committee" value={String(counts.committee)} />
        <Figure label="Guards" value={String(counts.guards)} />
        <Figure
          label="Admins"
          value={String(counts.admins)}
          hint="can grant roles"
          {...(counts.admins > 3 ? { tone: "arrears" as const } : {})}
        />
      </dl>

      {counts.admins > 3 ? (
        <Banner tone="warn">
          {counts.admins} people hold society admin. That role can grant every other role,
          including to themselves — most societies need two, and a third for when one is
          travelling.
        </Banner>
      ) : null}

      <section className="ledger settle">
        <div className="toolbar">
          <input
            placeholder="Find someone by name or number…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
            aria-label="Search the directory"
          />
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            aria-label="Filter by role"
          >
            <option value="">Every role</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <Loading />
        ) : visible.length === 0 ? (
          <p className="empty">
            {query || roleFilter ? "Nobody matches that." : "Nobody has been given access yet."}
          </p>
        ) : (
          <div className="ledger-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Role</th>
                  <th>What it allows</th>
                  <th>Since</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={`${row.personId}-${row.role}`}>
                    <td className="strong">{row.name ?? <span className="muted">unnamed</span>}</td>
                    <td className="num muted" style={{ textAlign: "left" }}>
                      {row.phone}
                    </td>
                    <td>
                      <Chip
                        tone={
                          row.role === "society_admin"
                            ? "arrears"
                            : row.role === "mc_member" || row.role === "accountant"
                              ? "brand"
                              : "quiet"
                        }
                      >
                        {row.role.replace(/_/g, " ")}
                      </Chip>
                    </td>
                    <td className="muted" style={{ maxWidth: "38ch" }}>
                      {ROLE_MEANING[row.role] ?? "—"}
                    </td>
                    <td className="muted">{shortDate(row.validFrom)}</td>
                    <td>
                      {mayGrant ? (
                        <div className="row-actions">
                          <RevokeButton row={row} onDone={load} />
                        </div>
                      ) : null}
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
          <h2>Why only an admin can do this</h2>
        </div>
        <div className="card-body">
          <p>
            Granting roles is the one action that can escalate someone&apos;s own
            privileges, so it sits with the society admin alone rather than with the wider
            committee. A committee member can run the society; they cannot quietly become
            the accountant.
          </p>
          <p>
            Revoking never deletes. The assignment is end-dated, so an audit can still
            answer <em>&quot;who held the books in June?&quot;</em> long after the
            committee has turned over.
          </p>
        </div>
      </section>

      {granting ? (
        <GrantRole
          onClose={() => setGranting(false)}
          onDone={() => {
            setGranting(false);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

function RevokeButton({ row, onDone }: { row: DirectoryRow; onDone: () => Promise<void> }) {
  const action = useAction();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button data-size="sm" onClick={() => setConfirming(true)}>
        Revoke
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
        onClick={() =>
          void action.run(
            () => api.del("/v1/society/roles", { personId: row.personId, roleCode: row.role }),
            { onDone },
          )
        }
      >
        {action.busy ? "…" : `Remove ${row.role.replace(/_/g, " ")}`}
      </button>
    </>
  );
}

function GrantRole({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const action = useAction();
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [roleCode, setRoleCode] = useState<string>("resident");

  const dangerous = roleCode === "society_admin";

  return (
    <Modal
      title="Grant a role"
      note="Identified by phone number. If they already have an account in another society, the same person is used."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            {...(dangerous ? { "data-variant": "danger" } : { "data-variant": "primary" })}
            disabled={action.busy || phone.trim().length < 6}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/society/roles", {
                    phone: phone.trim(),
                    ...(name.trim() ? { name: name.trim() } : {}),
                    roleCode,
                  }),
                { onDone },
              )
            }
          >
            {action.busy ? "Granting…" : dangerous ? "Grant admin" : "Grant role"}
          </button>
        </>
      }
    >
      {action.error ? <Banner tone="error">{action.error}</Banner> : null}

      <Form onSubmit={() => undefined}>
        <div className="grid-2">
          <Field label="Phone" htmlFor="gphone">
            <input
              id="gphone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={20}
              placeholder="+91 99000 00001"
            />
          </Field>

          <Field label="Name" htmlFor="gname" hint="Optional if they already have an account.">
            <input
              id="gname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
            />
          </Field>
        </div>

        <Field label="Role" htmlFor="grole" hint={ROLE_MEANING[roleCode]}>
          <select id="grole" value={roleCode} onChange={(e) => setRoleCode(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </Field>
      </Form>

      {dangerous ? (
        <Banner tone="error">
          A society admin can grant every role, including this one, to anyone — themselves
          included. Give it to the people who would still be accountable if it were misused.
        </Banner>
      ) : null}
    </Modal>
  );
}
