import type { Accessor } from "solid-js"
import { useServer, type PlacementId, type SessionRef } from "@/server"
import { useShellRoute } from "@/shell"

export function useActivePlacement(): Accessor<PlacementId | undefined> {
  const routing = useShellRoute()
  return () => {
    const route = routing.route()
    return route.kind === "session" || route.kind === "terminal" ? route.placementId : undefined
  }
}

export function useActiveSession(): Accessor<SessionRef | undefined> {
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
