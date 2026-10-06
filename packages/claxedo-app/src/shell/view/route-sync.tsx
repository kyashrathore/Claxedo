import { createEffect, on, onCleanup, untrack, type JSX } from "solid-js"
import { useServer, type ProjectId } from "@/server"
import { useSessionStores } from "@/session"
import { useWorkbench } from "@/workbench"
import { useShellLayout } from "../layout"
import { useShellRoute } from "../router"
import { draftPath, homePath, sessionPath, terminalPath, type ShellRoute } from "../routes"
import type { PaneRoute } from "../types"

function panePath(route: PaneRoute): string {
  if (route.kind === "pageTab") return route.path
  if (route.kind === "draft") return draftPath(route.placementId)
  return route.kind === "session" ? sessionPath(route) : terminalPath(route.placementId, route.terminalId)
}

function namesPlacement(route: ShellRoute): route is Extract<ShellRoute, { readonly kind: "draft" | "session" | "terminal" }> {
  return route.kind === "draft" || route.kind === "session" || route.kind === "terminal"
}

function namesTabPage(route: ShellRoute): boolean {
  return route.kind === "page" && route.page.tab === true
}

function showsPanes(route: ShellRoute): boolean {
  return namesPlacement(route) || namesTabPage(route)
}

function namesPane(route: ShellRoute, pane: PaneRoute): boolean {
  return route.kind === "session" && pane.kind === "session" && route.sessionId === pane.sessionId
}

function paneRouteOf(
  route: ShellRoute,
  pathname: string,
  projectOf: (route: Extract<ShellRoute, { placementId: unknown }>) => ProjectId | undefined,
): PaneRoute | undefined {
  if (namesTabPage(route)) return { kind: "pageTab", path: pathname }
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
  const stores = useSessionStores()
  onCleanup(routing.resolveSessions((id) => stores.list.rowOf(id)?.ref.placementId))

  createEffect(on([routing.route, routing.chosen, workbench.selectors.focusedContent], () => layout.send({ type: "navigated" }), { defer: true }))

  createEffect(() => {
    const target = paneRouteOf(routing.route(), routing.pathname(), (route) => route.kind === "session"
      ? server.sharedSessions.find(route)?.ref.projectId ?? server.placements.byId(route.placementId)?.projectId
      : server.placements.byId(route.placementId)?.projectId)
    if (target) untrack(() => workbench.openRoute(target))
  })

  createEffect(() => {
    if (workbench.selectors.focusedContent()) return
    const route = routing.route()
    if (namesTabPage(route)) return untrack(() => routing.navigate(homePath, { replace: true }))
    if (!namesPlacement(route)) return
    const projectId = server.placements.byId(route.placementId)?.projectId
    if (projectId) untrack(() => workbench.openRoute({ kind: "draft", projectId, placementId: route.placementId }))
  })

  createEffect(() => {
    const focused = workbench.selectors.focusedContent()
    if (!focused) return
    const paneRoute = workbench.routeOf(focused)
    if (!paneRoute) return
    const path = panePath(paneRoute)
    const route = untrack(routing.route)
    if (!showsPanes(route) || namesPane(route, paneRoute) || path === untrack(routing.pathname)) return
    routing.navigate(path, { replace: true })
  })

  return null
}
