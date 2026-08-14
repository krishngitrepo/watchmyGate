/**
 * Applies the SQL migrations in order.
 *
 * Runs as the **owner** role (`DATABASE_MIGRATION_URL`), not the application role.
 * The application role deliberately has no DDL rights and cannot bypass RLS — running
 * migrations as it would either fail or, worse, quietly grant it more than it should
 * have.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_MIGRATION_URL is not set. Point it at the Neon owner role.",
    );
  }
  if (url.includes("PLACEHOLDER")) {
    throw new Error(
      "DATABASE_MIGRATION_URL still contains a placeholder. Put the real Neon " +
        "connection string in .env before running migrations.",
    );
  }

  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes("localhost") ? false : { rejectUnauthorized: true },
  });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
      (r) => r.name,
    ),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.info(`skip   ${file}`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    console.info(`apply  ${file}`);

    // Each migration is one transaction: a failure leaves nothing half-applied.
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }

  await client.end();
  console.info("migrations up to date");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
