import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // 2-core CI runners under a concurrent turbo task starve wall-clock tests
    // past vitest's 5s default; budget for starvation like claxedo-server does.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: true,
    // The forks pool with better-sqlite3 loaded in every worker is the known
    // "all tests green, process never exits" hang on Windows CI — this suite
    // never once completed there (runs through 368) while every in-test wait
    // is timeout-bounded. Worker threads exit cleanly, and better-sqlite3 is
    // safe one-connection-per-thread, which is all these tests open.
    pool: "threads",
  },
})
