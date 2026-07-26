import { realDirectory, type ContentMeta } from "./types"
import {
  marketplaceRoute,
  workGraphRoute,
  sessionRoute as canonicalSessionRoute,
  workspacePageRoute,
  workspaceRoute as canonicalWorkspaceRoute,
  workspaceSessionRoute,
  workspaceTerminalRoute,
} from "@/platform/identity/route"
import { PENDING_TERMINAL_PREFIX } from "@/features/terminal/core/terminal-surface-id"

type RouteContent = Pick<ContentMeta, "type" | "sessionId" | "pageId" | "terminalId" | "content">

function workspaceBrowseRoute(dir: string) {
  return canonicalWorkspaceRoute(dir)
}

function pageRoute(dir: string, pageId: string) {
  return workspacePageRoute(dir, pageId)
}

function terminalRoute(dir: string, terminalId: string) {
  return workspaceTerminalRoute(dir, terminalId)
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

export function surfaceRoute(dir: string, content: RouteContent) {
  if (content.type === "marketplace") return marketplaceRoute()
  if (content.type === "workgraph") return workGraphRoute()
  if (content.type === "session") {
    const sessionRef = routeSessionRef(content)
    if (sessionRef?.sessionId && sessionRef.sessionId !== "new") {
      if (sessionRef.host === "workspace") return workspaceSessionRoute(dir, sessionRef.sessionId)
      return canonicalSessionRoute(sessionRef.sessionId)
    }
    const sessionId = routeSessionId(content)
    if (sessionId && sessionId !== "new") return canonicalSessionRoute(sessionId)
    return workspaceSessionRoute(dir)
  }
  if (content.type === "pages-index") return pageRoute(dir, "__index__")
  if (content.type === "page") {
    const pageId = routePageId(content)
    if (pageId) return pageRoute(dir, pageId)
  }
  const terminalId = routeTerminalId(content)
  // `new` (the creator) DOES get a route, unlike `pending-*`: it is a surface
  // the user can sit on, so it has to survive a reload the way the new-session
  // composer does. `pending-*` stays unroutable because that id is replaced by
  // a real pty id moments later and would deep-link to nothing.
  if (content.type === "terminal" && terminalId && !terminalId.startsWith(PENDING_TERMINAL_PREFIX)) {
    return terminalRoute(dir, terminalId)
  }
  return undefined
}

export function routeMatchesSurface(
  route: {
    id?: string
    marketplace?: boolean
    workgraph?: boolean
    pageId?: string
    terminalId?: string
  },
  dir: string,
  content: RouteContent,
  routeWorkspaceKey?: string,
) {
  if (content.type === "marketplace") return route.marketplace === true
  if (content.type === "workgraph") return route.workgraph === true
  if (routeWorkspaceKey !== dir) return false

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
    workgraph?: boolean
    pageId?: string
    terminalId?: string
  }
  surface?: ContentMeta
  routeWorkspaceKey?: string
  activeDirectory?: string
}) {
  const hasConcreteRoute = !!(input.route.id || input.route.pageId || input.route.terminalId)
  const pendingTerminalRoute = input.route.terminalId?.startsWith("pending-") === true
  if (input.route.terminalId && (!input.surface || input.surface.type !== "terminal")) return
  if (
    pendingTerminalRoute &&
    (!input.surface || input.surface.type !== "terminal" || routeTerminalId(input.surface) !== input.route.terminalId)
  ) return
  if (!input.surface) {
    if (input.route.marketplace) return
    if (input.route.workgraph) return
    if (!hasConcreteRoute || !input.activeDirectory) return
    return workspaceBrowseRoute(input.activeDirectory)
  }

  if (input.surface.type === "marketplace") {
    if (routeMatchesSurface(input.route, "", input.surface, input.routeWorkspaceKey)) return
    return surfaceRoute("", input.surface)
  }
  if (input.surface.type === "workgraph") {
    if (routeMatchesSurface(input.route, "", input.surface, input.routeWorkspaceKey)) return
    return surfaceRoute("", input.surface)
  }

  const surfaceDir = realDirectory(input.surface.directory)
  if (input.routeWorkspaceKey && hasConcreteRoute && surfaceDir && surfaceDir !== input.routeWorkspaceKey) return
  const dir = surfaceDir ?? input.activeDirectory
  if (!dir) return
  if (routeMatchesSurface(input.route, dir, input.surface, input.routeWorkspaceKey)) return
  const route = surfaceRoute(dir, input.surface)
  if (route) return route
  if (input.route.id || input.route.pageId) return workspaceBrowseRoute(dir)
}
