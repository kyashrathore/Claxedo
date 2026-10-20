import { defineConfig, loadEnv, type Plugin, type UserConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { resolveAccountBindingSelection, type AccountBindingBuildSelection, type AccountBindingId } from "./vite.account-binding"
import { claxedoFrameRuntime } from "./vite.frame-runtime"
import { claxedoPluginBundles, workspaceSourceExport } from "./vite.plugin-bundles"
import { webDocumentPlugins } from "./vite.web-document"

const normalizePath = (p: string) => p.replace(/\\/g, "/")
const shikiThemesDist = normalizePath(
  fileURLToPath(
    new URL("../../node_modules/.bun/@shikijs+themes@4.2.0/node_modules/@shikijs/themes/dist/", import.meta.url),
  ),
)

/**
 * Local signed web development runs the dev server over TLS: the browser
 * client's auth contract requires exact HTTPS origins, and the `Secure`
 * session cookie needs one. `script/dev-tls.ts` mints the certificate;
 * `CLAXEDO_DEV_TLS=1` turns it on. Absent, the dev server stays plain HTTP.
 */
function devTls(): { key: Buffer; cert: Buffer } | undefined {
  if (process.env.CLAXEDO_DEV_TLS?.trim() !== "1") return undefined
  const dir = new URL("./.artifacts/dev-tls/", import.meta.url)
  return {
    key: readFileSync(new URL("key.pem", dir)),
    cert: readFileSync(new URL("cert.pem", dir)),
  }
}

const localeFile = /\/src\/(?:(?:[^/]+\/)+locales|i18n\/errors)\/([a-z]+)\.ts$/

function localeChunk(id: string): string | undefined {
  const match = localeFile.exec(normalizePath(id))
  return match && match[1] !== "en" ? `locale-${match[1]}` : undefined
}

const vendorChunks: Record<string, readonly string[]> = {
  "vendor-solid": ["solid-js", "@solid-primitives"],
  "vendor-ui": ["@kobalte", "@floating-ui", "@corvu", "@solidjs", "solid-prevent-scroll", "solid-presence", "solid-list", "motion", "framer-motion", "motion-dom", "motion-utils"],
  "vendor-toast": ["solid-sonner"],
  "vendor-query": ["@tanstack"],
  "vendor-markdown": ["marked", "dompurify", "morphdom", "hast-util-to-html", "property-information", "character-entities-html4", "character-entities-legacy", "stringify-entities", "remend", "comma-separated-tokens", "space-separated-tokens", "html-void-elements", "ccount", "zwitch"],
}

function vendorChunk(id: string, binding: AccountBindingBuildSelection): string | undefined {
  const path = normalizePath(id)
  if (!path.includes("/node_modules/")) return undefined
  const chunks: Record<string, readonly string[]> = { ...vendorChunks, ...binding.manualChunks }
  for (const [chunk, packages] of Object.entries(chunks)) {
    if (packages.some((name) => path.includes(`/node_modules/${name}/`))) return chunk
  }
  return undefined
}

const frameRuntimeEntry = normalizePath(fileURLToPath(new URL("./src/plugins/frame/runtime/index.ts", import.meta.url)))

const appSourceRoots = [
  fileURLToPath(new URL("./src/", import.meta.url)),
  fileURLToPath(new URL("../ui/src/", import.meta.url)),
  fileURLToPath(new URL("../account-contract/src/", import.meta.url)),
  fileURLToPath(new URL("../agent-runtime-contract/src/", import.meta.url)),
].map(normalizePath)

/**
 * The app's own modules, the kit's and the contracts' do nothing at load but
 * declare (the app forbids module-level state; the kit's package.json names
 * only its stylesheets as side effects; the contracts are tables and types), so
 * a module none of an entry's imports use is left out of that entry's graph.
 * Without this Rollup assigns every module reachable through a domain's
 * index.ts to the chunk shared by both documents, and the signed-out document
 * carried the consent and device screens, the server adapter's account modules
 * with TanStack Query, the side panel controls and 44 kB of contract tables for
 * an entry that renders one form. Stylesheets keep Vite's own marking.
 */
function moduleSideEffects(id: string): boolean {
  const path = normalizePath(id)
  if (path.endsWith(".css") || path.includes("?")) return true
  return !appSourceRoots.some((root) => path.startsWith(root))
}


function claxedoWorkspaceSource(): Plugin {
  return {
    name: "claxedo-workspace-source",
    enforce: "pre",
    resolveId(source) {
      const match = /^(@claxedo\/[^/]+)(\/.+)?$/.exec(source)
      if (!match) return null
      const module = workspaceSourceExport(match[1], match[2] ? `.${match[2]}` : ".")
      if (!module) return null
      const id = normalizePath(module.path)
      return module.sideEffects ? id : { id, moduleSideEffects: false }
    },
  }
}

/**
 * Cloud-specific Vite configuration for Claxedo.
 */
export function cloudConfig({ mode }: { mode: string }, binding?: AccountBindingId): UserConfig {
  const env = loadEnv(mode, process.cwd(), "VITE_")
  const accountBinding = resolveAccountBindingSelection(
    binding ?? (env.VITE_CLAXEDO_AUTH_ADAPTER || process.env.VITE_CLAXEDO_AUTH_ADAPTER),
  )
  // The app reaches its server on its own origin, so the dev server forwards
  // the server's routes to `CLAXEDO_DEV_PROXY_TARGET`, else to 2593, the
  // DEFAULT_CLAXEDO_SERVER_PORT of claxedo-local-server
  // (src/deployments/local/port.ts) the desktop's local server listens on.
  const backendTarget = process.env.CLAXEDO_DEV_PROXY_TARGET || "http://127.0.0.1:2593"
  return {
    plugins: [claxedoPluginBundles(), claxedoFrameRuntime(frameRuntimeEntry), claxedoWorkspaceSource(), solidPlugin(), tailwindcss(), ...webDocumentPlugins()],
    publicDir: "public",
    server: {
      host: "0.0.0.0",
      allowedHosts: true,
      port: Number(process.env.PORT) || 4445,
      strictPort: true,
      ...(devTls() ? { https: devTls() } : {}),
      proxy: [
        "/api",
        "/experimental",
        "/file",
        "/find",
        "/path",
        "/permission",
        "/provider",
        "/question",
        "/session",
      ].reduce<Record<string, { target: string; changeOrigin: boolean; ws?: boolean }>>((acc, route) => {
        acc[route] = { target: backendTarget, changeOrigin: true, ws: route === "/api" }
        return acc
      }, {}),
    },
    worker: {
      format: "es",
      plugins: () => [claxedoWorkspaceSource(), solidPlugin()],
      // A worker build does not inherit the page build's `generatedCode:
      // "es2015"`. Without it the markdown worker's shiki grammars and themes
      // render `var` where @pierre/diffs' copies in the page build render
      // `const`, so each lands twice under two hashes (336 chunks, 8.6 MB raw)
      // and a reader who meets a language in a code block and in a diff
      // fetches its grammar twice.
      rollupOptions: { output: { generatedCode: "es2015" } },
    },
    optimizeDeps: {
      exclude: ["@pierre/diffs", "@pierre/theming"],
    },
    build: {
      target: "esnext",
      outDir: "dist",
      // Two-pass terser writes the web entry graph 32,838 bytes raw and 21,197
      // brotli smaller than esbuild (1,973,766 against 2,006,604 raw) for a build
      // that takes 23 s instead of 13 s; the desktop renderer keeps esbuild in
      // vite.renderer.ts.
      minify: "terser",
      terserOptions: { compress: { passes: 2 } },
      // "hidden" writes *.map files next to each chunk without adding a
      // `//# sourceMappingURL` comment to the bundle, so nothing the app
      // Worker serves points at a map file; the deploy deletes every *.map
      // from the publish directory (prepareBrowserArtifactsForWorkers) and
      // the desktop release uploads its own maps to PostHog.
      sourcemap: "hidden",
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
          login: fileURLToPath(new URL("./login.html", import.meta.url)),
          browserPreview: fileURLToPath(new URL("./browser-preview.html", import.meta.url)),
        },
        treeshake: { moduleSideEffects },
        output: {
          manualChunks: (id) => localeChunk(id) ?? vendorChunk(id, accountBinding),
        },
      },
    },
    resolve: {
      alias: [
        {
          find: "#account-binding",
          replacement: normalizePath(fileURLToPath(new URL(accountBinding.module, import.meta.url))),
        },
        // Keep the terminal backend lazy-loaded without making it configurable.
        {
          find: "#terminal-backend",
          replacement: normalizePath(
            fileURLToPath(new URL("./src/terminal/backend/xterm.ts", import.meta.url)),
          ),
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
          find: "@claxedo/app/ui",
          replacement: normalizePath(fileURLToPath(new URL("./src/ui/index.ts", import.meta.url))),
        },
        {
          find: "lru_map",
          replacement: normalizePath(fileURLToPath(new URL("./src/transcript/diff/lru-map.ts", import.meta.url))),
        },
        // General @/ alias (lowest priority) — resolves to claxedo's own src
        // (upstream packages/app fully vendored; divorce plan 006)
        { find: "@/", replacement: normalizePath(fileURLToPath(new URL("./src/", import.meta.url))) },
      ],
    },
  }
}

export default defineConfig(({ mode }) => cloudConfig({ mode }))
