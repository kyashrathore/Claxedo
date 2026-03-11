import { defineConfig, loadEnv } from "electron-vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { readdirSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

const normalizePath = (p: string) => p.replace(/\\/g, "/")

const channel = (() => {
  const raw = process.env.CLAXEDO_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// ── Override system (ported from claxedo-app/vite.cloud.config.ts) ──

const claxedoAppDir = normalizePath(fileURLToPath(new URL("../claxedo-app/", import.meta.url)))
const overridesRoot = normalizePath(path.join(claxedoAppDir, "src/overrides/"))
const upstreamRoot = normalizePath(fileURLToPath(new URL("../app/src/", import.meta.url)))

function list(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return list(p)
    return [p]
  })
}

function overrides() {
  const files = list(overridesRoot).filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"))

  return files.map((p) => {
    const rel = path.relative(overridesRoot, p).replace(/\\/g, "/")
    const key = `@/${rel.replace(/\.(ts|tsx)$/, "")}`
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return { find: new RegExp(`^${escaped}$`), replacement: normalizePath(p) }
  })
}

function overrideResolver() {
  const overrideMap = new Map<string, string>()
  const files = list(overridesRoot).filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"))
  for (const f of files) {
    const rel = path.relative(overridesRoot, f).replace(/\\/g, "/").replace(/\.(ts|tsx)$/, "")
    overrideMap.set(rel, normalizePath(f))
  }

  return {
    name: "claxedo-override-resolver",
    enforce: "pre" as const,
    async resolveId(
      this: any,
      source: string,
      importer: string | undefined,
      options: any,
    ) {
      if (overrideMap.size === 0) return null
      if (!importer || !normalizePath(importer).startsWith(upstreamRoot)) return null
      if (!source.startsWith("./") && !source.startsWith("../")) return null

      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved) return null
      const resolvedId = normalizePath(resolved.id)
      if (!resolvedId.startsWith(upstreamRoot)) return null

      const key = resolvedId.slice(upstreamRoot.length).replace(/\.(ts|tsx)$/, "")
      return overrideMap.get(key) ?? null
    },
  }
}

// ── Config ──

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.join(claxedoAppDir), "VITE_")
  const terminalBackend = env.VITE_TERMINAL_BACKEND || "xterm"

  return {
    main: {
      define: {
        "import.meta.env.CLAXEDO_CHANNEL": JSON.stringify(channel),
      },
      build: {
        rollupOptions: {
          input: { index: "src/main/index.ts" },
        },
      },
    },
    preload: {
      build: {
        rollupOptions: {
          input: { index: "src/preload/index.ts" },
        },
      },
    },
    renderer: {
      plugins: [overrideResolver(), solidPlugin(), tailwindcss()],
      publicDir: path.resolve(claxedoAppDir, "public"),
      root: "src/renderer",
      worker: {
        format: "es",
      },
      build: {
        rollupOptions: {
          input: {
            main: "src/renderer/index.html",
            loading: "src/renderer/loading.html",
          },
        },
      },
      resolve: {
        alias: [
          // Terminal backend swap
          {
            find: "#terminal-backend",
            replacement: normalizePath(
              path.join(claxedoAppDir, `src/overrides/terminal/backend/${terminalBackend}.ts`),
            ),
          },
          // Override files (specific aliases take precedence)
          ...overrides(),
          // Resolve claxedo-specific paths
          {
            find: "@claxedo/",
            replacement: normalizePath(path.join(claxedoAppDir, "src/")),
          },
          // General @/ alias (lowest priority)
          {
            find: "@/",
            replacement: normalizePath(upstreamRoot),
          },
        ],
      },
    },
  }
})
