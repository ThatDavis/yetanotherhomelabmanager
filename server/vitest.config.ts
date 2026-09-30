import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Test files share one dev database; parallel workers race on
    // create/cleanup/rotation. One fork = deterministic, and the suite
    // is fast enough (~10s) that parallelism buys nothing.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
