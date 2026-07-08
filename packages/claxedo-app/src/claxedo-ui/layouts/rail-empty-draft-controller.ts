import { createEffect, createMemo, on, type Accessor } from "solid-js"

import { isGlobalContent, type ContentMeta } from "../state"

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
  activeWorkspaceId: Accessor<string | undefined>
  autoOpenDisabled: Accessor<boolean | undefined>
  onNewSession?: (workspaceDir?: string) => void
}) {
  const renderableSurfaceIds = createMemo(() =>
    input.state.wb.selectors.aliveContents().filter((id) => !!input.state.meta.get(id)),
  )
  const visibleRenderableSurfaceIds = createMemo(() =>
    input.state.wb.selectors.visiblePanes()
      .map((pane) => pane.contentId)
      .filter((id): id is string => !!id && !!input.state.meta.get(id)),
  )
  const hasOpenSurfaces = createMemo(() => renderableSurfaceIds().length > 0)
  const focusedSurface = createMemo(() => {
    const contentId = input.state.wb.selectors.focusedContent()
    return contentId && visibleRenderableSurfaceIds().includes(contentId)
      ? input.state.meta.get(contentId)
      : undefined
  })
  const emptyDraftDirectory = createMemo(() => input.activeWorkspaceId() ?? input.projects()[0]?.worktree)
  const sidebarEligible = createMemo(() => input.projects().length > 0 || hasOpenSurfaces())

  let blockedUntil = 0
  const blockNextAutoOpen = () => {
    blockedUntil = Date.now() + 2_000
  }
  const shouldOpenEmptyDraftSession = createMemo(() => {
    if (Date.now() < blockedUntil) return false
    if (input.autoOpenDisabled()) return false
    if (!emptyDraftDirectory()) return false
    if (visibleRenderableSurfaceIds().length > 0) return false
    return !focusedSurface()
  })
  let didRequestEmptyDraftSession = false
  createEffect(
    on(shouldOpenEmptyDraftSession, (shouldOpen) => {
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
    }),
  )

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
