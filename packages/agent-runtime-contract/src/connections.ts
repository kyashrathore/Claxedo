import type { AgentCapabilities, AgentModel, ModelSelection } from "./capabilities"

export type ConnectionReadiness = "configured" | "ready" | "unavailable" | "disabled"

/** Ready proves the ACP handshake, not subscription authentication or session admission. */
export type ConnectionRuntimeState = "configured" | "connecting" | "ready" | "auth-required" | "disconnected" | "failed"
export type ConnectionRuntimeObservation = {
  generation: string
  role: "execution" | "discovery"
  state: Exclude<ConnectionRuntimeState, "configured">
  observedAt: number
  reason?: string
}
export type ConnectionRuntimeStatus = {
  state: ConnectionRuntimeState
  processes: ConnectionRuntimeObservation[]
}

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
    || (row.readiness !== "configured" && row.readiness !== "ready" && row.readiness !== "unavailable" && row.readiness !== "disabled")
  ) invalid("connection reference")
  return {
    connectionId: row.connectionId,
    label: row.label,
    enabled: row.enabled,
    readiness: row.readiness,
    capabilities: decodeCapabilities(row.capabilities),
    ...(row.modelSelection !== undefined ? { modelSelection: decodeModelSelection(row.modelSelection) } : {}),
  }
}

/** Exhaustiveness follows AgentCapabilities: a new flag requires a line here or this stops compiling. */
function decodeCapabilities(value: unknown): HarnessConnectionCapabilities {
  const source = record(value)
  return {
    abort: capabilityFlag(source, "abort"),
    reconnect: capabilityFlag(source, "reconnect"),
    replay: capabilityFlag(source, "replay"),
    permissions: capabilityFlag(source, "permissions"),
    questions: capabilityFlag(source, "questions"),
    todos: capabilityFlag(source, "todos"),
    commands: capabilityFlag(source, "commands"),
    fork: capabilityFlag(source, "fork"),
    revert: capabilityFlag(source, "revert"),
    unrevert: capabilityFlag(source, "unrevert"),
    configOptions: capabilityFlag(source, "configOptions"),
    subagents: capabilityFlag(source, "subagents"),
  }
}

function capabilityFlag(source: Record<string, unknown>, key: keyof HarnessConnectionCapabilities): boolean {
  const flag = source[key]
  if (typeof flag !== "boolean") invalid(`capability ${key}`)
  return flag
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
