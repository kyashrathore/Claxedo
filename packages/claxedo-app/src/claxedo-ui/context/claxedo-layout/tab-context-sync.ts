import { panes as paneInfos } from "./pane-intent"
import type { PaneLayout, TabItem } from "./types"

export type TabContextPane = {
  leafId: string
  name: string
  type: TabItem["type"]
  directory: string
  title: string | undefined
  sessionId: string | undefined
  terminalId: string | undefined
  pageId: string | undefined
  filePath: string | undefined
  intent:
    | {
        name?: string
        role?: string
        refs?: string[]
        defaults?: {
          agent?: string
          system?: string
        }
        meta?: Record<string, string>
      }
    | undefined
  meta: Record<string, string>
}

export type TabContextSnapshot = {
  tabId: string
  groupId: string
  tabType: TabItem["type"]
  directory: string
  title: string
  sessionId: string | undefined
  reviewMode: TabItem["reviewMode"] | undefined
  reviewFromRef: string | undefined
  reviewToRef: string | undefined
  pageId: string | undefined
  terminalId: string | undefined
  activeLeafId: string | undefined
  focusedLeafId: string | undefined
  terminalIds: string[]
  panes: TabContextPane[]
  updatedAt: number
}

function origin(url: string) {
  try {
    return new URL(url).origin
  } catch {
    if (typeof window !== "undefined") return window.location.origin
    return ""
  }
}

export function buildTabContextSnapshot(input: { groupId: string; tab: TabItem; layout: PaneLayout | undefined }) {
  const panes = paneInfos(input.layout).map((pane) => ({
    leafId: pane.leafId,
    name: pane.name,
    type: pane.content.type,
    directory: pane.content.directory,
    title: pane.content.title,
    sessionId: pane.content.sessionId,
    terminalId: pane.content.terminalId,
    pageId: pane.content.pageId,
    filePath: pane.content.filePath,
    intent: pane.content.intent,
    meta: pane.meta,
  }))

  const terminalIds = [
    ...(input.tab.terminalId ? [input.tab.terminalId] : []),
    ...panes.map((pane) => pane.terminalId).filter((id): id is string => !!id),
  ]

  return {
    tabId: input.tab.id,
    groupId: input.groupId,
    tabType: input.tab.type,
    directory: input.tab.directory,
    title: input.tab.title,
    sessionId: input.tab.sessionId,
    reviewMode: input.tab.reviewMode,
    reviewFromRef: input.tab.reviewFromRef,
    reviewToRef: input.tab.reviewToRef,
    pageId: input.tab.pageId,
    terminalId: input.tab.terminalId,
    activeLeafId: input.layout?.focus,
    focusedLeafId: input.layout?.focus,
    terminalIds: [...new Set(terminalIds)],
    panes,
    updatedAt: Date.now(),
  } satisfies TabContextSnapshot
}

export function createTabContextSyncAdapter(input: { sdkUrl: () => string; request?: typeof fetch }) {
  const request = input.request ?? fetch
  let last = ""

  const push = (snapshot: TabContextSnapshot | undefined) => {
    if (!snapshot) return

    const key = JSON.stringify({
      ...snapshot,
      updatedAt: 0,
    })
    if (key === last) return
    last = key

    const base = origin(input.sdkUrl())
    if (!base) return

    void request(`${base}/hook/tab-context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(snapshot),
    }).catch(() => {})
  }

  return {
    push,
  }
}
