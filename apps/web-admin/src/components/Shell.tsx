"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { session } from "../lib/api";

const PAGES = [
  { href: "/dashboard/", label: "Register" },
  { href: "/complaints/", label: "Complaints" },
  { href: "/billing/", label: "Dues & Billing" },
  { href: "/gate/", label: "Gate Log" },
  { href: "/operations/", label: "Gate Operations" },
  { href: "/staff/", label: "Staff" },
  { href: "/notices/", label: "Notices" },
  { href: "/units/", label: "Flats & Residents" },
];

/**
 * The console frame.
 *
 * Guards the whole authenticated area in one place: a page that renders inside Shell
 * cannot be reached without a session, so no individual page has to remember to check.
 * Forgetting that check on one page out of five is exactly the kind of gap that ships.
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

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-mark">
          <span className="society">Brigade Lakefront</span>
          <span className="product">WatchMyGate</span>
        </div>

        <nav>
          {PAGES.map((page) => (
            <Link
              key={page.href}
              href={page.href}
              data-active={pathname === page.href ? "true" : "false"}
            >
              {page.label}
            </Link>
          ))}
        </nav>

        <div className="rail-foot">
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
 * Every list in this console is the same object: a ruled block with a heading, a note,
 * and rows. Making that one component keeps the register metaphor consistent and means
 * an empty state is never forgotten — the commonest omission in an admin UI, and the
 * one a new society sees first.
 */
export function Ledger({
  title,
  note,
  head,
  children,
  empty,
  isEmpty,
}: {
  title: string;
  note?: string;
  head: string[];
  children: ReactNode;
  empty: string;
  isEmpty: boolean;
}) {
  return (
    <section className="ledger settle">
      <div className="ledger-head">
        <h2>{title}</h2>
        {note ? <span className="note">{note}</span> : null}
      </div>

      {isEmpty ? (
        <p className="empty">{empty}</p>
      ) : (
        <div className="ledger-scroll">
          <table>
            <thead>
              <tr>
                {head.map((column) => (
                  <th
                    key={column}
                    // Numeric columns are right-aligned so figures line up down the
                    // column, exactly as they would written in a register.
                    style={
                      column.startsWith("~")
                        ? { textAlign: "right" }
                        : undefined
                    }
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
  tone: "arrears" | "settled" | "pending" | "quiet";
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
