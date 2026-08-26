import type { UserMessage } from "@opencode-ai/sdk/v2"
import { useLocation, useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from "solid-js"
import { messageIdFromHash } from "./message-id-from-hash"
import { sessionMessageScrollTop, sessionMessageTopMargin } from "./session-message-scroll-position"

export const useSessionHashScroll = (input: {
  sessionKey: () => string
  sessionID: () => string | undefined
  messagesReady: () => boolean
  visibleUserMessages: () => UserMessage[]
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  currentMessageId: () => string | undefined
  pendingMessage: () => string | undefined
  setPendingMessage: (value: string | undefined) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  autoScroll: { pause: () => void; forceScrollToBottom: () => void }
  scroller: () => HTMLDivElement | undefined
  scrollToMessageOffset: (id: string, behavior: ScrollBehavior) => boolean
  anchor: (id: string) => string
  revealMessage?: (id: string) => void
  scheduleScrollState: (el: HTMLDivElement) => void
  consumePendingMessage: (key: string) => string | undefined
}) => {
  const visibleUserMessages = createMemo(() => input.visibleUserMessages())
  const messageById = createMemo(() => new Map(visibleUserMessages().map((m) => [m.id, m])))
  let pendingKey = ""
  let clearing = false
  let authoredHash = ""
  // True while a programmatic jump is converging — see seek() below.
  const [seeking, setSeeking] = createSignal(false)

  const location = useLocation()
  const navigate = useNavigate()

  const frames = new Set<number>()
  const scrollEndCleanups = new Set<() => void>()
  const queue = (fn: () => void) => {
    const id = requestAnimationFrame(() => {
      frames.delete(id)
      fn()
    })
    frames.add(id)
  }
  const cancel = () => {
    setSeeking(false)
    for (const id of frames) cancelAnimationFrame(id)
    frames.clear()
    for (const cleanup of scrollEndCleanups) cleanup()
    scrollEndCleanups.clear()
  }

  // The location hash is GLOBAL, but every kept-mounted session screen owns a
  // live instance of this hook. Only the screen on the visible workbench
  // surface may write the hash or react to it — a hidden pane's autoScroll
  // state flickers as surfaces swap, and letting it clear the hash yanks the
  // ACTIVE session to the bottom and cancels its in-flight jump.
  const surfaceHidden = () => {
    const surface = input.scroller()?.closest("[data-workbench-content]")
    return !!surface && (surface.getAttribute("aria-hidden") === "true" || surface.hasAttribute("inert"))
  }

  const clearMessageHash = () => {
    cancel()
    if (surfaceHidden()) return
    authoredHash = ""
    input.consumePendingMessage(input.sessionKey())
    if (input.pendingMessage()) input.setPendingMessage(undefined)
    if (!location.hash) return
    clearing = true
    navigate(location.pathname + location.search, { replace: true, scroll: false })
  }

  const updateHash = (id: string) => {
    const hash = `#${input.anchor(id)}`
    authoredHash = hash
    if (location.hash === hash) return
    clearing = false
    navigate(location.pathname + location.search + hash, {
      replace: true,
      scroll: false,
    })
  }

  const scrollToElement = (el: HTMLElement, behavior: ScrollBehavior, corrections = 2) => {
    const root = input.scroller()
    if (!root) return false

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    const sticky = root.querySelector("[data-session-title]")
    const stickyBottom = sticky instanceof HTMLElement ? sticky.getBoundingClientRect().bottom : b.top
    const top = sessionMessageScrollTop({
      currentScrollTop: root.scrollTop,
      rootTop: b.top,
      stickyBottom,
      targetTop: a.top,
    })
    let cleanup = () => {}
    if (corrections > 0) {
      const onScrollEnd = () => {
        cleanup()
        queue(() => {
          if (!el.isConnected) return
          const target = el.getBoundingClientRect()
          const stickyTarget = root.querySelector("[data-session-title]")
          const desired =
            (stickyTarget instanceof HTMLElement ? stickyTarget.getBoundingClientRect().bottom : b.top) +
            sessionMessageTopMargin
          if (Math.abs(target.top - desired) <= 1) return
          scrollToElement(el, behavior, corrections - 1)
        })
      }
      cleanup = () => {
        root.removeEventListener("scrollend", onScrollEnd)
        scrollEndCleanups.delete(cleanup)
      }
      scrollEndCleanups.add(cleanup)
      root.addEventListener("scrollend", onScrollEnd, { once: true })
    }
    root.scrollTo({ top, behavior })
    return true
  }

  const afterLayoutSettles = (fn: () => void, previous = "", stable = 0, left = 20) => {
    const root = input.scroller()
    if (!root || left <= 0) {
      fn()
      return
    }
    const current = `${Math.round(root.scrollTop)}:${root.scrollHeight}`
    const nextStable = current === previous ? stable + 1 : 0
    if (nextStable >= 3) {
      fn()
      return
    }
    queue(() => afterLayoutSettles(fn, current, nextStable, left - 1))
  }

  // A long jump through the virtualized timeline converges by repetition: each
  // scroll lands on the CURRENT offset estimate, nearby rows measure, and the
  // estimate improves for the next attempt. Four attempts strand a ~550k px
  // jump several thousand px short of the target with no way to recover except
  // clicking again; twelve gives geometric convergence comfortable headroom
  // while staying bounded.
  // A long jump through the virtualized timeline converges by repetition:
  // each attempt scrolls to the CURRENT offset estimate, nearby rows measure,
  // and the estimate improves for the next attempt. The error is worst for
  // end-of-list targets (nothing below the viewport is measured), where one
  // attempt closes only a turn or two — so the budget is generous and the
  // real terminator is PROGRESS: an attempt that no longer moves the viewport
  // means the estimate has converged on itself and retrying cannot help.
  const seekBudget = 40
  let seekStartTop: number | undefined
  let seekLastTop: number | undefined
  let seekStalls = 0
  // The bottom-return effect in the screen clears the message hash when the
  // viewport computes "at bottom", and clearing cancels the seek chain —
  // during a long jump the reveal and scroll anchoring transiently compute
  // exactly that, so an unguarded clear races the jump and strands it
  // mid-scroll. `seeking` lets that effect stand down while a jump converges.
  const seek = (id: string, behavior: ScrollBehavior, left = seekBudget, revealed = false): boolean => {
    if (!revealed) {
      input.revealMessage?.(id)
      afterLayoutSettles(() => seek(id, behavior, left, true))
      return false
    }
    if (left <= 0) {
      setSeeking(false)
      return false
    }
    const root = input.scroller()
    const el = document.getElementById(input.anchor(id))
    // The precise element scroll is NOT terminal: a smooth scroll through the
    // virtualized list can unmount its own target row mid-animation (the
    // mounted band shifts with measurement churn) and scrollToElement's
    // correction loop bails on a disconnected element. Verify after layout
    // settles and keep seeking if the row is gone or off-viewport.
    const settleOrReseek = () => {
      afterLayoutSettles(() => {
        const settled = document.getElementById(input.anchor(id))
        const rootBounds = input.scroller()?.getBoundingClientRect()
        if (settled && rootBounds) {
          const bounds = settled.getBoundingClientRect()
          if (bounds.bottom > rootBounds.top && bounds.top < rootBounds.bottom) {
            setSeeking(false)
            return
          }
        }
        seek(id, behavior, left - 1, true)
      })
    }
    if (left < seekBudget && el && scrollToElement(el, behavior)) {
      settleOrReseek()
      return true
    }
    if (left < seekBudget && root && seekLastTop !== undefined && Math.abs(root.scrollTop - seekLastTop) < 2 && !el) {
      // The offset estimate has converged on itself while the target row is
      // still unmounted — a repeat scroll would be a no-op that fires no
      // events, so the virtualizer never re-measures and no retry can help.
      // Walk one viewport further in the direction of travel to force the
      // next rows to mount and measure, then retry with a fresh estimate.
      seekStalls += 1
      if (seekStalls >= 4) {
        setSeeking(false)
        return false
      }
      const direction = Math.sign(root.scrollTop - (seekStartTop ?? 0)) || 1
      root.scrollBy({ top: direction * root.clientHeight, behavior: "auto" })
      seekLastTop = root.scrollTop
      afterLayoutSettles(() => seek(id, behavior, left - 1, true))
      return false
    }
    seekStalls = 0
    if (root) seekLastTop = root.scrollTop
    if (root && input.scrollToMessageOffset(id, behavior)) {
      let done = false
      let cleanup = () => {}
      const proceed = () => {
        if (done) return
        done = true
        cleanup()
        afterLayoutSettles(() => seek(id, behavior, left - 1, true))
      }
      // A zero-distance scroll (the estimate already equals the current
      // position while the target row is still unmounted) fires no scroll
      // events, so scrollend alone would strand the chain mid-jump.
      const timer = setTimeout(proceed, 800)
      const onScrollEnd = () => proceed()
      cleanup = () => {
        clearTimeout(timer)
        root.removeEventListener("scrollend", onScrollEnd)
        scrollEndCleanups.delete(cleanup)
      }
      scrollEndCleanups.add(cleanup)
      root.addEventListener("scrollend", onScrollEnd, { once: true })
      return true
    }
    if (el && scrollToElement(el, behavior)) {
      settleOrReseek()
      return true
    }
    queue(() => {
      seek(id, behavior, left - 1, true)
    })
    return false
  }

  const scrollToMessage = (message: UserMessage, behavior: ScrollBehavior = "smooth") => {
    cancel()
    seekStartTop = input.scroller()?.scrollTop
    seekLastTop = undefined
    seekStalls = 0
    setSeeking(true)
    updateHash(message.id)
    if (input.currentMessageId() !== message.id) input.setActiveMessage(message)
    seek(message.id, behavior)
  }

  const applyHash = (behavior: ScrollBehavior) => {
    const hash = location.hash.slice(1)
    if (!hash) {
      input.autoScroll.forceScrollToBottom()
      const el = input.scroller()
      if (el) input.scheduleScrollState(el)
      return
    }

    const messageId = messageIdFromHash(hash)
    if (messageId) {
      input.autoScroll.pause()
      const msg = messageById().get(messageId)
      if (msg) {
        scrollToMessage(msg, behavior)
        return
      }
      return
    }

    const target = document.getElementById(hash)
    if (target) {
      input.autoScroll.pause()
      scrollToElement(target, behavior)
      return
    }

    input.autoScroll.forceScrollToBottom()
    const el = input.scroller()
    if (el) input.scheduleScrollState(el)
  }

  // A fresh tuple, not a deduping primitive: these effects drive the
  // `authoredHash` / `clearing` / `pendingKey` latches and must see every
  // invalidation, exactly as the tracked form did. `surfaceHidden()` reads only
  // the DOM (`input.scroller()` is a plain ref, not a signal), so it stays in
  // the effect phase where it observes post-flush layout.
  createEffect(
    () => [location.hash, input.sessionID(), input.messagesReady(), seeking()] as const,
    ([hash, sessionID, ready, isSeeking]) => {
      // An EMPTY hash is the steady default, not an instruction. This effect
      // re-runs on its other dependencies (and the app's surface→URL sync
      // strips message hashes shortly after they are authored), so reacting to
      // emptiness force-scrolled the active session to the bottom at arbitrary
      // moments — including right after a message jump landed. Bottom
      // anchoring is owned by autoScroll and the session-switch restore; the
      // explicit "return to latest" flow calls scrollToEnd itself.
      if (!hash) {
        clearing = false
        authoredHash = ""
        return
      }
      if (!sessionID || !ready || surfaceHidden()) return
      if (authoredHash) {
        // The echo of our own authored hash, not an external navigation.
        const consumed = hash === authoredHash
        authoredHash = ""
        if (consumed) return
      }
      // An external hash change while our own jump is still converging must not
      // yank the scroll out from under it.
      if (isSeeking) return
      // `cancel()` clears `seeking`, which the compute reads — that write now
      // lands in the untracked phase instead of feeding this effect's own scope.
      cancel()
      queue(() => applyHash("auto"))
    },
  )

  // Self-feeding in the tracked form: the body read `pendingMessage` and then
  // wrote it (both the consume hand-off and the clear), so its own writes
  // re-entered its tracking scope. The writes now run untracked.
  createEffect(
    () =>
      [
        input.sessionID(),
        input.messagesReady(),
        visibleUserMessages(),
        input.pendingMessage(),
        input.sessionKey(),
        messageById(),
        input.currentMessageId(),
        location.hash,
      ] as const,
    ([sessionID, ready, , pendingMessage, key, byId, currentMessageId, hash]) => {
      if (!sessionID || !ready || surfaceHidden()) return

      let targetId = pendingMessage
      if (!targetId && pendingKey !== key) {
        pendingKey = key
        const next = input.consumePendingMessage(key)
        if (next) {
          input.setPendingMessage(next)
          targetId = next
        }
      }

      if (!targetId && !clearing) targetId = messageIdFromHash(authoredHash || hash)
      if (!targetId) return

      // The committed value, re-read at side-effect time exactly as the tracked
      // body did — the consume hand-off's write above is not visible until the
      // flush commits, so it must NOT be folded into this comparison. `untrack`
      // says that deliberately and keeps the strict-read diagnostic quiet.
      const pending = untrack(input.pendingMessage) === targetId
      const msg = byId.get(targetId)
      if (!msg) return

      if (pending) input.setPendingMessage(undefined)
      if (currentMessageId === targetId && !pending) return

      input.autoScroll.pause()
      cancel()
      queue(() => scrollToMessage(msg, "auto"))
    },
  )

  // Self-feeding in the tracked form: `loadMore` drives the very history state
  // (`historyLoading`, `historyMore`, the visible messages) the body subscribed
  // to. The call now runs untracked.
  createEffect(
    () =>
      [
        input.sessionID(),
        input.messagesReady(),
        visibleUserMessages(),
        input.pendingMessage(),
        messageById(),
        location.hash,
        input.historyMore(),
        input.historyLoading(),
      ] as const,
    ([sessionID, ready, , pendingMessage, byId, hash, historyMore, historyLoading]) => {
      if (!sessionID || !ready || surfaceHidden()) return

      let targetId = pendingMessage
      if (!targetId && !clearing) targetId = messageIdFromHash(authoredHash || hash)
      if (!targetId || byId.has(targetId)) return
      if (!historyMore || historyLoading) return

      void input.loadMore(sessionID)
    },
  )

  onSettled(() => {
    if (typeof window !== "undefined" && "scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual"
    }
  })

  onCleanup(() => {
    authoredHash = ""
    cancel()
  })

  return {
    clearMessageHash,
    scrollToMessage,
    applyHash,
    seeking,
  }
}
