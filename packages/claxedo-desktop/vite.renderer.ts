import { loadEnv, type UserConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { desktopProductMode, rendererDocument, type DesktopProductMode } from "./src/main/navigation-guard"

const normalize = (value: string) => value.replaceAll("\\", "/")

export const desktopDir = normalize(fileURLToPath(new URL("./", import.meta.url)))
export const claxedoAppDir = normalize(fileURLToPath(new URL("../claxedo-app/", import.meta.url)))
const agentEventRuntimeDir = normalize(fileURLToPath(new URL("../agent-event-runtime/", import.meta.url)))
const rendererRoot = normalize(path.join(desktopDir, "src/renderer"))
// Post-divorce (plan 006): the renderer resolves @/ against claxedo-app, not packages/app.
const upstreamRoot = normalize(fileURLToPath(new URL("../claxedo-app/src/", import.meta.url)))
/**
 * Which product this desktop build is.
 *
 * Resolved from the SAME environment `createElectronRenderer` already loads, by
 * the same function `src/main/windows.ts` reads its baked answer from. Exported
 * so `electron.vite.config.ts` can bake it into the main process without a
 * second `loadEnv` call and a second copy of the rule.
 */
export function desktopProductModeForBuild(mode: string): DesktopProductMode {
  return desktopProductMode(loadEnv(mode, claxedoAppDir, "VITE_"))
}

export function createElectronRenderer(mode: string): UserConfig {
  const env = loadEnv(mode, claxedoAppDir, "VITE_")
  const terminal = env.VITE_TERMINAL_BACKEND || "xterm"
  // Exactly ONE main document, chosen by product.
  //
  // This is the line that stops an unsigned desktop shipping the hosted control
  // plane, and it has to be an INPUT selection rather than a runtime branch:
  // rollup links whatever an input's graph reaches, so listing both documents
  // would put `index.tsx` — and through `@claxedo/app/auth`, `auth-client.ts`
  // and Clerk — into the local artifact no matter which one main then loaded.
  const document = rendererDocument(desktopProductMode(env))

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
    optimizeDeps: {
      // The Markdown highlighter is first reached from a web worker after a
      // session mounts. If Vite discovers it at that point, dependency
      // optimization invalidates the worker's WASM URL and reloads the whole
      // renderer in the middle of hydration.
      include: ["@opencode-ai/session-ui > @shikijs/stream"],
    },
    build: {
      // PostHog Error Tracking symbolication (release-claxedo.yml). Without
      // maps a desktop stack frame arrives as `main-Ci34eFPC.js:1:284915`,
      // which is untriageable. "hidden" writes *.map next to each chunk but
      // adds no `//# sourceMappingURL` comment, so the packaged app never
      // points at a map; the release workflow uploads them to PostHog and then
      // deletes every *.map before packaging. Mirrors claxedo-app's
      // vite.cloud.config.ts.
      sourcemap: "hidden",
      rollupOptions: {
        input: {
          main: normalize(path.join(rendererRoot, document)),
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
