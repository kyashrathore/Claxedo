import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["scripts/stress-workgraph.ts"],
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
})
