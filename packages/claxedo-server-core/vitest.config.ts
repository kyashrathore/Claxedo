import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    setupFiles: ["../../script/test-home/guard.mjs"],
  },
})
