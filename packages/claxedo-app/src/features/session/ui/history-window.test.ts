import { describe, expect, test } from "bun:test"
import { createRoot, createSignal, flush } from "solid-js"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createSessionHistoryWindow } from "./history-window"

function userMessage(index: number): UserMessage {
  return {
    id: `m-${index.toString().padStart(2, "0")}`,
    sessionID: "s-1",
    role: "user",
    time: { created: index },
    agent: "build",
    model: { providerID: "opencode", modelID: "model-1" },
  }
}

function userMessages(count: number) {
  return Array.from({ length: count }, (_, index) => userMessage(index + 1))
}

function ids(messages: UserMessage[]) {
  return messages.map((message) => message.id)
}

describe("createSessionHistoryWindow", () => {
  test("bounds initial rendering to recent user turns", () => {
    const root = createRoot((dispose) => {
      const [messages] = createSignal(userMessages(12))
      return {
        dispose,
        historyWindow: createSessionHistoryWindow({
          sessionID: () => "s-1",
          messagesReady: () => true,
          visibleUserMessages: messages,
          historyMore: () => false,
          historyLoading: () => false,
          loadMore: async () => undefined,
          userScrolled: () => false,
          scroller: () => undefined,
        }),
      }
    })

    flush()
    expect(root.historyWindow.turnStart()).toBe(8)
    flush()
    expect(ids(root.historyWindow.renderedUserMessages())).toEqual(["m-09", "m-10", "m-11", "m-12"])

    root.dispose()
  })

  // Hydration does not deliver every turn in one tick: `messagesReady` can flip
  // while the timeline still holds the first turn alone. Committing the window
  // at that instant pinned `turnStart` to 0 AND claimed the session, after which
  // the memo returned 0 forever — so the rest of the history landed in a
  // permanently un-windowed timeline (every turn painted at once) until a full
  // page reload. The window has to engage when the turns actually arrive.
  test("engages the window when history arrives after messagesReady flips", async () => {
    const root = createRoot((dispose) => {
      const [messages, setMessages] = createSignal(userMessages(1))
      // Starts false and flips true while only the first turn is present — the
      // transition this effect keys on, and the one hydration actually produces.
      const [ready, setReady] = createSignal(false)
      return {
        dispose,
        setMessages,
        setReady,
        historyWindow: createSessionHistoryWindow({
          sessionID: () => "s-1",
          messagesReady: ready,
          visibleUserMessages: messages,
          historyMore: () => false,
          historyLoading: () => false,
          loadMore: async () => undefined,
          userScrolled: () => false,
          scroller: () => undefined,
        }),
      }
    })

    // `messagesReady` flips while the timeline still holds one turn.
    root.setReady(true)

    // Only the first turn has hydrated: nothing to window yet. Solid 2 stages
    // the store and signal writes above until the scheduler flushes; the
    // timeline reads this window from memos, i.e. after a flush.
    flush()
    expect(root.historyWindow.turnStart()).toBe(0)

    // The remaining turns land a tick later.
    root.setMessages(userMessages(12))

    flush()
    expect(root.historyWindow.turnStart()).toBe(8)
    flush()
    expect(ids(root.historyWindow.renderedUserMessages())).toEqual(["m-09", "m-10", "m-11", "m-12"])

    root.dispose()
  })

  test("reveals cached turns when the viewport still needs history", async () => {
    const loadCalls: string[] = []
    const root = createRoot((dispose) => {
      const [messages] = createSignal(userMessages(12))
      return {
        dispose,
        historyWindow: createSessionHistoryWindow({
          sessionID: () => "s-1",
          messagesReady: () => true,
          visibleUserMessages: messages,
          historyMore: () => false,
          historyLoading: () => false,
          loadMore: async (sessionID) => {
            loadCalls.push(sessionID)
          },
          userScrolled: () => false,
          scroller: () => undefined,
        }),
      }
    })

    await root.historyWindow.loadAndReveal()

    flush()
    expect(root.historyWindow.turnStart()).toBe(0)
    flush()
    expect(ids(root.historyWindow.renderedUserMessages())).toEqual(ids(userMessages(12)))
    expect(loadCalls).toEqual([])

    root.dispose()
  })

  test("wraps cached backfill in the timeline's stable-row anchor transaction", () => {
    const events: string[] = []
    const root = createRoot((dispose) => {
      const [messages] = createSignal(userMessages(12))
      const [userScrolled, setUserScrolled] = createSignal(false)
      const scroller = document.createElement("div")
      scroller.scrollTop = 0
      return {
        dispose,
        setUserScrolled,
        historyWindow: createSessionHistoryWindow({
          sessionID: () => "s-1",
          messagesReady: () => true,
          visibleUserMessages: messages,
          historyMore: () => false,
          historyLoading: () => false,
          loadMore: async () => undefined,
          userScrolled,
          scroller: () => scroller,
          onBeforeReveal: () => events.push("capture"),
          onAfterReveal: () => events.push("restore"),
        }),
      }
    })

    root.setUserScrolled(true)
    root.historyWindow.onScrollerScroll()

    flush()
    expect(root.historyWindow.turnStart()).toBe(0)
    expect(events).toEqual(["capture", "restore"])
    root.dispose()
  })

  test("prefetches older history near the first cached turn", () => {
    const loadCalls: string[] = []
    const root = createRoot((dispose) => {
      const [messages] = createSignal(userMessages(12))
      const [userScrolled, setUserScrolled] = createSignal(false)
      const scroller = document.createElement("div")
      scroller.scrollTop = 0

      return {
        dispose,
        historyWindow: createSessionHistoryWindow({
          sessionID: () => "s-1",
          messagesReady: () => true,
          visibleUserMessages: messages,
          historyMore: () => true,
          historyLoading: () => false,
          loadMore: async (sessionID) => {
            loadCalls.push(sessionID)
          },
          userScrolled,
          scroller: () => scroller,
        }),
        setUserScrolled,
      }
    })

    root.setUserScrolled(true)
    root.historyWindow.onScrollerScroll()

    flush()
    expect(root.historyWindow.turnStart()).toBe(0)
    expect(loadCalls).toEqual(["s-1"])

    root.dispose()
  })
})
