import { defineConfig, loadEnv, type HtmlTagDescriptor, type Plugin, type UserConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"
import { resolveBrowserAuthBuildSelection } from "./vite.browser-auth"

/**
 * The chunks the authenticated app awaits BEFORE first paint. app/entry/app.tsx's
 * preloadClaxedoAppShell() dynamic-imports runtime-providers, whose
 * preloadRuntimeProviders() then awaits feature-ports + secondary-feature-ports
 * and finally app-shell-bootstrap. Vite only emits <link rel="modulepreload">
 * for the entry's STATIC imports, so without help the browser discovers each of
 * these only when the previous module executes — a 3-hop network waterfall
 * (main → runtime-providers → feature-ports → app-shell-bootstrap) on the
 * critical path. Keep in sync with preloadRuntimeProviders() in
 * src/app/entry/runtime-providers.tsx and BOOT_CLOSURE_ROOTS in
 * scripts/check-forbidden-eager-deps.ts.
 */
const BOOT_CHUNK_NAMES = ["runtime-providers", "feature-ports", "secondary-feature-ports", "app-shell-bootstrap"]

/**
 * Injects <link rel="modulepreload"> for the boot chunks (and their static
 * import closure) into the built index.html, so they download in parallel with
 * the entry chunk instead of serially after it executes. Hash-safe: file names
 * are read from the emitted bundle, never hardcoded. Applies to any HTML input
 * built with this config (cloud, local via vite.local.config.ts, demo) — the
 * plugin only acts on chunk names it finds in that build's bundle.
 */
function bootChunkModulepreloadPlugin(): Plugin {
  let base = "/"
  return {
    name: "claxedo:boot-chunk-modulepreload",
    apply: "build",
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const bundle = ctx.bundle
        if (!bundle) return
        // Vite already emits modulepreload links for the entry's static
        // imports (vendor-solid, vendor-better-auth); skip those and the entry.
        const seen = new Set<string>()
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk" && output.isEntry) {
            seen.add(output.fileName)
            for (const imported of output.imports) seen.add(imported)
          }
        }
        const files: string[] = []
        const add = (fileName: string) => {
          if (seen.has(fileName)) return
          seen.add(fileName)
          const chunk = bundle[fileName]
          if (!chunk || chunk.type !== "chunk") return
          files.push(fileName)
          // A modulepreload does not fetch the module's own static imports,
          // so walk them too — they are needed before boot evaluation anyway.
          for (const imported of chunk.imports) add(imported)
        }
        for (const name of BOOT_CHUNK_NAMES) {
          for (const output of Object.values(bundle)) {
            if (output.type === "chunk" && !output.isEntry && output.name === name) add(output.fileName)
          }
        }
        return files.map<HtmlTagDescriptor>((fileName) => ({
          tag: "link",
          attrs: { rel: "modulepreload", crossorigin: true, href: `${base}${fileName}` },
          injectTo: "head",
        }))
      },
    },
  }
}

const normalizePath = (p: string) => p.replace(/\\/g, "/")
const shikiThemesDist = normalizePath(
  fileURLToPath(
    new URL("../../node_modules/.bun/@shikijs+themes@4.2.0/node_modules/@shikijs/themes/dist/", import.meta.url),
  ),
)

const isDemoBuild = process.env.CLAXEDO_BUILD_TARGET === "demo"

/**
 * Cloud-specific Vite configuration for Claxedo.
 */
function cloudConfig({ mode }: { mode: string }): UserConfig {
  const env = loadEnv(mode, process.cwd(), "VITE_")
  const browserAuth = resolveBrowserAuthBuildSelection(
    env.VITE_CLAXEDO_AUTH_ADAPTER || process.env.VITE_CLAXEDO_AUTH_ADAPTER,
  )
  // 2593 tracks DEFAULT_CLAXEDO_SERVER_PORT in claxedo-server (see
  // src/deployments/local/port.ts) — the port `claxedo-server dev` listens on.
  const backendTarget = env.VITE_CLAXEDO_SERVER_URL || env.VITE_OPENCODE_BACKEND_URL || "http://127.0.0.1:2593"
  return {
    define: {
      __DEMO_ENABLED__: JSON.stringify(isDemoBuild || mode === "development"),
    },
    plugins: [solidPlugin(), tailwindcss(), bootChunkModulepreloadPlugin()],
    publicDir: "public",
    server: {
      host: "0.0.0.0",
      allowedHosts: true,
      port: Number(process.env.PORT) || 4444,
      strictPort: true,
      proxy: [
        "/agent",
        "/api",
        "/auth",
        "/command",
        "/config",
        "/event",
        "/experimental",
        "/file",
        "/find",
        "/formatter",
        "/global",
        "/instance",
        "^/log(/.*)?$",
        "/lsp",
        "/mcp",
        "/path",
        "/permission",
        "/project",
        "/provider",
        "/pty",
        "/question",
        "/session",
        "/skill",
        "/sync",
        "/tui",
        "/vcs",
      ].reduce<Record<string, { target: string; changeOrigin: boolean; ws?: boolean }>>((acc, route) => {
        acc[route] = { target: backendTarget, changeOrigin: true, ws: route === "/event" || route === "/api" }
        return acc
      }, {}),
    },
    worker: {
      format: "es",
    },
    optimizeDeps: {
      exclude: ["@pierre/diffs", "@pierre/theming"],
    },
    build: {
      target: "esnext",
      outDir: isDemoBuild ? "dist-demo" : "dist",
      // PostHog Error Tracking symbolication (deploy-claxedo-app.yml).
      // "hidden" writes *.map files next to each chunk without adding a
      // `//# sourceMappingURL` comment to the bundle, so nothing shipped to
      // Cloudflare Pages ever points at a map file, while the maps still
      // exist on disk for the deploy workflow's `posthog-cli sourcemap
      // inject`/`upload` step to find before it deletes every *.map from
      // the publish directory.
      sourcemap: "hidden",
      rollupOptions: {
        input: isDemoBuild
          ? { demo: fileURLToPath(new URL("./demo/index.html", import.meta.url)) }
          : { main: fileURLToPath(new URL("./index.html", import.meta.url)) },
        output: {
          manualChunks: {
            "vendor-solid": ["solid-js", "solid-js/web", "solid-js/store"],
            ...browserAuth.manualChunks,
          },
        },
      },
    },
    resolve: {
      alias: [
        {
          find: "#browser-auth-adapter",
          replacement: normalizePath(fileURLToPath(new URL(browserAuth.module, import.meta.url))),
        },
        // Keep the terminal backend lazy-loaded without making it configurable.
        {
          find: "#terminal-backend",
          replacement: normalizePath(
            fileURLToPath(new URL("./src/features/terminal/core/backend/xterm.ts", import.meta.url)),
          ),
        },
        {
          find: "@claxedo/agent-event-runtime/contracts",
          replacement: normalizePath(
            fileURLToPath(new URL("../agent-event-runtime/src/contracts/index.ts", import.meta.url)),
          ),
        },
        {
          find: "@claxedo/agent-event-runtime/opencode-compat",
          replacement: normalizePath(
            fileURLToPath(new URL("../agent-event-runtime/src/projections/opencode-compat/index.ts", import.meta.url)),
          ),
        },
        {
          find: "@claxedo/agent-event-runtime",
          replacement: normalizePath(fileURLToPath(new URL("../agent-event-runtime/src/index.ts", import.meta.url))),
        },
        {
          find: /^@shikijs\/themes\/(.+)$/,
          replacement: `${shikiThemesDist}$1.mjs`,
        },
        {
          find: "@shikijs/themes",
          replacement: `${shikiThemesDist}index.mjs`,
        },
        {
          find: "lru_map",
          replacement: normalizePath(fileURLToPath(new URL("./src/lib/lru-map.ts", import.meta.url))),
        },
        // General @/ alias (lowest priority) — resolves to claxedo's own src
        // (upstream packages/app fully vendored; divorce plan 006)
        { find: "@/", replacement: normalizePath(fileURLToPath(new URL("./src/", import.meta.url))) },
      ],
    },
  }
}

export default defineConfig(({ mode }) => cloudConfig({ mode }))
