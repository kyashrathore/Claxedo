import { inspectPluginTree } from "../artifacts/acquire"
import type {
  AgentPluginCatalogError,
  AgentPluginCollectionIndex,
  AgentPluginCollectionSource,
} from "./types"

export function pluginInstanceId(sourceId: string, relativePath: string) {
  return JSON.stringify([sourceId, relativePath])
}

export async function indexCollection(source: AgentPluginCollectionSource): Promise<AgentPluginCollectionIndex> {
  const sourceMetadata = {
    id: source.id,
    kind: source.kind,
    label: source.label,
    ...(source.repository ? { repository: source.repository } : {}),
    revision: source.revision,
  }
  const candidates: AgentPluginCollectionIndex["candidates"] = []
  const errors: AgentPluginCatalogError[] = (source.errors ?? []).map((error) => ({
    sourceId: source.id,
    ...error,
  }))
  const paths = new Set<string>()
  for (const child of [...source.plugins].toSorted((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    if (!child.relativePath
      || child.relativePath.includes("/")
      || child.relativePath.includes("\\")
      || child.relativePath === "."
      || child.relativePath === ".."
      || paths.has(child.relativePath)) {
      errors.push({
        sourceId: source.id,
        relativePath: child.relativePath || ".",
        code: "plugin_root_escape",
        message: "Collection child must have one unique immediate relative path",
      })
      continue
    }
    paths.add(child.relativePath)
    try {
      const artifact = await inspectPluginTree(child.tree)
      candidates.push({
        pluginInstanceId: pluginInstanceId(source.id, child.relativePath),
        sourceId: source.id,
        sourceKind: source.kind,
        sourceLabel: source.label,
        ...(source.repository ? { sourceRepository: source.repository } : {}),
        sourceRevision: source.revision,
        relativePath: child.relativePath,
        artifactDigest: artifact.digest,
        manifest: artifact.plugin.manifest,
        skills: artifact.plugin.skills,
        mcp: artifact.plugin.mcp,
        componentDiagnostics: artifact.diagnostics,
        tree: artifact.tree,
      })
    } catch (cause) {
      errors.push({
        sourceId: source.id,
        relativePath: child.relativePath,
        code: "manifest_invalid",
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
  return { source: sourceMetadata, candidates, errors }
}
