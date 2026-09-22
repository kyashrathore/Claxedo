import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { AgentUserMessage as UserMessage } from "@claxedo/agent-runtime-contract"
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

    expect(root.historyWindow.turnStart()).toBe(8)
    expect(ids(root.historyWindow.renderedUserMessages())).toEqual([
      "m-09",
      "m-10",
      "m-11",
      "m-12",
    ])

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

    // Only the first turn has hydrated: nothing to window yet.
    expect(root.historyWindow.turnStart()).toBe(0)

    // The remaining turns land a tick later.
    root.setMessages(userMessages(12))

    expect(root.historyWindow.turnStart()).toBe(8)
    expect(ids(root.historyWindow.renderedUserMessages())).toEqual([
      "m-09",
      "m-10",
      "m-11",
      "m-12",
    ])

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

    expect(root.historyWindow.turnStart()).toBe(0)
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

    expect(root.historyWindow.turnStart()).toBe(0)
    expect(loadCalls).toEqual(["s-1"])

    root.dispose()
  })

  test("a prefetch that lands after a backfill moved the window keeps the fetched turns hidden", async () => {
    const older = Array.from({ length: 10 }, (_, index) => ({ ...userMessage(index + 1), id: `older-${index + 1}` }))
    const root = createRoot((dispose) => {
      const [messages, setMessages] = createSignal(userMessages(12))
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
          historyMore: () => true,
          historyLoading: () => false,
          loadMore: async () => {
            await Promise.resolve()
            setMessages([...older, ...messages()])
          },
          userScrolled,
          scroller: () => scroller,
        }),
      }
    })

    root.setUserScrolled(true)
    root.historyWindow.onScrollerScroll()
    expect(root.historyWindow.turnStart()).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ids(root.historyWindow.renderedUserMessages())).toEqual(ids(userMessages(12)))
    expect(root.historyWindow.hiddenTurnCount()).toBe(10)
    root.dispose()
  })

  test("turnInit 1 renders only the last turn", () => {
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
          turnInit: 1,
        }),
      }
    })

    expect(root.historyWindow.turnStart()).toBe(11)
    expect(ids(root.historyWindow.renderedUserMessages())).toEqual(["m-12"])
    expect(root.historyWindow.hiddenTurnCount()).toBe(11)

    root.dispose()
  })

  test("collapseToLastTurn sets turnStart to the last index and hiddenTurnCount to n-1", () => {
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

    root.historyWindow.setTurnStart(0)
    expect(root.historyWindow.hiddenTurnCount()).toBe(0)

    root.historyWindow.collapseToLastTurn()

    expect(root.historyWindow.turnStart()).toBe(11)
    expect(root.historyWindow.hiddenTurnCount()).toBe(11)
    expect(ids(root.historyWindow.renderedUserMessages())).toEqual(["m-12"])

    root.dispose()
  })

  test("a live turnInit re-sizes the uncommitted window and the commit reads it", () => {
    const root = createRoot((dispose) => {
      const [messages, setMessages] = createSignal(userMessages(1))
      const [ready, setReady] = createSignal(false)
      const [turnInit, setTurnInit] = createSignal(4)
      return {
        dispose,
        setMessages,
        setReady,
        setTurnInit,
        historyWindow: createSessionHistoryWindow({
          sessionID: () => "s-1",
          messagesReady: ready,
          visibleUserMessages: messages,
          historyMore: () => false,
          historyLoading: () => false,
          loadMore: async () => undefined,
          userScrolled: () => false,
          scroller: () => undefined,
          turnInit,
        }),
      }
    })

    // The pane floats before its history lands: the derived window follows.
    root.setTurnInit(1)
    root.setMessages(userMessages(12))
    expect(root.historyWindow.turnStart()).toBe(11)
    expect(ids(root.historyWindow.renderedUserMessages())).toEqual(["m-12"])

    // The commit uses the live value, not the one the window was created with.
    root.setReady(true)
    expect(root.historyWindow.turnStart()).toBe(11)
    root.setMessages(userMessages(13))
    expect(root.historyWindow.turnStart()).toBe(11)
    expect(ids(root.historyWindow.renderedUserMessages())).toEqual(["m-12", "m-13"])

    root.dispose()
  })

  test("resetToInitialWindow returns a collapsed window to the first-paint window", () => {
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

    root.historyWindow.collapseToLastTurn()
    expect(root.historyWindow.turnStart()).toBe(11)

    root.historyWindow.resetToInitialWindow()

    expect(root.historyWindow.turnStart()).toBe(8)
    expect(ids(root.historyWindow.renderedUserMessages())).toEqual(["m-09", "m-10", "m-11", "m-12"])

    root.dispose()
  })

  test("restoreWindow puts back the window captured before a collapse; an uncommitted window resets", () => {
    const root = createRoot((dispose) => {
      const [messages, setMessages] = createSignal(userMessages(12))
      const [sessionID, setSessionID] = createSignal("s-1")
      return {
        dispose,
        setMessages,
        setSessionID,
        historyWindow: createSessionHistoryWindow({
          sessionID,
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

    // Nothing committed yet: the first-paint window is derived, not captured.
    expect(root.historyWindow.captureWindow()).toBeUndefined()
    root.historyWindow.collapseToLastTurn()
    root.historyWindow.restoreWindow(undefined)
    expect(root.historyWindow.turnStart()).toBe(8)

    // The user revealed everything, floated, and came back.
    root.historyWindow.setTurnStart(0)
    const revealed = root.historyWindow.captureWindow()
    expect(revealed).toEqual({ sessionID: "s-1", turnStart: 0 })
    root.historyWindow.collapseToLastTurn()
    expect(root.historyWindow.turnStart()).toBe(11)
    root.historyWindow.restoreWindow(revealed)
    expect(root.historyWindow.turnStart()).toBe(0)
    expect(ids(root.historyWindow.renderedUserMessages())).toHaveLength(12)

    // A window from another session is not this session's to restore.
    root.historyWindow.setTurnStart(5)
    const other = root.historyWindow.captureWindow()
    root.setSessionID("s-2")
    root.historyWindow.restoreWindow(other)
    expect(root.historyWindow.turnStart()).toBe(8)

    root.dispose()
  })

  test("resetToInitialWindow leaves a short list uncommitted so later history still windows", () => {
    const root = createRoot((dispose) => {
      const [messages, setMessages] = createSignal(userMessages(2))
      return {
        dispose,
        setMessages,
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

    root.historyWindow.collapseToLastTurn()
    expect(root.historyWindow.turnStart()).toBe(1)

    root.historyWindow.resetToInitialWindow()
    expect(root.historyWindow.turnStart()).toBe(0)

    // Had the reset committed a zero window, this history would render un-windowed.
    root.setMessages(userMessages(12))
    expect(root.historyWindow.turnStart()).toBe(8)

    root.dispose()
  })

  test("loadAndReveal(0) pages server history when the local list is shorter", async () => {
    const events: string[] = []
    const root = createRoot((dispose) => {
      // The session holds 12 turns; the client has hydrated the last 4.
      const [messages, setMessages] = createSignal(userMessages(12).slice(8))
      const [more, setMore] = createSignal(true)
      return {
        dispose,
        historyWindow: createSessionHistoryWindow({
          sessionID: () => "s-1",
          messagesReady: () => true,
          visibleUserMessages: messages,
          historyMore: more,
          historyLoading: () => false,
          loadMore: async (sessionID) => {
            events.push(`load:${sessionID}`)
            setMessages(userMessages(12))
            setMore(false)
          },
          userScrolled: () => false,
          scroller: () => undefined,
          onBeforeLoad: () => events.push("load-capture"),
          onAfterLoad: () => events.push("load-restore"),
          onBeforeReveal: () => events.push("capture"),
          onAfterReveal: () => events.push("restore"),
          turnInit: 1,
        }),
      }
    })

    expect(root.historyWindow.hiddenTurnCount()).toBe(3)

    await root.historyWindow.loadAndReveal(0)

    expect(events).toEqual(["capture", "restore", "load-capture", "load:s-1", "load-restore"])
    expect(root.historyWindow.turnStart()).toBe(0)
    expect(root.historyWindow.hiddenTurnCount()).toBe(0)
    expect(ids(root.historyWindow.renderedUserMessages())).toEqual(ids(userMessages(12)))

    root.dispose()
  })

  test("autoFill false leaves hidden turns to the explicit reveal but still pages once nothing is hidden", () => {
    const loadCalls: string[] = []
    const root = createRoot((dispose) => {
      const [messages] = createSignal(userMessages(12))
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
          userScrolled: () => true,
          scroller: () => scroller,
          turnInit: 1,
          autoFill: false,
        }),
      }
    })

    root.historyWindow.onScrollerScroll()
    expect(root.historyWindow.turnStart()).toBe(11)
    expect(loadCalls).toEqual([])

    root.historyWindow.setTurnStart(0)
    root.historyWindow.onScrollerScroll()
    expect(loadCalls).toEqual(["s-1"])

    root.dispose()
  })
})
