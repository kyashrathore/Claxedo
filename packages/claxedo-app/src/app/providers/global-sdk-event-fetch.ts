import { createTransport } from "@/platform/runtime/transport"
import { queryClient } from "@/platform/query/query-client"
import { workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { workspaceResolveUrl } from "@/platform/runtime/agent/workspace-control-routes"
import { centralTransportForServer } from "@/platform/runtime/transport"
import type { SessionRef } from "@/platform/identity/session-ref"
import { accountStreamAvailable, openAccountStreamResponse } from "@/platform/account/account-stream-fetch"
import type { AccountState } from "@/platform/account/account-port"
import { workspaceKind } from "@/platform/runtime/agent/workspace-kind"

export type LiveSession = {
  sessionID: string
  host?: "central" | "workspace"
  directory?: string
  workspaceId?: string
  workspaceKind?: string
  sessionRef?: SessionRef
}

export type ControlPlaneEventFetchInput = {
  signedControlPlane: () => boolean
  liveSession: () => LiveSession | undefined
  setLiveSession: (session: LiveSession) => void
  fetch: typeof fetch
}

export async function openCentralRuntimeEventResponse(input: {
  request: typeof fetch
  serverUrl: string
  sessionId: string
  lastEventId?: string
  init: RequestInit
  signal: AbortSignal
  accountState: AccountState
}) {
  if (!accountStreamAvailable(input.accountState)) {
    return input.request(
      new URL(
        `/api/control/session/${encodeURIComponent(input.sessionId)}/runtime-events?parentSessionId=${encodeURIComponent(input.sessionId)}`,
        input.serverUrl,
      ),
      input.init,
    )
  }
  return openAccountStreamResponse({
    operation: "session.runtimeEvents",
    params: {
      sessionId: input.sessionId,
      parentSessionId: input.sessionId,
      ...(input.lastEventId ? { lastEventId: input.lastEventId } : {}),
    },
    signal: input.signal,
  })
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

export function createControlPlaneEventFetch(input: ControlPlaneEventFetchInput): typeof fetch {
  const workspace = async (requestUrl: string, session: LiveSession) => {
    if (session.workspaceId) {
      return {
        workspaceId: session.workspaceId,
        ...(session.workspaceKind ? { kind: session.workspaceKind } : {}),
      }
    }
    if (!session.directory) return
    const directoryWorkspaceId = workspaceIdFromRef(session.directory)
    if (directoryWorkspaceId) return { workspaceId: directoryWorkspaceId, kind: "cloud" }
    return await queryClient.fetchQuery({
      queryKey: ["shell", "control-plane-event-workspace", requestUrl.replace(/\/+$/, ""), session.directory] as const,
      queryFn: async () => {
        const res = await input.fetch(workspaceResolveUrl({ baseUrl: requestUrl, scope: session.directory }))
        if (!res.ok) throw new Error(`signed event workspace resolve failed: ${res.status}`)
        const data = await res.json() as { workspaceId?: unknown; kind?: unknown }
        if (typeof data.workspaceId !== "string") throw new Error("signed event workspace resolve did not return workspaceId")
        return {
          workspaceId: data.workspaceId,
          ...(typeof data.kind === "string" ? { kind: data.kind } : {}),
        }
      },
      staleTime: Number.POSITIVE_INFINITY,
    })
  }

  return async (requestInput, init) => {
    const request = new Request(requestInput, init)
    const url = new URL(request.url)
    const session = input.liveSession()
    if (url.pathname !== "/global/event" && url.pathname !== "/event") return input.fetch(request)
    if (session?.host === "central") return input.fetch(request)
    // A signed-out local desktop already receives canonical local workspace
    // events through its loopback compat stream. Do not ask the local product
    // for the hosted `api/workspace/resolve` authority merely because a local
    // session has a filesystem directory.
    if (
      centralTransportForServer(url.origin) === "loopback" &&
      !input.signedControlPlane() &&
      session?.directory &&
      !session.workspaceId
    ) return input.fetch(request)

    const explicitWorkspaceId = url.searchParams.get("workspaceId")
    const resolvedWorkspace = explicitWorkspaceId
      ? { workspaceId: explicitWorkspaceId }
      : session
        ? await workspace(request.url, session)
        : undefined

    if (session?.directory || resolvedWorkspace?.workspaceId) {
      if (session && resolvedWorkspace?.kind === "local" && session.workspaceId) {
        input.setLiveSession({ ...session, workspaceId: undefined, workspaceKind: "local" })
      } else if (session && resolvedWorkspace?.workspaceId && resolvedWorkspace.kind !== "local" && session.workspaceId !== resolvedWorkspace.workspaceId) {
        input.setLiveSession({
          ...session,
          workspaceId: resolvedWorkspace.workspaceId,
          ...(resolvedWorkspace.kind ? { workspaceKind: resolvedWorkspace.kind } : {}),
        })
      }
      const resolvedWorkspaceKind = workspaceKind(resolvedWorkspace?.kind)
      const sessionWorkspaceKind = workspaceKind(session?.workspaceKind)
      const workspaceId = resolvedWorkspace?.kind === "local"
        ? undefined
        : resolvedWorkspace?.workspaceId ?? (sessionWorkspaceKind === "local" ? undefined : session?.workspaceId)
      const transport = workspaceEventTransport({
        serverUrl: url.origin,
        signedControlPlane: input.signedControlPlane(),
        workspaceId,
        workspaceKind: resolvedWorkspaceKind ?? sessionWorkspaceKind,
      })
      if (transport === "workspace-relay") {
        const sessionID = session?.sessionID.trim()
        if (sessionID && sessionID !== "route") {
          // The session controller is the canonical producer of LiveSession.
          // Stamp its current value on every attempt so initial connect,
          // reconnect, and Last-Event-ID replay all traverse the same managed
          // private-session authorization boundary. Never infer it from the
          // workspace or directory.
          url.searchParams.set("sessionID", sessionID)
        } else {
          // A caller URL is transport input, not session authority. In
          // particular, a reconnect racing a route transition may still carry
          // the previous session's query. Remove it unless LiveSession names a
          // real current session; otherwise the stale caller scope could be
          // relayed under fresh actor credentials.
          url.searchParams.delete("sessionID")
          // A workspace route/sentinel is not session authority. Keep the
          // signed control-plane lifecycle stream alive until a real session
          // becomes active instead of opening an unscoped managed stream.
          if (input.signedControlPlane()) {
            return input.fetch(new Request(new URL("/api/wr/events", request.url), request))
          }
        }
      }
      return await createTransport({
        placement: {
          ...(workspaceId ? { workspaceId } : {}),
          hosting: "workspace",
          transport,
        },
        serverUrl: url.origin,
        directory: session?.directory,
        request: input.fetch,
        relayRequest: input.fetch,
      }).fetch(`${url.pathname}${url.search}`, request)
    }

    if (!input.signedControlPlane()) return input.fetch(request)
    return input.fetch(new Request(new URL("/api/wr/events", request.url), request))
  }
}
