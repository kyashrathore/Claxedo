import { loadEnv, type UserConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { MAIN_RENDERER_DOCUMENT } from "./src/main/navigation-guard"
import { desktopRendererBoundaryManifestPlugin } from "./scripts/product-boundary-manifests"

const normalize = (value: string) => value.replaceAll("\\", "/")

export const desktopDir = normalize(fileURLToPath(new URL("./", import.meta.url)))
export const claxedoAppDir = normalize(fileURLToPath(new URL("../claxedo-app/", import.meta.url)))
const agentEventRuntimeDir = normalize(fileURLToPath(new URL("../agent-event-runtime/", import.meta.url)))
const rendererRoot = normalize(path.join(desktopDir, "src/renderer"))
// Post-divorce (plan 006): the renderer resolves @/ against claxedo-app, not packages/app.
const upstreamRoot = normalize(fileURLToPath(new URL("../claxedo-app/src/", import.meta.url)))
export function createElectronRenderer(mode: string): UserConfig {
  const env = loadEnv(mode, claxedoAppDir, "VITE_")
  const terminal = env.VITE_TERMINAL_BACKEND || process.env.VITE_TERMINAL_BACKEND || "xterm"
  // `loadEnv` only copies prefixed process.env keys when a matching .env file
  // exists. This worktree has none, so a signed inner build must also read
  // VITE_AUTH_ENABLED from the process (same precedence the contract tests
  // document for `.env.local`).
  const hostedActivationEnabled =
    (env.VITE_AUTH_ENABLED ?? process.env.VITE_AUTH_ENABLED)?.trim() === "true"
  const viteFlag = (name: string) =>
    (env[name] ?? process.env[name])?.trim() === "true" ? "true" : ""
  const localServerUrl = env.VITE_CLAXEDO_SERVER_URL?.trim() || "http://127.0.0.1:2593"
  // The hosted app a PHONE must open, baked per build.
  //
  // `loadEnv` reads these from claxedo-app, but `root` is the RENDERER
  // directory, so Vite's own env handling never sees them — anything not
  // explicitly forwarded through `define` below is simply absent at runtime.
  // `VITE_CLAXEDO_APP_ORIGIN` was read by `remoteAccessAppOrigin()` and
  // forwarded by nobody, so it was always undefined and the resolver fell
  // through to its hardcoded production default: a STAGING desktop handed
  // phones a `app.claxedo.com` QR code, which renders a blank page there
  // because the workspace does not exist on that control plane.
  const appOrigin = env.VITE_CLAXEDO_APP_ORIGIN?.trim() ?? ""

  return {
    define: {
      __DEMO_ENABLED__: "false",
      __CLAXEDO_AGENT_PLUGINS_ENABLED__: JSON.stringify(process.env.CLAXEDO_AGENT_PLUGINS?.trim() === "1"),
      // Replaced before Rollup links the graph. A self-build (unset/false)
      // removes the dynamic import entirely; a release emits it as a hashed
      // chunk while keeping the base document and its startup path local.
      __CLAXEDO_HOSTED_ACTIVATION_ENABLED__: JSON.stringify(hostedActivationEnabled),
      // Empty when unset, which `remoteAccessAppOrigin()` treats as "not
      // baked" and falls back from — rather than baking the string
      // "undefined", which is truthy and would be handed to a phone verbatim.
      "import.meta.env.VITE_CLAXEDO_APP_ORIGIN": JSON.stringify(appOrigin),
    },
    plugins: [solidPlugin(), tailwindcss(), desktopRendererBoundaryManifestPlugin(desktopDir)],
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
    server:
      mode === "development"
        ? {
            proxy: {
              "/api/claxedo/credentials": { target: localServerUrl, changeOrigin: true },
              "/api/claxedo/integrations": { target: localServerUrl, changeOrigin: true },
            },
          }
        : undefined,
    build: {
      // PostHog Error Tracking symbolication (release-claxedo.yml). Without
      // maps a desktop stack frame arrives as `main-Ci34eFPC.js:1:284915`,
      // which is untriageable. "hidden" writes *.map next to each chunk but
      // adds no `//# sourceMappingURL` comment, so the packaged app never
      // points at a map; the release workflow uploads them to PostHog and then
      // deletes every *.map before packaging. Mirrors claxedo-app's
      // vite.cloud.config.ts.
      sourcemap: "hidden",
      // electron-vite's renderer preset defaults minify off (plain Vite would
      // default to esbuild). Minified chunks still symbolicate through the
      // hidden maps above, so PostHog triage is unaffected.
      minify: "esbuild",
      rollupOptions: {
        input: {
          main: normalize(path.join(rendererRoot, MAIN_RENDERER_DOCUMENT)),
          loading: normalize(path.join(rendererRoot, "loading.html")),
        },
        output: {
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
