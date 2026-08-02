import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // 2-core CI runners under a concurrent turbo task starve wall-clock tests
    // past vitest's 5s default; budget for starvation like claxedo-server does.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  test: {
    globals: true,
  },
})
