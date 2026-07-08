import { afterEach, describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import type { Event, Message } from "@opencode-ai/sdk/v2/client"
import {
  applyRegisteredConversationEvent,
  clearConversationChatRegistryForTest,
  registeredConversationSnapshot,
  registerSessionConversationChat,
} from "./conversation-registry"

function event(type: string, properties: Record<string, unknown>): Event {
  return { type, properties } as Event
}

function message(id: string, sessionID: string): Message {
  return {
    id,
    role: "assistant",
    sessionID,
    time: { created: 1 },
    parentID: "msg_user",
    modelID: "gpt-4o",
    providerID: "openai",
    mode: "chat",
    agent: "assistant",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as Message
}

afterEach(() => {
  clearConversationChatRegistryForTest()
})

describe("conversation registry reactivity", () => {
  test("a stream in session A does not invalidate session B's reader", () => {
    // Materialize both sessions BEFORE building the memos so the one-time
    // entry-creation topology bump does not confound the measurement.
    registerSessionConversationChat("ses_a")
    registerSessionConversationChat("ses_b")

    createRoot((dispose) => {
      let runsA = 0
      let runsB = 0
      const a = createMemo(() => {
        runsA++
        return registeredConversationSnapshot("ses_a").messages.length
      })
      const b = createMemo(() => {
        runsB++
        return registeredConversationSnapshot("ses_b").messages.length
      })

      // Prime both memos.
      a()
      b()
      expect(runsA).toBe(1)
      expect(runsB).toBe(1)

      // A receives a streamed message.
      applyRegisteredConversationEvent(event("message.updated", { info: message("msg_1", "ses_a") }))

      // A's reader recomputes; B's reader stays cached (per-session signal,
      // not a global version counter).
      expect(a()).toBe(1)
      expect(runsA).toBe(2)
      expect(b()).toBe(0)
      expect(runsB).toBe(1)

      dispose()
    })
  })
})
