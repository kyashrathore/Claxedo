import { base64Encode } from "@opencode-ai/util/encode"
import type { Session } from "@opencode-ai/sdk/v2"
import type { LayoutCommand } from "./commands"
import type { TabItem } from "./types"

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
  addSession: (directory: string, sessionId: string, title: string, badge?: Badge) => string | undefined
  addTerminal: (directory: string, terminalId: string, title: string) => string | undefined
  addPage: (pageId: string, title: string, directory?: string, filePath?: string) => string | undefined
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

function tabPath(directory: string, tabId: string) {
  return `/${base64Encode(directory)}/tab/${tabId}`
}

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
  navigate: (path: string, options?: { replace?: boolean }) => void
  fetch?: typeof fetch
  log?: (event: string, payload?: Record<string, unknown>) => void
}) {
  const hydrating = new Set<string>()
  const attempted = new Set<string>()
  const request = input.fetch ?? fetch
  const log = input.log ?? (() => undefined)

  const redirect = (directory: string, tabId: string) =>
    queueMicrotask(() => input.navigate(tabPath(directory, tabId), { replace: true }))

  const activate = (tabId: string) => {
    const groupId = input.claxedo.findTabGroup(tabId)
    if (!groupId) return false
    if (input.claxedo.split.focusedId() !== groupId) {
      input.claxedo.dispatch({ type: "SplitFocusRequested", groupId })
    }
    const tabs = input.claxedo.groupTabs(groupId)
    if (tabs.activeId() !== tabId) tabs.setActive(tabId)
    const tab = tabs.items().find((item) => item.id === tabId)
    if (tab?.directory && tab.directory !== "__pages__") {
      input.claxedo.dispatch({ type: "GroupWorktreeDefaultSetRequested", groupId, directory: tab.directory })
    }
    return true
  }

  const recover = (workspace: string, tabId: string, raw: unknown) => {
    const context = asRecord(raw)
    if (!context) {
      const created = input.claxedo.topTabs.addSession(workspace, "new", "New Session")
      if (!created) return
      input.claxedo.topTabs.setActive(created)
      redirect(workspace, created)
      return
    }

    const directory = asText(context.directory) ?? workspace
    if (!directory) return
    if (directory !== workspace) {
      redirect(directory, tabId)
      return
    }

    if (activate(tabId)) return

    const title = asText(context.title) ?? "Recovered Tab"
    const type = asText(context.tabType) ?? ""
    const reviewMode = asText(context.reviewMode) as TabItem["reviewMode"] | undefined
    const reviewFromRef = asText(context.reviewFromRef)
    const reviewToRef = asText(context.reviewToRef)
    const recovered = (() => {
      if (type === "page") {
        const pageId = asText(context.pageId)
        if (!pageId) return
        return input.claxedo.topTabs.addPage(pageId, title, directory)
      }
      if (type === "terminal") {
        const terminalId = asText(context.terminalId)
        if (!terminalId) return
        return input.claxedo.topTabs.addTerminal(directory, terminalId, title || "Terminal")
      }
      if (type === "file") {
        const filePath = asText(context.filePath)
        if (!filePath) return
        return input.claxedo.topTabs.addFile(directory, filePath, title || "File")
      }
      if (type === "review") {
        const sessionId = asText(context.sessionId)
        if (!sessionId) return
        return input.claxedo.topTabs.addReview(
          directory,
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
          directory,
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
        return input.claxedo.topTabs.addContext(directory, sessionId, title || "Context")
      }
      return input.claxedo.topTabs.addSession(directory, asText(context.sessionId) ?? "new", title || "Session")
    })()

    if (!recovered) {
      const created = input.claxedo.topTabs.addSession(directory, "new", "New Session")
      if (!created) return
      input.claxedo.topTabs.setActive(created)
      redirect(directory, created)
      return
    }

    if (input.claxedo.topTabs.activeId() !== recovered) {
      input.claxedo.topTabs.setActive(recovered)
    }
    redirect(directory, recovered)
  }

  const hydrate = (workspace: string, tabId: string) => {
    if (hydrating.has(tabId)) return
    hydrating.add(tabId)
    const site = origin(input.globalSDK.url)
    if (!site) {
      hydrating.delete(tabId)
      return
    }

    void request(`${site}/hook/tab-context?tabId=${encodeURIComponent(tabId)}`)
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
      const existing = input.claxedo.topTabs
        .orderedItems()
        .find((tab) => tab.type === "page" && tab.pageId === intent.pageId)
      if (existing?.id && existing.sessionId) {
        input.claxedo.topTabs.patch(existing.id, { sessionId: undefined })
      }
      const nextTabId = existing?.id ?? input.claxedo.topTabs.addPage(intent.pageId, "Untitled", workspaceId)
      if (nextTabId && input.claxedo.topTabs.activeId() !== nextTabId) {
        input.claxedo.topTabs.setActive(nextTabId)
      }
      if (nextTabId) redirect(workspaceId, nextTabId)
      return
    }

    if (!intent.sessionId) {
      const active = input.claxedo.topTabs.active()
      if (active?.directory === workspaceId) {
        redirect(workspaceId, active.id)
        return
      }

      const tab = input.claxedo.topTabs.orderedItems().find((item) => item.directory === workspaceId)
      if (tab?.id) {
        input.claxedo.topTabs.setActive(tab.id)
        redirect(workspaceId, tab.id)
        return
      }

      const created = input.claxedo.topTabs.addSession(workspaceId, "new", "New Session")
      if (!created) return
      input.claxedo.topTabs.setActive(created)
      redirect(workspaceId, created)
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
      !!active && (active.type === "review" || active.type === "context") && active.directory === workspaceId
    const nextTitle =
      isDefaultSessionTitle(intent.sessionTitle) && desired ? desired : intent.sessionTitle || "New Session"
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
    if (nextTabId) redirect(workspaceId, nextTabId)

    if (intent.sessionId !== "new") {
      const tab = input.claxedo.topTabs.findSession(workspaceId, "new")
      if (tab) input.claxedo.topTabs.close(tab.id)
    }
  }

  return {
    receive,
  }
}
