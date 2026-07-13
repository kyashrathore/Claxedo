import {
  ExecutionCapabilitiesSchema,
  type ExecutionConnectionCapability,
  type ExecutionEnvironmentCapability,
  type WorkGraphContext,
} from "@claxedo/workgraph/contracts"
import {
  ExecutionCapabilitiesUnavailableError,
  type ExecutionCapabilitiesPort,
  type ExecutionCapabilitiesReadInput,
} from "@claxedo/workgraph/ports"

type RuntimeCatalog = Readonly<{
  harness: unknown
  agents: unknown
  providers: unknown
  tools: unknown
}>

type RepositoryCatalog = Readonly<{
  remoteUrl?: string
  baseRevisions: readonly string[]
}>

export function createExecutionCapabilitiesPort(input: Readonly<{
  environment: ExecutionEnvironmentCapability
  readRuntime(context: WorkGraphContext, request: ExecutionCapabilitiesReadInput): Promise<RuntimeCatalog>
  readRepository(context: WorkGraphContext, request: ExecutionCapabilitiesReadInput): Promise<RepositoryCatalog>
  readConnections(context: WorkGraphContext): Promise<readonly ExecutionConnectionCapability[]>
  connectionToolIds?: readonly string[]
  now?: () => number
}>): ExecutionCapabilitiesPort {
  return {
    async read(context, request) {
      const [runtime, repository, connections] = await Promise.all([
        readRequired("runtime", "runtime_unavailable", () => input.readRuntime(context, request)),
        readRequired("repository", "repository_unavailable", () => input.readRepository(context, request)),
        readRequired("connections", "connections_unavailable", () => input.readConnections(context)),
      ])
      const harnessId = runtimeHarness(runtime.harness)
      const agents = runtimeAgents(runtime.agents, harnessId)
      const models = runtimeModels(runtime.providers, harnessId)
      const tools = runtimeTools(runtime.tools, harnessId)
      const connectionTools = connections.some((connection) => connection.grantedCapabilities.includes("work-source"))
        ? (input.connectionToolIds ?? []).map((id) => ({
            harnessId,
            id,
            requiresConnectionCapability: "work-source",
          }))
        : []
      const baseRevisions = unique(repository.baseRevisions)
      if (input.environment.repositoryRequired && baseRevisions.length === 0) {
        throw new ExecutionCapabilitiesUnavailableError(
          "repository",
          "catalog_invalid",
          "The execution repository did not expose a valid base revision",
          false,
        )
      }
      return ExecutionCapabilitiesSchema.parse({
        schemaVersion: 1,
        ownerUserId: context.ownerUserId,
        observedAt: (input.now ?? Date.now)(),
        environments: [input.environment],
        harnesses: [{ id: harnessId }],
        agents,
        models,
        tools: uniqueBy([...tools, ...connectionTools], (tool) => tool.id),
        repository: {
          ...(clean(repository.remoteUrl) ? { remoteUrl: clean(repository.remoteUrl) } : {}),
          baseRevisions,
        },
        connections: uniqueBy(connections, (connection) => connection.id),
      })
    },
  }
}

function runtimeHarness(input: unknown) {
  const value = record(input)?.harness
  if (typeof value === "string" && value.trim()) return value.trim()
  throw invalidCatalog("harnesses", "The runtime did not identify its active harness")
}

function runtimeAgents(input: unknown, harnessId: string) {
  if (!Array.isArray(input)) throw invalidCatalog("agents", "The runtime Agent catalog was malformed")
  const agents = input.flatMap((value) => {
    const row = record(value)
    const id = clean(row?.name)
    if (!id) return []
    const mode = row?.mode === "primary" || row?.mode === "subagent" || row?.mode === "all" ? row.mode : undefined
    return [{
      harnessId,
      id,
      label: id,
      ...(clean(row?.description) ? { description: clean(row?.description) } : {}),
      ...(mode ? { mode } : {}),
    }]
  })
  if (agents.length === 0) throw invalidCatalog("agents", "The runtime exposed no executable Agents")
  return uniqueBy(agents, (agent) => agent.id)
}

function runtimeModels(input: unknown, harnessId: string) {
  const root = record(input)
  if (!root || !Array.isArray(root.all) || !Array.isArray(root.connected)) {
    throw invalidCatalog("models", "The runtime Provider catalog was malformed")
  }
  const connected = new Set(root.connected.filter((value): value is string => typeof value === "string" && !!value.trim()))
  return root.all.flatMap((value) => {
    const provider = record(value)
    const providerId = clean(provider?.id)
    if (!providerId || !connected.has(providerId)) return []
    const models = record(provider?.models)
    if (!models) throw invalidCatalog("models", `Provider ${providerId} did not expose a model catalog`)
    return Object.values(models).flatMap((modelValue) => {
      const model = record(modelValue)
      const modelId = clean(model?.id)
      if (!modelId || model?.status === "deprecated") return []
      const variants = record(model?.variants)
      return [{
        harnessId,
        providerId,
        modelId,
        label: clean(model?.name) ?? modelId,
        efforts: variants ? unique(Object.keys(variants)) : [],
      }]
    })
  })
}

function runtimeTools(input: unknown, harnessId: string) {
  if (!Array.isArray(input)) throw invalidCatalog("tools", "The runtime Tool catalog was malformed")
  const tools = input.flatMap((value) => typeof value === "string" && value.trim()
    ? [{ harnessId, id: value.trim() }]
    : [])
  if (tools.length === 0) throw invalidCatalog("tools", "The runtime exposed no executable Tools")
  return uniqueBy(tools, (tool) => tool.id)
}

async function readRequired<Value>(
  capability: "runtime" | "repository" | "connections",
  reason: "runtime_unavailable" | "repository_unavailable" | "connections_unavailable",
  read: () => Promise<Value>,
) {
  try {
    return await read()
  } catch (error) {
    if (error instanceof ExecutionCapabilitiesUnavailableError) throw error
    throw new ExecutionCapabilitiesUnavailableError(
      capability,
      reason,
      error instanceof Error ? error.message : `${capability} capability discovery failed`,
      true,
    )
  }
}

function invalidCatalog(capability: "harnesses" | "agents" | "models" | "tools", message: string) {
  return new ExecutionCapabilitiesUnavailableError(capability, "catalog_invalid", message, false)
}

function record(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

function clean(input: unknown) {
  if (typeof input !== "string") return
  const value = input.trim()
  return value || undefined
}

function unique(input: readonly string[]) {
  return [...new Set(input.map((value) => value.trim()).filter(Boolean))]
}

function uniqueBy<Value>(input: readonly Value[], key: (value: Value) => string) {
  return [...new Map(input.map((value) => [key(value), value])).values()]
}
