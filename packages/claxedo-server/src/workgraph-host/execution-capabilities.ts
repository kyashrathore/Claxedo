import {
  EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
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

type RuntimeHarnessCatalog = Readonly<{
  harness: unknown
  agents: unknown
  providers: unknown
  tools: unknown
  connectionTools?: boolean
}>

type RuntimeCatalog = RuntimeHarnessCatalog | Readonly<{ harnesses: readonly RuntimeHarnessCatalog[] }>

type RepositoryCatalog = Readonly<{
  remoteUrl?: string
  baseRevisions: readonly string[]
}>

export function createExecutionCapabilitiesPort(
  input: Readonly<{
    environment: ExecutionEnvironmentCapability
    readRuntime(context: WorkGraphContext, request: ExecutionCapabilitiesReadInput): Promise<RuntimeCatalog>
    readRepository(context: WorkGraphContext, request: ExecutionCapabilitiesReadInput): Promise<RepositoryCatalog>
    readConnections(context: WorkGraphContext): Promise<readonly ExecutionConnectionCapability[]>
    connectionToolIds?: readonly string[]
    now?: () => number
  }>,
): ExecutionCapabilitiesPort {
  return {
    async read(context, request) {
      const [runtime, repository, connections] = await Promise.all([
        readRequired("runtime", "runtime_unavailable", () => input.readRuntime(context, request)),
        readRequired("repository", "repository_unavailable", () => input.readRepository(context, request)),
        readRequired("connections", "connections_unavailable", () => input.readConnections(context)),
      ])
      const catalogs = runtimeCatalogs(runtime).map((catalog) => ({
        ...catalog,
        harnessId: runtimeHarness(catalog.harness),
      }))
      const agents = uniqueBy(
        catalogs.flatMap((catalog) => runtimeAgents(catalog.agents, catalog.harnessId)),
        (agent) => `${agent.harnessId}\n${agent.id}`,
      )
      const models = uniqueBy(
        catalogs.flatMap((catalog) => runtimeModels(catalog.providers, catalog.harnessId)),
        (model) => `${model.harnessId}\n${model.providerId}\n${model.modelId}`,
      )
      const tools = uniqueBy(
        catalogs.flatMap((catalog) => runtimeTools(catalog.tools, catalog.harnessId)),
        (tool) => `${tool.harnessId}\n${tool.id}`,
      )
      const connectionTools = connections.some((connection) => connection.grantedCapabilities.includes("work-source"))
        ? catalogs
            .filter((catalog) => catalog.connectionTools !== false)
            .flatMap((catalog) => (input.connectionToolIds ?? []).map((id) => ({
              harnessId: catalog.harnessId,
              id,
              requiresConnectionCapability: "work-source",
            })))
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
      const observedAt = (input.now ?? Date.now)()
      const observation = {
        schemaVersion: 1,
        organizationId: context.organizationId,
        ownerUserId: context.ownerUserId,
        observedAt,
        expiresAt: observedAt + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
        environments: [input.environment],
        harnesses: catalogs.map((catalog) => ({ id: catalog.harnessId })),
        agents,
        models,
        tools: uniqueBy([...tools, ...connectionTools], (tool) => `${tool.harnessId}\n${tool.id}`),
        repository: {
          ...(clean(repository.remoteUrl) ? { remoteUrl: clean(repository.remoteUrl) } : {}),
          baseRevisions,
        },
        connections: uniqueBy(connections, (connection) => connection.id),
      } as const
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(observation)))
      const capabilities = ExecutionCapabilitiesSchema.safeParse({
        ...observation,
        catalogRevision: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      })
      if (!capabilities.success) {
        const root = capabilities.error.issues[0]?.path[0]
        const capability =
          root === "harnesses" ||
          root === "agents" ||
          root === "models" ||
          root === "tools" ||
          root === "repository" ||
          root === "connections"
            ? root
            : "runtime"
        throw new ExecutionCapabilitiesUnavailableError(
          capability,
          "catalog_invalid",
          `The assembled execution ${capability} catalog was malformed`,
          false,
        )
      }
      return capabilities.data
    },
  }
}

function runtimeCatalogs(input: RuntimeCatalog) {
  if ("harnesses" in input) {
    if (!Array.isArray(input.harnesses) || input.harnesses.length === 0) {
      throw invalidCatalog("harnesses", "The runtime did not expose any harness catalogs")
    }
    return input.harnesses
  }
  return [input]
}

function runtimeHarness(input: unknown) {
  const value = record(input)?.harness
  if (typeof value === "string" && value.trim()) return value.trim()
  throw invalidCatalog("harnesses", "The runtime did not identify its active harness")
}

function runtimeAgents(input: unknown, harnessId: string) {
  if (!Array.isArray(input)) throw invalidCatalog("agents", "The runtime Agent catalog was malformed")
  if (input.length === 0) {
    return [{ harnessId, id: "build", label: "build", mode: "primary" as const }]
  }
  const agents = input.flatMap((value) => {
    const row = record(value)
    const id = clean(row?.name)
    if (!id) return []
    const mode = row?.mode === "primary" || row?.mode === "subagent" || row?.mode === "all" ? row.mode : undefined
    return [
      {
        harnessId,
        id,
        label: id,
        ...(clean(row?.description) ? { description: clean(row?.description) } : {}),
        ...(mode ? { mode } : {}),
      },
    ]
  })
  if (agents.length === 0) throw invalidCatalog("agents", "The runtime exposed no executable Agents")
  return uniqueBy(agents, (agent) => agent.id)
}

function runtimeModels(input: unknown, harnessId: string) {
  const root = record(input)
  if (Array.isArray(root?.data)) {
    return root.data.flatMap((value) => {
      const model = record(value)
      const providerId = clean(model?.providerID)
      const modelId = clean(model?.id)
      if (!providerId || !modelId || model?.enabled === false || model?.status === "deprecated") return []
      const variants = Array.isArray(model?.variants)
        ? model.variants.flatMap((value) => {
            const id = clean(record(value)?.id)
            return id ? [id] : []
          })
        : []
      return [{
        harnessId,
        providerId,
        modelId,
        label: clean(model?.name) ?? modelId,
        efforts: unique(["default", ...variants]),
      }]
    })
  }
  if (!root || !Array.isArray(root.all) || !Array.isArray(root.connected)) {
    throw invalidCatalog("models", "The runtime Provider catalog was malformed")
  }
  const connected = new Set(
    root.connected.filter((value): value is string => typeof value === "string" && !!value.trim()),
  )
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
      return [
        {
          harnessId,
          providerId,
          modelId,
          label: clean(model?.name) ?? modelId,
          efforts: variants ? unique(Object.keys(variants)) : [],
        },
      ]
    })
  })
}

function runtimeTools(input: unknown, harnessId: string) {
  if (!Array.isArray(input)) throw invalidCatalog("tools", "The runtime Tool catalog was malformed")
  const tools = input.flatMap((value) =>
    typeof value === "string" && value.trim() ? [{ harnessId, id: value.trim() }] : [],
  )
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
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}
