import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The checkout root, found by walking up for `.git`.
 *
 * Works identically from `src/` under the watcher and from `dist/` under `node`, and is
 * unaffected by the directory the process was launched in. Falls back to the current
 * directory if no marker is found, which only happens outside a checkout.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Load the repository's `.env` into `process.env`, if there is one.
 *
 * The API is started by `nest start`, which runs with `apps/api` as the working
 * directory — so Node's own `--env-file` flag cannot be pointed at the root `.env` from
 * the npm script the way `apps/worker` does it. Without this the process died at boot
 * with "DATABASE_URL: Required" despite a perfectly good `.env` two directories up.
 *
 * Deliberately does **not** overwrite variables that are already set: a value exported
 * by the shell, injected by Cloud Run, or written by CI must win over a stale file
 * someone left in their checkout.
 */
export function loadRepoEnv(): void {
  const path = join(repoRoot(), ".env");
  if (!existsSync(path)) return;

  try {
    process.loadEnvFile(path);
  } catch {
    // A malformed .env must not stop a container that already has its configuration
    // from the environment. `loadConfig` reports what is actually missing.
    return;
  }

  // `loadEnvFile` overwrites, so anything the environment already had is put back.
  for (const [key, value] of originalEnv) process.env[key] = value;
}

/**
 * Snapshot of the environment as the process was launched, taken at import — before
 * anything has had the chance to load a file over it.
 */
const originalEnv = new Map(Object.entries(process.env) as [string, string][]);
