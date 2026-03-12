/**
 * Dynamic Tab Title Sync
 *
 * Scans pane contents for each tab and resolves a meaningful title
 * based on priority rules. Session titles flow from the sync store;
 * when a session has only a default title, the first user message
 * preview is used instead.
 */

import { batch, createEffect, untrack } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import type { PaneContent, TabItem, GroupState } from "./types"
import { isDefaultSessionTitle } from "./route-intent"
import { sessionPaneSummary } from "../../utils/session-pane-summary"

// ---------------------------------------------------------------------------
// Pure title computation
// ---------------------------------------------------------------------------

export type ComputeTitleInput = {
  tab: TabItem
  paneContents: PaneContent[]
  /** Session title from the sync store (for the primary session pane) */
  sessionTitle: string | undefined
  /** First-message preview from sessionPaneSummary */
  firstMessagePreview: string | undefined
  /** Whether the sync store session title is a default ("New session - ...") */
  isDefaultTitle: boolean
}

/**
 * Compute the desired tab title from pane contents and sync data.
 * Returns `undefined` when no change is needed (title already matches).
 */
export function computeTabTitle(input: ComputeTitleInput): string | undefined {
  const { tab, paneContents, sessionTitle, firstMessagePreview, isDefaultTitle } = input

  if (paneContents.length === 0) return undefined

  // Find the primary content based on priority rules
  let primary: { type: string; title?: string } | undefined
  let primaryPriority = Infinity

  for (const content of paneContents) {
    let priority: number
    switch (content.type) {
      case "session":
        priority = 1
        break
      case "terminal":
        // TUI terminals (claude/codex) get session-level priority
        if (content.command && /\b(claude|codex)\b/i.test(content.command)) {
          priority = 1
        } else {
          priority = 3
        }
        break
      case "review":
      case "review-workspace":
        priority = 2
        break
      case "page":
        priority = 2
        break
      case "file":
        priority = 2
        break
      case "process":
        priority = 3
        break
      // filetree, context defer to session
      case "filetree":
      case "context":
        continue
      default:
        priority = 4
    }
    if (priority < primaryPriority) {
      primaryPriority = priority
      primary = content
    }
  }

  if (!primary) return undefined

  let computed: string | undefined

  switch (primary.type) {
    case "session": {
      // Use session title from sync store, or first-message preview if default
      if (sessionTitle && !isDefaultTitle) {
        computed = sessionTitle
      } else if (firstMessagePreview) {
        computed = firstMessagePreview
      }
      break
    }
    case "terminal": {
      // TUI terminal — keep static title (already meaningful: "Claude", "Codex")
      // Regular terminals stay as "Terminal"
      break
    }
    case "review":
    case "review-workspace": {
      // Review pane — prefix with "Review: " if we have a session title
      if (sessionTitle && !isDefaultTitle) {
        computed = `Review: ${sessionTitle}`
      } else if (firstMessagePreview) {
        computed = `Review: ${firstMessagePreview}`
      }
      break
    }
    case "page": {
      // Page title from content
      if (primary.title) {
        computed = primary.title
      }
      break
    }
    case "file": {
      // Filename from content title
      if (primary.title) {
        computed = primary.title
      }
      break
    }
    // process, regular terminal — no dynamic title
  }

  if (!computed) return undefined
  // Only return if different from current
  if (computed === tab.title) return undefined
  return computed
}

// ---------------------------------------------------------------------------
// Find the session info for a tab's pane contents
// ---------------------------------------------------------------------------

type SessionInfo = {
  sessionId: string
  directory: string
}

/**
 * Find the primary session referenced by a tab's pane contents.
 * Returns the sessionId and directory of the first session-type pane,
 * or the first review/review-workspace pane's session.
 */
export function findPrimarySession(paneContents: PaneContent[]): SessionInfo | undefined {
  // First pass: look for session panes
  for (const content of paneContents) {
    if (content.type === "session" && content.sessionId && content.sessionId !== "new" && content.directory) {
      return { sessionId: content.sessionId, directory: content.directory }
    }
  }
  // Second pass: look for review/review-workspace panes
  for (const content of paneContents) {
    if (
      (content.type === "review" || content.type === "review-workspace") &&
      content.sessionId &&
      content.sessionId !== "new" &&
      content.directory
    ) {
      return { sessionId: content.sessionId, directory: content.directory }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Reactive sync effect
// ---------------------------------------------------------------------------

export type DynamicTitleSyncDeps = {
  /** Access to split groups and tab management */
  claxedo: {
    split: {
      groups: () => GroupState[]
    }
    groupTabs: (groupId: string) => {
      items: () => TabItem[]
      updateTitle: (tabId: string, title: string) => void
    }
    multiPane: {
      leafIds: (tabId: string) => string[]
      getContent: (tabId: string, leafId: string) => PaneContent | undefined
    }
  }
  /** Access to sync store for session titles and messages */
  globalSync: {
    child: (
      directory: string,
      opts?: { bootstrap?: boolean },
    ) => [import("@/context/global-sync/types").State, ...unknown[]]
  }
}

export type DynamicTitleUpdate = {
  groupId: string
  tabId: string
  title: string
}

export function listDynamicTitleUpdates(deps: DynamicTitleSyncDeps): DynamicTitleUpdate[] {
  const { claxedo, globalSync } = deps
  const next: DynamicTitleUpdate[] = []

  for (const group of claxedo.split.groups()) {
    for (const tab of claxedo.groupTabs(group.id).items()) {
      const ids = claxedo.multiPane.leafIds(tab.id)
      if (ids.length === 0) continue

      const panes: PaneContent[] = []
      for (const id of ids) {
        const pane = claxedo.multiPane.getContent(tab.id, id)
        if (pane) panes.push(pane)
      }
      if (panes.length === 0) continue

      const info = findPrimarySession(panes)

      let title: string | undefined
      let preview: string | undefined
      let fallback = false

      if (info) {
        const [store] = globalSync.child(info.directory, { bootstrap: false })
        const session = store.session.find((s: Session) => s.id === info.sessionId && s.directory === info.directory)
        title = session?.title
        fallback = !title || isDefaultSessionTitle(title)
        preview = sessionPaneSummary(store, info.sessionId).title || undefined
      }

      const computed = computeTabTitle({
        tab,
        paneContents: panes,
        sessionTitle: title,
        firstMessagePreview: preview,
        isDefaultTitle: fallback,
      })
      if (!computed) continue

      next.push({
        groupId: group.id,
        tabId: tab.id,
        title: computed,
      })
    }
  }

  return next
}

/**
 * Create a reactive effect that syncs tab titles from pane contents.
 * Call once inside a SolidJS owner (e.g. inside ClaxedoStateBridge).
 */
export function createDynamicTitleSync(deps: DynamicTitleSyncDeps) {
  createEffect(() => {
    const next = listDynamicTitleUpdates(deps)

    if (next.length === 0) return

    untrack(() =>
      batch(() => {
        for (const item of next) {
          claxedo.groupTabs(item.groupId).updateTitle(item.tabId, item.title)
        }
      }),
    )
  })
}
