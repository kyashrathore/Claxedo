import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["e2e/helpers/*.test.ts"],
    environment: "node",
  },
})
