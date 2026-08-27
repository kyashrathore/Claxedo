import type { ContentMeta } from "./types"
import {
  marketplaceRoute,
  newTaskRoute,
  workGraphRoute,
  sessionRoute as canonicalSessionRoute,
  workspacePageRoute,
  workspaceRoute as canonicalWorkspaceRoute,
  workspaceSessionRoute,
  workspaceTerminalRoute,
  workspaceWorkGraphRoute,
} from "@/platform/identity/route"
import { PENDING_TERMINAL_PREFIX } from "@/features/terminal/core/terminal-surface-id"
import { workspaceKey } from "@/platform/identity/session-ref"

type RouteContent = Pick<ContentMeta, "type" | "directory" | "sessionId" | "pageId" | "terminalId" | "content">

function workspaceBrowseRoute(workspaceId: string | undefined) {
  return workspaceId ? canonicalWorkspaceRoute(workspaceId) : undefined
}

function pageRoute(workspaceId: string | undefined, pageId: string) {
  return workspaceId ? workspacePageRoute(workspaceId, pageId) : undefined
}

function terminalRoute(workspaceId: string | undefined, terminalId: string) {
  return workspaceId ? workspaceTerminalRoute(workspaceId, terminalId) : undefined
}

function payloadText(content: RouteContent, key: "sessionId" | "pageId" | "terminalId") {
  const value = content.content?.[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function routeSessionId(content: RouteContent) {
  return content.sessionId ?? payloadText(content, "sessionId")
}

function routePageId(content: RouteContent) {
  return content.pageId ?? payloadText(content, "pageId")
}

function routeTerminalId(content: RouteContent) {
  return content.terminalId ?? payloadText(content, "terminalId")
}

function routeSessionRef(content: RouteContent) {
  return content.content?.type === "session" ? content.content.sessionRef : undefined
}

function surfaceWorkspaceRouteKey(content: RouteContent, fallback: string | undefined) {
  if (content.type !== "session") return fallback
  const ref = routeSessionRef(content)
  if (ref?.host !== "workspace") return fallback
  return workspaceKey(ref) ?? fallback
}

export function surfaceRoute(workspaceId: string | undefined, content: RouteContent) {
  if (content.type === "marketplace") return marketplaceRoute()
  if (content.type === "workgraph") return workGraphRoute()
  if (content.type === "workspace-workgraph") return workspaceId ? workspaceWorkGraphRoute(workspaceId) : undefined
  if (content.type === "task-composer") return newTaskRoute(content.directory ? workspaceId : undefined)
  if (content.type === "session") {
    const sessionRef = routeSessionRef(content)
    if (sessionRef?.sessionId && sessionRef.sessionId !== "new") {
      if (sessionRef.host === "workspace") {
        const workspaceId = workspaceKey(sessionRef)
        return workspaceId
          ? workspaceSessionRoute(workspaceId, sessionRef.sessionId)
          : canonicalSessionRoute(sessionRef.sessionId)
      }
      return canonicalSessionRoute(sessionRef.sessionId)
    }
    const sessionId = routeSessionId(content)
    if (sessionId && sessionId !== "new") return canonicalSessionRoute(sessionId)
    const routeId = surfaceWorkspaceRouteKey(content, workspaceId)
    return routeId ? workspaceSessionRoute(routeId) : undefined
  }
  if (content.type === "pages-index") return pageRoute(workspaceId, "__index__")
  if (content.type === "page") {
    const pageId = routePageId(content)
    if (pageId) return pageRoute(workspaceId, pageId)
  }
  const terminalId = routeTerminalId(content)
  // `new` (the creator) DOES get a route, unlike `pending-*`: it is a surface
  // the user can sit on, so it has to survive a reload the way the new-session
  // composer does. `pending-*` stays unroutable because that id is replaced by
  // a real pty id moments later and would deep-link to nothing.
  if (content.type === "terminal" && terminalId && !terminalId.startsWith(PENDING_TERMINAL_PREFIX)) {
    return terminalRoute(workspaceId, terminalId)
  }
  return undefined
}

export function routeMatchesSurface(
  route: {
    id?: string
    marketplace?: boolean
    newTask?: boolean
    workgraph?: boolean
    workspaceWorkGraph?: boolean
    pageId?: string
    terminalId?: string
  },
  workspaceId: string,
  content: RouteContent,
  routeWorkspaceKey?: string,
) {
  if (content.type === "marketplace") return route.marketplace === true
  if (content.type === "workgraph") return route.workgraph === true
  if (content.type === "task-composer") {
    if (route.newTask !== true) return false
    return content.directory ? routeWorkspaceKey === content.directory : !routeWorkspaceKey
  }
  if (content.type === "workspace-workgraph") {
    return route.workspaceWorkGraph === true && routeWorkspaceKey === workspaceId
  }
  if (routeWorkspaceKey !== surfaceWorkspaceRouteKey(content, workspaceId)) return false

  if (content.type === "session") {
    if (route.pageId || route.terminalId) return false
    const sessionId = routeSessionId(content)
    if (!sessionId || sessionId === "new") return !route.id
    return route.id === sessionId
  }

  if (content.type === "pages-index") return route.pageId === "__index__"
  if (content.type === "page") return route.pageId === routePageId(content)
  if (content.type === "terminal") return !!route.terminalId && route.terminalId === routeTerminalId(content)
  return false
}

export function focusedSurfaceRouteTarget(input: {
  route: {
    workspaceId?: string
    dir?: string
    id?: string
    marketplace?: boolean
    newTask?: boolean
    workgraph?: boolean
    workspaceWorkGraph?: boolean
    pageId?: string
    terminalId?: string
  }
  surface?: ContentMeta
  routeWorkspaceKey?: string
  activeRouteId?: string
}) {
  const hasConcreteRoute = !!(input.route.id || input.route.pageId || input.route.terminalId || input.route.newTask || input.route.workspaceWorkGraph)
  const pendingTerminalRoute = input.route.terminalId?.startsWith("pending-") === true
  if (input.route.terminalId && (!input.surface || input.surface.type !== "terminal")) return
  if (pendingTerminalRoute && (!input.surface || input.surface.type !== "terminal" || routeTerminalId(input.surface) !== input.route.terminalId)) return
  if (!input.surface) {
    if (input.route.marketplace) return
    if (input.route.workgraph) return
    if (input.route.newTask) return
    if (input.route.workspaceWorkGraph) return
    if (!hasConcreteRoute || !input.activeRouteId) return
    return workspaceBrowseRoute(input.activeRouteId)
  }

  if (input.surface.type === "marketplace") {
    if (routeMatchesSurface(input.route, "", input.surface, input.routeWorkspaceKey)) return
    return surfaceRoute("", input.surface)
  }
  if (input.surface.type === "workgraph") {
    if (routeMatchesSurface(input.route, "", input.surface, input.routeWorkspaceKey)) return
    return surfaceRoute("", input.surface)
  }
  if (input.surface.type === "task-composer" && !input.surface.directory) {
    if (routeMatchesSurface(input.route, "", input.surface, input.routeWorkspaceKey)) return
    return surfaceRoute("", input.surface)
  }

  const surfaceWorkspaceKey = surfaceWorkspaceRouteKey(input.surface, input.activeRouteId)
  if (input.routeWorkspaceKey && hasConcreteRoute && surfaceWorkspaceKey && surfaceWorkspaceKey !== input.routeWorkspaceKey) return
  const workspaceId = surfaceWorkspaceKey ?? input.activeRouteId
  if (!workspaceId && input.surface.type !== "session") return
  if (workspaceId && routeMatchesSurface(input.route, workspaceId, input.surface, input.routeWorkspaceKey)) return
  const route = surfaceRoute(workspaceId, input.surface)
  if (route) return route
  if (input.route.id || input.route.pageId) return workspaceBrowseRoute(workspaceId)
}
