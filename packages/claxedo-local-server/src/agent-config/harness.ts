import {
  type AgentHarnessId,
  type SessionHarnessId,
  type SessionHarness,
} from "@claxedo/agent-sdk-runtime"
import { normalize } from "@claxedo/server-core/session/harness/index"
import { sandboxFetch, type SandboxFetchOptions } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"

export type HarnessConfigOption = {
  id: string
  name: string
  category?: string | null
  type: "select" | "boolean"
  currentValue: unknown
  options?: Array<{ value: string; name: string; description?: string }>
  selectOptions?: Array<{ id: string; name: string }>
}

import type { ResolvedHarnessModel } from "@claxedo/agent-sdk-runtime"
export type { ResolvedHarnessModel }

export type OptionsResponse = {
  options: HarnessConfigOption[]
  source: "harness" | "catalog"
  stale: boolean
  /** The model the harness resolved for itself, when it named one. */
  resolvedModel?: ResolvedHarnessModel
}

/** The runtime's own answer shape for `/api/wr/harness-config-options`. */
export type RuntimeHarnessConfigOptions = {
  options: HarnessConfigOption[]
  resolvedModel?: ResolvedHarnessModel
}

export function isRuntimeHarnessConfigOptions(value: unknown): value is RuntimeHarnessConfigOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (!Array.isArray(row.options)) return false
  const resolved = row.resolvedModel
  if (resolved === undefined) return true
  if (!resolved || typeof resolved !== "object") return false
  const model = resolved as Record<string, unknown>
  return typeof model.id === "string" && typeof model.name === "string"
}

/** Canonical successful response for the local harness-options proxy. */
export function liveHarnessOptionsResponse(live: RuntimeHarnessConfigOptions): OptionsResponse {
  return {
    options: live.options,
    source: "harness",
    stale: false,
    ...(live.resolvedModel ? { resolvedModel: live.resolvedModel } : {}),
  }
}

type NativeSdkHarnessId = Extract<AgentHarnessId, "claude" | "codex" | "cursor">

export function isNativeSdkHarnessId(id: SessionHarnessId): id is NativeSdkHarnessId {
  return id === "claude" || id === "codex" || id === "cursor"
}

export function harnessModelConfigurable(harness: SessionHarness) {
  return harness.access === "connection" || isNativeSdkHarnessId(harness.id)
}

export function harnessConfigOptionsUnavailable(harness: SessionHarness) {
  if (harness.id === "pi") return "pi does not expose harness config options"
  return `${harness.id} did not return live harness config options`
}

export function sameHarness(a: SessionHarness, b: SessionHarness) {
  return a.id === b.id && a.access === b.access
}

export type SandboxHarnessHealth = {
  status?: "ok" | "degraded" | "unavailable"
  reason?: string
  message?: string
}

export type SandboxHealth = {
  ok?: boolean
  status?: string
  agentType?: string
  acpBinary?: string | null
  model?: string | null
  error?: string | null
  harnessHealth?: SandboxHarnessHealth
}

type RuntimeSessionConfig = {
  harness?: SessionHarness
  model?: {
    providerID?: string
    modelID?: string
  }
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
    return config.harness?.id ? normalize(config.harness) : undefined
  } catch {
    return
  }
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

export function workspaceRuntimeHealthPath(sessionId?: string) {
  if (!sessionId) return "/api/wr/health"
  const params = new URLSearchParams({ sessionId })
  return `/api/wr/health?${params}`
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
