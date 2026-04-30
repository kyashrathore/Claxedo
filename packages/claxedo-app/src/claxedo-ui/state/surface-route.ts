import { base64Encode } from "@opencode-ai/util/encode"
import type { ContentMeta } from "./types"

type RouteContent = Pick<ContentMeta, "type" | "sessionId" | "pageId" | "terminalId">

export function sessionRoute(dir: string, id?: string) {
  const root = `/${base64Encode(dir)}`
  if (!id || id === "new") return `${root}/session`
  return `${root}/session/${id}`
}

function workspaceRoute(dir: string) {
  return `/${base64Encode(dir)}`
}

function terminalRoute(dir: string, terminalId: string) {
  return `${workspaceRoute(dir)}/terminal/${terminalId}`
}

export function surfaceRoute(dir: string, content: RouteContent) {
  if (content.type === "session") return sessionRoute(dir, content.sessionId)
  if (content.type === "pages-index") return `${workspaceRoute(dir)}/page/__index__`
  if (content.type === "workgraph") return `${workspaceRoute(dir)}/page/__workgraph__`
  if (content.type === "page" && content.pageId) return `${workspaceRoute(dir)}/page/${content.pageId}`
  if (content.type === "terminal" && content.terminalId && !content.terminalId.startsWith("pending-")) {
    return terminalRoute(dir, content.terminalId)
  }
  return undefined
}

export function routeMatchesSurface(
  route: {
    dir?: string
    id?: string
    pageId?: string
    terminalId?: string
  },
  dir: string,
  content: RouteContent,
) {
  if (route.dir !== base64Encode(dir)) return false

  if (content.type === "session") {
    if (route.pageId || route.terminalId) return false
    if (!content.sessionId || content.sessionId === "new") return !route.id
    return route.id === content.sessionId
  }

  if (content.type === "pages-index") return route.pageId === "__index__"
  if (content.type === "workgraph") return route.pageId === "__workgraph__"
  if (content.type === "page") return route.pageId === content.pageId
  if (content.type === "terminal") return !!route.terminalId && route.terminalId === content.terminalId
  return false
}
