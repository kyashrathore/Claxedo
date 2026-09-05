import type { AgentCapabilities, AgentModel, ModelSelection } from "./capabilities"

export type ConnectionReadiness = "ready" | "unavailable" | "disabled"
export type HarnessConnectionCapabilities = Omit<AgentCapabilities, "harness" | "modelSelection">

/** Public discovery metadata. Provider configuration and credentials stay on the host. */
export type HarnessConnectionRef = {
  connectionId: string
  label: string
  enabled: boolean
  readiness: ConnectionReadiness
  capabilities: HarnessConnectionCapabilities
  modelSelection?: ModelSelection
}

export type HarnessConnectionsCatalog =
  | { status: "supported"; connections: HarnessConnectionRef[] }
  | { status: "unsupported"; reason: string }

// Exhaustiveness follows AgentCapabilities: a new flag requires a decoder entry.
const capabilityKeys = {
  abort: true, reconnect: true, replay: true, permissions: true, questions: true,
  todos: true, commands: true, fork: true, revert: true, unrevert: true,
  configOptions: true, subagents: true,
} satisfies Record<keyof HarnessConnectionCapabilities, true>

export function decodeHarnessConnectionsCatalog(value: unknown): HarnessConnectionsCatalog {
  const root = record(value)
  if (root.status === "unsupported") {
    if (typeof root.reason !== "string" || !root.reason.trim() || "connections" in root) invalid("unsupported discovery")
    return { status: "unsupported", reason: root.reason }
  }
  if (root.status !== "supported" || !Array.isArray(root.connections)) invalid("discovery envelope")
  return { status: "supported", connections: root.connections.map(decodeConnection) }
}

function decodeConnection(value: unknown): HarnessConnectionRef {
  const row = record(value)
  if (
    typeof row.connectionId !== "string" || !row.connectionId.trim()
    || typeof row.label !== "string" || !row.label.trim()
    || typeof row.enabled !== "boolean"
    || (row.readiness !== "ready" && row.readiness !== "unavailable" && row.readiness !== "disabled")
  ) invalid("connection reference")
  const source = record(row.capabilities)
  const capabilities = Object.fromEntries(Object.keys(capabilityKeys).map((key) => {
    if (typeof source[key] !== "boolean") invalid(`capability ${key}`)
    return [key, source[key]]
  })) as HarnessConnectionCapabilities
  return {
    connectionId: row.connectionId,
    label: row.label,
    enabled: row.enabled,
    readiness: row.readiness,
    capabilities,
    ...(row.modelSelection !== undefined ? { modelSelection: decodeModelSelection(row.modelSelection) } : {}),
  }
}

export function decodeModelSelection(value: unknown): ModelSelection {
  const row = record(value)
  if (row.status === "unsupported" && row.models === undefined) return { status: "unsupported" }
  if (row.status !== "required" && row.status !== "optional") invalid("model selection")
  const models = row.models === undefined ? undefined : decodeModels(row.models)
  if (row.status === "required") {
    if (!models?.length) invalid("required models")
    return { status: "required", models }
  }
  return { status: "optional", ...(models ? { models } : {}) }
}

function decodeModels(value: unknown): AgentModel[] {
  if (!Array.isArray(value)) invalid("models")
  return value.map((item) => {
    const row = record(item)
    if (
      typeof row.providerId !== "string" || !row.providerId
      || typeof row.modelId !== "string" || !row.modelId
      || typeof row.name !== "string" || !row.name
      || (row.description !== undefined && typeof row.description !== "string")
    ) invalid("model")
    return {
      providerId: row.providerId, modelId: row.modelId, name: row.name,
      ...(typeof row.description === "string" ? { description: row.description } : {}),
    }
  })
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object")
  return Object.fromEntries(Object.entries(value))
}

function invalid(field: string): never {
  throw new Error(`Invalid agent connection ${field}`)
}
