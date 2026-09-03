import { getDefaultBaseUrl, normalizeUrl } from "@/platform/api/api"
import { controlSessionUrl } from "@/platform/runtime/agent/workspace-control-routes"

export type AgentRuntimeDirectory = string

export type AgentRuntimeSessionResource = "session" | "messages" | "todo" | "capabilities" | "config"
type AgentRuntimeSessionResourceSuffix = "" | "/message" | "/messages" | "/todo" | "/capabilities" | "/config"

export function normalizedAgentRuntimeServerUrl(url: string | undefined) {
  const trimmed = url?.trim()
  if (!trimmed) return "default"
  return trimmed.replace(/\/+$/, "")
}

export function agentRuntimeBaseUrl(serverUrl: string | undefined) {
  return normalizeUrl(serverUrl) ?? getDefaultBaseUrl()
}

export function agentRuntimeSessionUrl(input: { serverUrl?: string; sessionID: string; suffix?: string }) {
  return new URL(`/session/${encodeURIComponent(input.sessionID)}${input.suffix ?? ""}`, agentRuntimeBaseUrl(input.serverUrl))
}

export function agentRuntimeSessionListUrl(input: { serverUrl?: string; scope?: string; roots?: boolean; limit?: number }) {
  const url = new URL("/session", agentRuntimeBaseUrl(input.serverUrl))
  if (input.scope) url.searchParams.set("directory", input.scope)
  if (input.roots) url.searchParams.set("roots", "true")
  if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit))
  return url
}

export function agentRuntimeEventsUrl(input: {
  serverUrl?: string
  workspaceId?: string
  scope?: string
  sessionID?: string
}) {
  const sessionID = input.sessionID?.trim()
  if (input.workspaceId) {
    const url = new URL(`/workspaces/${encodeURIComponent(input.workspaceId)}/api/wr/events`, agentRuntimeBaseUrl(input.serverUrl))
    if (sessionID) url.searchParams.set("sessionID", sessionID)
    return url
  }
  const url = new URL("/api/wr/events", agentRuntimeBaseUrl(input.serverUrl))
  if (input.scope) url.searchParams.set("directory", input.scope)
  if (sessionID) url.searchParams.set("sessionID", sessionID)
  return url
}

export function agentRuntimeSessionResourceUrl(input: {
  serverUrl?: string
  sessionID: string
  directory: AgentRuntimeDirectory
  signedControlPlane?: boolean
  workspaceId?: string
  resource?: AgentRuntimeSessionResource
  query?: Record<string, string | number | undefined>
}) {
  const signed = input.signedControlPlane === true
  const suffix: AgentRuntimeSessionResourceSuffix = (() => {
    if (!input.resource || input.resource === "session") return ""
    if (input.resource === "messages") return signed ? "/messages" : "/message"
    return `/${input.resource}`
  })()
  const url = signed
    ? controlSessionUrl({
      baseUrl: agentRuntimeBaseUrl(input.serverUrl),
      sessionID: input.sessionID,
      suffix: suffix || undefined,
      workspaceId: input.workspaceId,
    })
    : agentRuntimeSessionUrl({
      serverUrl: input.serverUrl,
      sessionID: input.sessionID,
      suffix,
    })
  if (!signed) url.searchParams.set("directory", input.directory)
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url
}
