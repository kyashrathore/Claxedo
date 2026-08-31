import { createSignal } from "solid-js"
import type { AgentModel, ModelSelection } from "@claxedo/agent-runtime-contract"

export type HarnessConnectionReadiness = "ready" | "unavailable" | "disabled"

export type HarnessConnectionCapabilities = {
  abort: boolean
  reconnect: boolean
  replay: boolean
  permissions: boolean
  questions: boolean
  todos: boolean
  commands: boolean
  fork: boolean
  revert: boolean
  unrevert: boolean
  configOptions: boolean
  subagents: boolean
}

export type HarnessConnectionRef = {
  connectionId: string
  label: string
  enabled: boolean
  readiness: HarnessConnectionReadiness
  capabilities: HarnessConnectionCapabilities
  modelSelection?: ModelSelection
}

const CAPABILITY_KEYS = [
  "abort",
  "reconnect",
  "replay",
  "permissions",
  "questions",
  "todos",
  "commands",
  "fork",
  "revert",
  "unrevert",
  "configOptions",
  "subagents",
] as const

export function decodeHarnessConnectionRefs(value: unknown): HarnessConnectionRef[] {
  const root = record(value)
  if (!Array.isArray(root?.connections)) return []
  return root.connections.flatMap((value) => {
    const row = record(value)
    const capabilities = decodeCapabilities(row?.capabilities)
    const modelSelection = decodeModelSelection(row?.modelSelection)
    if (
      !row
      || typeof row.connectionId !== "string"
      || !row.connectionId
      || typeof row.label !== "string"
      || !row.label.trim()
      || typeof row.enabled !== "boolean"
      || !isReadiness(row.readiness)
      || !capabilities
      || (row.modelSelection !== undefined && !modelSelection)
    ) return []
    return [{
      connectionId: row.connectionId,
      label: row.label,
      enabled: row.enabled,
      readiness: row.readiness,
      capabilities,
      ...(modelSelection ? { modelSelection } : {}),
    }]
  })
}

export function createHarnessConnectionsCatalog(input: {
  base: string
  request: typeof fetch
}) {
  const [rows, setRows] = createSignal<HarnessConnectionRef[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const refresh = async () => {
    setLoading(true)
    setError()
    try {
      const response = await input.request(new URL("/api/claxedo/agent-config/connections", input.base))
      if (!response.ok) {
        setRows([])
        setError(`Failed to load agent connections (status ${response.status})`)
        return
      }
      setRows(decodeHarnessConnectionRefs(await response.json().catch(() => undefined)))
    } catch (cause) {
      setRows([])
      setError(cause instanceof Error ? cause.message : "Failed to load agent connections")
    } finally {
      setLoading(false)
    }
  }

  const remove = async (connectionId: string) => {
    try {
      const response = await input.request(
        new URL(`/api/claxedo/agent-config/connections/${encodeURIComponent(connectionId)}`, input.base),
        { method: "DELETE" },
      )
      if (!response.ok) return { ok: false, error: `Remove failed (status ${response.status})` }
      await refresh()
      return { ok: true }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : "Remove failed" }
    }
  }

  return {
    rows,
    loading,
    error,
    refresh,
    remove,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return Object.fromEntries(Object.entries(value))
}

function isReadiness(value: unknown): value is HarnessConnectionReadiness {
  return value === "ready" || value === "unavailable" || value === "disabled"
}

function decodeCapabilities(value: unknown): HarnessConnectionCapabilities | undefined {
  const row = record(value)
  if (
    !row
    || CAPABILITY_KEYS.some((key) => typeof row[key] !== "boolean")
    || Object.keys(row).some((key) => !CAPABILITY_KEYS.includes(key as (typeof CAPABILITY_KEYS)[number]))
  ) return
  return {
    abort: row.abort === true,
    reconnect: row.reconnect === true,
    replay: row.replay === true,
    permissions: row.permissions === true,
    questions: row.questions === true,
    todos: row.todos === true,
    commands: row.commands === true,
    fork: row.fork === true,
    revert: row.revert === true,
    unrevert: row.unrevert === true,
    configOptions: row.configOptions === true,
    subagents: row.subagents === true,
  }
}

function decodeModelSelection(value: unknown): ModelSelection | undefined {
  const row = record(value)
  if (!row || Object.keys(row).some((key) => key !== "status" && key !== "models")) return
  if (row.status === "unsupported" && row.models === undefined) return { status: "unsupported" }
  if (row.status !== "required" && row.status !== "optional") return
  const models = row.models === undefined ? undefined : decodeModels(row.models)
  if (row.models !== undefined && !models) return
  if (row.status === "required") {
    if (!models?.length) return
    return { status: "required", models }
  }
  return { status: "optional", ...(models ? { models } : {}) }
}

function decodeModels(input: unknown): AgentModel[] | undefined {
  if (!Array.isArray(input)) return
  const models: AgentModel[] = []
  for (const item of input) {
    const row = record(item)
    if (
      !row
      || typeof row.providerId !== "string"
      || !row.providerId
      || typeof row.modelId !== "string"
      || !row.modelId
      || typeof row.name !== "string"
      || !row.name
      || (row.description !== undefined && typeof row.description !== "string")
      || Object.keys(row).some((key) => !["providerId", "modelId", "name", "description"].includes(key))
    ) return
    models.push({
      providerId: row.providerId,
      modelId: row.modelId,
      name: row.name,
      ...(typeof row.description === "string" ? { description: row.description } : {}),
    })
  }
  return models
}
