import { defineConfig, loadEnv, type UserConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"

const normalizePath = (p: string) => p.replace(/\\/g, "/")
const shikiThemesDist = normalizePath(fileURLToPath(
  new URL("../../node_modules/.bun/@shikijs+themes@4.2.0/node_modules/@shikijs/themes/dist/", import.meta.url),
))

const isDemoBuild = process.env.CLAXEDO_BUILD_TARGET === "demo"

/**
 * Cloud-specific Vite configuration for Claxedo.
 */
function cloudConfig({ mode }: { mode: string }): UserConfig {
  const env = loadEnv(mode, process.cwd(), "VITE_")
  const backendTarget = env.VITE_CLAXEDO_SERVER_URL || env.VITE_OPENCODE_BACKEND_URL || "http://127.0.0.1:3001"
  return {
    define: {
      __DEMO_ENABLED__: JSON.stringify(isDemoBuild || mode === "development"),
    },
    plugins: [solidPlugin(), tailwindcss()],
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
      rollupOptions: {
        input: isDemoBuild
          ? { demo: fileURLToPath(new URL("./demo/index.html", import.meta.url)) }
          : { main: fileURLToPath(new URL("./index.html", import.meta.url)) },
        output: {
          manualChunks: {
            "vendor-solid": ["solid-js", "solid-js/web", "solid-js/store"],
            "vendor-clerk": ["@clerk/clerk-js/headless"],
          },
        },
      },
    },
    resolve: {
      alias: [
        // Keep the terminal backend lazy-loaded without making it configurable.
        {
          find: "#terminal-backend",
          replacement: normalizePath(fileURLToPath(new URL("./src/terminal/backend/xterm.ts", import.meta.url))),
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
        // Resolve claxedo-specific paths
        { find: "@claxedo/", replacement: normalizePath(fileURLToPath(new URL("./src/", import.meta.url))) },
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
          replacement: normalizePath(fileURLToPath(new URL("./src/utils/lru-map.ts", import.meta.url))),
        },
        // Resolve packages only available in upstream's node_modules
        { find: "@solid-primitives/active-element", replacement: normalizePath(fileURLToPath(new URL("../app/node_modules/@solid-primitives/active-element/dist/index.js", import.meta.url))) },
        // General @/ alias (lowest priority) — resolves to claxedo's own src
        // (upstream packages/app fully vendored; divorce plan 006)
        { find: "@/", replacement: normalizePath(fileURLToPath(new URL("./src/", import.meta.url))) },
      ],
    },
  }
}

export default defineConfig(({ mode }) => cloudConfig({ mode }))
