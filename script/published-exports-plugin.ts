/**
 * Bun bundler plugin: resolve `@claxedo/*` through the PUBLISHED export
 * condition (`default`), never through the workspace's `development`/`bun`
 * source conditions.
 *
 * Why this exists: every workspace package exports `development` and `bun` ->
 * src/*.ts so that typecheck, `bun test`, Vite and Vitest read sibling source
 * with no build step. Bun's bundler also selects `development` whenever
 * NODE_ENV is not "production" (and setting NODE_ENV would inline it into the
 * bundle, changing runtime behaviour), so a product bundle built with
 * `Bun.build` would otherwise fold sibling SOURCE into the artifact — with
 * that bundle's loaders and externals instead of the package's own build
 * (`.sh` text imports, the generated `pi-catalog`, declared externals).
 *
 * Shipped artifacts consume the same dist an npm consumer gets. The caller is
 * responsible for that dist being fresh (`bun run build:packages`, or the
 * desktop prebuild's own builds).
 */
import fs from "node:fs"
import path from "node:path"
import type { BunPlugin } from "bun"
import { isRecord, parseJsonObject, text } from "./json"

const REPO_ROOT = path.resolve(import.meta.dirname, "..")

/** `node` is one `exports` entry: a path, a condition map, or null. Array fallbacks are not used in this workspace. */
function publishedTarget(node: unknown): string | null {
  if (typeof node === "string") return node
  if (!isRecord(node)) return null
  if (typeof node.default === "string") return node.default
  if (typeof node.import === "string") return node.import
  for (const [condition, child] of Object.entries(node)) {
    if (condition === "development" || condition === "bun" || condition === "types") continue
    const target = publishedTarget(child)
    if (target) return target
  }
  return null
}

type Workspace = { dir: string; published: boolean }
let workspaces: Map<string, Workspace> | undefined

/**
 * `@claxedo/<name>` -> package directory and whether it is published, scanned
 * from the packages directory (Bun's isolated linker does not link every
 * workspace at the root). Only published packages have a dist to prefer;
 * private ones (`"private": true`) export source and resolve normally.
 */
function workspace(packageName: string): Workspace | undefined {
  if (!workspaces) {
    workspaces = new Map()
    const packagesRoot = path.join(REPO_ROOT, "packages")
    for (const entry of fs.readdirSync(packagesRoot)) {
      const manifestPath = path.join(packagesRoot, entry, "package.json")
      if (!fs.existsSync(manifestPath)) continue
      const manifest = parseJsonObject(fs.readFileSync(manifestPath, "utf8"), manifestPath)
      const name = text(manifest.name)
      if (name) workspaces.set(name, { dir: path.join(packagesRoot, entry), published: manifest.private !== true })
    }
  }
  return workspaces.get(packageName)
}

/** Absolute path of `specifier` under the package's `default` export condition, or null for a private workspace package. */
export function resolvePublishedExport(specifier: string): string | null {
  const [scope, name, ...rest] = specifier.split("/")
  const entry = workspace(`${scope}/${name}`)
  if (!entry) throw new Error(`${specifier}: ${scope}/${name} is not a workspace package under packages/`)
  if (!entry.published) return null
  const packageDir = entry.dir
  const manifestPath = path.join(packageDir, "package.json")
  const exports = parseJsonObject(fs.readFileSync(manifestPath, "utf8"), manifestPath).exports
  const subpath = rest.length === 0 ? "." : `./${rest.join("/")}`
  const node = isRecord(exports) ? exports[subpath] : undefined
  if (node === undefined) throw new Error(`${specifier}: ${scope}/${name} has no exports entry for ${subpath}`)
  const target = publishedTarget(node)
  if (!target) throw new Error(`${specifier}: ${scope}/${name} exports ${subpath} without a default/import target`)
  const resolved = path.join(packageDir, target)
  if (!fs.existsSync(resolved)) throw new Error(`${specifier}: ${resolved} does not exist — build the package first`)
  return resolved
}

export function publishedExportsPlugin(): BunPlugin {
  return {
    name: "claxedo-published-exports",
    setup(build) {
      build.onResolve({ filter: /^@claxedo\// }, (args) => {
        const resolved = resolvePublishedExport(args.path)
        return resolved === null ? undefined : { path: resolved }
      })
    },
  }
}
