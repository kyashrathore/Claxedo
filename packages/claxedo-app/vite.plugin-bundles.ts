import { execFile } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { Plugin } from "vite"

const BUNDLE_SUFFIX = "/app?claxedo-plugin-bundle"
const BUNDLE_ID_PREFIX = "\0claxedo-plugin-bundle:"
const BUNDLE_OUTPUT_MAX_BYTES = 64 * 1024 * 1024

const WORKSPACE_ROOTS = [
  fileURLToPath(new URL("./node_modules/", import.meta.url)),
  fileURLToPath(new URL("../../node_modules/", import.meta.url)),
]

const run = promisify(execFile)

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return new Map<string, unknown>(Object.entries(value)).get(key)
}

export function workspacePackageManifest(name: string): string | undefined {
  for (const root of WORKSPACE_ROOTS) {
    const path = `${root}${name}/package.json`
    if (existsSync(path)) return path
  }
  return undefined
}

export type WorkspaceSourceModule = { readonly path: string; readonly sideEffects: boolean }

export function workspaceSourceExport(name: string, subpath: string): WorkspaceSourceModule | undefined {
  const manifestPath = workspacePackageManifest(name)
  if (!manifestPath) return undefined
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  const development = field(field(field(manifest, "exports"), subpath), "development")
  if (typeof development !== "string") return undefined
  return { path: realpathSync(`${dirname(manifestPath)}/${development}`), sideEffects: field(manifest, "sideEffects") !== false }
}

export class PluginBundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PluginBundleError"
  }
}

async function bundleModule(rootDir: string): Promise<string> {
  const cli = workspaceSourceExport("@claxedo/plugin-build", "./app-bundle-cli")
  if (!cli) throw new PluginBundleError("@claxedo/plugin-build does not export its app bundle command")
  const { stdout } = await run("bun", [cli.path, rootDir], { maxBuffer: BUNDLE_OUTPUT_MAX_BYTES })
  return `export default ${stdout}`
}

export function claxedoPluginBundles(): Plugin {
  return {
    name: "claxedo:plugin-bundles",
    enforce: "pre",
    resolveId(source) {
      if (!source.endsWith(BUNDLE_SUFFIX)) return null
      const name = source.slice(0, -BUNDLE_SUFFIX.length)
      const manifest = workspacePackageManifest(name)
      if (!manifest) throw new PluginBundleError(`${name} is not a workspace package this app can bundle`)
      return `${BUNDLE_ID_PREFIX}${dirname(realpathSync(manifest))}`
    },
    load(id) {
      return id.startsWith(BUNDLE_ID_PREFIX) ? bundleModule(id.slice(BUNDLE_ID_PREFIX.length)) : null
    },
  }
}
