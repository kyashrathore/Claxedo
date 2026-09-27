import { createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionView } from "@/session"
import { createScrollGestureWindow, type MessageTimelineProps, type TimelineNavTurn } from "./timeline"
import { createAutoScroll, type AutoScroll } from "./auto-scroll"
import { createHistoryBackfill } from "./history-backfill"
import { createHistoryPaging, type HistoryAnchor } from "./history-paging"
import { createTurnPick } from "./turn-pick"
import { computeScrollState, type ScrollState } from "./scroll-anchor"

export type TimelineScrollProps = Pick<
  MessageTimelineProps,
  | "scroll"
  | "onResumeScroll"
  | "setScrollRef"
  | "onScheduleScrollState"
  | "onAutoScrollHandleScroll"
  | "onMarkScrollGesture"
  | "hasScrollGesture"
  | "onUserScroll"
  | "onHistoryScroll"
  | "onHistoryPull"
  | "shouldAnchorBottom"
  | "hasScrollTarget"
  | "restoreFollowing"
  | "setContentRef"
  | "setScrollToEnd"
  | "setScrollToMessage"
  | "setHistoryAnchor"
  | "onMessageSelect"
>

type ScrollHandles = {
  scrollToEnd: () => void
  scrollToMessage: (id: string, behavior: ScrollBehavior) => boolean
  anchor: HistoryAnchor
}

function createScrollStateFrame(setScroll: (next: ScrollState) => void) {
  let frame: number | undefined
  let target: HTMLDivElement | undefined
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })
  return (el: HTMLDivElement) => {
    target = el
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      const current = target
      target = undefined
      if (current) setScroll(computeScrollState(current))
    })
  }
}

type ScrollParts = {
  readonly scroll: ScrollState
  readonly auto: AutoScroll
  readonly gesture: ReturnType<typeof createScrollGestureWindow>
  readonly paging: ReturnType<typeof createHistoryPaging>
  readonly backfill: ReturnType<typeof createHistoryBackfill>
  readonly schedule: (el: HTMLDivElement) => void
  readonly handles: ScrollHandles
  readonly selected: () => string | undefined
  readonly select: (messageId: string | undefined) => void
  readonly resume: () => void
  readonly seekTurn: (messageId: string) => Promise<void>
  readonly scroller: () => HTMLDivElement | undefined
  readonly setScroller: (el: HTMLDivElement | undefined) => void
}

function timelineScrollProps(parts: ScrollParts): TimelineScrollProps {
  const { auto, gesture, paging, backfill, schedule, handles } = parts
  return {
    scroll: parts.scroll,
    onResumeScroll: parts.resume,
    setScrollRef: (el) => {
      parts.setScroller(el)
      auto.scrollRef(el)
      if (el) schedule(el)
    },
    onScheduleScrollState: schedule,
    onAutoScrollHandleScroll: auto.handleScroll,
    onMarkScrollGesture: gesture.mark,
    hasScrollGesture: gesture.active,
    onUserScroll: () => {},
    onHistoryScroll: () => {
      paging.onScroll()
      backfill.onScroll()
    },
    onHistoryPull: paging.onPull,
    shouldAnchorBottom: () => !parts.selected() && !auto.userScrolled(),
    hasScrollTarget: () => !!parts.selected(),
    restoreFollowing: auto.restoreFollowing,
    setContentRef: (el) => {
      auto.contentRef(el)
      const scroller = parts.scroller()
      if (scroller) schedule(scroller)
    },
    setScrollToEnd: (fn) => (handles.scrollToEnd = fn),
    setScrollToMessage: (fn) => (handles.scrollToMessage = fn ?? (() => false)),
    setHistoryAnchor: (anchor) => (handles.anchor = anchor),
    onMessageSelect: (turn: TimelineNavTurn) => {
      auto.pause()
      parts.select(turn.id)
      void parts.seekTurn(turn.id)
    },
  }
}

export type TimelineScroll = ReturnType<typeof createTimelineScroll>

type TimelineScrollInput = {
  readonly view: () => SessionView
  readonly active: () => boolean
  readonly working: () => boolean
  readonly revealed: () => boolean
}

type HistoryInput = TimelineScrollInput & {
  readonly handles: ScrollHandles
  readonly scroller: () => HTMLDivElement | undefined
  readonly selected: () => string | undefined
  readonly userScrolled: () => boolean
}

function createHistoryLoads(input: HistoryInput) {
  const { view, handles, scroller, selected } = input
  const paging = createHistoryPaging({ view, scroller, userScrolled: input.userScrolled, anchor: () => handles.anchor })
  const pick = createTurnPick({ view, loadUntil: paging.loadUntil, handles, selected, scroller })
  const backfill = createHistoryBackfill({ view, scroller, anchor: () => handles.anchor, open: () => input.revealed() && !input.working() && !selected() })
  return { paging, pick, backfill }
}

export function createTimelineScroll(input: TimelineScrollInput) {
  let scroller: HTMLDivElement | undefined
  const handles: ScrollHandles = { scrollToEnd: () => {}, scrollToMessage: () => false, anchor: { capture: () => {}, restore: () => {}, settle: () => {} } }
  const [scroll, setScroll] = createStore<ScrollState>({ overflow: false, bottom: true, jump: false })
  const [selected, select] = createSignal<string>()
  const gesture = createScrollGestureWindow({ scroller: () => scroller })
  const auto = createAutoScroll({ working: input.working, enabled: input.active, overflowAnchor: "none", mayFollow: () => !gesture.active() })
  const schedule = createScrollStateFrame((next) => setScroll(next))
  const { paging, pick, backfill } = createHistoryLoads({ ...input, handles, scroller: () => scroller, selected, userScrolled: auto.userScrolled })
  const settle = () => {
    handles.scrollToEnd()
    if (scroller) schedule(scroller)
  }
  const resume = () => {
    pick.cancel()
    select(undefined)
    auto.resume()
    settle()
    requestAnimationFrame(() => {
      if (!selected()) settle()
    })
  }
  const setScroller = (el: HTMLDivElement | undefined) => (scroller = el)
  const parts = { scroll, auto, gesture, paging, backfill, schedule, handles, selected, select, resume, seekTurn: pick.seek, scroller: () => scroller, setScroller }
  return {
    props: timelineScrollProps(parts),
    selected,
    resume,
    scroller: () => scroller,
    userScrolled: auto.userScrolled,
    scrollToEnd: () => handles.scrollToEnd(),
    schedule,
  }
}
