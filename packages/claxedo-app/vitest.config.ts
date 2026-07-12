import { defineConfig } from "vitest/config"
import type { UserConfig } from "vitest/config"
import solid from "vite-plugin-solid"
import { fileURLToPath } from "node:url"

const normalizePath = (p: string) => p.replace(/\\/g, "/")

export default defineConfig({
  define: {
    __DEMO_ENABLED__: "false",
  },
  plugins: [solid() as unknown as NonNullable<UserConfig["plugins"]>[number]] satisfies UserConfig["plugins"],
  resolve: {
    conditions: ["development", "browser"],
    alias: [
      {
        find: "#terminal-backend",
        replacement: normalizePath(fileURLToPath(new URL("./src/features/terminal/core/backend/xterm.ts", import.meta.url))),
      },
      {
        find: "@opencode-ai/app-shared",
        replacement: normalizePath(fileURLToPath(new URL("./src/extensions/index.ts", import.meta.url))),
      },
      {
        find: "@claxedo/agent-event-runtime/contracts",
        replacement: normalizePath(fileURLToPath(new URL("../agent-event-runtime/src/contracts/index.ts", import.meta.url))),
      },
      {
        find: "@claxedo/agent-event-runtime/opencode-compat",
        replacement: normalizePath(fileURLToPath(new URL("../agent-event-runtime/src/projections/opencode-compat/index.ts", import.meta.url))),
      },
      {
        find: "@claxedo/agent-event-runtime",
        replacement: normalizePath(fileURLToPath(new URL("../agent-event-runtime/src/index.ts", import.meta.url))),
      },
      { find: "@/", replacement: normalizePath(fileURLToPath(new URL("./src/", import.meta.url))) },
    ],
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.vitest.ts", "src/**/*.vitest.tsx"],
  },
})
