import { createEffect, on, untrack, type JSX } from "solid-js"
import { useServer, type ProjectId } from "@/server"
import { useWorkbench } from "@/workbench"
import { useShellLayout } from "../layout"
import { useShellRoute } from "../router"
import { draftPath, sessionPath, terminalPath, type ShellRoute } from "../routes"
import type { PaneRoute } from "../types"

function panePath(route: PaneRoute): string {
  if (route.kind === "draft") return draftPath(route.placementId)
  return route.kind === "session" ? sessionPath(route) : terminalPath(route.placementId, route.terminalId)
}

function showsPanes(route: ShellRoute): boolean {
  return route.kind === "home" || route.kind === "draft" || route.kind === "session" || route.kind === "terminal"
}

function paneRouteOf(route: ShellRoute, projectOf: (route: Extract<ShellRoute, { placementId: unknown }>) => ProjectId | undefined): PaneRoute | undefined {
  if (route.kind === "terminal") return { kind: "terminal", placementId: route.placementId, terminalId: route.terminalId }
  if (route.kind !== "draft" && route.kind !== "session") return undefined
  const projectId = projectOf(route)
  if (!projectId) return undefined
  return route.kind === "draft"
    ? { kind: "draft", projectId, placementId: route.placementId }
    : { kind: "session", projectId, placementId: route.placementId, sessionId: route.sessionId }
}

export function RouteSync(): JSX.Element {
  const routing = useShellRoute()
  const server = useServer()
  const workbench = useWorkbench()
  const layout = useShellLayout()

  createEffect(on(routing.route, () => layout.send({ type: "navigated" }), { defer: true }))
  createEffect(on(workbench.selectors.focusedContent, () => layout.send({ type: "navigated" }), { defer: true }))

  createEffect(() => {
    const target = paneRouteOf(routing.route(), (route) => server.placements.byId(route.placementId)?.projectId)
    if (target) untrack(() => workbench.openRoute(target))
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
