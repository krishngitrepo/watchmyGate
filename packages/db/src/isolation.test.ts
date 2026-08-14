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

  // Ordered by dependency; the owner bypasses RLS so this reaches both societies.
  await owner.query("BEGIN");
  for (const table of [
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
