import type { Accessor } from "solid-js"
import { useServer, type SessionLocation } from "@/server"
import { useShellRoute } from "@/shell"

export function useActiveSession(): Accessor<SessionLocation | undefined> {
  const routing = useShellRoute()
  const server = useServer()
  return () => {
    const route = routing.route()
    if (route.kind !== "session") return undefined
    const placement = server.placements.byId(route.placementId)
    if (!placement) return undefined
    return { projectId: placement.projectId, placementId: route.placementId, sessionId: route.sessionId }
  }
}
