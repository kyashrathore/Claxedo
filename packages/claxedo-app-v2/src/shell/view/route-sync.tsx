import { createEffect, on, untrack, type JSX } from "solid-js"
import { useServer } from "@/server"
import { useWorkbench } from "@/workbench"
import { useShellLayout } from "../layout"
import { useShellRoute } from "../router"
import { sessionPath, terminalPath, type ShellRoute } from "../routes"
import type { PaneRoute } from "../types"

function panePath(route: PaneRoute): string {
  return route.kind === "session" ? sessionPath(route) : terminalPath(route.placementId, route.terminalId)
}

function showsPanes(route: ShellRoute): boolean {
  return route.kind === "home" || route.kind === "session" || route.kind === "terminal"
}

export function RouteSync(): JSX.Element {
  const routing = useShellRoute()
  const server = useServer()
  const workbench = useWorkbench()
  const layout = useShellLayout()

  createEffect(on(routing.route, () => layout.send({ type: "navigated" }), { defer: true }))

  createEffect(() => {
    const route = routing.route()
    if (route.kind === "terminal") {
      untrack(() => workbench.openRoute({ kind: "terminal", placementId: route.placementId, terminalId: route.terminalId }))
      return
    }
    if (route.kind !== "session") return
    const placement = server.placements.byId(route.placementId)
    if (!placement) return
    untrack(() => workbench.openRoute({ kind: "session", projectId: placement.projectId, placementId: route.placementId, sessionId: route.sessionId }))
  })

  createEffect(() => {
    const focused = workbench.selectors.focusedContent()
    if (!focused) return
    const paneRoute = workbench.routeOf(focused)
    if (!paneRoute) return
    const path = panePath(paneRoute)
    if (!showsPanes(untrack(routing.route)) || path === untrack(routing.pathname)) return
    routing.navigate(path, { replace: true })
  })

  return null
}
