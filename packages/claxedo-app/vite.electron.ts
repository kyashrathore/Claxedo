import { loadEnv, type Plugin, type UserConfig } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const normalize = (value: string) => value.replaceAll("\\", "/")

export const claxedoAppDir = normalize(fileURLToPath(new URL("./", import.meta.url)))
const desktopRoot = normalize(path.join(claxedoAppDir, "src/desktop"))
const overridesRoot = normalize(path.join(claxedoAppDir, "src/overrides"))
const upstreamRoot = normalize(fileURLToPath(new URL("../app/src/", import.meta.url)))

function list(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return list(file)
    return [file]
  })
}

function overrides() {
  const files = list(overridesRoot).filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))

  return files.map((file) => {
    const rel = path.relative(overridesRoot, file).replaceAll("\\", "/")
    const key = `@/${rel.replace(/\.(ts|tsx)$/, "")}`
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return { find: new RegExp(`^${escaped}$`), replacement: normalize(file) }
  })
}

function overrideResolver(): Plugin {
  const map = new Map<string, string>()
  const files = list(overridesRoot).filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
  for (const file of files) {
    const rel = path.relative(overridesRoot, file).replaceAll("\\", "/").replace(/\.(ts|tsx)$/, "")
    map.set(rel, normalize(file))
  }

  return {
    name: "claxedo-override-resolver",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !normalize(importer).startsWith(upstreamRoot)) return null
      if (!source.startsWith("./") && !source.startsWith("../")) return null

      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved) return null

      const id = normalize(resolved.id)
      if (!id.startsWith(upstreamRoot)) return null

      const key = id.slice(upstreamRoot.length).replace(/\.(ts|tsx)$/, "")
      return map.get(key) ?? null
    },
  }
}

export function createElectronRenderer(mode: string): UserConfig {
  const env = loadEnv(mode, claxedoAppDir, "VITE_")
  const terminal = env.VITE_TERMINAL_BACKEND || "xterm"

  return {
    define: {
      __DEMO_ENABLED__: "false",
    },
    plugins: [overrideResolver(), solidPlugin(), tailwindcss()],
    publicDir: normalize(path.join(claxedoAppDir, "public")),
    root: desktopRoot,
    worker: {
      format: "es",
    },
    build: {
      rollupOptions: {
        input: {
          main: normalize(path.join(desktopRoot, "index.html")),
          loading: normalize(path.join(desktopRoot, "loading.html")),
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
          replacement: normalize(path.join(claxedoAppDir, `src/overrides/terminal/backend/${terminal}.ts`)),
        },
        ...overrides(),
        {
          find: "@claxedo/",
          replacement: normalize(path.join(claxedoAppDir, "src/")),
        },
        {
          find: "@/",
          replacement: upstreamRoot,
        },
      ],
    },
  }
}
