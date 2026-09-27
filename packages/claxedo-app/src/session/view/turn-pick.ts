import { onCleanup } from "solid-js"
import type { SessionView } from "@/session"
import type { HistoryAnchor } from "./history-paging"
import { createMessageSeek } from "./message-seek"

export function createTurnPick(input: {
  readonly view: () => SessionView
  readonly loadUntil: (loaded: () => boolean, current: () => boolean) => Promise<boolean>
  readonly handles: { readonly anchor: HistoryAnchor; readonly scrollToMessage: (messageId: string, behavior: ScrollBehavior) => boolean }
  readonly selected: () => string | undefined
  readonly scroller: () => HTMLElement | undefined
}) {
  const seeker = createMessageSeek({ scroller: input.scroller, scrollTo: (messageId) => input.handles.scrollToMessage(messageId, "auto") })
  let run = 0
  const cancel = () => {
    run += 1
    seeker.cancel()
  }
  onCleanup(cancel)
  return {
    seek: async (messageId: string) => {
      cancel()
      const mine = run
      const view = input.view()
      const current = () => run === mine && input.view() === view
      const loaded = await input.loadUntil(() => view.messages().some((message) => message.id === messageId), current)
      if (!loaded || !current() || input.selected() !== messageId) return
      input.handles.anchor.settle()
      seeker.seek(messageId)
    },
    cancel,
  }
}
