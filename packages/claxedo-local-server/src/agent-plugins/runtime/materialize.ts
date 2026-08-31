import fs from "node:fs/promises"
import path from "node:path"
import type { ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"
import type { AgentPluginArtifactStore } from "@claxedo/server-core/agent-plugins/artifacts/types"
import { writeAgentPluginTreeToDirectory } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import {
  isAgentPluginHarnessId,
  type AgentPluginHarnessId,
} from "@claxedo/server-core/agent-plugins/runtime/harness-registry"
import {
  activateGeneration,
  cleanupInactiveGenerations,
  generationDirectory,
  newGenerationId,
  readActiveGeneration,
} from "./generation"
import { pluginDataDirectory, pluginInstanceStorageKey } from "./plugin-data"
import type {
  AgentPluginHarnessProjectionAdapter,
  GenerationPluginRoot,
  HarnessPluginProjection,
  RuntimeMcpServerProjection,
} from "./adapters/types"

export type AgentPluginRuntimeIdentity =
  | { mode: "unsigned"; machineId: string }
  | { mode: "signed"; userId: string; projectId: string }

export type AgentPluginMaterializationSelection = {
  pluginInstanceId: string
  artifactDigest: ArtifactDigest
  harnessIds: readonly string[]
}

export type MaterializedAgentPluginGeneration = {
  generationId: string
  revision: number
  root: string
  projections: Partial<Record<AgentPluginHarnessId, HarnessPluginProjection>>
  cleanupWarning?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function contained(root: string, relative: string): string | undefined {
  if (!relative || path.isAbsolute(relative)) return undefined
  const resolved = path.resolve(root, relative)
  const prefix = `${path.resolve(root)}${path.sep}`
  return resolved.startsWith(prefix) ? resolved : undefined
}

/** Restores the active immutable projection after a server/VM process restart. */
export async function readMaterializedAgentPluginGeneration(
  runtimeRoot: string,
): Promise<MaterializedAgentPluginGeneration | undefined> {
  const active = await readActiveGeneration(runtimeRoot)
  if (!active) return undefined
  const root = generationDirectory(runtimeRoot, active.generationId)
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(path.join(root, "generation.json"), "utf8"))
  } catch (error) {
    throw new AgentPluginMaterializationError(
      "artifact-unavailable",
      `Active Agent Plugins generation manifest is unreadable: ${String(error)}`,
    )
  }
  if (!record(raw)) {
    throw new AgentPluginMaterializationError("artifact-unavailable", "Active Agent Plugins generation manifest is invalid")
  }
  const manifest = raw
  if (manifest.generationId !== active.generationId || manifest.revision !== active.revision) {
    throw new AgentPluginMaterializationError("artifact-unavailable", "Active Agent Plugins generation manifest disagrees with its pointer")
  }
  const rows = manifest.projections
  if (!record(rows)) {
    throw new AgentPluginMaterializationError("artifact-unavailable", "Active Agent Plugins generation has no projections")
  }
  const projections: Partial<Record<AgentPluginHarnessId, HarnessPluginProjection>> = {}
  for (const [harnessId, value] of Object.entries(rows)) {
    if (!isAgentPluginHarnessId(harnessId) || !record(value)) {
      throw new AgentPluginMaterializationError("artifact-unavailable", "Active Agent Plugins projection metadata is invalid")
    }
    const row = value
    if (!Array.isArray(row.pluginRoots)) {
      throw new AgentPluginMaterializationError("artifact-unavailable", `Active ${harnessId} projection has invalid roots`)
    }
    const pluginRoots = row.pluginRoots.map((item) => {
      if (!record(item)) {
        throw new AgentPluginMaterializationError("artifact-unavailable", `Active ${harnessId} projection root is invalid`)
      }
      const entry = item
      const materializedRoot = typeof entry.root === "string" ? contained(root, entry.root) : undefined
      if (typeof entry.pluginInstanceId !== "string" || !materializedRoot) {
        throw new AgentPluginMaterializationError("artifact-unavailable", `Active ${harnessId} projection root escapes its generation`)
      }
      return {
        pluginInstanceId: entry.pluginInstanceId,
        root: materializedRoot,
        dataRoot: pluginDataDirectory(runtimeRoot, entry.pluginInstanceId),
      }
    })
    const configFile = row.configFile === undefined
      ? undefined
      : typeof row.configFile === "string"
        ? contained(root, row.configFile)
        : undefined
    if (row.configFile !== undefined && !configFile) {
      throw new AgentPluginMaterializationError("artifact-unavailable", `Active ${harnessId} config escapes its generation`)
    }
    projections[harnessId] = {
      harnessId,
      pluginRoots,
      diagnostics: [],
      ...(configFile ? { configFile } : {}),
    }
  }
  return {
    generationId: active.generationId,
    revision: active.revision,
    root,
    projections,
  }
}

export class AgentPluginMaterializationError extends Error {
  constructor(
    readonly code:
      | "identity-required"
      | "stale-revision"
      | "duplicate-selection"
      | "unsupported-harness"
      | "adapter-unavailable"
      | "artifact-unavailable",
    message: string,
  ) {
    super(message)
    this.name = "AgentPluginMaterializationError"
  }
}

function assertIdentity(identity: AgentPluginRuntimeIdentity) {
  const valid = identity.mode === "signed"
    ? Boolean(identity.userId && identity.projectId)
    : Boolean(identity.machineId)
  if (!valid) throw new AgentPluginMaterializationError("identity-required", "Agent Plugins runtime identity is incomplete")
}

function copiedPluginName(pluginName: string, pluginInstanceId: string, artifactDigest: ArtifactDigest) {
  return `${pluginName}-${pluginInstanceStorageKey(`${pluginInstanceId}:${artifactDigest}`).slice(0, 12)}`
}

export async function materializeAgentPluginGeneration(input: {
  runtimeRoot: string
  identity: AgentPluginRuntimeIdentity
  revision: number
  selections: readonly AgentPluginMaterializationSelection[]
  artifacts: AgentPluginArtifactStore
  adapters: readonly AgentPluginHarnessProjectionAdapter[]
  mcpServers?: readonly RuntimeMcpServerProjection[]
}): Promise<MaterializedAgentPluginGeneration> {
  assertIdentity(input.identity)
  const active = await readActiveGeneration(input.runtimeRoot)
  if (active && input.revision <= active.revision) {
    throw new AgentPluginMaterializationError(
      "stale-revision",
      `Agent Plugins revision ${input.revision} does not advance active revision ${active.revision}`,
    )
  }

  const adapterByHarness = new Map(input.adapters.map((adapter) => [adapter.harnessId, adapter]))
  const seenPluginHarnesses = new Set<string>()
  const seenSelections = new Set<string>()
  const normalized = input.selections.map((selection) => {
    const selectionKey = `${selection.pluginInstanceId}\0${selection.artifactDigest}`
    if (seenSelections.has(selectionKey)) {
      throw new AgentPluginMaterializationError("duplicate-selection", `Plugin artifact ${selection.pluginInstanceId} ${selection.artifactDigest} was selected more than once`)
    }
    seenSelections.add(selectionKey)
    const harnessIds = [...new Set(selection.harnessIds.map((value) => {
      if (!isAgentPluginHarnessId(value)) {
        throw new AgentPluginMaterializationError("unsupported-harness", `Unsupported Agent Plugins harness: ${value}`)
      }
      if (!adapterByHarness.has(value)) {
        throw new AgentPluginMaterializationError("adapter-unavailable", `No Agent Plugins projection adapter for ${value}`)
      }
      const harnessKey = `${selection.pluginInstanceId}\0${value}`
      if (seenPluginHarnesses.has(harnessKey)) {
        throw new AgentPluginMaterializationError("duplicate-selection", `Plugin ${selection.pluginInstanceId} has more than one artifact for ${value}`)
      }
      seenPluginHarnesses.add(harnessKey)
      return value
    }))]
    return { ...selection, harnessIds }
  })

  const generationId = newGenerationId(input.revision)
  const finalRoot = generationDirectory(input.runtimeRoot, generationId)
  await fs.mkdir(path.join(finalRoot, "plugins"), { recursive: true })

  try {
    const materialized: Array<GenerationPluginRoot & { harnessIds: AgentPluginHarnessId[]; artifactDigest: ArtifactDigest }> = []
    for (const selection of normalized.toSorted((a, b) => a.pluginInstanceId.localeCompare(b.pluginInstanceId))) {
      const artifact = await input.artifacts.get(selection.artifactDigest)
      if (!artifact) {
        throw new AgentPluginMaterializationError(
          "artifact-unavailable",
          `Retained artifact ${selection.artifactDigest} is unavailable for ${selection.pluginInstanceId}`,
        )
      }
      const root = path.join(finalRoot, "plugins", copiedPluginName(
        artifact.plugin.manifest.name,
        selection.pluginInstanceId,
        selection.artifactDigest,
      ))
      await writeAgentPluginTreeToDirectory(artifact.tree, root)
      const dataRoot = pluginDataDirectory(input.runtimeRoot, selection.pluginInstanceId)
      await fs.mkdir(dataRoot, { recursive: true })
      materialized.push({
        pluginInstanceId: selection.pluginInstanceId,
        plugin: { ...artifact.plugin, root },
        root,
        dataRoot,
        harnessIds: selection.harnessIds,
        artifactDigest: selection.artifactDigest,
      })
    }

    const seenMcpServers = new Set<string>()
    for (const server of input.mcpServers ?? []) {
      const key = `${server.pluginInstanceId}\0${server.artifactDigest}\0${server.harnessId}\0${server.serverName}`
      if (seenMcpServers.has(key)) {
        throw new AgentPluginMaterializationError("duplicate-selection", `MCP server projection ${server.serverName} was supplied more than once`)
      }
      seenMcpServers.add(key)
      const plugin = materialized.find((candidate) =>
        candidate.pluginInstanceId === server.pluginInstanceId
        && candidate.artifactDigest === server.artifactDigest
        && candidate.harnessIds.includes(server.harnessId))
      const declared = plugin?.plugin.mcp.status === "valid"
        ? plugin.plugin.mcp.servers.find((candidate) => candidate.name === server.serverName && candidate.type !== "stdio")
        : undefined
      if (!plugin || !declared) {
        throw new AgentPluginMaterializationError(
          "artifact-unavailable",
          `MCP projection ${server.pluginInstanceId}/${server.harnessId}/${server.serverName} does not match the selected artifact`,
        )
      }
    }

    const projections: Partial<Record<AgentPluginHarnessId, HarnessPluginProjection>> = {}
    const selectedHarnesses = new Set(materialized.flatMap((plugin) => plugin.harnessIds))
    const projectedHarnesses = [...adapterByHarness]
      .filter(([harnessId, adapter]) => selectedHarnesses.has(harnessId) || adapter.projectEmpty)
      .map(([harnessId]) => harnessId)
      .toSorted()
    for (const harnessId of projectedHarnesses) {
      const plugins = materialized.filter((plugin) => plugin.harnessIds.includes(harnessId))
      projections[harnessId] = await adapterByHarness.get(harnessId)!.project({
        generationRoot: finalRoot,
        plugins,
        mcpServers: (input.mcpServers ?? []).filter((server) => server.harnessId === harnessId),
      })
    }

    const manifest = {
      version: 1,
      generationId,
      revision: input.revision,
      identity: input.identity,
      plugins: materialized.map((plugin) => ({
        pluginInstanceId: plugin.pluginInstanceId,
        artifactDigest: plugin.artifactDigest,
        harnessIds: plugin.harnessIds,
        root: path.relative(finalRoot, plugin.root),
        dataKey: pluginInstanceStorageKey(plugin.pluginInstanceId),
      })),
      projections: Object.fromEntries(Object.entries(projections).map(([harnessId, projection]) => [
        harnessId,
        {
          ...(projection.configFile ? { configFile: path.relative(finalRoot, projection.configFile) } : {}),
          pluginRoots: projection.pluginRoots.map((plugin) => ({
            pluginInstanceId: plugin.pluginInstanceId,
            root: path.relative(finalRoot, plugin.root),
          })),
        },
      ])),
    }
    await fs.writeFile(path.join(finalRoot, "generation.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    await activateGeneration(input.runtimeRoot, { generationId, revision: input.revision })
    let cleanupWarning: string | undefined
    try {
      await cleanupInactiveGenerations(input.runtimeRoot)
    } catch (error) {
      cleanupWarning = error instanceof Error ? error.message : "Inactive Agent Plugins generation cleanup failed"
    }

    return {
      generationId,
      revision: input.revision,
      root: finalRoot,
      projections,
      ...(cleanupWarning ? { cleanupWarning } : {}),
    }
  } catch (error) {
    await fs.rm(finalRoot, { recursive: true, force: true })
    throw error
  }
}

/** Translate one materialized generation into the opaque launch contract consumed by harness drivers. */
export async function agentPluginHarnessLaunch(
  generation: Pick<MaterializedAgentPluginGeneration, "projections"> | undefined,
) {
  const result: Record<string, Record<string, unknown>> = {}
  for (const [harnessId, projection] of Object.entries(generation?.projections ?? {})) {
    if (!projection) continue
    if (projection.configFile) {
      const config = JSON.parse(await fs.readFile(projection.configFile, "utf8")) as unknown
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new AgentPluginMaterializationError(
          "artifact-unavailable",
          `Materialized ${harnessId} plugin configuration is invalid`,
        )
      }
      result[harnessId] = { config }
      continue
    }
    result[harnessId] = { pluginRoots: projection.pluginRoots.map((plugin) => plugin.root) }
  }
  return result
}
