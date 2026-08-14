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

  await provisionAppRole(client);

  await client.end();
  console.info("migrations up to date");
}

/**
 * Give the application role its login credential.
 *
 * Migration 0001 creates `watchmygate_app` NOLOGIN with no password, because a secret
 * in a committed .sql file is a secret that eventually ships. The password lives only
 * in the environment and is applied here.
 *
 * Idempotent: re-running rotates the password to whatever APP_DB_PASSWORD currently
 * holds, which is also how a rotation is performed.
 */
async function provisionAppRole(client: pg.Client): Promise<void> {
  const password = process.env.APP_DB_PASSWORD;
  if (!password) {
    console.warn(
      "APP_DB_PASSWORD not set — watchmygate_app stays NOLOGIN and the API cannot " +
        "connect. Set it and re-run to provision the application role.",
    );
    return;
  }
  if (password.includes("PLACEHOLDER") || password.length < 16) {
    throw new Error(
      "APP_DB_PASSWORD is a placeholder or too short. This role guards tenant " +
        "isolation — give it a real, generated password of at least 16 characters.",
    );
  }

  // Identifier is a literal, so only the password is parameterised — and ALTER ROLE
  // does not accept bind parameters, hence the explicit quoting of the literal.
  await client.query(
    `ALTER ROLE watchmygate_app LOGIN PASSWORD ${client.escapeLiteral(password)}`,
  );

  // Belt and braces: assert the attribute the whole isolation model depends on.
  const { rows } = await client.query<{ rolbypassrls: boolean; rolcanlogin: boolean }>(
    "SELECT rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'watchmygate_app'",
  );
  if (rows[0]?.rolbypassrls) {
    throw new Error(
      "watchmygate_app has BYPASSRLS. Every society's data is readable through it. " +
        "Refusing to continue.",
    );
  }
  console.info("application role provisioned (LOGIN, NOBYPASSRLS)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
