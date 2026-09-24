import type { SessionView } from "@/session"

const TOP_THRESHOLD = 200

export type HistoryAnchor = { readonly capture: () => void; readonly restore: () => void }

export function createHistoryPaging(input: {
  readonly view: () => SessionView
  readonly scroller: () => HTMLElement | undefined
  readonly userScrolled: () => boolean
  readonly anchor: () => HistoryAnchor
}) {
  const loadOlder = async () => {
    const view = input.view()
    if (!view.hasOlder() || view.olderState().kind === "loading") return
    const anchor = input.anchor()
    anchor.capture()
    await view.loadOlder()
    anchor.restore()
  }
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
