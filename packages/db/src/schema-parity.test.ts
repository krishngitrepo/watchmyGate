/**
 * Schema parity — does the database actually look like `schema.ts` says it does?
 *
 * The migrations are hand-written SQL and the Drizzle schema is hand-written TypeScript.
 * Nothing forces them to agree, and when they disagree the symptom is not a clean error
 * — it is a column read as the wrong type, a NOT NULL that isn't, or money silently
 * arriving as a float. This test is what forces them to agree.
 *
 * It found a real drift on its first run: `ip` columns were `inet` in the migrations and
 * `varchar(45)` in the schema.
 *
 * Add a column to one side only and this fails with the exact table, column and the two
 * differing types.
 */

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "./schema.js";

const OWNER_URL = process.env.DATABASE_MIGRATION_URL;
const configured = Boolean(OWNER_URL && !OWNER_URL.includes("PLACEHOLDER"));

if (!configured) {
  console.warn("\n  SKIPPING SCHEMA PARITY — DATABASE_MIGRATION_URL is not configured.\n");
}

interface DbColumn {
  table: string;
  column: string;
  dataType: string;
  udtName: string;
  charMax: number | null;
  numPrecision: number | null;
  numScale: number | null;
  isNullable: string;
}

let columns = new Map<string, DbColumn>();
let dbTables = new Set<string>();
let client: pg.Client;

/** Render an information_schema row the way Drizzle's `getSQLType()` would. */
function canonicalDbType(c: DbColumn): string {
  switch (c.dataType) {
    case "character varying":
      return c.charMax === null ? "varchar" : `varchar(${c.charMax})`;
    case "character":
      return c.charMax === null ? "char" : `char(${c.charMax})`;
    case "numeric":
      return c.numPrecision === null
        ? "numeric"
        : `numeric(${c.numPrecision}, ${c.numScale})`;
    case "USER-DEFINED":
      // Enums surface as USER-DEFINED; the real name is in udt_name.
      return c.udtName;
    default:
      return c.dataType;
  }
}

/** Drizzle spells a few types differently from information_schema. */
function canonicalDrizzleType(sqlType: string): string {
  const t = sqlType.toLowerCase().trim();
  if (t === "timestamp with time zone") return "timestamp with time zone";
  if (t === "timestamp") return "timestamp without time zone";
  // Same pair for `time`: Drizzle emits the short spelling, information_schema the long
  // one. They are the same type, so treating them as a mismatch would report a fault
  // that is not there — and a parity test that cries wolf stops being read.
  if (t === "time with time zone") return "time with time zone";
  if (t === "time") return "time without time zone";
  return t;
}

beforeAll(async () => {
  if (!configured) return;
  client = new pg.Client({
    connectionString: OWNER_URL,
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();

  const { rows } = await client.query<DbColumn>(`
    SELECT table_name             AS "table",
           column_name            AS "column",
           data_type              AS "dataType",
           udt_name               AS "udtName",
           character_maximum_length AS "charMax",
           numeric_precision      AS "numPrecision",
           numeric_scale          AS "numScale",
           is_nullable            AS "isNullable"
      FROM information_schema.columns
     WHERE table_schema = 'public'
  `);
  columns = new Map(rows.map((r) => [`${r.table}.${r.column}`, r]));
  dbTables = new Set(rows.map((r) => r.table));
}, 60_000);

afterAll(async () => {
  if (configured) await client.end();
});

/** Every exported Drizzle table, paired with the SQL table name it claims. */
const modelled: Array<[string, PgTable]> = Object.values(schema)
  .filter((v): v is PgTable => is(v, PgTable))
  .map((t) => [getTableConfig(t).name, t]);

// A silently empty list would make every assertion below pass while testing nothing.
if (configured && modelled.length === 0) {
  throw new Error("No Drizzle tables discovered in schema.ts — the parity test is inert.");
}

describe.skipIf(!configured)("every table in schema.ts exists in the database", () => {
  it.each(modelled.map(([name]) => name))("%s", (name) => {
    expect(dbTables.has(name)).toBe(true);
  });
});

describe.skipIf(!configured)("column types match between schema.ts and the database", () => {
  it.each(modelled)("%s", (tableName, table) => {
    const config = getTableConfig(table);
    const mismatches: string[] = [];

    for (const col of config.columns) {
      const key = `${tableName}.${col.name}`;
      const dbCol = columns.get(key);

      if (!dbCol) {
        mismatches.push(`${key}: declared in schema.ts, MISSING from the database`);
        continue;
      }

      const want = canonicalDrizzleType(col.getSQLType());
      const got = canonicalDbType(dbCol);
      if (want !== got) {
        mismatches.push(`${key}: schema.ts says ${want}, database has ${got}`);
      }

      // A NOT NULL that exists in only one place is how a null reaches code that
      // was written on the assumption it could not.
      const dbNotNull = dbCol.isNullable === "NO";
      if (col.notNull !== dbNotNull) {
        mismatches.push(
          `${key}: schema.ts notNull=${col.notNull}, database notNull=${dbNotNull}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });
});

describe.skipIf(!configured)("the database has no columns schema.ts does not know about", () => {
  it.each(modelled)("%s", (tableName, table) => {
    const declared = new Set(getTableConfig(table).columns.map((c) => c.name));
    const extra = [...columns.values()]
      .filter((c) => c.table === tableName && !declared.has(c.column))
      .map((c) => `${c.table}.${c.column}`);

    // An unmodelled column is not always a bug, but it is always something to know
    // about — silently ignored columns are where data goes to be forgotten.
    expect(extra).toEqual([]);
  });
});

describe.skipIf(!configured)("money columns are numeric, never floating point", () => {
  it("no double precision or real column exists anywhere", () => {
    const floats = [...columns.values()]
      .filter((c) => c.dataType === "double precision" || c.dataType === "real")
      .map((c) => `${c.table}.${c.column} (${c.dataType})`);

    // Not merely a money rule. A float anywhere in a financial schema is a rounding
    // error waiting for a month-end close, so the whole database is checked.
    expect(floats).toEqual([]);
  });

  it("every amount column is numeric(18, 4)", () => {
    const moneyish = /^(amount|debit|credit|rate|total|subtotal|late_fee|gst_amount|quantity|society_turnover|monthly_threshold_per_member|annual_turnover_threshold)$/;
    const wrong = [...columns.values()]
      .filter((c) => moneyish.test(c.column))
      // gst_rate and late_fee_percent_per_month are percentages, not amounts.
      .filter((c) => !(c.numPrecision === 5 && c.numScale === 2))
      .filter((c) => !(c.dataType === "numeric" && c.numPrecision === 18 && c.numScale === 4))
      .map((c) => `${c.table}.${c.column} is ${canonicalDbType(c)}`);

    expect(wrong).toEqual([]);
  });
});
