/**
 * Dynamic Tab Title Sync
 *
 * Scans pane contents for each tab and resolves a meaningful title
 * based on priority rules. Session titles flow from the sync store;
 * when a session has only a default title, the first user message
 * preview is used instead.
 */

import { createEffect, on, untrack } from "solid-js"
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

/**
 * Create a reactive effect that syncs tab titles from pane contents.
 * Call once inside a SolidJS owner (e.g. inside ClaxedoStateBridge).
 */
export function createDynamicTitleSync(deps: DynamicTitleSyncDeps) {
  const { claxedo, globalSync } = deps

  createEffect(
    on(
      // Track groups and their tab items — re-run when tabs change
      () => {
        const groups = claxedo.split.groups()
        return groups.map((g) => ({
          id: g.id,
          tabs: claxedo.groupTabs(g.id).items(),
        }))
      },
      (groupSnapshots) => {
        for (const { id: groupId, tabs } of groupSnapshots) {
          for (const tab of tabs) {
            // Get pane contents for this tab
            const leafIds = untrack(() => claxedo.multiPane.leafIds(tab.id))
            if (leafIds.length === 0) continue

            const paneContents: PaneContent[] = []
            for (const leafId of leafIds) {
              const content = untrack(() => claxedo.multiPane.getContent(tab.id, leafId))
              if (content) paneContents.push(content)
            }
            if (paneContents.length === 0) continue

            // Find the primary session for this tab
            const sessionInfo = findPrimarySession(paneContents)

            let sessionTitle: string | undefined
            let firstMessagePreview: string | undefined
            let isDefault = false

            if (sessionInfo) {
              // Read session title from sync store (reactive — this tracks)
              const [store] = globalSync.child(sessionInfo.directory, { bootstrap: false })
              const session = store.session.find(
                (s: Session) => s.id === sessionInfo.sessionId && s.directory === sessionInfo.directory,
              )
              sessionTitle = session?.title
              isDefault = !sessionTitle || isDefaultSessionTitle(sessionTitle)

              // Get first-message preview
              const preview = sessionPaneSummary(store, sessionInfo.sessionId)
              firstMessagePreview = preview.title || undefined
            }

            const computed = computeTabTitle({
              tab,
              paneContents,
              sessionTitle,
              firstMessagePreview,
              isDefaultTitle: isDefault,
            })

            if (computed !== undefined) {
              untrack(() => claxedo.groupTabs(groupId).updateTitle(tab.id, computed))
            }
          }
        }
      },
    ),
  )
}
