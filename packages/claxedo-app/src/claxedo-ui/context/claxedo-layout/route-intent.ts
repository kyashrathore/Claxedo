import type { Session } from "@opencode-ai/sdk/v2"
import type { Accessor } from "solid-js"
import type { LayoutCommand } from "./commands"
import { sessionRoute, tabRoute } from "./tab-route"
import type { TabItem } from "./types"
import { realDirectory } from "./types"

type Badge = {
  additions: number
  deletions: number
}

export type RouteIntent = {
  ready: boolean
  workspaceId: string | undefined
  tabId: string | undefined
  sessionId: string | undefined
  pageId: string | undefined
  sessionTitle: string
  sessionBadge: Badge | undefined
}

type GroupTabs = {
  items: () => TabItem[]
  activeId: () => string | null
  setActive: (tabId: string) => void
}

type TopTabs = {
  add?: (tab: Omit<TabItem, "id">) => string | undefined
  addSession: (directory: string, sessionId: string, title: string, badge?: Badge) => string | undefined
  addTerminal: (directory: string, terminalId: string, title: string) => string | undefined
  addPagesIndex: (directory?: string) => string | undefined
  addPage: (pageId: string, title: string, directory?: string, filePath?: string) => string | undefined
  addWorkgraph: (directory?: string) => string | undefined
  addFile: (directory: string, filePath: string, title: string) => string | undefined
  addReview: (
    directory: string,
    sessionId: string,
    title: string,
    badge?: Badge,
    reviewMode?: TabItem["reviewMode"],
    reviewFromRef?: string,
    reviewToRef?: string,
  ) => string | undefined
  addReviewWorkspace: (
    directory: string,
    sessionId: string,
    title: string,
    badge?: Badge,
    reviewMode?: TabItem["reviewMode"],
    reviewFromRef?: string,
    reviewToRef?: string,
  ) => string | undefined
  addContext: (directory: string, sessionId: string, title: string) => string | undefined
  setActive: (tabId: string) => void
  activeId: () => string | null
  active: () => TabItem | undefined
  orderedItems: () => TabItem[]
  findSession: (directory: string, sessionId: string) => TabItem | undefined
  patch: (tabId: string, patch: Partial<TabItem>) => void
  close: (tabId: string) => void
}

type LayoutApi = {
  dispatch: (command: LayoutCommand) => unknown
  findTabGroup: (tabId: string) => string | undefined
  split: { focusedId: () => string | undefined }
  groupTabs: (groupId: string) => GroupTabs
  groupWorktree: (groupId: string) => { setDefault: (directory: string | null) => void }
  topTabs: TopTabs
}

type SyncApi = {
  child: (directory: string) => [{ session: Session[] }, unknown]
}

type SdkApi = {
  url: string
  client: {
    session: {
      update: (input: { directory: string; sessionID: string; title: string }) => Promise<unknown>
    }
  }
}

export const ROUTE_INTENT_INDEX = "__index__"
export const ROUTE_INTENT_WORKGRAPH = "__workgraph__"

function origin(url: string) {
  try {
    return new URL(url).origin
  } catch {
    if (typeof window !== "undefined") return window.location.origin
    return ""
  }
}

function asText(value: unknown) {
  if (typeof value !== "string") return
  const next = value.trim()
  if (!next) return
  return next
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object") return
  return value as Record<string, unknown>
}

export function isDefaultSessionTitle(value: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
}

export function createRouteIntentAdapter(input: {
  claxedo: LayoutApi
  globalSync: SyncApi
  globalSDK: SdkApi
  workgraphEnabled?: Accessor<boolean>
  navigate: (path: string, options?: { replace?: boolean }) => void
  fetch?: typeof fetch
  log?: (event: string, payload?: Record<string, unknown>) => void
}) {
  const hydrating = new Set<string>()
  const attempted = new Set<string>()
  const request = input.fetch ?? fetch
  const log = input.log ?? (() => undefined)
  const workgraph = () => input.workgraphEnabled?.() ?? false

  const redirect = (path: string) => queueMicrotask(() => input.navigate(path, { replace: true }))

  const activate = (tabId: string) => {
    const groupId = input.claxedo.findTabGroup(tabId)
    if (!groupId) return false
    if (input.claxedo.split.focusedId() !== groupId) {
      input.claxedo.dispatch({ type: "SplitFocusRequested", groupId })
    }
    const tabs = input.claxedo.groupTabs(groupId)
    if (tabs.activeId() !== tabId) tabs.setActive(tabId)
    const tab = tabs.items().find((item) => item.id === tabId)
    const dir = realDirectory(tab?.directory)
    if (dir) {
      input.claxedo.dispatch({ type: "GroupWorktreeDefaultSetRequested", groupId, directory: dir })
    }
    return true
  }

  const recover = (workspace: string, tabId: string, raw: unknown) => {
    const context = asRecord(raw)
    if (!context) {
      const created = input.claxedo.topTabs.addSession(workspace, "new", "New Session")
      if (!created) return
      input.claxedo.topTabs.setActive(created)
      redirect(sessionRoute(workspace))
      return
    }

    const scope = asText(context.scope) as TabItem["scope"] | undefined
    const global = scope === "global"
    const directory = global ? undefined : (asText(context.directory) ?? workspace)
    if (!global && !directory) return
    if (directory && directory !== workspace) {
      redirect(tabRoute(directory, tabId))
      return
    }

    if (activate(tabId)) return

    const title = asText(context.title) ?? "Recovered Tab"
    const type = asText(context.tabType) ?? ""
    const reviewMode = asText(context.reviewMode) as TabItem["reviewMode"] | undefined
    const reviewFromRef = asText(context.reviewFromRef)
    const reviewToRef = asText(context.reviewToRef)
    const pageId = asText(context.pageId)
    const recovered = (() => {
      if (type === "pages-index") {
        return global ? input.claxedo.topTabs.addPagesIndex() : input.claxedo.topTabs.addPagesIndex(directory)
      }
      if (type === "workgraph") {
        if (!workgraph()) {
          redirect(sessionRoute(workspace))
          return
        }
        return global ? input.claxedo.topTabs.addWorkgraph() : input.claxedo.topTabs.addWorkgraph(directory)
      }
      if (type === "page") {
        if (!pageId) return
        return global ? input.claxedo.topTabs.addPage(pageId, title) : input.claxedo.topTabs.addPage(pageId, title, directory)
      }
      if (pageId === ROUTE_INTENT_INDEX) {
        return global ? input.claxedo.topTabs.addPagesIndex() : input.claxedo.topTabs.addPagesIndex(directory)
      }
      if (pageId === ROUTE_INTENT_WORKGRAPH) {
        if (!workgraph()) {
          redirect(sessionRoute(workspace))
          return
        }
        return global ? input.claxedo.topTabs.addWorkgraph() : input.claxedo.topTabs.addWorkgraph(directory)
      }
      if (type === "terminal") {
        const terminalId = asText(context.terminalId)
        if (!terminalId) return
        return input.claxedo.topTabs.addTerminal(directory!, terminalId, title || "Terminal")
      }
      if (type === "file") {
        const filePath = asText(context.filePath)
        if (!filePath) return
        return input.claxedo.topTabs.addFile(directory!, filePath, title || "File")
      }
      if (type === "review") {
        const sessionId = asText(context.sessionId)
        if (!sessionId) return
        return input.claxedo.topTabs.addReviewWorkspace(
          directory!,
          sessionId,
          title || "Session",
          undefined,
          reviewMode,
          reviewFromRef,
          reviewToRef,
        )
      }
      if (type === "review-workspace") {
        const sessionId = asText(context.sessionId)
        if (!sessionId) return
        return input.claxedo.topTabs.addReviewWorkspace(
          directory!,
          sessionId,
          title || "Session",
          undefined,
          reviewMode,
          reviewFromRef,
          reviewToRef,
        )
      }
      if (type === "context") {
        const sessionId = asText(context.sessionId)
        if (!sessionId) return
        return input.claxedo.topTabs.addContext(directory!, sessionId, title || "Context")
      }
      return input.claxedo.topTabs.addSession(directory!, asText(context.sessionId) ?? "new", title || "Session")
    })()

    if (!recovered) {
      const created = input.claxedo.topTabs.addSession(directory!, "new", "New Session")
      if (!created) return
      input.claxedo.topTabs.setActive(created)
      redirect(sessionRoute(directory ?? workspace))
      return
    }

    if (input.claxedo.topTabs.activeId() !== recovered) {
      input.claxedo.topTabs.setActive(recovered)
    }
    if (type === "session" || (!type && !pageId)) {
      redirect(sessionRoute(directory ?? workspace, asText(context.sessionId)))
      return
    }
    redirect(tabRoute(directory ?? workspace, recovered))
  }

  const hydrate = (workspace: string, tabId: string) => {
    if (hydrating.has(tabId)) return
    hydrating.add(tabId)
    const site = origin(input.globalSDK.url)
    if (!site) {
      hydrating.delete(tabId)
      return
    }

    void request(`${site}/api/claxedo/hook/tab-context?tabId=${encodeURIComponent(tabId)}`)
      .then((res) => (res.ok ? res.json() : undefined))
      .then((data) => {
        const context = asRecord(data && typeof data === "object" && "context" in data ? data.context : undefined)
        recover(workspace, tabId, context)
      })
      .catch(() => undefined)
      .finally(() => {
        hydrating.delete(tabId)
      })
  }

  const receive = (intent: RouteIntent) => {
    input.claxedo.dispatch({
      type: "RouteIntentReceived",
      intent: {
        workspaceId: intent.workspaceId,
        tabId: intent.tabId,
        sessionId: intent.sessionId,
        pageId: intent.pageId,
      },
    })

    if (!intent.ready) return
    const workspaceId = intent.workspaceId
    if (!workspaceId) return

    input.globalSync.child(workspaceId)
    log("route intent", {
      workspaceId,
      tabId: intent.tabId,
      sessionId: intent.sessionId,
      pageId: intent.pageId,
      activeTabId: input.claxedo.topTabs.activeId(),
      activeTabType: input.claxedo.topTabs.active()?.type,
      activeTabSession: input.claxedo.topTabs.active()?.sessionId,
      activeTabPage: input.claxedo.topTabs.active()?.pageId,
    })

    if (intent.tabId) {
      if (activate(intent.tabId)) return
      hydrate(workspaceId, intent.tabId)
      return
    }

    if (intent.pageId) {
      if (intent.pageId === ROUTE_INTENT_INDEX) {
        const existing = input.claxedo.topTabs.orderedItems().find((tab) => tab.type === "pages-index" && !tab.directory)
        const nextTabId = existing?.id ?? input.claxedo.topTabs.addPagesIndex()
        if (nextTabId && input.claxedo.topTabs.activeId() !== nextTabId) {
          input.claxedo.topTabs.setActive(nextTabId)
        }
        if (nextTabId) redirect(tabRoute(workspaceId, nextTabId))
        return
      }
      if (intent.pageId === ROUTE_INTENT_WORKGRAPH) {
        if (!workgraph()) {
          redirect(sessionRoute(workspaceId))
          return
        }
        const existing = input.claxedo.topTabs.orderedItems().find((tab) => tab.type === "workgraph" && !tab.directory)
        const nextTabId = existing?.id ?? input.claxedo.topTabs.addWorkgraph()
        if (nextTabId && input.claxedo.topTabs.activeId() !== nextTabId) {
          input.claxedo.topTabs.setActive(nextTabId)
        }
        if (nextTabId) redirect(tabRoute(workspaceId, nextTabId))
        return
      }

      const existing = input.claxedo.topTabs.orderedItems().find((tab) => tab.type === "page" && tab.pageId === intent.pageId)
      if (existing?.id && existing.sessionId) {
        input.claxedo.topTabs.patch(existing.id, { sessionId: undefined })
      }
      const nextTabId =
        existing?.id ?? input.claxedo.topTabs.addPage(intent.pageId, "Untitled", workspaceId)
      if (nextTabId && input.claxedo.topTabs.activeId() !== nextTabId) {
        input.claxedo.topTabs.setActive(nextTabId)
      }
      if (nextTabId) redirect(tabRoute(workspaceId, nextTabId))
      return
    }

    if (!intent.sessionId) {
      const tab = input.claxedo.topTabs.findSession(workspaceId, "new")
      if (tab?.id) {
        input.claxedo.topTabs.setActive(tab.id)
        return
      }

      const created = input.claxedo.topTabs.addSession(workspaceId, "new", "New Session")
      if (!created) return
      input.claxedo.topTabs.setActive(created)
      return
    }

    const key = `${workspaceId}:${intent.sessionId}`
    const existingTitle = input.claxedo.topTabs.findSession(workspaceId, intent.sessionId)?.title
    const desired = existingTitle && !isDefaultSessionTitle(existingTitle) ? existingTitle : undefined
    const shouldPersist = isDefaultSessionTitle(intent.sessionTitle) && !!desired && !attempted.has(key)
    if (shouldPersist) {
      attempted.add(key)
      void input.globalSDK.client.session
        .update({ directory: workspaceId, sessionID: intent.sessionId, title: desired })
        .catch(() => undefined)
    }

    const active = input.claxedo.topTabs.active()
    const keepActive =
      !!active && (active.type === "review" || active.type === "review-workspace" || active.type === "context") && active.directory === workspaceId
    const nextTitle =
      desired ||
      intent.sessionTitle ||
      existingTitle ||
      "Session"
    const nextTabId = input.claxedo.topTabs.addSession(workspaceId, intent.sessionId, nextTitle, intent.sessionBadge)

    log("route intent decision", {
      workspaceId,
      sessionId: intent.sessionId,
      nextTitle,
      tabId: nextTabId,
      keepActive,
      activeTabId: active?.id,
      activeType: active?.type,
      activeSession: active?.sessionId,
    })
    if (keepActive && active && input.claxedo.topTabs.activeId() !== active.id) {
      input.claxedo.topTabs.setActive(active.id)
    }
    if (!keepActive && nextTabId && input.claxedo.topTabs.activeId() !== nextTabId) {
      input.claxedo.topTabs.setActive(nextTabId)
    }
  }

  return {
    receive,
  }
}
