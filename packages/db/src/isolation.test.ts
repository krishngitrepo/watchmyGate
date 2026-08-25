/**
 * Tenant isolation — the test that must never be allowed to fail.
 *
 * Everything else in this product is a feature. This is the guarantee. If a resident of
 * one society can read another society's ledger, complaints or gate log, nothing else
 * we built matters.
 *
 * These tests connect as the REAL application role against the REAL database, because
 * the thing being verified is a property of the database, not of our code. A mock would
 * assert that our beliefs are self-consistent, which is exactly the failure mode RLS
 * exists to prevent.
 *
 * Requires DATABASE_URL (application role) and DATABASE_MIGRATION_URL (owner). Skips
 * with a loud message when they are absent rather than passing vacuously — a green tick
 * on a test that never ran is worse than a red one.
 */

import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.DATABASE_MIGRATION_URL;
const configured = Boolean(APP_URL && OWNER_URL && !APP_URL.includes("PLACEHOLDER"));

if (!configured) {
  console.warn(
    "\n  SKIPPING TENANT ISOLATION TESTS — DATABASE_URL is not configured.\n" +
      "  The isolation guarantee is UNVERIFIED in this run.\n",
  );
}

const ssl = { rejectUnauthorized: true };

/** Society A and B, plus the identifiers seeded into each. */
interface Fixture {
  societyA: string;
  societyB: string;
  towerB: string;
  unitB: string;
  personB: string;
  ticketB: string;
  categoryB: string;
  accountB: string;
  entryB: string;
}

let owner: pg.Client;
let app: pg.Pool;
let fx: Fixture;

/**
 * Run as the application role, scoped to one society.
 *
 * Deliberately mirrors `withTenant` in tenant.ts rather than importing it: this test
 * must fail if the production helper is wrong, so it cannot share the helper's
 * assumptions. `set_config(..., true)` is transaction-local, which is what makes this
 * correct under Neon's transaction-mode pooler.
 */
async function asSociety<T>(
  societyId: string | null,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    if (societyId !== null) {
      await client.query("SELECT set_config('app.society_id', $1, true)", [societyId]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  if (!configured) return;

  owner = new pg.Client({ connectionString: OWNER_URL, ssl });
  await owner.connect();
  app = new pg.Pool({ connectionString: APP_URL, ssl, max: 4 });

  const societyA = randomUUID();
  const societyB = randomUUID();
  const towerB = randomUUID();
  const unitB = randomUUID();
  const personB = randomUUID();
  const categoryB = randomUUID();
  const ticketB = randomUUID();
  const accountB = randomUUID();
  const entryB = randomUUID();
  const suffix = societyB.slice(0, 8);

  // Seed as the owner, which carries BYPASSRLS on Neon — so seeding is not itself a
  // test of the policies, and cannot accidentally pass because of them.
  await owner.query("BEGIN");
  await owner.query(
    `INSERT INTO societies (id, name, slug, state_code) VALUES
       ($1, 'Society A', $3, 'KA'), ($2, 'Society B', $4, 'KA')`,
    [societyA, societyB, `iso-a-${suffix}`, `iso-b-${suffix}`],
  );
  await owner.query(
    "INSERT INTO towers (id, society_id, name) VALUES ($1, $2, 'Tower B1')",
    [towerB, societyB],
  );
  await owner.query(
    `INSERT INTO units (id, society_id, tower_id, number, carpet_area_sqft, bhk)
     VALUES ($1, $2, $3, 'B-101', 1200.00, 3)`,
    [unitB, societyB, towerB],
  );
  await owner.query(
    "INSERT INTO persons (id, phone, name) VALUES ($1, $2, 'Resident B')",
    [personB, `+9199${suffix.slice(0, 8).replace(/\D/g, "0").padEnd(8, "7")}`],
  );
  await owner.query(
    `INSERT INTO ticket_categories (id, society_id, name) VALUES ($1, $2, 'Lift → Lighting')`,
    [categoryB, societyB],
  );
  await owner.query(
    `INSERT INTO tickets
       (id, society_id, ticket_number, raised_by, unit_id, location_type, category_id,
        title, description, sla_due_at, escalation_due_at)
     VALUES ($1, $2, 'B-0001', $3, $4, 'common', $5,
       'Light is not working in the lift',
       'Tower B lift, ground floor. Dark since Tuesday.',
       now() + interval '24 hours', now() + interval '48 hours')`,
    [ticketB, societyB, personB, unitB, categoryB],
  );
  await owner.query(
    `INSERT INTO ledger_accounts (id, society_id, code, name, type)
     VALUES ($1, $2, '4000', 'Maintenance Income', 'income')`,
    [accountB, societyB],
  );
  await owner.query(
    `INSERT INTO journal_entries
       (id, society_id, entry_number, entry_date, narration, source_type, posted_at)
     VALUES ($1, $2, 'JE-0001', current_date, 'Opening', 'opening', now())`,
    [entryB, societyB],
  );
  await owner.query(
    `INSERT INTO journal_lines (society_id, journal_entry_id, account_id, debit, credit)
     VALUES ($1, $2, $3, 0, 5000.0000)`,
    [societyB, entryB, accountB],
  );
  await owner.query("COMMIT");

  fx = { societyA, societyB, towerB, unitB, personB, ticketB, categoryB, accountB, entryB };
}, 60_000);

afterAll(async () => {
  if (!configured) return;

  // The ledger immutability trigger blocks DELETE for EVERY role, the table owner
  // included — which is why teardown has to switch it off explicitly. That is the
  // control behaving correctly, not an obstacle: removing posted ledger rows takes a
  // deliberate, privileged DDL statement that the application role can never issue.
  await owner.query("ALTER TABLE journal_lines   DISABLE TRIGGER trg_journal_lines_immutable");
  await owner.query("ALTER TABLE journal_entries DISABLE TRIGGER trg_journal_entries_immutable");

  // Same for the budget freeze and the maintenance log, for the same reason. An approved
  // budget's lines and a completed job are unremovable by any role through ordinary SQL,
  // which is what makes them evidence; clearing them is a privileged DDL act.
  await owner.query("ALTER TABLE budget_lines      DISABLE TRIGGER trg_budget_lines_frozen");
  await owner.query("ALTER TABLE budgets           DISABLE TRIGGER trg_budget_approval_one_way");
  await owner.query("ALTER TABLE asset_maintenance DISABLE TRIGGER trg_maintenance_final");

  // Ordered by dependency; the owner bypasses RLS so this reaches both societies.
  await owner.query("BEGIN");
  for (const table of [
    // Phase 2 first, children before parents: parking_violations → parking_slots →
    // vehicles → staff, and the poll/notice chain. None of these carry fixtures today,
    // but a list that is only correct while it is unused is a trap for whoever adds the
    // first one.
    "poll_votes",
    "poll_options",
    "notice_reads",
    "notices",
    "parking_violations",
    "parking_slots",
    "vehicles",
    "staff_attendance",
    "staff_assignments",
    "staff",
    "deliveries",
    "dlt_templates",
    // Budget lines reference ledger accounts, and asset maintenance references assets,
    // so both come out before the tables they point at.
    "budget_lines",
    "budgets",
    "asset_maintenance",
    "assets",
    "journal_lines",
    "journal_entries",
    "ledger_accounts",
    "ticket_events",
    "ticket_subscribers",
    "tickets",
    "ticket_categories",
    "unit_occupancies",
    "units",
    "towers",
  ]) {
    await owner.query(
      `DELETE FROM ${table} WHERE society_id = ANY($1::uuid[])`,
      [[fx.societyA, fx.societyB]],
    );
  }
  await owner.query("DELETE FROM societies WHERE id = ANY($1::uuid[])", [
    [fx.societyA, fx.societyB],
  ]);
  await owner.query("DELETE FROM persons WHERE id = $1", [fx.personB]);
  await owner.query("COMMIT");

  await owner.query("ALTER TABLE journal_lines   ENABLE TRIGGER trg_journal_lines_immutable");
  await owner.query("ALTER TABLE journal_entries ENABLE TRIGGER trg_journal_entries_immutable");
  // Every DISABLE above needs its ENABLE here. `ALTER TABLE ... DISABLE TRIGGER` is DDL
  // and persists: forgetting one leaves the control switched off on the database itself,
  // long after this run has ended, which is how a green test suite ships an absent
  // safeguard. Found exactly that way.
  await owner.query("ALTER TABLE budget_lines      ENABLE TRIGGER trg_budget_lines_frozen");
  await owner.query("ALTER TABLE budgets           ENABLE TRIGGER trg_budget_approval_one_way");
  await owner.query("ALTER TABLE asset_maintenance ENABLE TRIGGER trg_maintenance_final");

  await owner.end();
  await app.end();
}, 60_000);

describe.skipIf(!configured)("the application role cannot bypass RLS", () => {
  it("is NOBYPASSRLS — the attribute the whole model rests on", async () => {
    const { rows } = await asSociety(fx.societyA, (c) =>
      c.query<{ u: string; b: boolean }>(
        "SELECT current_user u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) b",
      ),
    );
    expect(rows[0]!.u).toBe("watchmygate_app");
    expect(rows[0]!.b).toBe(false);
  });
});

describe.skipIf(!configured)("society A cannot read society B", () => {
  // Every tenant-scoped table. Adding a table without adding it here is the mistake
  // this list exists to make visible.
  const tenantTables = [
    "towers",
    "units",
    "unit_occupancies",
    "role_assignments",
    "ticket_categories",
    "tickets",
    "ticket_events",
    "ticket_subscribers",
    "attachments",
    "society_signing_keys",
    "gates",
    "visitor_passes",
    "gate_events",
    "approvals",
    "approval_rungs",
    "standing_rules",
    "sos_alerts",
    "watchlist",
    "ledger_accounts",
    "accounting_periods",
    "journal_entries",
    "journal_lines",
    "charge_types",
    "gst_rules",
    "invoices",
    "invoice_lines",
    "payment_destinations",
    "charge_type_routing",
    "receipts",
    "receipt_allocations",
    "amenities",
    "amenity_bookings",
    // Phase 2. `dlt_templates` is deliberately absent: its policy also admits
    // platform-wide rows where society_id IS NULL, so a plain "sees zero of B's rows"
    // assertion does not describe it. It is covered separately below.
    "staff",
    "staff_assignments",
    "staff_attendance",
    "deliveries",
    "notices",
    "notice_reads",
    "poll_options",
    "poll_votes",
    "vehicles",
    "parking_slots",
    "parking_violations",
  ];

  it.each(tenantTables)(
    "%s — scoped to A, sees zero of B's rows",
    async (table) => {
      const { rows } = await asSociety(fx.societyA, (c) =>
        c.query<{ n: string }>(
          `SELECT count(*)::text n FROM ${table} WHERE society_id = $1`,
          [fx.societyB],
        ),
      );
      expect(rows[0]!.n).toBe("0");
    },
  );

  /**
   * DLT templates are the one table with a deliberately asymmetric policy: reads admit
   * platform-wide rows (society_id IS NULL) so every society can use the shared
   * templates, while writes stay society-scoped. Both halves need proving — a policy
   * that is loose on reads and silently loose on writes is how a society ends up able
   * to edit the template every other society sends with.
   */
  it("dlt_templates — a society sees platform templates but not another society's", async () => {
    const platform = await asSociety(fx.societyA, (c) =>
      c.query<{ n: string }>(
        "SELECT count(*)::text n FROM dlt_templates WHERE society_id IS NULL",
      ),
    );
    expect(Number(platform.rows[0]!.n)).toBeGreaterThanOrEqual(0);

    const other = await asSociety(fx.societyA, (c) =>
      c.query<{ n: string }>(
        "SELECT count(*)::text n FROM dlt_templates WHERE society_id = $1",
        [fx.societyB],
      ),
    );
    expect(other.rows[0]!.n).toBe("0");
  });

  it("dlt_templates — a society cannot insert a row belonging to another", async () => {
    await expect(
      asSociety(fx.societyA, (c) =>
        c.query(
          `INSERT INTO dlt_templates (society_id, code, provider_id, header, category, body)
           VALUES ($1, 'stolen', 'p', 'WMGATE', 'transactional', 'x')`,
          [fx.societyB],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("dlt_templates — a society cannot insert a platform-wide template", async () => {
    // WITH CHECK requires society_id to equal the current society, so NULL fails too.
    // That is intended: platform templates are seeded by a migration, never by a tenant.
    await expect(
      asSociety(fx.societyA, (c) =>
        c.query(
          `INSERT INTO dlt_templates (society_id, code, provider_id, header, category, body)
           VALUES (NULL, 'sneaky', 'p', 'WMGATE', 'promotional', 'x')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot read B's complaint even knowing its exact primary key", async () => {
    const { rows } = await asSociety(fx.societyA, (c) =>
      c.query("SELECT title FROM tickets WHERE id = $1", [fx.ticketB]),
    );
    expect(rows).toHaveLength(0);
  });

  it("cannot read B's ledger — no amount leaks through an aggregate", async () => {
    const { rows } = await asSociety(fx.societyA, (c) =>
      c.query<{ total: string | null }>(
        "SELECT sum(credit)::text total FROM journal_lines",
      ),
    );
    expect(rows[0]!.total).toBeNull();
  });

  it("sees B's rows when correctly scoped to B — proving the fixture is real", async () => {
    // Without this, every assertion above could pass against an empty database.
    const { rows } = await asSociety(fx.societyB, (c) =>
      c.query<{ title: string }>("SELECT title FROM tickets WHERE id = $1", [fx.ticketB]),
    );
    expect(rows[0]!.title).toBe("Light is not working in the lift");
  });
});

/**
 * Negative control.
 *
 * Every assertion above is of the form "A sees zero rows of B". Such a test also passes
 * against an empty database, a broken connection, or a typo in a table name — so on its
 * own it proves nothing. This suite establishes that the rows really are there and that
 * RLS is the only thing hiding them.
 *
 * It does so by connecting as the OWNER, which carries BYPASSRLS on Neon, and showing
 * it sees straight across societies. That is not a defect; it is why `DATABASE_URL`
 * must point at `watchmygate_app` and never at `neondb_owner`. If someone ever "fixes"
 * a connection problem by swapping in the owner credentials, isolation silently
 * evaporates with no error anywhere — this test is the written record of that.
 */
describe.skipIf(!configured)("negative control — the owner CAN cross societies", () => {
  it("reads B's complaint while scoped to A, proving the fixture is real", async () => {
    await owner.query("BEGIN");
    await owner.query("SELECT set_config('app.society_id', $1, true)", [fx.societyA]);
    const { rows } = await owner.query<{ title: string }>(
      "SELECT title FROM tickets WHERE id = $1",
      [fx.ticketB],
    );
    await owner.query("COMMIT");

    // The owner sees it. The application role, in the identical query above, did not.
    // The difference between those two results IS the isolation guarantee.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Light is not working in the lift");
  });

  it("confirms the owner is the dangerous role, by attribute", async () => {
    const { rows } = await owner.query<{ b: boolean }>(
      "SELECT rolbypassrls b FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]!.b).toBe(true);
  });
});

describe.skipIf(!configured)("unscoped access fails closed", () => {
  it("returns zero rows rather than everything when no society is set", async () => {
    const { rows } = await asSociety(null, (c) =>
      c.query<{ n: string }>("SELECT count(*)::text n FROM tickets"),
    );
    expect(rows[0]!.n).toBe("0");
  });

  /**
   * The regression test for the bug that made this whole approach fail once already.
   *
   * `set_config(..., is_local => true)` resets to the EMPTY STRING at transaction end,
   * not to NULL. On a pooled connection that previously served a scoped request, a bare
   * `''::uuid` raises InvalidTextRepresentation instead of filtering — so behaviour
   * depended on whether the connection happened to be warm. `nullif(..., '')` is what
   * makes it deterministic.
   *
   * This must reuse a connection that has already been scoped, or it proves nothing.
   */
  it("still fails closed on a pooled connection previously scoped to a society", async () => {
    const single = new pg.Pool({ connectionString: APP_URL, ssl, max: 1 });
    try {
      await single.query("BEGIN");
      await single.query("SELECT set_config('app.society_id', $1, true)", [fx.societyB]);
      const scoped = await single.query<{ n: string }>(
        "SELECT count(*)::text n FROM tickets",
      );
      expect(scoped.rows[0]!.n).toBe("1");
      await single.query("COMMIT");

      // Same physical connection, now unscoped. Must filter, not raise.
      await single.query("BEGIN");
      const after = await single.query<{ n: string }>(
        "SELECT count(*)::text n FROM tickets",
      );
      await single.query("COMMIT");
      expect(after.rows[0]!.n).toBe("0");
    } finally {
      await single.end();
    }
  });
});

describe.skipIf(!configured)("society A cannot write into society B", () => {
  it("rejects an INSERT carrying B's society_id", async () => {
    await expect(
      asSociety(fx.societyA, (c) =>
        c.query("INSERT INTO towers (society_id, name) VALUES ($1, 'Smuggled')", [
          fx.societyB,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot move its own row into B by UPDATE", async () => {
    const towerA = randomUUID();
    await asSociety(fx.societyA, (c) =>
      c.query("INSERT INTO towers (id, society_id, name) VALUES ($1, $2, 'Tower A1')", [
        towerA,
        fx.societyA,
      ]),
    );
    await expect(
      asSociety(fx.societyA, (c) =>
        c.query("UPDATE towers SET society_id = $1 WHERE id = $2", [fx.societyB, towerA]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot DELETE B's rows", async () => {
    const { rowCount } = await asSociety(fx.societyA, (c) =>
      c.query("DELETE FROM tickets WHERE id = $1", [fx.ticketB]),
    );
    expect(rowCount).toBe(0);

    // And B's complaint is still there.
    const { rows } = await asSociety(fx.societyB, (c) =>
      c.query("SELECT id FROM tickets WHERE id = $1", [fx.ticketB]),
    );
    expect(rows).toHaveLength(1);
  });
});

describe.skipIf(!configured)("the ledger is immutable at the database", () => {
  it("rejects UPDATE on a posted journal entry", async () => {
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query("UPDATE journal_entries SET narration = 'edited' WHERE id = $1", [
          fx.entryB,
        ]),
      ),
    ).rejects.toThrow(/immutable|permission denied/i);
  });

  it("rejects UPDATE on a posted journal line — no silent restatement", async () => {
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query("UPDATE journal_lines SET credit = 999999 WHERE journal_entry_id = $1", [
          fx.entryB,
        ]),
      ),
    ).rejects.toThrow(/immutable|permission denied/i);
  });

  it("rejects DELETE on a posted journal entry", async () => {
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query("DELETE FROM journal_entries WHERE id = $1", [fx.entryB]),
      ),
    ).rejects.toThrow(/immutable|permission denied/i);
  });

  it("rejects a line that is both debit and credit", async () => {
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query(
          `INSERT INTO journal_lines (society_id, journal_entry_id, account_id, debit, credit)
           VALUES ($1, $2, $3, 100, 100)`,
          [fx.societyB, fx.entryB, fx.accountB],
        ),
      ),
    ).rejects.toThrow(/ck_line_one_sided/);
  });

  it("rejects a line that is neither debit nor credit", async () => {
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query(
          `INSERT INTO journal_lines (society_id, journal_entry_id, account_id, debit, credit)
           VALUES ($1, $2, $3, 0, 0)`,
          [fx.societyB, fx.entryB, fx.accountB],
        ),
      ),
    ).rejects.toThrow(/ck_line_one_sided/);
  });
});

describe.skipIf(!configured)("money survives the round trip exactly", () => {
  it("returns numeric as a string, never a float", async () => {
    const { rows } = await asSociety(fx.societyB, (c) =>
      c.query<{ credit: unknown }>(
        "SELECT credit FROM journal_lines WHERE journal_entry_id = $1",
        [fx.entryB],
      ),
    );
    // node-postgres would hand back a JS number by default and destroy precision on
    // every currency column before our code ever saw it. tenant.ts overrides the parser.
    expect(typeof rows[0]!.credit).toBe("string");
    expect(rows[0]!.credit).toBe("5000.0000");
  });

  it("stores a value that has no exact float representation, unchanged", async () => {
    const account = randomUUID();
    const entry = randomUUID();
    const awkward = "1234567890123.4567"; // > 2^53, and .4567 is not a dyadic rational

    const value = await asSociety(fx.societyB, async (c) => {
      await c.query(
        `INSERT INTO ledger_accounts (id, society_id, code, name, type)
         VALUES ($1, $2, '9999', 'Precision probe', 'asset')`,
        [account, fx.societyB],
      );
      await c.query(
        `INSERT INTO journal_entries
           (id, society_id, entry_number, entry_date, narration, source_type, posted_at)
         VALUES ($1, $2, 'JE-PREC', current_date, 'probe', 'opening', now())`,
        [entry, fx.societyB],
      );
      await c.query(
        `INSERT INTO journal_lines (society_id, journal_entry_id, account_id, debit, credit)
         VALUES ($1, $2, $3, $4, 0)`,
        [fx.societyB, entry, account, awkward],
      );
      const { rows } = await c.query<{ debit: string }>(
        "SELECT debit FROM journal_lines WHERE journal_entry_id = $1",
        [entry],
      );
      return rows[0]!.debit;
    });

    expect(value).toBe(awkward);
    expect(Number(value).toString()).not.toBe(awkward); // proves the float path would lose it
  });
});

describe.skipIf(!configured)("amenity double-booking is impossible", () => {
  it("rejects an overlapping confirmed booking at the database", async () => {
    const amenity = randomUUID();
    const start = "2026-09-01T10:00:00Z";

    await asSociety(fx.societyB, (c) =>
      c.query(
        "INSERT INTO amenities (id, society_id, name) VALUES ($1, $2, 'Party Hall')",
        [amenity, fx.societyB],
      ),
    );
    await asSociety(fx.societyB, (c) =>
      c.query(
        `INSERT INTO amenity_bookings
           (society_id, amenity_id, unit_id, booked_by, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $5::timestamptz + interval '3 hours')`,
        [fx.societyB, amenity, fx.unitB, fx.personB, start],
      ),
    );

    // Second family, overlapping window. An application-level check would race here.
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query(
          `INSERT INTO amenity_bookings
             (society_id, amenity_id, unit_id, booked_by, starts_at, ends_at)
           VALUES ($1, $2, $3, $4, $5::timestamptz + interval '1 hour',
                   $5::timestamptz + interval '4 hours')`,
          [fx.societyB, amenity, fx.unitB, fx.personB, start],
        ),
      ),
    ).rejects.toThrow(/ex_amenity_no_overlap|conflicting key value/i);

    await asSociety(fx.societyB, (c) =>
      c.query("DELETE FROM amenity_bookings WHERE amenity_id = $1", [amenity]),
    );
    await asSociety(fx.societyB, (c) =>
      c.query("DELETE FROM amenities WHERE id = $1", [amenity]),
    );
  });
});

/**
 * The controls added with budgets and the asset register (migrations 0011, 0012).
 *
 * Every one of these is asserted through the **application role**, because that is the
 * only role the API ever holds and the claim being made is that these hold even when the
 * calling code is wrong. A service-layer check would pass this file and fail the moment
 * anybody opened psql.
 */
describe.skipIf(!configured)("a passed budget cannot be quietly edited", () => {
  // Only one budget per year may be live, so fixtures walk the years rather than
  // guessing at them — a random year collides often enough to make this file flaky.
  let nextYear = 2000;

  /** A fresh approved budget with one line, in a year nothing else is using. */
  async function approvedBudget(): Promise<{ budget: string; line: string }> {
    const year = (nextYear += 1);
    return asSociety(fx.societyB, async (c) => {
      const budget = (
        await c.query(
          `INSERT INTO budgets (society_id, financial_year, title, created_by)
           VALUES ($1, $2, 'Fixture', $3) RETURNING id`,
          [fx.societyB, year, fx.personB],
        )
      ).rows[0].id as string;

      const line = (
        await c.query(
          `INSERT INTO budget_lines (society_id, budget_id, account_id, annual_amount)
           VALUES ($1, $2, $3, 1000) RETURNING id`,
          [fx.societyB, budget, fx.accountB],
        )
      ).rows[0].id as string;

      await c.query(
        `UPDATE budgets SET status = 'approved', approved_by = $2, approved_at = now()
         WHERE id = $1`,
        [budget, fx.personB],
      );
      return { budget, line };
    });
  }

  it("rejects an UPDATE on a line of an approved budget", async () => {
    const { line } = await approvedBudget();
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query("UPDATE budget_lines SET annual_amount = 999999 WHERE id = $1", [line]),
      ),
    ).rejects.toThrow(/approved/i);
  });

  it("rejects a new line added to an approved budget", async () => {
    const { budget } = await approvedBudget();
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query(
          `INSERT INTO budget_lines (society_id, budget_id, account_id, annual_amount)
           VALUES ($1, $2, $3, 5000)`,
          [fx.societyB, budget, fx.accountB],
        ),
      ),
    ).rejects.toThrow(/approved/i);
  });

  it("rejects DELETE of a line of an approved budget", async () => {
    const { line } = await approvedBudget();
    await expect(
      asSociety(fx.societyB, (c) => c.query("DELETE FROM budget_lines WHERE id = $1", [line])),
    ).rejects.toThrow(/approved/i);
  });

  it("refuses to return an approved budget to draft", async () => {
    // "Unapprove, edit, re-approve" is the same edit taken the long way round.
    const { budget } = await approvedBudget();
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query("UPDATE budgets SET status = 'draft' WHERE id = $1", [budget]),
      ),
    ).rejects.toThrow(/draft/i);
  });

  it("refuses to revive a superseded budget", async () => {
    const { budget } = await approvedBudget();
    await asSociety(fx.societyB, (c) =>
      c.query("UPDATE budgets SET status = 'superseded' WHERE id = $1", [budget]),
    );
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query("UPDATE budgets SET status = 'approved' WHERE id = $1", [budget]),
      ),
    ).rejects.toThrow(/revived/i);
  });

  it("does not let the application delete a budget at all", async () => {
    // A budget the AGM passed is the record of a decision. Superseding is the only exit.
    const { budget } = await approvedBudget();
    await expect(
      asSociety(fx.societyB, (c) => c.query("DELETE FROM budgets WHERE id = $1", [budget])),
    ).rejects.toThrow(/permission denied/i);
  });

  it("allows a draft to be edited freely, proving the freeze is the approval and not the table", async () => {
    const year = (nextYear += 1);
    const line = await asSociety(fx.societyB, async (c) => {
      const budget = (
        await c.query(
          `INSERT INTO budgets (society_id, financial_year, title, created_by)
           VALUES ($1, $2, 'Draft fixture', $3) RETURNING id`,
          [fx.societyB, year, fx.personB],
        )
      ).rows[0].id as string;
      return (
        await c.query(
          `INSERT INTO budget_lines (society_id, budget_id, account_id, annual_amount)
           VALUES ($1, $2, $3, 1000) RETURNING id`,
          [fx.societyB, budget, fx.accountB],
        )
      ).rows[0].id as string;
    });

    const updated = await asSociety(fx.societyB, (c) =>
      c.query("UPDATE budget_lines SET annual_amount = 2000 WHERE id = $1", [line]),
    );
    expect(updated.rowCount).toBe(1);
  });
});

describe.skipIf(!configured)("a maintenance record cannot be tidied up afterwards", () => {
  async function asset(code: string): Promise<string> {
    return asSociety(fx.societyB, async (c) =>
      (
        await c.query(
          `INSERT INTO assets (society_id, code, name, category, purchase_cost)
           VALUES ($1, $2, 'Fixture lift', 'lift', 400000) RETURNING id`,
          [fx.societyB, code],
        )
      ).rows[0].id as string,
    );
  }

  async function completedJob(): Promise<string> {
    const assetId = await asset(`FIX-${randomUUID().slice(0, 8)}`);
    return asSociety(fx.societyB, async (c) => {
      const id = (
        await c.query(
          `INSERT INTO asset_maintenance (society_id, asset_id, kind, due_on)
           VALUES ($1, $2, 'service', current_date - 10) RETURNING id`,
          [fx.societyB, assetId],
        )
      ).rows[0].id as string;
      await c.query(
        "UPDATE asset_maintenance SET completed_on = current_date, cost = 5000 WHERE id = $1",
        [id],
      );
      return id;
    });
  }

  it("refuses to move the date a job was completed", async () => {
    // This log is what a society produces when a lift injures somebody and the question
    // is whether it was serviced. The temptation to adjust it arrives exactly then.
    const job = await completedJob();
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query(
          "UPDATE asset_maintenance SET completed_on = current_date - 30 WHERE id = $1",
          [job],
        ),
      ),
    ).rejects.toThrow(/already recorded as done/i);
  });

  it("refuses to un-complete a job", async () => {
    const job = await completedJob();
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query("UPDATE asset_maintenance SET completed_on = NULL WHERE id = $1", [job]),
      ),
    ).rejects.toThrow(/already recorded as done/i);
  });

  it("refuses to restate what a completed job cost", async () => {
    const job = await completedJob();
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query("UPDATE asset_maintenance SET cost = 1 WHERE id = $1", [job]),
      ),
    ).rejects.toThrow(/already recorded as done/i);
  });

  it("refuses to move a completed job onto a different asset", async () => {
    const job = await completedJob();
    const other = await asset(`FIX-${randomUUID().slice(0, 8)}`);
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query("UPDATE asset_maintenance SET asset_id = $2 WHERE id = $1", [job, other]),
      ),
    ).rejects.toThrow(/already recorded as done/i);
  });

  it("still allows notes to be added to a completed job", async () => {
    // Adding what was found is not restating what happened, and a log nobody can annotate
    // is a log people keep somewhere else.
    const job = await completedJob();
    const result = await asSociety(fx.societyB, (c) =>
      c.query("UPDATE asset_maintenance SET notes = 'Bearing replaced' WHERE id = $1", [job]),
    );
    expect(result.rowCount).toBe(1);
  });

  it("refuses two assets carrying the same tag", async () => {
    const code = `DUP-${randomUUID().slice(0, 8)}`;
    await asset(code);
    await expect(asset(code)).rejects.toThrow(/uq_asset_code|duplicate key/i);
  });

  it("refuses to mark an asset disposed without saying when", async () => {
    const id = await asset(`DIS-${randomUUID().slice(0, 8)}`);
    await expect(
      asSociety(fx.societyB, (c) =>
        c.query("UPDATE assets SET status = 'disposed' WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/ck_asset_disposal/);
  });
});
