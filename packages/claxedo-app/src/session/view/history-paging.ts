import type { SessionView } from "@/session"

export type HistoryAnchor = { readonly capture: () => void; readonly restore: () => void; readonly settle: () => void }

type PagingInput = {
  readonly view: () => SessionView
  readonly scroller: () => HTMLElement | undefined
  readonly userScrolled: () => boolean
  readonly anchor: () => HistoryAnchor
}

function createOlderLoader(input: PagingInput) {
  return {
    load: async () => {
      const anchor = input.anchor()
      anchor.capture()
      await input.view().loadOlder()
      anchor.restore()
    },
    loadable: () => {
      const view = input.view()
      return view.hasOlder() && view.olderState().kind !== "loading"
    },
    failed: () => input.view().olderState().kind === "failed",
  }
}

function gesturePaging(input: PagingInput, loader: ReturnType<typeof createOlderLoader>) {
  const onGesture = () => {
    if (loader.loadable()) void loader.load()
  }
  return {
    onScroll: () => {
      const el = input.scroller()
      if (!input.userScrolled() || !el || el.scrollTop >= el.clientHeight) return
      onGesture()
    },
    onPull: () => {
      const el = input.scroller()
      if (!el || el.scrollTop > 0) return
      onGesture()
    },
  }
}

export function createHistoryPaging(input: PagingInput) {
  const loader = createOlderLoader(input)
  return {
    ...gesturePaging(input, loader),
    loadUntil: async (loaded: () => boolean, current: () => boolean = () => true): Promise<boolean> => {
      while (!loaded()) {
        if (!current() || !input.view().hasOlder()) return false
        await loader.load()
        if (loader.failed()) return false
      }
      return true
    },
  }
}
