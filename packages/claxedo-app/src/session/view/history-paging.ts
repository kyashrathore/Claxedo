import { createEffect, untrack } from "solid-js"
import type { SessionView } from "@/session"

const TOP_THRESHOLD = 200

export type HistoryAnchor = { readonly capture: () => void; readonly restore: () => void }

export function createHistoryPaging(input: {
  readonly view: () => SessionView
  readonly scroller: () => HTMLElement | undefined
  readonly userScrolled: () => boolean
  readonly anchor: () => HistoryAnchor
  readonly active: () => boolean
  readonly wantsOlder: () => boolean
}) {
  const loadOlder = async () => {
    const view = input.view()
    if (!view.hasOlder() || view.olderState().kind === "loading") return
    const anchor = input.anchor()
    anchor.capture()
    await view.loadOlder()
    anchor.restore()
  }
  const filled = new WeakSet<SessionView>()
  createEffect(() => {
    const view = input.view()
    if (!input.active() || filled.has(view) || !view.conversation()) return
    filled.add(view)
    if (!view.hasOlder() || untrack(view.olderPagesLoaded) > 0 || !untrack(input.wantsOlder)) return
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (input.view() === view && input.active()) void loadOlder()
    }))
  })
  return {
    onScroll: () => {
      const el = input.scroller()
      if (!input.userScrolled() || !el || el.scrollTop >= TOP_THRESHOLD) return
      void loadOlder()
    },
    onPull: () => {
      const el = input.scroller()
      if (!el || el.scrollTop > 0) return
      void loadOlder()
    },
  }
}
