import { createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionView } from "@/session"
import type { TranscriptUserMessage } from "@/transcript"
import { createScrollGestureWindow, type MessageTimelineProps } from "./timeline"
import { createAutoScroll, type AutoScroll } from "./auto-scroll"
import { createHistoryPaging, type HistoryAnchor } from "./history-paging"
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
  readonly schedule: (el: HTMLDivElement) => void
  readonly handles: ScrollHandles
  readonly selected: () => string | undefined
  readonly select: (messageId: string | undefined) => void
  readonly resume: () => void
  readonly scroller: () => HTMLDivElement | undefined
  readonly setScroller: (el: HTMLDivElement | undefined) => void
}

function timelineScrollProps(parts: ScrollParts): TimelineScrollProps {
  const { auto, gesture, paging, schedule, handles } = parts
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
    onHistoryScroll: paging.onScroll,
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
    onMessageSelect: (message: TranscriptUserMessage) => {
      auto.pause()
      parts.select(message.id)
      handles.scrollToMessage(message.id, "smooth")
    },
  }
}

export function createTimelineScroll(input: { readonly view: () => SessionView; readonly active: () => boolean; readonly working: () => boolean }) {
  let scroller: HTMLDivElement | undefined
  const handles: ScrollHandles = { scrollToEnd: () => {}, scrollToMessage: () => false, anchor: { capture: () => {}, restore: () => {} } }
  const [scroll, setScroll] = createStore<ScrollState>({ overflow: false, bottom: true, jump: false })
  const [selected, select] = createSignal<string>()
  const gesture = createScrollGestureWindow({ scroller: () => scroller })
  const auto = createAutoScroll({ working: input.working, enabled: input.active, overflowAnchor: "none", mayFollow: () => !gesture.active() })
  const schedule = createScrollStateFrame((next) => setScroll(next))
  const paging = createHistoryPaging({ view: input.view, scroller: () => scroller, userScrolled: auto.userScrolled, anchor: () => handles.anchor })
  const settle = () => {
    handles.scrollToEnd()
    if (scroller) schedule(scroller)
  }
  const resume = () => {
    select(undefined)
    auto.resume()
    settle()
    requestAnimationFrame(settle)
  }
  const setScroller = (el: HTMLDivElement | undefined) => (scroller = el)
  const parts = { scroll, auto, gesture, paging, schedule, handles, selected, select, resume, scroller: () => scroller, setScroller }
  return { props: timelineScrollProps(parts), selected, resume }
}
