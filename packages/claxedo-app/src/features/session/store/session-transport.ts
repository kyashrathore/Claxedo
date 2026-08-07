import { createHttpSessionBackend, DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES } from "@/platform/runtime/http-backend"
import type { SessionTransportCapabilities } from "../data/backend/types"
import type { AgentRuntimeDirectory } from "@/platform/runtime/agent/agent-runtime-client"
import { usesScopedSessionTransport } from "@/platform/identity/legacy-resolver"
import { suppressedByFastSessionSwitch } from "@/platform/runtime/session-switch"
import type { SessionRef } from "@/platform/identity/session-ref"

export type SessionClient = Parameters<typeof createHttpSessionBackend>[0]["client"]

export type { SessionTransportCapabilities }
export { DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES }

export function usesClaxedoSessionTransport(sessionID: string | undefined, directory?: string) {
  return usesScopedSessionTransport(sessionID, directory)
}

export async function fetchSessionByTransport(input: {
  client: SessionClient
  directory: string
  sessionID: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
    sessionRef: input.sessionRef,
  }).getSession(input)
}

export async function fetchSessionMessagesByTransport(input: {
  client: SessionClient
  directory: string
  sessionID: string
  limit: number
  before?: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  /**
   * Whether the workspace runtime can currently answer. A dead CLOUD workspace
   * reads its transcript from the control plane instead of the relay — the
   * history synced there outlives the sandbox.
   */
  workspaceReachable?: boolean
  sessionRef?: SessionRef
}) {
  if (suppressedByFastSessionSwitch(input.sessionID)) {
    return { data: [], response: new Response(null) }
  }
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
    workspaceReachable: input.workspaceReachable,
    sessionRef: input.sessionRef,
  }).listMessages(input)
}

export async function fetchSessionTodoByTransport(input: {
  client: SessionClient
  directory: string
  sessionID: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
    sessionRef: input.sessionRef,
  }).listTodos(input)
}

/**
 * The harness's own permission modes for a session.
 *
 * Same transport split as the todo fetch beside it, for the same reason: which
 * backend answers depends on the session's scope, and only the runtime transport
 * has this route at all.
 */
export async function fetchSessionPermissionModesByTransport(input: {
  client: SessionClient
  directory: AgentRuntimeDirectory
  sessionID: string
  /** The harness being asked about — see the port doc; required on a draft. */
  harness?: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
    sessionRef: input.sessionRef,
  }).getPermissionModes(input)
}

export async function setSessionPermissionModeByTransport(input: {
  client: SessionClient
  directory: AgentRuntimeDirectory
  sessionID: string
  modeId: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
    sessionRef: input.sessionRef,
  }).setPermissionMode(input)
}

export async function fetchSessionCapabilitiesByTransport(input: {
  client: SessionClient
  directory: string
  sessionID?: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
  sessionRef?: SessionRef
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
    sessionRef: input.sessionRef,
  }).getCapabilities(input)
}
