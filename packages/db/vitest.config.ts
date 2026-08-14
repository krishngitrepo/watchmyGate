import { defineConfig } from "vitest/config";

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
