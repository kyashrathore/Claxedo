import { createTransport } from "@/platform/runtime/transport"
import { queryClient } from "@/platform/query/query-client"
import { workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { workspaceResolveUrl } from "@/platform/runtime/agent/workspace-control-routes"
import { centralTransportForServer } from "@/platform/runtime/transport"

const USER_HOSTED_WORKSPACE_KIND = "user-hosted"

export type LiveSession = {
  sessionID: string
  directory?: string
  workspaceId?: string
  workspaceKind?: string
}

export type ControlPlaneEventFetchInput = {
  signedControlPlane: () => boolean
  liveSession: () => LiveSession | undefined
  setLiveSession: (session: LiveSession) => void
  fetch: typeof fetch
}

function runtimeWorkspaceKind(input: unknown) {
  if (input === "local" || input === "cloud" || input === USER_HOSTED_WORKSPACE_KIND) return input
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
      const resolvedWorkspaceKind = runtimeWorkspaceKind(resolvedWorkspace?.kind)
      const sessionWorkspaceKind = runtimeWorkspaceKind(session?.workspaceKind)
      const workspaceId = resolvedWorkspace?.kind === "local"
        ? undefined
        : resolvedWorkspace?.workspaceId ?? (sessionWorkspaceKind === "local" ? undefined : session?.workspaceId)
      return await createTransport({
        placement: {
          ...(workspaceId ? { workspaceId } : {}),
          hosting: "workspace",
          transport: workspaceId && (input.signedControlPlane() || centralTransportForServer(url.origin) !== "loopback")
            ? "workspace-relay"
            : "loopback",
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
