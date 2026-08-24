"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { ApiError, can, session } from "../lib/api";

/**
 * Where you can go, grouped by the question being asked.
 *
 * Thirteen destinations is past what anyone scans as a flat list, so they are grouped —
 * money, community, the gate, people, setup — in the order a committee thinks about
 * them. `roles` hides a section from someone who could not use it anyway: an auditor has
 * no business seeing an Import link that would refuse them.
 */
const SECTIONS: {
  group: string;
  roles?: string[];
  pages: { href: string; label: string }[];
}[] = [
  {
    group: "Overview",
    pages: [
      { href: "/dashboard/", label: "Today" },
      { href: "/reports/", label: "Reports" },
    ],
  },
  {
    group: "Money",
    roles: ["society_admin", "mc_member", "accountant", "auditor"],
    pages: [
      { href: "/billing/", label: "Dues & Billing" },
      { href: "/payments/", label: "Payments" },
      { href: "/books/", label: "The Books" },
    ],
  },
  {
    group: "Community",
    pages: [
      { href: "/complaints/", label: "Complaints" },
      { href: "/notices/", label: "Notices & Polls" },
      { href: "/amenities/", label: "Amenities" },
    ],
  },
  {
    group: "The gate",
    pages: [
      { href: "/gate/", label: "Gate Log" },
      { href: "/operations/", label: "Operations" },
      { href: "/parking/", label: "Parking" },
    ],
  },
  {
    group: "People",
    pages: [
      { href: "/units/", label: "Flats & Residents" },
      { href: "/directory/", label: "Directory & Roles" },
      { href: "/staff/", label: "Staff" },
    ],
  },
  {
    group: "Setup",
    roles: ["society_admin"],
    pages: [{ href: "/migration/", label: "Import Data" }],
  },
];

/**
 * The console frame.
 *
 * Guards the whole authenticated area in one place: a page that renders inside Shell
 * cannot be reached without a session, so no individual page has to remember to check.
 * Forgetting that check on one page out of fourteen is exactly the kind of gap that ships.
 */
export function Shell({
  title,
  lede,
  actions,
  children,
}: {
  title: string;
  lede?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // sessionStorage is unavailable during the static export's prerender, so the check
    // has to happen after mount rather than during render.
    if (!session.isSignedIn()) {
      router.replace("/login/");
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) {
    return (
      <div className="gate">
        <p className="muted">Opening the register…</p>
      </div>
    );
  }

  const roles = session.roles();

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-mark">
          <span className="society">{session.societyName()}</span>
          <span className="product">
            Watch<em>My</em>Gate
          </span>
        </div>

        <nav>
          {SECTIONS.filter(
            (section) => !section.roles || can(...section.roles),
          ).map((section) => (
            <div key={section.group}>
              <div className="rail-group">{section.group}</div>
              {section.pages.map((page) => (
                <Link
                  key={page.href}
                  href={page.href}
                  data-active={pathname === page.href ? "true" : "false"}
                >
                  {page.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div className="rail-foot">
          <p className="rail-who">
            Signed in as{" "}
            {roles.length > 0 ? roles.join(", ").replace(/_/g, " ") : "a resident"}
          </p>
          <button
            type="button"
            onClick={() => {
              session.clear();
              router.replace("/login/");
            }}
            style={{ width: "100%" }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="page-head settle">
          <div>
            <h1>{title}</h1>
            {lede ? <p>{lede}</p> : null}
          </div>
          {actions ? <div>{actions}</div> : null}
        </header>
        {children}
      </main>
    </div>
  );
}

/**
 * A framed table.
 *
 * Every list in this console is the same object: a titled card with a note and rows.
 * Making that one component means an empty state is never forgotten — the commonest
 * omission in an admin UI, and the one a new society sees first.
 */
export function Ledger({
  title,
  note,
  head,
  children,
  empty,
  isEmpty,
  actions,
}: {
  title: string;
  note?: string;
  head: string[];
  children: ReactNode;
  empty: string;
  isEmpty: boolean;
  actions?: ReactNode;
}) {
  return (
    <section className="ledger settle">
      <div className="ledger-head">
        <div>
          <h2>{title}</h2>
        </div>
        <div>
          {note ? <span className="note">{note}</span> : null}
          {actions}
        </div>
      </div>

      {isEmpty ? (
        <p className="empty">{empty}</p>
      ) : (
        <div className="ledger-scroll">
          <table>
            <thead>
              <tr>
                {head.map((column, index) => (
                  <th
                    // Columns can repeat a label (two "Actions"), so the index is part of
                    // the key rather than the label alone.
                    key={`${column}-${index}`}
                    // A leading ~ marks a numeric column: right-aligned so figures line
                    // up down the column and can be compared by eye.
                    style={column.startsWith("~") ? { textAlign: "right" } : undefined}
                  >
                    {column.replace(/^~/, "")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{children}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A plain titled card, for content that is not a table. */
export function Card({
  title,
  note,
  actions,
  children,
}: {
  title: string;
  note?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card settle">
      <div className="card-head">
        <h2>{title}</h2>
        <div>
          {note ? <span className="note">{note}</span> : null}
          {actions}
        </div>
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

/** A single headline figure. */
export function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "arrears" | "settled";
}) {
  return (
    <div className="figure" {...(tone ? { "data-tone": tone } : {})}>
      <dt>{label}</dt>
      <dd>
        {value}
        {hint ? <small>{hint}</small> : null}
      </dd>
    </div>
  );
}

export function Chip({
  tone,
  children,
}: {
  tone: "arrears" | "settled" | "pending" | "quiet" | "brand";
  children: ReactNode;
}) {
  return (
    <span className="chip" data-tone={tone}>
      {children}
    </span>
  );
}

/** Consistent loading and error handling, so no page invents its own. */
export function Loading() {
  return <p className="empty">Loading…</p>;
}

export function Problem({ error }: { error: string }) {
  return (
    <div className="notice" data-tone="error">
      {error}
    </div>
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: "error" | "ok" | "warn" | "info";
  children: ReactNode;
}) {
  return (
    <div className="notice" data-tone={tone}>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------- forms

/** A labelled control with optional help text. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label {...(htmlFor ? { htmlFor } : {})}>{label}</label>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Check({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint ? <span className="hint">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * A modal.
 *
 * Escape closes it and focus is trapped nowhere clever — the forms inside are short, and
 * a half-built focus trap is worse for a screen-reader user than none. Clicking the
 * backdrop does **not** close it: every modal here holds a form someone has typed into,
 * and losing that to a stray click is the kind of small betrayal that makes a treasurer
 * stop trusting the software with anything longer than one field.
 */
export function Modal({
  title,
  note,
  onClose,
  footer,
  wide,
  children,
}: {
  title: string;
  note?: string;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal" {...(wide ? { "data-width": "wide" } : {})}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {note ? <p>{note}</p> : null}
          </div>
          <button type="button" onClick={onClose} data-size="sm" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          data-active={tab.id === active ? "true" : "false"}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A horizontal bar.
 *
 * Hand-drawn rather than pulled from a charting library: every figure on a committee
 * report has to be readable as a number as well as a shape, so the value is always
 * printed beside the bar. A 60 KB bundle to draw eight rectangles is a poor trade on a
 * society's connection.
 */
export function Bar({
  label,
  value,
  max,
  display,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  display: string;
  tone?: "arrears" | "settled" | "gold";
}) {
  /*
   * Zero draws nothing. The `Math.max(1, …)` floor keeps a tiny-but-real value visible,
   * but applying it to an actual zero paints a stub that reads as "a small amount" —
   * which on an arrears chart is the difference between "nobody is 90 days late" and
   * "somebody is".
   */
  const pct = value <= 0 || max <= 0 ? 0 : Math.max(1, Math.round((value / max) * 100));
  return (
    <div className="bar-row">
      <span className="bar-label" title={label}>
        {label}
      </span>
      <span className="bar-track">
        <span
          className="bar-fill"
          style={{ width: `${pct}%` }}
          {...(tone ? { "data-tone": tone } : {})}
        />
      </span>
      <span className="bar-value">{display}</span>
    </div>
  );
}

// --------------------------------------------------------------- mutations

/**
 * Run a write, once.
 *
 * Every mutation in this console goes through here, for three reasons that were each a
 * bug the first time somebody hand-rolled them:
 *
 *   1. **The button disables while in flight.** Double-tapping "Issue invoice" on a slow
 *      connection must not issue two invoices.
 *   2. **The API's own message is shown.** `ApiError` carries what the server said —
 *      "That slot is already allotted", "Only a society admin can grant roles" — and
 *      replacing it with "Something went wrong" throws away the only useful sentence.
 *   3. **Errors do not clear the form.** Whatever was typed is still there to correct.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const run = useCallback(
    async (
      work: () => Promise<unknown>,
      options?: { success?: string; onDone?: () => void | Promise<void> },
    ) => {
      if (busy) return false;
      setBusy(true);
      setError("");
      setDone("");
      try {
        await work();
        if (options?.success) setDone(options.success);
        await options?.onDone?.();
        return true;
      } catch (err) {
        setError(
          err instanceof ApiError ? err.message : (err as Error).message || "That did not work.",
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const reset = useCallback(() => {
    setError("");
    setDone("");
  }, []);

  return { busy, error, done, run, reset };
}

/** A form that never reloads the page and never submits twice. */
export function Form({
  onSubmit,
  children,
}: {
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}
