import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // The first private-file write in a Windows test process starts the
    // PowerShell runner, 1.4 to 5.3 s on the hosted runner, so whichever test
    // writes first would otherwise race the 5 s default.
    ...(process.platform === "win32" ? { testTimeout: 15_000 } : {}),
    setupFiles: ["../../script/test-home/guard.mjs"],
  },
})
