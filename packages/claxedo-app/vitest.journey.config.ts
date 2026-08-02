import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { conditions: ["development", "node"] },
  test: {
    environment: "node",
    include: ["e2e/bun/journey-local.journey.ts"],
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
