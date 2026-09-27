import { createEffect, onCleanup } from "solid-js"
import type { SessionView } from "@/session"
import { waitForIdle, type IdleWait } from "@/lib/idle"
import type { HistoryAnchor } from "./history-paging"

export const BACKFILL_VIEWPORTS = 2
const SCROLL_QUIET_MS = 150
const IDLE_TIMEOUT_MS = 1000

type BackfillInput = {
  readonly view: () => SessionView
  readonly scroller: () => HTMLElement | undefined
  readonly anchor: () => HistoryAnchor
  readonly open: () => boolean
  readonly idle?: () => IdleWait
}

function latestTurnWhole(view: SessionView): boolean {
  return view.conversation()?.fragmentParts.size === 0
}

function createIdleSlot(idle: () => IdleWait) {
  let wait: IdleWait | undefined
  return {
    start: (run: () => void) => {
      if (wait) return
      const current = idle()
      wait = current
      void current.done.then((ready) => {
        if (wait !== current) return
        wait = undefined
        if (ready) run()
      })
    },
    cancel: () => {
      wait?.cancel()
      wait = undefined
    },
  }
}

export function createHistoryBackfill(input: BackfillInput) {
  const slot = createIdleSlot(input.idle ?? (() => waitForIdle(IDLE_TIMEOUT_MS)))
  let scrolledAt = Number.NEGATIVE_INFINITY
  const wanted = () => {
    const view = input.view()
    return input.open() && latestTurnWhole(view) && view.hasOlder() && view.olderState().kind === "idle"
  }
  const short = () => {
    const el = input.scroller()
    return !!el && el.scrollTop < BACKFILL_VIEWPORTS * el.clientHeight
  }
  const step = async () => {
    if (!wanted()) return
    if (performance.now() - scrolledAt < SCROLL_QUIET_MS) return schedule()
    if (!short()) return
    const anchor = input.anchor()
    anchor.capture()
    await input.view().loadOlderTurn()
    anchor.restore()
    schedule()
  }
  const schedule = () => {
    if (wanted()) slot.start(() => void step())
  }
  createEffect(() => (wanted() ? schedule() : slot.cancel()))
  onCleanup(slot.cancel)
  return {
    onScroll: () => {
      scrolledAt = performance.now()
      schedule()
    },
  }
}
