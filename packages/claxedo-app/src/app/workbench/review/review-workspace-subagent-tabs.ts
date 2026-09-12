import { createComputed, createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"

import {
  REVIEW_TAB_ID,
  closeSubagentWorkspaceTabsForSession,
  openSubagentWorkspaceTab,
  reviewWorkspaceTabsForSession,
  type ReviewWorkspaceTab,
} from "@/features/review/ui/review-workspace-tabs"
import type { PreparedReviewTabActivation } from "./review-tab-activation"

const FOCUS_WAIT_FRAMES = 30

export function subagentChildHeading(sessionId: string): HTMLElement | null {
  if (typeof document === "undefined") return null
  return document.querySelector<HTMLElement>(
    `[data-session-timeline-session-id="${CSS.escape(sessionId)}"] [data-subagent-child-heading]`,
  )
}

/**
 * Move keyboard focus onto the child transcript's own heading once a subagent
 * tab has opened, so the reader lands in the work they asked for instead of on
 * the chip they left behind in the parent turn.
 *
 * The heading cannot be focused in the frame the tab activates: the child's
 * session screen is code-split, and its heading only exists once the first
 * messages render. So each frame re-asks until the heading is there, and gives
 * up rather than holding a wait open for a child that never resolves. A second
 * open cancels the first — two waits would fight over focus.
 */
export function createSubagentHeadingFocus(input: {
  find?: (sessionId: string) => HTMLElement | null
  frames?: number
} = {}) {
  const find = input.find ?? subagentChildHeading
  const budget = input.frames ?? FOCUS_WAIT_FRAMES
  let handle: number | undefined

  const cancel = () => {
    if (handle !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle)
    handle = undefined
  }

  return {
    cancel,
    request(sessionId: string) {
      cancel()
      if (typeof requestAnimationFrame !== "function") return
      let remaining = budget
      const attempt = () => {
        handle = undefined
        const heading = find(sessionId)
        if (heading) {
          heading.focus({ preventScroll: true })
          return
        }
        remaining -= 1
        if (remaining <= 0) return
        handle = requestAnimationFrame(attempt)
      }
      handle = requestAnimationFrame(attempt)
    },
  }
}

/**
 * The part of the workspace's tab strip that follows the conversation rather than
 * the workspace.
 *
 * Every other tab kind is a property of the workspace and survives a session
 * switch unchanged. A subagent tab is a property of the session that spawned it,
 * so it has to be hidden when another session takes the pane, shown again on the
 * way back, and dropped outright when either end of that parent/child pair is
 * deleted — none of which the workspace-keyed working set can express on its own.
 */
export function createReviewWorkspaceSubagentTabs(input: {
  tabs: Accessor<readonly ReviewWorkspaceTab[]>
  activeTabId: Accessor<string>
  /** The session holding the pane; a subagent tab shows only while it is the tab's parent. */
  paneSessionId: Accessor<string>
  deletedSession: Accessor<string | undefined>
  setTabs: (tabs: ReviewWorkspaceTab[]) => void
  prepareActivation: (id: string) => PreparedReviewTabActivation
  activateAfterMount: (activation: PreparedReviewTabActivation) => void
  activate: (id: string) => void
}) {
  const headingFocus = createSubagentHeadingFocus()
  onCleanup(headingFocus.cancel)

  const visibleTabs = createMemo(() =>
    reviewWorkspaceTabsForSession({ tabs: input.tabs(), sessionId: input.paneSessionId() })
  )

  // A tab the pane's session no longer shows cannot stay selected: its body is
  // unmounted, so the panel would draw an empty region under a strip whose
  // selection points at nothing.
  createEffect(() => {
    if (visibleTabs().some((tab) => tab.id === input.activeTabId())) return
    input.activate(REVIEW_TAB_ID)
  })

  // A computed, not an effect: the tab list it rewrites is what the strip and the
  // mounted body render from, so the rewrite has to land in the same update the
  // deletion arrives in rather than one render behind it.
  createComputed(on(input.deletedSession, (sessionId) => {
    if (!sessionId) return
    const next = closeSubagentWorkspaceTabsForSession({
      tabs: input.tabs(),
      activeTabId: input.activeTabId(),
      sessionId,
    })
    if (!next.removed) return
    input.activate(next.activeTabId)
    input.setTabs([...next.tabs])
  }))

  return {
    visibleTabs,
    open(sessionId: string, label?: string, description?: string) {
      const next = openSubagentWorkspaceTab({
        tabs: input.tabs(),
        sessionId,
        parentSessionId: input.paneSessionId(),
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
      })
      if (next.added) {
        const activation = input.prepareActivation(next.activeTabId)
        input.setTabs([...next.tabs])
        input.activateAfterMount(activation)
      } else {
        if (next.tabs !== input.tabs()) input.setTabs([...next.tabs])
        input.activate(next.activeTabId)
      }
      headingFocus.request(sessionId)
    },
  }
}
