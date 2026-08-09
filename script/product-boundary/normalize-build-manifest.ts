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

export type SourceMapMetadata = {
  sourceRoot?: string
  sources: string[]
}

export type EsbuildMetafile = {
  inputs: Record<string, {
    imports?: Array<{ path: string; kind: string; external?: boolean }>
  }>
  outputs: Record<string, {
    entryPoint?: string
    imports?: Array<{ path: string; kind: string; external?: boolean }>
    inputs?: Record<string, unknown>
  }>
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

/** Normalize a single-file bundler's external source-map metadata. */
export function normalizeSourceMapBuildManifest(input: {
  entry: string
  sourceMap: SourceMapMetadata
  sourceMapDirectory: string
  chunks: string[]
  workspaceRoot: string
}): BuildManifest {
  const sourceRoot = input.sourceMap.sourceRoot ?? ""
  return {
    entry: normalizeModuleId(input.entry, input.workspaceRoot),
    modules: sorted(input.sourceMap.sources.map((source) =>
      normalizeModuleId(path.resolve(input.sourceMapDirectory, sourceRoot, source), input.workspaceRoot),
    )),
    chunks: sorted(input.chunks.map(slash)),
    edges: { static: [], dynamic: [] },
  }
}

/** Normalize esbuild/Wrangler metafiles without inspecting emitted code. */
export function normalizeEsbuildBuildManifest(input: {
  entry: string
  metafile: EsbuildMetafile
  workingDirectory: string
  workspaceRoot: string
}): BuildManifest {
  const moduleId = (id: string) => normalizeModuleId(
    path.isAbsolute(id) ? id : path.resolve(input.workingDirectory, id),
    input.workspaceRoot,
  )
  const importTarget = (value: { path: string; external?: boolean }) =>
    value.external ? normalizeModuleId(value.path, input.workspaceRoot) : moduleId(value.path)
  const staticEdges: string[] = []
  const dynamicEdges: string[] = []
  for (const [from, metadata] of Object.entries(input.metafile.inputs)) {
    for (const imported of metadata.imports ?? []) {
      const target = imported.kind === "dynamic-import" ? dynamicEdges : staticEdges
      target.push(edge(moduleId(from), importTarget(imported)))
    }
  }

  return {
    entry: normalizeModuleId(input.entry, input.workspaceRoot),
    modules: sorted(Object.keys(input.metafile.inputs).map(moduleId)),
    chunks: sorted(Object.entries(input.metafile.outputs)
      .filter(([, output]) => output.entryPoint !== undefined || Object.keys(output.inputs ?? {}).length > 0)
      .map(([output]) => slash(path.relative(input.workspaceRoot, path.resolve(input.workingDirectory, output))))),
    edges: { static: sorted(staticEdges), dynamic: sorted(dynamicEdges) },
  }
}

export function serializeBuildManifest(manifest: BuildManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
