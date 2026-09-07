// `src/**/*.vitest.ts(x)` files are excluded from tsconfig.json, so this runner
// is the only thing that ever compiles them; a type error there surfaces here.
import { defineConfig } from "vitest/config"
import type { UserConfig } from "vitest/config"
import solid from "vite-plugin-solid"
import { fileURLToPath } from "node:url"

const normalizePath = (p: string) => p.replace(/\\/g, "/")

// vitest 2.1.9 bundles its own `vite@5` type declarations, while this package
// (and `vite-plugin-solid`) build against the workspace's `vite@7`. The plugin
// object is the same value at runtime; the two `.d.ts` copies just disagree
// nominally on the `UserConfig` inside `Plugin["apply"]`. There is no way to
// state "these are the same type" — the bridge goes away when vitest is on a
// vite@7-compatible major, not before.

export default defineConfig({
  plugins: [solid() as NonNullable<UserConfig["plugins"]>[number]] satisfies UserConfig["plugins"],
  resolve: {
    conditions: ["development", "browser"],
    alias: [
      {
        find: "#terminal-backend",
        replacement: normalizePath(fileURLToPath(new URL("./src/features/terminal/core/backend/xterm.ts", import.meta.url))),
      },
      {
        find: "@opencode-ai/app-shared",
        replacement: normalizePath(fileURLToPath(new URL("./src/features/extensions/data/index.ts", import.meta.url))),
      },
      {
        find: "@claxedo/agent-event-runtime/contracts",
        replacement: normalizePath(fileURLToPath(new URL("../agent-event-runtime/src/contracts/index.ts", import.meta.url))),
      },
      {
        find: "@claxedo/agent-event-runtime/client-presentation",
        replacement: normalizePath(fileURLToPath(new URL("../agent-event-runtime/src/projections/client-presentation/index.ts", import.meta.url))),
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
