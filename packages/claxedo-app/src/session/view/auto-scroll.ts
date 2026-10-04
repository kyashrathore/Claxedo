import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"

export type AutoScrollOptions = {
  readonly working: () => boolean
  readonly enabled?: () => boolean
  readonly overflowAnchor?: "none" | "auto" | "dynamic"
  readonly bottomThreshold?: number
  readonly mayFollow?: () => boolean
}

const OWN_SCROLL_WINDOW_MS = 1500
const SETTLE_MS = 300

type ScrollerState = { contentRef?: HTMLElement; scrollRef?: HTMLElement; userScrolled: boolean }

type OwnScroll = {
  readonly mark: (el: HTMLElement) => void
  readonly matches: (el: HTMLElement) => boolean
  readonly dispose: () => void
}

type Settle = { readonly active: () => boolean; readonly begin: () => void; readonly end: () => void }

type Scroller = {
  readonly state: ScrollerState
  readonly setScrolled: (value: boolean) => void
  readonly enabled: () => boolean
  readonly active: () => boolean
  readonly own: OwnScroll
}

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.clientHeight - el.scrollTop
}

function canScroll(el: HTMLElement): boolean {
  return el.scrollHeight - el.clientHeight > 1
}

function createOwnScroll(): OwnScroll {
  let last: { top: number; time: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    mark: (el) => {
      last = { top: Math.max(0, el.scrollHeight - el.clientHeight), time: Date.now() }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        last = undefined
        timer = undefined
      }, OWN_SCROLL_WINDOW_MS)
    },
    matches: (el) => {
      if (!last) return false
      if (Date.now() - last.time > OWN_SCROLL_WINDOW_MS) {
        last = undefined
        return false
      }
      return Math.abs(el.scrollTop - last.top) < 2
    },
    dispose: () => {
      if (timer) clearTimeout(timer)
    },
  }
}

function createSettle(): Settle {
  let settling = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const end = () => {
    settling = false
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const begin = () => {
    settling = true
    timer = setTimeout(() => {
      settling = false
    }, SETTLE_MS)
  }
  return { active: () => settling, begin, end }
}

function scrollToBottom(scroller: Scroller, force: boolean): void {
  if (!scroller.enabled()) return
  if (!force && !scroller.active()) return
  if (force) scroller.setScrolled(false)
  const el = scroller.state.scrollRef
  if (!el || (!force && scroller.state.userScrolled)) return
  scroller.own.mark(el)
  if (distanceFromBottom(el) < 2) return
  el.scrollTop = el.scrollHeight
}

function pauseFollowing(scroller: Scroller): void {
  const el = scroller.state.scrollRef
  if (!el) return
  scroller.setScrolled(canScroll(el))
}

function handleWheel(scroller: Scroller, event: WheelEvent): void {
  if (event.deltaY >= 0) return
  const el = scroller.state.scrollRef
  const target = event.target instanceof Element ? event.target : undefined
  const nested = target?.closest("[data-scrollable]")
  if (el && nested && nested !== el) return
  pauseFollowing(scroller)
}

function handleScroll(scroller: Scroller, threshold: number): void {
  if (!scroller.enabled()) return
  const el = scroller.state.scrollRef
  if (!el) return
  if (!canScroll(el) || distanceFromBottom(el) < threshold) return scroller.setScrolled(false)
  if (!scroller.state.userScrolled && scroller.own.matches(el)) return scrollToBottom(scroller, false)
  pauseFollowing(scroller)
}

function handleClick(scroller: Scroller, settle: Settle): void {
  if (!scroller.active()) return
  const selection = window.getSelection()
  if (selection && selection.toString().length > 0) pauseFollowing(scroller)
  settle.end()
}

function followOnResize(scroller: Scroller, mayFollow: (() => boolean) | undefined): void {
  if (!scroller.enabled()) return
  const el = scroller.state.scrollRef
  if (el && !canScroll(el)) return scroller.setScrolled(false)
  if (!scroller.active() || scroller.state.userScrolled || mayFollow?.() === false) return
  scrollToBottom(scroller, false)
}

function overflowAnchor(mode: NonNullable<AutoScrollOptions["overflowAnchor"]>, userScrolled: boolean): string {
  if (mode !== "dynamic") return mode
  return userScrolled ? "auto" : "none"
}

export function createAutoScroll(options: AutoScrollOptions) {
  const [state, setState] = createStore<ScrollerState>({ userScrolled: false })
  const settle = createSettle()
  const scroller: Scroller = {
    state,
    setScrolled: (value) => {
      if (state.userScrolled !== value) setState("userScrolled", value)
    },
    enabled: () => options.enabled?.() !== false,
    active: () => options.working() || settle.active(),
    own: createOwnScroll(),
  }
  createResizeObserver(() => [state.contentRef, state.scrollRef], () => followOnResize(scroller, options.mayFollow))
  createEffect(
    on(options.working, (working) => {
      settle.end()
      if (!working) return settle.begin()
      if (!state.userScrolled) scrollToBottom(scroller, true)
    }),
  )
  createEffect(() => {
    const mode = overflowAnchor(options.overflowAnchor ?? "dynamic", state.userScrolled)
    if (state.scrollRef) state.scrollRef.style.overflowAnchor = mode
  })
  createEventListener(() => state.scrollRef, "wheel", (event) => handleWheel(scroller, event), { passive: true })
  createEventListener(() => state.scrollRef, "click", () => handleClick(scroller, settle), { capture: true })
  onCleanup(() => {
    settle.end()
    scroller.own.dispose()
  })
  return {
    scrollRef: (el: HTMLElement | undefined) => setState("scrollRef", el),
    contentRef: (el: HTMLElement | undefined) => setState("contentRef", el),
    handleScroll: () => handleScroll(scroller, options.bottomThreshold ?? 10),
    pause: () => pauseFollowing(scroller),
    restoreFollowing: (following: boolean) => setState("userScrolled", !following),
    resume: () => scrollToBottom(scroller, true),
    userScrolled: () => state.userScrolled,
  }
}

export type AutoScroll = ReturnType<typeof createAutoScroll>
