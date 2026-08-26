import { storePath } from "solid-js"
import { createEffect, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js"
import { createEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
  overflowAnchor?: "none" | "auto" | "dynamic"
  bottomThreshold?: number
}

export function createAutoScroll(options: AutoScrollOptions) {
  let settling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  let auto: { top: number; time: number } | undefined

  const threshold = () => options.bottomThreshold ?? 10

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    scrollRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })

  // Consulted imperatively only — from `scrollToBottom` and the resize
  // reaction, both of which run in effect apply phases or event handlers,
  // never in a tracking scope. `untrack` states that, and keeps Solid 2's
  // strict-read diagnostic from flagging a read it is right to call
  // non-updating: the effects that must re-run track their own sources.
  const active = () => untrack(options.working) || settling

  const distanceFromBottom = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  const canScroll = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight > 1
  }

  // Browsers can dispatch scroll events asynchronously. If new content arrives
  // between us calling `scrollTo()` and the subsequent `scroll` event firing,
  // the handler can see a non-zero `distanceFromBottom` and incorrectly assume
  // the user scrolled.
  const markAuto = (el: HTMLElement) => {
    auto = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: Date.now(),
    }

    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      auto = undefined
      autoTimer = undefined
    }, 1500)
  }

  const isAuto = (el: HTMLElement) => {
    const a = auto
    if (!a) return false

    if (Date.now() - a.time > 1500) {
      auto = undefined
      return false
    }

    return Math.abs(el.scrollTop - a.top) < 2
  }

  const scrollToBottomNow = (behavior: ScrollBehavior) => {
    const el = untrack(() => store.scrollRef)
    if (!el) return
    markAuto(el)
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior })
      return
    }

    // `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`.
    el.scrollTop = el.scrollHeight
  }

  const scrollToBottom = (force: boolean) => {
    if (!force && !active()) return

    // Imperative helper: it is called from event handlers AND from effect apply
    // phases, and it must read the CURRENT value without making its caller
    // depend on it — `updateOverflowAnchor`'s own effect tracks `userScrolled`
    // explicitly for that. Solid 2 flags a bare reactive read in an apply phase
    // as one that will not update, which here is the intent.
    const { userScrolled, el } = untrack(() => ({ userScrolled: store.userScrolled, el: store.scrollRef }))

    if (force && userScrolled) setStore(storePath("userScrolled", false))

    if (!el) return

    if (!force && userScrolled) return

    const distance = distanceFromBottom(el)
    if (distance < 2) {
      markAuto(el)
      return
    }

    // For auto-following content we prefer immediate updates to avoid
    // visible "catch up" animations while content is still settling.
    scrollToBottomNow("auto")
  }

  const stop = () => {
    const el = store.scrollRef
    if (!el) return
    if (!canScroll(el)) {
      if (store.userScrolled) setStore(storePath("userScrolled", false))
      return
    }
    if (store.userScrolled) return

    setStore(storePath("userScrolled", true))
    options.onUserInteracted?.()
  }

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY >= 0) return
    // If the user is scrolling within a nested scrollable region (tool output,
    // code block, etc), don't treat it as leaving the "follow bottom" mode.
    // Those regions opt in via `data-scrollable`.
    const el = store.scrollRef
    const target = e.target instanceof Element ? e.target : undefined
    const nested = target?.closest("[data-scrollable]")
    if (el && nested && nested !== el) return
    stop()
  }

  const handleScroll = () => {
    const el = store.scrollRef
    if (!el) return

    if (!canScroll(el)) {
      if (store.userScrolled) setStore(storePath("userScrolled", false))
      return
    }

    if (distanceFromBottom(el) < threshold()) {
      if (store.userScrolled) setStore(storePath("userScrolled", false))
      return
    }

    // Ignore scroll events triggered by our own scrollToBottom calls.
    if (!store.userScrolled && isAuto(el)) {
      scrollToBottom(false)
      return
    }

    stop()
  }

  const handleInteraction = () => {
    if (!active()) return
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      stop()
    }
  }

  const updateOverflowAnchor = (el: HTMLElement) => {
    const mode = options.overflowAnchor ?? "dynamic"

    if (mode === "none") {
      el.style.overflowAnchor = "none"
      return
    }

    if (mode === "auto") {
      el.style.overflowAnchor = "auto"
      return
    }

    el.style.overflowAnchor = untrack(() => store.userScrolled) ? "auto" : "none"
  }

  // The distance from the bottom is `scrollHeight - clientHeight - scrollTop`,
  // so the viewport's own height moves the bottom exactly as much as the
  // content's does. Observing only the content leaves a real gap: when the
  // viewport grows the browser clamps `scrollTop` down to the new maximum, and
  // when it shrinks back that clamped value is stranded short of the bottom —
  // with no content resize to trigger a re-pin. A transient viewport change
  // (the prompt dock losing and regaining a status line as a turn completes)
  // therefore knocked the timeline permanently off the bottom by one line.
  createResizeObserver(
    () => [store.contentRef, store.scrollRef],
    () => {
      // One untracked snapshot, like `scrollToBottom`: the observer already
      // tracks the two refs above, and this reaction only needs the CURRENT
      // scroll state. Bare reads here would subscribe nothing (an apply phase
      // does not track) while reading as if they did — which is exactly what
      // Solid 2's strict-read diagnostic reports.
      const { el, userScrolled } = untrack(() => ({
        el: store.scrollRef,
        userScrolled: store.userScrolled,
      }))
      if (el && !canScroll(el)) {
        if (userScrolled) setStore(storePath("userScrolled", false))
        return
      }
      if (!active()) return
      if (userScrolled) return
      // ResizeObserver fires after layout, before paint.
      // Keep the bottom locked in the same frame to avoid visible
      // "jump up then catch up" artifacts while streaming content.
      scrollToBottom(false)
    },
  )

  createEffect(options.working, (working: boolean) => {
    settling = false
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = undefined

    if (working) {
      // Current state, not a subscription — the effect reacts to `working`.
      if (!untrack(() => store.userScrolled)) scrollToBottom(true)
      return
    }

    settling = true
    settleTimer = setTimeout(() => {
      settling = false
    }, 300)
  })

  createEffect(
    // Track `userScrolled` even before `scrollRef` is attached, so we can
    // update overflow anchoring once the element exists. The box is fresh on
    // purpose: returning the ref alone would dedupe away every run where only
    // `userScrolled` flipped, which is the case the anchor exists for.
    () => ({ el: store.scrollRef, userScrolled: store.userScrolled }),
    ({ el }) => {
      if (el) updateOverflowAnchor(el)
    },
  )

  createEventListener(() => store.scrollRef, "wheel", handleWheel, { passive: true })

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (autoTimer) clearTimeout(autoTimer)
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => setStore(storePath("scrollRef", el)),
    contentRef: (el: HTMLElement | undefined) => setStore(storePath("contentRef", el)),
    handleScroll,
    handleInteraction,
    pause: stop,
    resume: () => {
      if (store.userScrolled) setStore(storePath("userScrolled", false))
      scrollToBottom(true)
    },
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => scrollToBottom(true),
    userScrolled: () => store.userScrolled,
  }
}
