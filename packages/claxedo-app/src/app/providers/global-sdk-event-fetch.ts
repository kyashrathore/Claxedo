import { centralTransportForServer, createTransport } from "@/platform/runtime/transport"
import type { SessionRef } from "@/platform/identity/session-ref"
import { accountStreamAvailable, openAccountStreamResponse } from "@/platform/account/account-stream-fetch"
import type { AccountState } from "@/platform/account/account-port"
import { workspaceKind } from "@/platform/runtime/agent/workspace-kind"

export type LiveSession = {
  sessionID: string
  host?: "workspace"
  directory?: string
  workspaceId?: string
  workspaceKind?: string
  sessionRef?: SessionRef
}

export function workspaceEventTransport(input: {
  serverUrl: string
  signedControlPlane: boolean
  workspaceId?: string
  workspaceKind?: string
}) {
  const kind = workspaceKind(input.workspaceKind)
  return input.workspaceId && kind !== "local" && (
    input.signedControlPlane || centralTransportForServer(input.serverUrl) !== "loopback"
  ) ? "workspace-relay" as const : "loopback" as const
}

/** Opens the one private session lane; the transport owns relay authorization. */
export function openWorkspaceRuntimeEventResponse(input: {
  request: typeof fetch
  serverUrl: string
  session: LiveSession
  signedControlPlane: boolean
  init: RequestInit
  resolveWorkspaceRuntime?: Parameters<typeof createTransport>[0]["resolveWorkspaceRuntime"]
}) {
  const sessionID = input.session.sessionID.trim()
  if (!sessionID || sessionID === "route") throw new Error("Runtime events require a session identity")
  const path = new URL("/api/wr/runtime-events", input.serverUrl)
  if (input.session.directory) path.searchParams.set("directory", input.session.directory)
  path.searchParams.set("parentSessionId", sessionID)
  return createTransport({
    placement: {
      ...(input.session.workspaceId ? { workspaceId: input.session.workspaceId } : {}),
      hosting: "workspace",
      transport: workspaceEventTransport({
        serverUrl: input.serverUrl,
        signedControlPlane: input.signedControlPlane,
        workspaceId: input.session.workspaceId,
        workspaceKind: input.session.workspaceKind,
      }),
    },
    serverUrl: input.serverUrl,
    directory: input.session.directory,
    resolveWorkspaceRuntime: input.resolveWorkspaceRuntime,
    request: input.request,
    relayRequest: input.request,
  }).fetch(`${path.pathname}${path.search}`, input.init)
}
