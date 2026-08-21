import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"
import { same } from "@/lib/same"

export const emptyUserMessages: UserMessage[] = []

type Input = {
  sessionID: () => string | undefined
  messagesReady: () => boolean
  visibleUserMessages: () => UserMessage[]
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  userScrolled: () => boolean
  scroller: () => HTMLDivElement | undefined
  onBeforeLoad?: () => void
  onAfterLoad?: () => void
  onBeforeReveal?: () => void
  onAfterReveal?: () => void
}

/**
 * Maintains the rendered history window for a session timeline.
 *
 * It keeps initial paint bounded to recent turns, reveals cached turns in
 * small batches while scrolling upward, and prefetches older history near top.
 */
export function createSessionHistoryWindow(input: Input) {
  const turnInit = 4
  const turnBatch = 8
  const turnScrollThreshold = 200
  const turnPrefetchBuffer = 16
  const prefetchCooldownMs = 400
  const prefetchNoGrowthLimit = 2

  const [state, setState] = createStore({
    turnID: undefined as string | undefined,
    turnStart: 0,
    // Target-anchored upper bound. Undefined = the window runs to the session
    // end (the normal bottom-anchored transcript). A deep jump to an OLD turn
    // cannot simply lower turnStart — slice(start) would render every turn
    // between it and the newest, tens of thousands of parts. Anchoring caps
    // the upper edge near the target instead, trading live-follow (which the
    // user just left) for a bounded render.
    turnEnd: undefined as number | undefined,
    prefetchUntil: 0,
    prefetchNoGrowth: 0,
  })

  const initialTurnStart = (len: number) => (len > turnInit ? len - turnInit : 0)

  const turnStart = createMemo(() => {
    const id = input.sessionID()
    const len = input.visibleUserMessages().length
    if (!id || len <= 0) return 0
    if (state.turnID !== id) return initialTurnStart(len)
    if (state.turnStart <= 0) return 0
    if (state.turnStart >= len) return initialTurnStart(len)
    return state.turnStart
  })

  const setTurnStart = (start: number) => {
    const id = input.sessionID()
    const next = start > 0 ? start : 0
    if (!id) {
      setState({ turnID: undefined, turnStart: next })
      return
    }
    setState({ turnID: id, turnStart: next })
  }

  const turnEnd = createMemo(() => {
    const len = input.visibleUserMessages().length
    const end = state.turnEnd
    if (end === undefined || end >= len) return len
    return Math.max(end, 1)
  })

  const renderedUserMessages = createMemo(
    () => {
      const msgs = input.visibleUserMessages()
      const start = turnStart()
      const end = turnEnd()
      if (start <= 0 && end >= msgs.length) return msgs
      return msgs.slice(start, end)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )

  /** True while the window is capped short of the newest turn (anchored jump). */
  const anchoredToTurn = () => state.turnEnd !== undefined

  /** Drops the upper cap — back to the normal bottom-anchored window. */
  const resetAnchor = () => {
    if (state.turnEnd !== undefined) setState("turnEnd", undefined)
  }

  const preserveScroll = (fn: () => void) => {
    if (input.onBeforeReveal && input.onAfterReveal) {
      input.onBeforeReveal()
      fn()
      input.onAfterReveal()
      return
    }
    const el = input.scroller()
    if (!el) {
      fn()
      return
    }
    const beforeTop = el.scrollTop
    const beforeHeight = el.scrollHeight
    fn()
    requestAnimationFrame(() => {
      const delta = el.scrollHeight - beforeHeight
      if (!delta) return
      el.scrollTop = beforeTop + delta
    })
  }

  const backfillTurns = () => {
    const start = turnStart()
    if (start <= 0) return

    const next = start - turnBatch
    const nextStart = next > 0 ? next : 0

    preserveScroll(() => setTurnStart(nextStart))
  }

  const loadAndReveal = async () => {
    const id = input.sessionID()
    if (!id) return

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length

    if (start > 0) setTurnStart(0)

    if (!input.historyMore() || input.historyLoading()) return

    input.onBeforeLoad?.()
    await input.loadMore(id)
    input.onAfterLoad?.()
    if (input.sessionID() !== id) return

    const afterVisible = input.visibleUserMessages().length
    const growth = afterVisible - beforeVisible
    if (state.prefetchNoGrowth) setState("prefetchNoGrowth", 0)
    if (growth <= 0) return
    if (turnStart() !== 0) return

    const target = Math.min(afterVisible, Math.max(beforeVisible, renderedUserMessages().length) + turnBatch)
    const nextStart = Math.max(0, afterVisible - target)
    preserveScroll(() => setTurnStart(nextStart))
  }

  const fetchOlderMessages = async (opts?: { prefetch?: boolean }) => {
    const id = input.sessionID()
    if (!id) return
    if (!input.historyMore() || input.historyLoading()) return

    if (opts?.prefetch) {
      const now = Date.now()
      if (state.prefetchUntil > now) return
      if (state.prefetchNoGrowth >= prefetchNoGrowthLimit) return
      setState("prefetchUntil", now + prefetchCooldownMs)
    }

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length
    const beforeRendered = start <= 0 ? beforeVisible : renderedUserMessages().length

    input.onBeforeLoad?.()
    await input.loadMore(id)
    input.onAfterLoad?.()
    if (input.sessionID() !== id) return

    const afterVisible = input.visibleUserMessages().length
    const growth = afterVisible - beforeVisible

    if (opts?.prefetch) {
      setState("prefetchNoGrowth", growth > 0 ? 0 : state.prefetchNoGrowth + 1)
    } else if (growth > 0 && state.prefetchNoGrowth) {
      setState("prefetchNoGrowth", 0)
    }

    if (growth <= 0) return
    if (turnStart() !== start) return

    const reveal = !opts?.prefetch
    const currentRendered = renderedUserMessages().length
    const base = Math.max(beforeRendered, currentRendered)
    const target = reveal ? Math.min(afterVisible, base + turnBatch) : base
    const nextStart = Math.max(0, afterVisible - target)
    preserveScroll(() => setTurnStart(nextStart))
  }

  const onScrollerScroll = () => {
    if (!input.userScrolled()) return
    const el = input.scroller()
    if (!el) return
    if (el.scrollTop >= turnScrollThreshold) return

    const start = turnStart()
    if (start > 0) {
      if (start <= turnPrefetchBuffer) {
        void fetchOlderMessages({ prefetch: true })
      }
      backfillTurns()
      return
    }

    void fetchOlderMessages()
  }

  const revealTurn = (id: string) => {
    const index = input.visibleUserMessages().findIndex((message) => message.id === id)
    if (index < 0) return
    const start = turnStart()
    const end = turnEnd()
    // Already inside the rendered window — nothing to reveal.
    if (index >= start && index < end) return
    // Target-anchored reveal: bound BOTH edges around the destination instead
    // of rendering every newer turn behind it (slice(start) would mount tens
    // of thousands of parts for an old turn and stall the jump).
    const len = input.visibleUserMessages().length
    const context = 24
    setState({
      turnStart: Math.max(0, index - 4),
      turnEnd: Math.min(len, index + 1 + context),
    })
  }

  createEffect(
    on(
      input.sessionID,
      () => {
        setState({ prefetchUntil: 0, prefetchNoGrowth: 0, turnEnd: undefined })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [input.sessionID(), input.messagesReady()] as const,
      ([id, ready]) => {
        if (!id || !ready) return
        const len = input.visibleUserMessages().length
        // Only COMMIT once there is a real window to commit.
        //
        // `messagesReady` can flip while the timeline still holds the FIRST turn
        // alone — the rest of the history arrives a tick later. For any
        // `len <= turnInit`, `initialTurnStart(len)` is 0, so committing here
        // wrote a zero window AND claimed ownership of the session (`turnID`).
        // From then on `turnStart`'s `state.turnID !== id` branch stopped
        // re-deriving and its `state.turnStart <= 0` branch returned 0 forever,
        // so the remaining turns arrived into a permanently un-windowed
        // timeline: every fetched turn painted at once, for the whole life of
        // the session, with only a full reload to recover.
        //
        // Leaving it uncommitted costs nothing: the memo keeps deriving
        // `initialTurnStart` reactively from the live length, which is the same
        // 0 while the list is short and becomes the real window the moment the
        // history lands. A stale committed value from a previous, longer list is
        // still handled by the memo's own `state.turnStart >= len` branch.
        if (len <= turnInit) return
        setTurnStart(initialTurnStart(len))
      },
      { defer: true },
    ),
  )

  return {
    turnStart,
    setTurnStart,
    renderedUserMessages,
    revealTurn,
    loadAndReveal,
    onScrollerScroll,
    anchoredToTurn,
    resetAnchor,
  }
}
