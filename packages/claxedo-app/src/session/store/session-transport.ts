import { createHttpSessionBackend, DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES } from "../../shared/data/http-backend"
import type { SessionTransportCapabilities } from "../../shared/data/types"
import { usesScopedSessionTransport } from "../../shell/identity/legacy-resolver"
import { suppressedByFastSessionSwitch } from "./fast-session-switch"

type SessionClient = Parameters<typeof createHttpSessionBackend>[0]["client"]

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
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
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
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
  }).listTodos(input)
}

export async function fetchSessionCapabilitiesByTransport(input: {
  client: SessionClient
  directory: string
  sessionID?: string
  claxedoServerUrl?: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
}) {
  return await createHttpSessionBackend({
    client: input.client,
    claxedoServerUrl: input.claxedoServerUrl,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    workspaceKind: input.workspaceKind,
  }).getCapabilities(input)
}
