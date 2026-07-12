import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
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
})
