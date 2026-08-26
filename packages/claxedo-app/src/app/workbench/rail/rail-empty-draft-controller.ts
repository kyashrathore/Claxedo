import { createEffect } from "solid-js"
import { createMemo, createSignal, type Accessor } from "solid-js"

import { isGlobalContent, type ContentMeta } from "../state/index"

type RailEmptyDraftState = {
  wb: {
    selectors: {
      aliveContents: () => readonly string[]
      visiblePanes: () => readonly { contentId?: string | null }[]
      focusedContent: () => string | null | undefined
    }
  }
  meta: {
    get: (contentId: string) => ContentMeta | undefined
  }
}

export function useRailEmptyDraftController(input: {
  state: RailEmptyDraftState
  projects: Accessor<readonly { worktree: string }[]>
  activeDirectory: Accessor<string | undefined>
  autoOpenDisabled: Accessor<boolean | undefined>
  onNewSession?: (workspaceDir?: string) => void
}) {
  const renderableSurfaceIds = createMemo(() =>
    input.state.wb.selectors.aliveContents().filter((id) => !!input.state.meta.get(id)),
  )
  const visibleRenderableSurfaceIds = createMemo(() =>
    input.state.wb.selectors
      .visiblePanes()
      .map((pane) => pane.contentId)
      .filter((id): id is string => !!id && !!input.state.meta.get(id)),
  )
  const hasOpenSurfaces = createMemo(() => renderableSurfaceIds().length > 0)
  const focusedSurface = createMemo(() => {
    const contentId = input.state.wb.selectors.focusedContent()
    return contentId && visibleRenderableSurfaceIds().includes(contentId) ? input.state.meta.get(contentId) : undefined
  })
  const emptyDraftDirectory = createMemo(() => input.activeDirectory() ?? input.projects()[0]?.worktree)
  const sidebarEligible = createMemo(() => input.projects().length > 0 || hasOpenSurfaces())

  // The block window must be reactive: a plain `let` read inside the memo below
  // is not a tracked dependency, so calling blockNextAutoOpen() after the memo
  // already recomputed to `true` (the surface was removed first, then the block
  // applied) leaves the memo returning a stale `true` and the queued re-open
  // microtask fires anyway — the draft reappears in ~80ms instead of being
  // suppressed (core-panes-split-tabs:802). A signal forces the memo (and the
  // effect's microtask re-check) to re-evaluate the fresh time gate.
  const [blockedUntil, setBlockedUntil] = createSignal(0)
  const blockNextAutoOpen = () => {
    setBlockedUntil(Date.now() + 2_000)
  }
  const shouldOpenEmptyDraftSession = createMemo(() => {
    if (Date.now() < blockedUntil()) return false
    if (input.autoOpenDisabled()) return false
    if (!emptyDraftDirectory()) return false
    if (visibleRenderableSurfaceIds().length > 0) return false
    return !focusedSurface()
  })
  let didRequestEmptyDraftSession = false

  // Bootstrap the canonical Workbench draft before the shell renders its
  // provisional empty fallback. The local new-session action opens the draft
  // synchronously, so doing this during controller construction means the
  // first SessionContent node is also the node promoted by first-submit; a
  // later effect would briefly mount EmptyDraftSessionComposer and then detach
  // its complete timeline/header subtree when the real Workbench pane arrived.
  // Keep later re-open requests queued below: closing the last tab and applying
  // blockNextAutoOpen happen in the same user-action turn, and that cancellation
  // window must remain observable before a replacement draft is opened.
  if (shouldOpenEmptyDraftSession()) {
    didRequestEmptyDraftSession = true
    input.onNewSession?.(emptyDraftDirectory())
  }

  createEffect(shouldOpenEmptyDraftSession, (shouldOpen) => {
    if (!shouldOpen) {
      didRequestEmptyDraftSession = false
      return
    }
    if (didRequestEmptyDraftSession) return
    didRequestEmptyDraftSession = true
    queueMicrotask(() => {
      if (!shouldOpenEmptyDraftSession()) {
        didRequestEmptyDraftSession = false
        return
      }
      input.onNewSession?.(emptyDraftDirectory())
    })
  })

  const activeGlobal = createMemo(() => {
    const surface = focusedSurface()
    return !!surface && isGlobalContent(surface)
  })

  return {
    activeGlobal,
    emptyDraftDirectory,
    focusedSurface,
    hasOpenSurfaces,
    renderableSurfaceIds,
    sidebarEligible,
    blockNextAutoOpen,
    visibleRenderableSurfaceIds,
  }
}
