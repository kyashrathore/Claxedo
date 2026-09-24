import { batch, createComputed, createMemo, createSelector, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { PaneRect, WorkbenchState } from "../types"

export type ContentIndex = {
  readonly paneOf: (contentId: string) => string | null
  readonly assigned: Accessor<ReadonlySet<string>>
  readonly isDisplayed: (contentId: string) => boolean
}

export function createContentIndex(layout: Accessor<WorkbenchState>, displayRects: Accessor<Map<string, PaneRect>>): ContentIndex {
  const contentPaneMap = createMemo(() => {
    const map = new Map<string, string>()
    for (const pane of layout().panes) if (pane.contentId) map.set(pane.contentId, pane.id)
    return map
  })
  const [contentPaneById, setContentPaneById] = createStore<Record<string, string | undefined>>({})
  let previous = new Map<string, string>()
  createComputed(() => {
    const next = contentPaneMap()
    batch(() => {
      for (const contentId of previous.keys()) if (!next.has(contentId)) setContentPaneById(contentId, undefined)
      for (const [contentId, paneId] of next) if (previous.get(contentId) !== paneId) setContentPaneById(contentId, paneId)
    })
    previous = next
  })
  const assigned = createMemo(() => new Set(contentPaneMap().keys()))
  const displayed = createMemo(() => {
    const rects = displayRects()
    return new Set([...contentPaneMap()].flatMap(([contentId, paneId]) => (rects.has(paneId) ? [contentId] : [])))
  })
  const isDisplayed = createSelector(displayed, (contentId: string, set) => set.has(contentId))
  return { paneOf: (contentId) => contentPaneById[contentId] ?? null, assigned, isDisplayed }
}
