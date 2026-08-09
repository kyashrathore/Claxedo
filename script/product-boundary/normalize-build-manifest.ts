import path from "node:path"

export type RollupChunkMetadata = {
  type: "chunk"
  fileName: string
  facadeModuleId: string | null
  isEntry: boolean
  modules: Record<string, unknown>
  imports: string[]
  dynamicImports: string[]
}

export type RollupAssetMetadata = {
  type: "asset"
  fileName: string
}

export type RollupBundleMetadata = Record<string, RollupChunkMetadata | RollupAssetMetadata>

export type BuildManifest = {
  entry: string
  modules: string[]
  chunks: string[]
  edges: {
    static: string[]
    dynamic: string[]
  }
}

function slash(value: string) {
  return value.replaceAll("\\", "/")
}

function withoutQuery(value: string) {
  const index = value.search(/[?#]/)
  return index === -1 ? value : value.slice(0, index)
}

/**
 * Turn a build-tool module id into a stable repository/package identity.
 *
 * Bun's install layout includes versioned `.bun/<pkg>@<version>/node_modules/`
 * segments and temporary isolation workspaces live at random absolute paths.
 * Keeping either in a committed comparison makes identical builds differ by
 * machine. The final `node_modules/` segment is the runtime package identity;
 * repository sources are relative to the supplied workspace root.
 */
export function normalizeModuleId(raw: string, workspaceRoot: string): string {
  const value = slash(withoutQuery(raw))
  if (value.startsWith("\0")) return `virtual:${value.slice(1)}`

  const nodeModules = value.lastIndexOf("/node_modules/")
  if (nodeModules !== -1) return value.slice(nodeModules + "/node_modules/".length)

  const normalizedRoot = slash(path.resolve(workspaceRoot)).replace(/\/$/, "")
  if (value === normalizedRoot) return "."
  if (value.startsWith(`${normalizedRoot}/`)) return value.slice(normalizedRoot.length + 1)

  if (path.isAbsolute(raw)) {
    throw new Error(`build metadata contains a module outside the workspace: ${raw}`)
  }
  return value.replace(/^\.\//, "")
}

function sorted(values: Iterable<string>) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function edge(from: string, to: string) {
  return `${slash(from)} -> ${slash(to)}`
}

/** Normalize Rollup/Vite's `generateBundle` metadata without reading output text. */
export function normalizeRollupBuildManifest(input: {
  entry: string
  bundle: RollupBundleMetadata
  workspaceRoot: string
}): BuildManifest {
  const chunks = Object.values(input.bundle).filter((item): item is RollupChunkMetadata => item.type === "chunk")

  return {
    entry: normalizeModuleId(input.entry, input.workspaceRoot),
    modules: sorted(chunks.flatMap((chunk) => Object.keys(chunk.modules).map((id) => normalizeModuleId(id, input.workspaceRoot)))),
    chunks: sorted(chunks.map((chunk) => slash(chunk.fileName))),
    edges: {
      static: sorted(chunks.flatMap((chunk) => chunk.imports.map((target) => edge(chunk.fileName, target)))),
      dynamic: sorted(chunks.flatMap((chunk) => chunk.dynamicImports.map((target) => edge(chunk.fileName, target)))),
    },
  }
}

export function serializeBuildManifest(manifest: BuildManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
