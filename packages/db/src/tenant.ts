/**
 * Tenant scoping — the single entry point for all database access.
 *
 * ## Why this exists
 *
 * Isolation between societies is enforced by Postgres Row-Level Security, not by
 * application code remembering to add `WHERE society_id = ...`. Each policy compares
 * against `current_setting('app.society_id')`, so that setting must be present on the
 * connection running the query.
 *
 * Neon pools connections in **transaction mode**, which means session state does not
 * survive between queries — a plain `SET` would leak into, or be lost by, an unrelated
 * request. `set_config(..., is_local => true)` is transaction-scoped and therefore
 * correct under transaction pooling, but only *inside an explicit transaction*.
 *
 * Hence the rule: **every query runs inside `withTenant`.** ESLint bans importing the
 * raw pool anywhere else.
 *
 * ## Fails closed
 *
 * `nullif(current_setting('app.society_id', true), '')` yields NULL when unset, the
 * policy comparison becomes NULL, and an unscoped query returns **zero rows** rather
 * than every society's data.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
export type TenantTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

let pool: pg.Pool | undefined;
let db: Database | undefined;

/** Money arrives as `numeric` — parse to string, never to float. */
function configureTypeParsers(): void {
  // 1700 = numeric. node-postgres would otherwise hand back a JS number and silently
  // destroy precision on every currency column before our code ever sees it.
  pg.types.setTypeParser(1700, (value: string) => value);
  // 20 = int8. Return as string to avoid silent overflow above 2^53.
  pg.types.setTypeParser(20, (value: string) => value);
}

export function initDatabase(connectionString: string): Database {
  if (db) return db;

  configureTypeParsers();

  pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DB_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Neon requires TLS.
    ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: true },
  });

  db = drizzle(pool, { schema });
  return db;
}

export function getDatabase(): Database {
  if (!db) {
    throw new Error("Database not initialised. Call initDatabase() at boot.");
  }
  return db;
}

export async function closeDatabase(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}

/**
 * Run work inside a transaction scoped to one society.
 *
 * Commits on clean return, rolls back on throw.
 *
 * @example
 * const units = await withTenant(societyId, async (tx) =>
 *   tx.select().from(schema.units),
 * );
 */
export async function withTenant<T>(
  societyId: string,
  fn: (tx: TenantTx) => Promise<T>,
  opts: { actorId?: string } = {},
): Promise<T> {
  return getDatabase().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.society_id', ${societyId}, true)`,
    );
    if (opts.actorId) {
      await tx.execute(sql`SELECT set_config('app.actor_id', ${opts.actorId}, true)`);
    }
    return fn(tx);
  });
}

/**
 * Run work with **no** tenant scope.
 *
 * Only legitimate for genuinely cross-tenant work: login before a society is chosen,
 * super-admin portfolio reads, and scheduled jobs that sweep every tenant.
 *
 * This grants no bypass. The application role is NOBYPASSRLS, so tenant-scoped tables
 * still return zero rows here — this is for tables that carry no `society_id` at all,
 * such as `persons` and `sessions`.
 *
 * The `reason` is required and logged, so the audit surface stays reviewable.
 */
export async function withoutTenant<T>(
  reason: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  // eslint-disable-next-line no-console -- replaced by Pino in the API bootstrap
  console.info(JSON.stringify({ event: "unscoped_db_access", reason }));
  return getDatabase().transaction(fn);
}

/**
 * Tenant-scoped access performed by the platform rather than a signed-in user.
 *
 * Used by the worker: billing runs, SLA sweeps, approval-ladder timers. Identical
 * scoping to `withTenant`, logged distinctly so background writes are distinguishable
 * from user actions when reading an incident timeline.
 */
export async function withSystemTenant<T>(
  societyId: string,
  reason: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  // eslint-disable-next-line no-console
  console.info(JSON.stringify({ event: "system_db_access", societyId, reason }));
  return withTenant(societyId, fn);
}

export { schema };
