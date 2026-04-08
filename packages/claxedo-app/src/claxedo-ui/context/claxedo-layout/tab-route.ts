import { base64Encode } from "@opencode-ai/util/encode"
import type { TabItem } from "./types"

type Tab = Pick<TabItem, "id" | "type" | "sessionId">

export function sessionRoute(dir: string, id?: string) {
  const root = `/${base64Encode(dir)}`
  if (!id || id === "new") return `${root}/session`
  return `${root}/session/${id}`
}

export function tabRoute(dir: string, id: string) {
  return `/${base64Encode(dir)}/tab/${id}`
}

export function itemRoute(dir: string, tab: Tab) {
  if (tab.type === "session") return sessionRoute(dir, tab.sessionId)
  return tabRoute(dir, tab.id)
}

export function routeMatchesTab(
  route: {
    dir?: string
    id?: string
    tabId?: string
    pageId?: string
  },
  dir: string,
  tab: Tab,
) {
  if (route.dir !== base64Encode(dir)) return false

  if (tab.type === "session") {
    if (route.tabId || route.pageId) return false
    if (!tab.sessionId || tab.sessionId === "new") return !route.id
    return route.id === tab.sessionId
  }

  return route.tabId === tab.id
}
