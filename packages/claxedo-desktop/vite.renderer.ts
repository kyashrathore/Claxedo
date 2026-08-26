import { loadEnv, type UserConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { MAIN_RENDERER_DOCUMENT } from "./src/main/navigation-guard"
import { desktopRendererBoundaryManifestPlugin } from "./scripts/product-boundary-manifests"
import {
  resolveSubtractionManifest,
  type SubtractionManifest,
} from "../claxedo-app/src/platform/performance/subtraction"

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
  const hostedActivationEnabled = env.VITE_AUTH_ENABLED?.trim() === "true"
  const subtraction = resolveSubtractionManifest({
    mode,
    owner: env.VITE_CLAXEDO_SUBTRACTION_OWNER,
  })

  return {
    define: {
      __DEMO_ENABLED__: "false",
      // Replaced before Rollup links the graph. A self-build (unset/false)
      // removes the dynamic import entirely; a release emits it as a hashed
      // chunk while keeping the base document and its startup path local.
      __CLAXEDO_HOSTED_ACTIVATION_ENABLED__: JSON.stringify(hostedActivationEnabled),
      __CLAXEDO_SUBTRACTION_OWNER__: JSON.stringify(subtraction.owner),
    },
    plugins: [
      solidPlugin(),
      tailwindcss(),
      desktopRendererBoundaryManifestPlugin(desktopDir),
      ...(subtraction.diagnosticOnly ? [diagnosticSubtractionManifestPlugin(subtraction)] : []),
    ],
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
          main: normalize(path.join(rendererRoot, MAIN_RENDERER_DOCUMENT)),
          loading: normalize(path.join(rendererRoot, "loading.html")),
        },
        output: {
          // A manual Mermaid diagram chunk must contain only the explicitly
          // selected diagram modules. With Rollup's transitive default, shared
          // Vite/CJS helpers were pulled into that chunk, which made the main
          // entry import and modulepreload 1+ MB of Mermaid on every startup.
          onlyExplicitManualChunks: true,
          // Keep the optional facade recognizable while Rollup owns the
          // dependency-safe split produced by the dynamic import.
          chunkFileNames(chunk) {
            if (chunk.facadeModuleId?.endsWith("/src/renderer/hosted-contributions.ts")) {
              return "assets/desktop-hosted-contributions-[hash].js"
            }
            return "assets/[name]-[hash].js"
          },
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

export function diagnosticSubtractionManifestPlugin(manifest: SubtractionManifest) {
  return {
    name: "claxedo-diagnostic-subtraction-manifest",
    generateBundle(this: { emitFile(asset: { type: "asset"; fileName: string; source: string }): void }) {
      this.emitFile({
        type: "asset",
        fileName: "claxedo-diagnostic-subtraction.json",
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      })
    },
  }
}
