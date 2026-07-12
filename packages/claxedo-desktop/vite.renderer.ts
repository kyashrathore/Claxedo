import { loadEnv, type UserConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"
import { fileURLToPath } from "node:url"

const normalize = (value: string) => value.replaceAll("\\", "/")

export const desktopDir = normalize(fileURLToPath(new URL("./", import.meta.url)))
export const claxedoAppDir = normalize(fileURLToPath(new URL("../claxedo-app/", import.meta.url)))
const agentEventRuntimeDir = normalize(fileURLToPath(new URL("../agent-event-runtime/", import.meta.url)))
const rendererRoot = normalize(path.join(desktopDir, "src/renderer"))
// Post-divorce (plan 006): the renderer resolves @/ against claxedo-app, not packages/app.
const upstreamRoot = normalize(fileURLToPath(new URL("../claxedo-app/src/", import.meta.url)))
export function createElectronRenderer(mode: string): UserConfig {
  const env = loadEnv(mode, claxedoAppDir, "VITE_")
  const terminal = env.VITE_TERMINAL_BACKEND || "xterm"

  return {
    define: {
      __DEMO_ENABLED__: "false",
    },
    plugins: [solidPlugin(), tailwindcss()],
    publicDir: normalize(path.join(claxedoAppDir, "public")),
    root: rendererRoot,
    worker: {
      format: "es",
    },
    build: {
      rollupOptions: {
        input: {
          main: normalize(path.join(rendererRoot, "index.html")),
          loading: normalize(path.join(rendererRoot, "loading.html")),
        },
        output: {
          manualChunks(id) {
            // Mermaid's classDiagram and classDiagram-v2 are separate dynamic
            // imports that produce byte-identical chunks. Merge them.
            if (/mermaid[^]*\/classDiagram/.test(id)) {
              return "mermaid-classDiagram"
            }
          },
        },
      },
    },
    resolve: {
      alias: [
        {
          find: /^@tanstack\/solid-query$/,
          replacement: normalize(path.join(upstreamRoot, "../node_modules/@tanstack/solid-query")),
        },
        {
          find: "#terminal-backend",
          replacement: normalize(path.join(claxedoAppDir, `src/features/terminal/core/backend/${terminal}.ts`)),
        },
        {
          find: "@opencode-ai/app-shared",
          replacement: normalize(path.join(claxedoAppDir, "src/features/extensions/data/index.ts")),
        },
        {
          find: /^@claxedo\/app$/,
          replacement: normalize(path.join(claxedoAppDir, "src/app/entry/index.tsx")),
        },
        {
          find: /^@claxedo\/agent-event-runtime$/,
          replacement: normalize(path.join(agentEventRuntimeDir, "src/index.ts")),
        },
        {
          find: /^@claxedo\/agent-event-runtime\/contracts$/,
          replacement: normalize(path.join(agentEventRuntimeDir, "src/contracts/index.ts")),
        },
        {
          find: /^@claxedo\/agent-event-runtime\/opencode-compat$/,
          replacement: normalize(path.join(agentEventRuntimeDir, "src/projections/opencode-compat/index.ts")),
        },
        {
          find: "@/",
          replacement: upstreamRoot,
        },
      ],
    },
  }
}
