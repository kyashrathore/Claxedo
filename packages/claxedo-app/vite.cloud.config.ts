import { defineConfig, loadEnv, type Plugin, type UserConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname } from "node:path"
import { resolveAccountBindingSelection, type AccountBindingId } from "./vite.account-binding"
import { webContentSecurityPolicyPlugin } from "./vite.content-security-policy"

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

function claxedoWorkspaceSource(): Plugin {
  const roots = [
    fileURLToPath(new URL("./node_modules/", import.meta.url)),
    fileURLToPath(new URL("../../node_modules/", import.meta.url)),
  ]
  const manifestFor = (name: string) => {
    for (const root of roots) {
      const path = `${root}${name}/package.json`
      if (existsSync(path)) return path
    }
    return undefined
  }
  return {
    name: "claxedo-workspace-source",
    enforce: "pre",
    resolveId(source) {
      const match = /^(@claxedo\/[^/]+)(\/.+)?$/.exec(source)
      if (!match) return null
      const manifestPath = manifestFor(match[1])
      if (!manifestPath) return null
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { exports?: Record<string, unknown> }
      const entry = manifest.exports?.[match[2] ? `.${match[2]}` : "."]
      if (!entry || typeof entry !== "object") return null
      const development = (entry as Record<string, unknown>).development
      if (typeof development !== "string") return null
      return normalizePath(realpathSync(`${dirname(manifestPath)}/${development}`))
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
  // 2593 tracks DEFAULT_CLAXEDO_SERVER_PORT in claxedo-server (see
  // src/deployments/local/port.ts) — the port `claxedo-server dev` listens on.
  // `CLAXEDO_DEV_PROXY_TARGET` names the server the dev proxy forwards to when
  // the app's own origin is configured as its server (local signed web
  // development: VITE_CLAXEDO_SERVER_URL is this dev server's HTTPS origin).
  const backendTarget = process.env.CLAXEDO_DEV_PROXY_TARGET
    || env.VITE_CLAXEDO_SERVER_URL
    || "http://127.0.0.1:2593"
  return {
    plugins: [claxedoWorkspaceSource(), solidPlugin(), tailwindcss(), webContentSecurityPolicyPlugin(env.VITE_CLAXEDO_SERVER_URL)],
    publicDir: "public",
    server: {
      host: "0.0.0.0",
      allowedHosts: true,
      port: Number(process.env.PORT) || 4445,
      strictPort: true,
      ...(devTls() ? { https: devTls() } : {}),
      proxy: [
        "/agent",
        "/api",
        "/auth",
        "/command",
        "/config",
        "/experimental",
        "/file",
        "/find",
        "/formatter",
        "/global",
        "/instance",
        "^/log(/.*)?$",
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
        acc[route] = { target: backendTarget, changeOrigin: true, ws: route === "/api" }
        return acc
      }, {}),
    },
    worker: {
      format: "es",
      plugins: () => [claxedoWorkspaceSource(), solidPlugin()],
    },
    optimizeDeps: {
      exclude: ["@pierre/diffs", "@pierre/theming"],
    },
    build: {
      target: "esnext",
      outDir: "dist",
      // PostHog Error Tracking symbolication (deploy-claxedo-app.yml).
      // "hidden" writes *.map files next to each chunk without adding a
      // `//# sourceMappingURL` comment to the bundle, so nothing shipped to
      // Cloudflare Pages ever points at a map file, while the maps still
      // exist on disk for the deploy workflow's `posthog-cli sourcemap
      // inject`/`upload` step to find before it deletes every *.map from
      // the publish directory.
      sourcemap: "hidden",
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
          browserPreview: fileURLToPath(new URL("./browser-preview.html", import.meta.url)),
          cliCallback: fileURLToPath(new URL("./cli-callback.html", import.meta.url)),
        },
        output: {
          manualChunks: {
            "vendor-solid": ["solid-js", "solid-js/web", "solid-js/store"],
            ...accountBinding.manualChunks,
          },
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
          find: "@claxedo/agent-event-runtime/contracts",
          replacement: normalizePath(
            fileURLToPath(new URL("../agent-event-runtime/src/contracts/index.ts", import.meta.url)),
          ),
        },
        {
          find: "@claxedo/agent-event-runtime/client-presentation",
          replacement: normalizePath(
            fileURLToPath(new URL("../agent-event-runtime/src/projections/client-presentation/index.ts", import.meta.url)),
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
