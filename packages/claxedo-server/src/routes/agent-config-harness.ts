import {
  isSdkModelId,
  normalizeAgentHarnessTransport,
  normalizeHarnessIdentity,
  type AgentHarnessId,
  type SessionHarness,
} from "@claxedo/agent-sdk-runtime"
import { normalize } from "../session-harness"
import { sandboxFetch, type SandboxFetchOptions } from "../sandbox-target-fetch"
import type { Workspace } from "../workspace-store"

export type HarnessConfigOption = {
  id: string
  name: string
  category?: string | null
  type: "select" | "boolean"
  currentValue: unknown
  options?: Array<{ value: string; name: string; description?: string }>
  selectOptions?: Array<{ id: string; name: string }>
}

export type OptionsResponse = {
  options: HarnessConfigOption[]
  source: "harness" | "catalog"
  stale: boolean
}

type NativeSdkHarnessId = Extract<AgentHarnessId, "claude" | "codex" | "cursor">

export function isNativeSdkHarnessId(id: AgentHarnessId): id is NativeSdkHarnessId {
  return id === "claude" || id === "codex" || id === "cursor"
}

export function harnessModelConfigurable(harness: SessionHarness) {
  return harness.access === "acp" || isNativeSdkHarnessId(harness.id)
}

export function harnessConfigOptionsUnavailable(harness: SessionHarness) {
  if (harness.id === "opencode") return "opencode model options are exposed through /provider, not harness config options"
  if (harness.id === "pi") return "pi does not expose harness config options"
  return `${harness.id} did not return live harness config options`
}

export function harnessBinary(harness: SessionHarness) {
  return harness.connection?.kind === "process" ? harness.connection.binary : undefined
}

export function sameHarness(a: SessionHarness, b: SessionHarness) {
  return a.id === b.id
    && a.access === b.access
    && (harnessBinary(a) ?? "") === (harnessBinary(b) ?? "")
}

export function harnessFromRequest(input: unknown, fallback?: { type?: unknown; id?: unknown; access?: unknown; binary?: unknown; transport?: unknown; url?: unknown; headers?: unknown }) {
  const identity = normalizeHarnessIdentity(input ?? fallback)
  if (!identity) return
  const row = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : fallback ?? {}
  const binary = typeof row.binary === "string" ? row.binary : undefined
  const transport = normalizeAgentHarnessTransport(row.transport)
  const headers = stringRecord(row.headers)
  const url = typeof row.url === "string" ? row.url : undefined
  return normalize({
    id: identity.id,
    access: identity.access,
    ...(binary
      ? { connection: { kind: "process" as const, binary } }
      : url || transport || headers
      ? {
          connection: {
            kind: "remote" as const,
            ...(transport ? { transport } : {}),
            ...(url ? { url } : {}),
            ...(headers ? { headers } : {}),
          },
        }
      : {}),
  })
}

export type SandboxHealth = {
  ok?: boolean
  status?: string
  agentType?: string
  acpBinary?: string | null
  model?: string | null
  error?: string | null
}

type RuntimeSessionConfig = {
  harness?: SessionHarness
  runner?: {
    type?: string
    binary?: string
    model?: string
    transport?: string
    url?: string
    headers?: Record<string, unknown>
  }
  model?: {
    providerID?: string
    modelID?: string
  }
}

function stringRecord(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input)
    && Object.values(input).every((item) => typeof item === "string")
    ? input as Record<string, string>
    : undefined
}

export async function cloudRuntimeSessionHarness(
  ws: Workspace,
  sessionId?: string,
  options: SandboxFetchOptions = {},
) {
  if (ws.kind !== "cloud" || !sessionId) return
  try {
    const url = new URL(`/session/${encodeURIComponent(sessionId)}/config`, "http://sandbox-manager.local")
    url.searchParams.set("directory", ws.remote_directory || "/workspace")
    const res = await sandboxFetch(ws, `${url.pathname}${url.search}`, undefined, options)
    if (!res.ok) return
    const config = await res.json() as RuntimeSessionConfig
    return config.harness?.id
      ? normalize(config.harness)
      : harnessFromRequest(config.runner, config.runner)
  } catch {
    return
  }
}

export function requestedHarness(input?: string | null) {
  const identity = input ? normalizeHarnessIdentity(input) : undefined
  return identity ? normalize(identity) : undefined
}

export async function sandboxJson<T>(
  ws: Workspace,
  path: string,
  init?: RequestInit,
  options: SandboxFetchOptions = {},
) {
  const res = await sandboxFetch(ws, path, init, options)
  if (!res.ok) {
    const body = await res.clone().json().catch(() => undefined)
    const error = body && typeof body === "object" && !Array.isArray(body) ? body.error : undefined
    const message = error && typeof error === "object" && !Array.isArray(error) && typeof error.message === "string"
      ? error.message
      : `sandbox request failed: ${res.status}`
    throw new Error(message)
  }
  return await res.json() as T
}

export async function sandboxSessionExists(
  ws: Workspace,
  sessionId: string,
  options: SandboxFetchOptions = {},
) {
  const params = new URLSearchParams({
    directory: ws.kind === "cloud" ? (ws.remote_directory || "/workspace") : ws.directory,
  })
  const res = await sandboxFetch(ws, `/session/${encodeURIComponent(sessionId)}?${params}`, undefined, options)
    .catch(() => undefined)
  return !!res?.ok
}
