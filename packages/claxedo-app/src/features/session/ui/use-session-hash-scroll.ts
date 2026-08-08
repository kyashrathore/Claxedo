import type { UserMessage } from "@opencode-ai/sdk/v2"
import { useLocation, useNavigate } from "@solidjs/router"
import { createEffect, createMemo, onCleanup, onMount } from "solid-js"
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
    for (const id of frames) cancelAnimationFrame(id)
    frames.clear()
    for (const cleanup of scrollEndCleanups) cleanup()
    scrollEndCleanups.clear()
  }

  const clearMessageHash = () => {
    cancel()
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

  const seek = (id: string, behavior: ScrollBehavior, left = 4, revealed = false): boolean => {
    if (!revealed) {
      input.revealMessage?.(id)
      afterLayoutSettles(() => seek(id, behavior, left, true))
      return false
    }
    if (left <= 0) return false
    const root = input.scroller()
    const el = document.getElementById(input.anchor(id))
    if (left < 4 && el && scrollToElement(el, behavior)) return true
    if (root && input.scrollToMessageOffset(id, behavior)) {
      let cleanup = () => {}
      const onScrollEnd = () => {
        cleanup()
        afterLayoutSettles(() => seek(id, behavior, left - 1, true))
      }
      cleanup = () => {
        root.removeEventListener("scrollend", onScrollEnd)
        scrollEndCleanups.delete(cleanup)
      }
      scrollEndCleanups.add(cleanup)
      root.addEventListener("scrollend", onScrollEnd, { once: true })
      return true
    }
    if (el && scrollToElement(el, behavior)) return true
    queue(() => {
      seek(id, behavior, left - 1, true)
    })
    return false
  }

  const scrollToMessage = (message: UserMessage, behavior: ScrollBehavior = "smooth") => {
    cancel()
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

  createEffect(() => {
    const hash = location.hash
    if (!hash) clearing = false
    if (!input.sessionID() || !input.messagesReady()) return
    if (authoredHash && authoredHash === hash) {
      authoredHash = ""
      return
    }
    authoredHash = ""
    cancel()
    queue(() => applyHash("auto"))
  })

  createEffect(() => {
    if (!input.sessionID() || !input.messagesReady()) return

    visibleUserMessages()

    let targetId = input.pendingMessage()
    if (!targetId) {
      const key = input.sessionKey()
      if (pendingKey !== key) {
        pendingKey = key
        const next = input.consumePendingMessage(key)
        if (next) {
          input.setPendingMessage(next)
          targetId = next
        }
      }
    }

    if (!targetId && !clearing) targetId = messageIdFromHash(authoredHash || location.hash)
    if (!targetId) return

    const pending = input.pendingMessage() === targetId
    const msg = messageById().get(targetId)
    if (!msg) return

    if (pending) input.setPendingMessage(undefined)
    if (input.currentMessageId() === targetId && !pending) return

    input.autoScroll.pause()
    cancel()
    queue(() => scrollToMessage(msg, "auto"))
  })

  createEffect(() => {
    const sessionID = input.sessionID()
    if (!sessionID || !input.messagesReady()) return

    visibleUserMessages()

    let targetId = input.pendingMessage()
    if (!targetId && !clearing) targetId = messageIdFromHash(authoredHash || location.hash)
    if (!targetId) return
    if (messageById().has(targetId)) return
    if (!input.historyMore() || input.historyLoading()) return

    void input.loadMore(sessionID)
  })

  onMount(() => {
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
  }
}
