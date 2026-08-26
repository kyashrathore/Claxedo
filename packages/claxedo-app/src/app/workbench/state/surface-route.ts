import { realDirectory, type ContentMeta } from "./types"
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
import { sameWorkspaceDirectory } from "@/platform/runtime/agent/signed-workspace"

type RouteContent = Pick<ContentMeta, "type" | "directory" | "sessionId" | "pageId" | "terminalId" | "content">

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

function surfaceWorkspaceRouteKey(content: RouteContent, fallback: string) {
  if (content.type !== "session") return fallback
  const ref = routeSessionRef(content)
  if (ref?.host !== "workspace") return fallback
  // A signed (cloud-sandboxed) workspace routes by its canonical workspace id:
  // its runtime directory is an ephemeral mount that does not survive as a
  // stable route key. Every other workspace surface prefers the DIRECTORY
  // form: the rail and deep links write directory-form URLs, and a mirror that
  // emits the ref's workspace-id form instead makes the two writers alternate
  // — flipping the :workspaceId route param, re-running workspace resolution,
  // and rebuilding the rail rows mid-interaction.
  const signed = ref.toolSandbox?.kind === "workspace"
  if (!signed && fallback && fallback !== "/workspace") return fallback
  return workspaceKey(ref) ?? fallback
}

export function surfaceRoute(dir: string, content: RouteContent) {
  if (content.type === "marketplace") return marketplaceRoute()
  if (content.type === "workgraph") return workGraphRoute()
  if (content.type === "workspace-workgraph") return workspaceWorkGraphRoute(dir)
  if (content.type === "task-composer") return newTaskRoute(realDirectory(content.directory))
  if (content.type === "session") {
    const sessionRef = routeSessionRef(content)
    if (sessionRef?.sessionId && sessionRef.sessionId !== "new") {
      if (sessionRef.host === "workspace") {
        return workspaceSessionRoute(surfaceWorkspaceRouteKey(content, dir), sessionRef.sessionId)
      }
      return canonicalSessionRoute(sessionRef.sessionId)
    }
    const sessionId = routeSessionId(content)
    if (sessionId && sessionId !== "new") return canonicalSessionRoute(sessionId)
    return workspaceSessionRoute(surfaceWorkspaceRouteKey(content, dir))
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
    newTask?: boolean
    workgraph?: boolean
    workspaceWorkGraph?: boolean
    pageId?: string
    terminalId?: string
  },
  dir: string,
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
    return route.workspaceWorkGraph === true && routeWorkspaceKey === dir
  }
  if (routeWorkspaceKey !== surfaceWorkspaceRouteKey(content, dir)) return false

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
  routeDirectory?: string
  routeId?: string
  activeDirectory?: string
}) {
  const hasConcreteRoute = !!(
    input.route.id ||
    input.route.pageId ||
    input.route.terminalId ||
    input.route.newTask ||
    input.route.workspaceWorkGraph
  )
  const pendingTerminalRoute = input.route.terminalId?.startsWith("pending-") === true
  if (input.route.terminalId && (!input.surface || input.surface.type !== "terminal")) return
  if (
    pendingTerminalRoute &&
    (!input.surface || input.surface.type !== "terminal" || routeTerminalId(input.surface) !== input.route.terminalId)
  )
    return
  if (!input.surface) {
    if (input.route.marketplace) return
    if (input.route.workgraph) return
    if (input.route.newTask) return
    if (input.route.workspaceWorkGraph) return
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
  if (input.surface.type === "task-composer" && !input.surface.directory) {
    if (routeMatchesSurface(input.route, "", input.surface, input.routeWorkspaceKey)) return
    return surfaceRoute("", input.surface)
  }

  const surfaceDir = realDirectory(input.surface.directory)
  const canonicalSurfaceDir =
    surfaceDir && input.routeId && sameWorkspaceDirectory(input.routeDirectory, surfaceDir) ? input.routeId : surfaceDir
  const surfaceWorkspaceKey = canonicalSurfaceDir
    ? surfaceWorkspaceRouteKey(input.surface, canonicalSurfaceDir)
    : undefined
  if (
    input.routeWorkspaceKey &&
    hasConcreteRoute &&
    surfaceWorkspaceKey &&
    surfaceWorkspaceKey !== input.routeWorkspaceKey
  )
    return
  const dir = surfaceWorkspaceKey ?? input.activeDirectory
  if (!dir) return
  if (routeMatchesSurface(input.route, dir, input.surface, input.routeWorkspaceKey)) return
  const route = surfaceRoute(dir, input.surface)
  if (route) return route
  if (input.route.id || input.route.pageId) return workspaceBrowseRoute(dir)
}
