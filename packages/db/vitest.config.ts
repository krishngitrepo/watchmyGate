import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Load the repo-root .env before tests start.
 *
 * The isolation tests need DATABASE_URL and DATABASE_MIGRATION_URL. Without this they
 * skip themselves — which is worse than failing, because the run still goes green while
 * the isolation guarantee goes unverified.
 *
 * Doing it here rather than in the npm script means plain `npm test` from the repo root
 * exercises them, with no --env-file flag to remember and no shell gymnastics.
 */
const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export default defineConfig({
  test: {
    // Isolation tests talk to a real database in Singapore. The default 5s timeout is
    // shorter than a cold Neon connection from India.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // These tests share fixture rows and assert on exact row counts, so they must not
    // interleave with each other.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
