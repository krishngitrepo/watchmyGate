/**
 * Development seed — one realistic society.
 *
 * Creates enough of a working society that every Phase 1 flow can be exercised by hand:
 * log in, raise the lift complaint, issue a visitor pass, run the approval ladder,
 * preview an invoice.
 *
 * Idempotent. Re-running updates rather than duplicating, because a seed that fails the
 * second time is a seed nobody runs.
 *
 *   node --env-file=.env --experimental-strip-types packages/db/src/seed.ts
 *
 * Never run this against production: it creates known accounts with a fixed login.
 * The ENVIRONMENT guard below refuses.
 */

import pg from "pg";

const SOCIETY_SLUG = "brigade-lakefront";

/** Fixed phone numbers so the login flow is repeatable. OTP is stubbed locally. */
const PEOPLE = [
  { phone: "+919900000001", name: "Krishna Nara", role: "society_admin" },
  { phone: "+919900000002", name: "Priya Menon", role: "resident" },
  { phone: "+919900000003", name: "Suresh Kumar", role: "guard" },
  { phone: "+919900000004", name: "Anita Rao", role: "accountant" },
  { phone: "+919900000005", name: "Vikram Shetty", role: "mc_member" },
] as const;

async function main(): Promise<void> {
  if (process.env.ENVIRONMENT === "production") {
    throw new Error(
      "Refusing to seed production. This creates known accounts with a fixed login.",
    );
  }

  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url || url.includes("PLACEHOLDER")) {
    throw new Error("DATABASE_MIGRATION_URL is not set to a real connection string.");
  }

  const db = new pg.Client({
    connectionString: url,
    ssl: url.includes("localhost") ? false : { rejectUnauthorized: true },
  });
  await db.connect();

  try {
    await db.query("BEGIN");

    // ------------------------------------------------------------- society
    const society = await one<{ id: string }>(
      db,
      `INSERT INTO societies (name, slug, state_code, status, timezone)
       VALUES ('Brigade Lakefront', $1, 'KA', 'active', 'Asia/Kolkata')
       ON CONFLICT (slug) DO UPDATE SET name = excluded.name
       RETURNING id`,
      [SOCIETY_SLUG],
    );
    const societyId = society.id;

    // Scope every subsequent statement, exactly as the application does. The owner role
    // carries BYPASSRLS so this is not strictly required — but seeding the same way the
    // app writes means the seed exercises the policies rather than sidestepping them.
    await db.query("SELECT set_config('app.society_id', $1, true)", [societyId]);

    // --------------------------------------------------------------- towers
    const towerIds: string[] = [];
    for (const name of ["Tower A", "Tower B"]) {
      const tower = await one<{ id: string }>(
        db,
        `INSERT INTO towers (society_id, name, floors) VALUES ($1, $2, 12)
         ON CONFLICT (society_id, name) DO UPDATE SET floors = excluded.floors
         RETURNING id`,
        [societyId, name],
      );
      towerIds.push(tower.id);
    }

    // ---------------------------------------------------------------- units
    // Mixed sizes, because per-sq-ft billing is only interesting when they differ.
    const unitSpecs = [
      { tower: 0, number: "A-101", floor: 1, sqft: "1150.00", bhk: 2 },
      { tower: 0, number: "A-102", floor: 1, sqft: "1480.00", bhk: 3 },
      { tower: 0, number: "A-201", floor: 2, sqft: "1150.00", bhk: 2 },
      { tower: 1, number: "B-101", floor: 1, sqft: "1820.00", bhk: 3 },
      { tower: 1, number: "B-102", floor: 1, sqft: "2400.00", bhk: 4 },
    ];
    const unitIds: Record<string, string> = {};
    for (const u of unitSpecs) {
      const unit = await one<{ id: string }>(
        db,
        `INSERT INTO units (society_id, tower_id, number, floor, carpet_area_sqft, bhk, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'occupied')
         ON CONFLICT (society_id, tower_id, number)
           DO UPDATE SET carpet_area_sqft = excluded.carpet_area_sqft
         RETURNING id`,
        [societyId, towerIds[u.tower], u.number, u.floor, u.sqft, u.bhk],
      );
      unitIds[u.number] = unit.id;
    }

    // -------------------------------------------------------------- people
    const personIds: Record<string, string> = {};
    for (const p of PEOPLE) {
      const person = await one<{ id: string }>(
        db,
        `INSERT INTO persons (phone, name, status) VALUES ($1, $2, 'active')
         ON CONFLICT (phone) DO UPDATE SET name = excluded.name
         RETURNING id`,
        [p.phone, p.name],
      );
      personIds[p.phone] = person.id;

      const role = await one<{ id: string }>(
        db,
        "SELECT id FROM roles WHERE code = $1",
        [p.role],
      );

      // No natural unique key on role_assignments, so check before inserting rather
      // than relying on ON CONFLICT.
      const existing = await db.query(
        `SELECT 1 FROM role_assignments
          WHERE society_id = $1 AND person_id = $2 AND role_id = $3 AND valid_to IS NULL`,
        [societyId, person.id, role.id],
      );
      if (existing.rowCount === 0) {
        await db.query(
          `INSERT INTO role_assignments (society_id, person_id, role_id, scope_type, valid_from)
           VALUES ($1, $2, $3, 'society', current_date)`,
          [societyId, person.id, role.id],
        );
      }
    }

    // ----------------------------------------------------------- occupancy
    // Deliberately split: the OWNER votes, the TENANT pays. Collapsing these two into
    // one "resident" field is the classic bug in this category, so the seed shows the
    // distinction rather than hiding it behind a simple case.
    await upsertOccupancy(db, societyId, unitIds["A-101"]!, personIds["+919900000002"]!, {
      relationship: "tenant",
      billing: true,
      voting: false,
    });
    await upsertOccupancy(db, societyId, unitIds["A-102"]!, personIds["+919900000001"]!, {
      relationship: "owner",
      billing: true,
      voting: true,
    });
    await upsertOccupancy(db, societyId, unitIds["B-101"]!, personIds["+919900000005"]!, {
      relationship: "owner",
      billing: true,
      voting: true,
    });

    // ------------------------------------------------------------ helpdesk
    // The category tree behind "Light is not working in the lift".
    const common = await upsertCategory(db, societyId, null, "Common Area", 24, 48);
    const lift = await upsertCategory(db, societyId, common, "Lift", 8, 16);
    await upsertCategory(db, societyId, lift, "Lighting", 8, 16);
    await upsertCategory(db, societyId, lift, "Not working", 4, 8);
    await upsertCategory(db, societyId, common, "Water supply", 6, 12);
    await upsertCategory(db, societyId, common, "Garden and landscaping", 72, 120);
    const flat = await upsertCategory(db, societyId, null, "Inside my flat", 24, 48);
    await upsertCategory(db, societyId, flat, "Plumbing", 24, 48);
    await upsertCategory(db, societyId, flat, "Electrical", 12, 24);

    // -------------------------------------------------------------- ledger
    // Minimal chart of accounts. 1200 is the receivable the billing module debits.
    const accounts: Array<[string, string, string, boolean]> = [
      ["1000", "Bank — Current Account", "asset", false],
      ["1100", "Bank — Corpus Fund", "asset", true],
      ["1200", "Maintenance Receivable", "asset", false],
      ["2100", "GST Payable", "liability", false],
      ["2200", "Corpus Fund", "equity", true],
      ["4000", "Maintenance Income", "income", false],
      ["4100", "Amenity Income", "income", false],
      ["4200", "Late Fee Income", "income", false],
      ["5000", "Housekeeping", "expense", false],
      ["5100", "Security", "expense", false],
      ["5200", "Electricity — Common Area", "expense", false],
      ["5300", "Lift Maintenance", "expense", false],
    ];
    const accountIds: Record<string, string> = {};
    for (const [code, name, type, restricted] of accounts) {
      const row = await one<{ id: string }>(
        db,
        `INSERT INTO ledger_accounts (society_id, code, name, type, is_restricted)
         VALUES ($1, $2, $3, $4::account_type, $5)
         ON CONFLICT (society_id, code) DO UPDATE SET name = excluded.name
         RETURNING id`,
        [societyId, code, name, type, restricted],
      );
      accountIds[code] = row.id;
    }

    // ------------------------------------------------------------- billing
    const charges: Array<[string, string, string, string, string, boolean]> = [
      ["MAINT", "Maintenance charge", "per_sqft", "3.5000", "4000", true],
      ["SINKING", "Sinking fund", "per_sqft", "1.0000", "2200", false],
      ["WATER", "Water charge", "per_meter", "0.2500", "4000", true],
      ["CLUB", "Clubhouse subscription", "flat", "500.0000", "4100", true],
    ];
    for (const [code, name, formula, rate, account, gst] of charges) {
      await db.query(
        `INSERT INTO charge_types
           (society_id, code, name, formula, rate, account_id, gst_applicable, gst_rate)
         VALUES ($1, $2, $3, $4::billing_formula, $5, $6, $7, 18)
         ON CONFLICT (society_id, code) DO UPDATE
           SET rate = excluded.rate, name = excluded.name`,
        [societyId, code, name, formula, rate, accountIds[account], gst],
      );
    }

    // Statutory thresholds as DATA. GST on maintenance needs BOTH conditions met:
    // over Rs 7,500/month per member AND society turnover over Rs 20 lakh. This
    // society's turnover is set below the threshold, so GST correctly does NOT apply
    // — which is the more common real case and the one worth seeding.
    const hasRules = await db.query(
      "SELECT 1 FROM gst_rules WHERE society_id = $1",
      [societyId],
    );
    if (hasRules.rowCount === 0) {
      await db.query(
        `INSERT INTO gst_rules
           (society_id, effective_from, monthly_threshold_per_member,
            annual_turnover_threshold, rate, society_turnover,
            late_fee_percent_per_month, grace_days)
         VALUES ($1, '2025-04-01', 7500, 2000000, 18, 1450000, 1.5, 5)`,
        [societyId],
      );
    }

    // ---------------------------------------------------------------- gate
    for (const name of ["Main Gate", "Service Gate"]) {
      await db.query(
        `INSERT INTO gates (society_id, name) VALUES ($1, $2)
         ON CONFLICT (society_id, name) DO NOTHING`,
        [societyId, name],
      );
    }

    // A standing rule, so the 45-second ladder rung has something to apply.
    const hasRule = await db.query(
      "SELECT 1 FROM standing_rules WHERE society_id = $1 AND unit_id = $2",
      [societyId, unitIds["A-101"]],
    );
    if (hasRule.rowCount === 0) {
      await db.query(
        `INSERT INTO standing_rules (society_id, unit_id, category, matcher, action, is_active)
         VALUES
           ($1, $2, 'delivery', 'Amazon', 'auto_approve', true),
           ($1, $2, 'service',  NULL,     'ask_to_wait',  true)`,
        [societyId, unitIds["A-101"]],
      );
    }

    // ------------------------------------------------------------ amenities
    for (const [name, capacity, rate] of [
      ["Party Hall", 80, "2000.0000"],
      ["Tennis Court", 4, "200.0000"],
      ["Swimming Pool", 30, "0.0000"],
    ] as const) {
      await db.query(
        `INSERT INTO amenities (society_id, name, capacity, is_paid, rate)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (society_id, name) DO UPDATE SET rate = excluded.rate`,
        [societyId, name, capacity, Number(rate) > 0, rate],
      );
    }

    await db.query("COMMIT");

    console.info("seeded society:", societyId);
    console.info("units:", Object.entries(unitIds).map(([n, id]) => `${n}=${id}`).join(" "));
    console.info("\nsign in with any of these (OTP is printed to the API log):");
    for (const p of PEOPLE) console.info(`  ${p.phone}  ${p.name} (${p.role})`);
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    await db.end();
  }
}

async function one<T extends pg.QueryResultRow>(
  db: pg.Client,
  sql: string,
  params: unknown[],
): Promise<T> {
  const { rows } = await db.query<T>(sql, params);
  if (!rows[0]) throw new Error(`Expected a row from: ${sql.slice(0, 60)}…`);
  return rows[0];
}

async function upsertCategory(
  db: pg.Client,
  societyId: string,
  parentId: string | null,
  name: string,
  slaHours: number,
  escalationHours: number,
): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM ticket_categories
      WHERE society_id = $1 AND name = $2
        AND parent_id IS NOT DISTINCT FROM $3`,
    [societyId, name, parentId],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const row = await one<{ id: string }>(
    db,
    `INSERT INTO ticket_categories
       (society_id, parent_id, name, sla_hours, escalation_hours)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [societyId, parentId, name, slaHours, escalationHours],
  );
  return row.id;
}

async function upsertOccupancy(
  db: pg.Client,
  societyId: string,
  unitId: string,
  personId: string,
  opts: { relationship: string; billing: boolean; voting: boolean },
): Promise<void> {
  const existing = await db.query(
    `SELECT 1 FROM unit_occupancies
      WHERE society_id = $1 AND unit_id = $2 AND person_id = $3 AND valid_to IS NULL`,
    [societyId, unitId, personId],
  );
  if (existing.rowCount && existing.rowCount > 0) return;

  await db.query(
    `INSERT INTO unit_occupancies
       (society_id, unit_id, person_id, relationship, is_billing_liable,
        has_voting_right, has_app_access, valid_from)
     VALUES ($1, $2, $3, $4::occupancy_relationship, $5, $6, true, current_date)`,
    [societyId, unitId, personId, opts.relationship, opts.billing, opts.voting],
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
