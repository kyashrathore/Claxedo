import type { ProjectedUserMessage as UserMessage } from "../conversation/agent-conversation-codec"
export type { ProjectedUserMessage as UserMessage } from "../conversation/agent-conversation-codec"
import { createEffect, createMemo, on, type Accessor } from "solid-js"

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
  /**
   * Turns rendered on first paint; the window opens at `length - turnInit`.
   * Read live until the window commits (see the commit effect below), so a
   * pane whose presentation changes before its history lands opens at the
   * right size without a second pass.
   */
  turnInit?: Accessor<number> | number
  /**
   * Whether scrolling to the top reveals hidden turns. When false, hidden turns
   * are only revealed explicitly (`loadAndReveal`, `revealTurn`); once nothing
   * is hidden the scroller still pages older server history.
   */
  autoFill?: Accessor<boolean> | boolean
}

/** A committed window, taken before a presentation flip so it can be put back after. */
export type HistoryWindowSnapshot = { sessionID: string; turnStart: number }

/**
 * Maintains the rendered history window for a session timeline.
 *
 * It keeps initial paint bounded to recent turns, reveals cached turns in
 * small batches while scrolling upward, and prefetches older history near top.
 */
export function createSessionHistoryWindow(input: Input) {
  const turnInitInput = input.turnInit
  const turnInit: Accessor<number> = typeof turnInitInput === "function" ? turnInitInput : () => turnInitInput ?? 4
  const autoFill: Accessor<boolean> =
    typeof input.autoFill === "function" ? input.autoFill : () => input.autoFill !== false
  const turnBatch = 8
  const turnScrollThreshold = 200
  const turnPrefetchBuffer = 16
  const prefetchCooldownMs = 400
  const prefetchNoGrowthLimit = 2

  const [state, setState] = createStore({
    turnID: undefined as string | undefined,
    turnStart: 0,
    prefetchUntil: 0,
    prefetchNoGrowth: 0,
  })

  const initialTurnStart = (len: number) => (len > turnInit() ? len - turnInit() : 0)

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

  /** Turns above the window: `turnStart` is the index of the first rendered turn. */
  const hiddenTurnCount: Accessor<number> = turnStart

  const collapseToLastTurn = () => {
    setTurnStart(Math.max(0, input.visibleUserMessages().length - 1))
  }

  /**
   * The committed window for the current session, or undefined while the
   * window is still derived from `turnInit` (nothing to restore then).
   */
  const captureWindow = (): HistoryWindowSnapshot | undefined => {
    const id = input.sessionID()
    if (!id || state.turnID !== id) return undefined
    return { sessionID: id, turnStart: state.turnStart }
  }

  /**
   * Puts back a window captured by `captureWindow` for the same session;
   * anything else returns to the first-paint window. The memo above clamps a
   * start the list has since shrunk below.
   */
  const restoreWindow = (snapshot: HistoryWindowSnapshot | undefined) => {
    if (snapshot && snapshot.sessionID === input.sessionID()) {
      setTurnStart(snapshot.turnStart)
      return
    }
    resetToInitialWindow()
  }

  /**
   * Returns the window to what first paint would have opened for the current
   * list, the way the commit effect below does: committed when the list is
   * longer than `turnInit`, otherwise left uncommitted so the memo keeps
   * deriving it while history is still arriving.
   */
  const resetToInitialWindow = () => {
    const len = input.visibleUserMessages().length
    if (len <= turnInit()) {
      setState({ turnID: undefined, turnStart: 0 })
      return
    }
    setTurnStart(initialTurnStart(len))
  }

  const renderedUserMessages = createMemo(
    () => {
      const msgs = input.visibleUserMessages()
      const start = turnStart()
      if (start <= 0) return msgs
      return msgs.slice(start)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )

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
    // The prepended rows may not have mounted (and grown scrollHeight) by the
    // first frame on a slow machine; a single-frame sample then reads delta 0
    // and silently never compensates, leaving the viewport at the top the
    // wheel left behind. Watch a short frame budget and compensate on the
    // first observed growth — one write, same as before, just not tied to
    // frame one.
    let frames = 0
    const compensate = () => {
      const delta = el.scrollHeight - beforeHeight
      if (delta) {
        el.scrollTop = beforeTop + delta
        return
      }
      frames += 1
      if (frames < 30) requestAnimationFrame(compensate)
    }
    requestAnimationFrame(compensate)
  }

  const backfillTurns = () => {
    const start = turnStart()
    if (start <= 0) return

    const next = start - turnBatch
    const nextStart = next > 0 ? next : 0

    preserveScroll(() => setTurnStart(nextStart))
  }

  /**
   * Reveals every cached turn, then pages one batch of older server history
   * when the session has more. `target` is the turn index the window settles
   * at after paging (`0` keeps everything the page delivered revealed); when
   * omitted the window settles one batch above the turns rendered before the
   * call, which is what the short-viewport fill wants.
   */
  const loadAndReveal = async (target?: number) => {
    const id = input.sessionID()
    if (!id) return

    const start = turnStart()
    const beforeVisible = input.visibleUserMessages().length

    if (target !== undefined) preserveScroll(() => setTurnStart(target))
    else if (start > 0) setTurnStart(0)

    if (!input.historyMore() || input.historyLoading()) return

    input.onBeforeLoad?.()
    await input.loadMore(id)
    input.onAfterLoad?.()
    if (input.sessionID() !== id) return

    const afterVisible = input.visibleUserMessages().length
    const growth = afterVisible - beforeVisible
    if (state.prefetchNoGrowth) setState("prefetchNoGrowth", 0)
    if (growth <= 0) return
    if (target !== undefined || turnStart() !== 0) return

    const nextTarget = Math.min(afterVisible, Math.max(beforeVisible, renderedUserMessages().length) + turnBatch)
    const nextStart = Math.max(0, afterVisible - nextTarget)
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
    // A backfill moved the window while this page was in flight. The page grew
    // the list at its head, so an unshifted start would render the fetched
    // turns above the reader with no anchor left to hold their place.
    if (turnStart() !== start) {
      setTurnStart(turnStart() + growth)
      return
    }

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
      if (!autoFill()) return
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
    if (index >= 0 && index < turnStart()) setTurnStart(index)
  }

  createEffect(
    on(
      input.sessionID,
      () => {
        setState({ prefetchUntil: 0, prefetchNoGrowth: 0 })
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
        if (len <= turnInit()) return
        setTurnStart(initialTurnStart(len))
      },
      { defer: true },
    ),
  )

  return {
    turnStart,
    setTurnStart,
    hiddenTurnCount,
    collapseToLastTurn,
    captureWindow,
    restoreWindow,
    resetToInitialWindow,
    renderedUserMessages,
    revealTurn,
    loadAndReveal,
    onScrollerScroll,
  }
}
