import { afterEach, describe, expect, test } from "bun:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import type { Event, Message } from "@opencode-ai/sdk/v2/client"
import {
  applyRegisteredConversationEvent as applyScopedConversationEvent,
  clearConversationChatRegistryForTest,
  createActiveConversationSnapshot,
  hydrateRegisteredConversationSnapshot as hydrateScopedConversationSnapshot,
  registeredConversationSnapshot as scopedConversationSnapshot,
  registerSessionConversationChat as registerScopedConversationChat,
} from "./conversation-registry"

const testDirectory = "/repo"
const registerSessionConversationChat = (sessionID: string) => registerScopedConversationChat({ directory: testDirectory, sessionID })
const applyRegisteredConversationEvent = (event: Event) => applyScopedConversationEvent({ directory: testDirectory, event })
const hydrateRegisteredConversationSnapshot = (input: Omit<Parameters<typeof hydrateScopedConversationSnapshot>[0], "directory">) =>
  hydrateScopedConversationSnapshot({ directory: testDirectory, ...input })
const registeredConversationSnapshot = (sessionID: string | undefined) => scopedConversationSnapshot(testDirectory, sessionID)

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
  test("a hidden pane stays quiescent and catches up once on activation", () => {
    registerSessionConversationChat("ses_1")
    applyRegisteredConversationEvent(event("message.updated", { info: message("msg_1", "ses_1") }))
    applyRegisteredConversationEvent(event("message.part.updated", {
      part: textPart("part_1", "ses_1", "msg_1", "initial"),
    }))

    createRoot((dispose) => {
      const [active, setActive] = createSignal(true)
      const snapshot = createActiveConversationSnapshot({
        directory: () => testDirectory,
        sessionID: () => "ses_1",
        active,
      })
      let consumerRuns = 0
      const renderedText = createMemo(() => {
        consumerRuns++
        return (snapshot()?.parts.msg_1?.[0] as { text?: string } | undefined)?.text
      })

      expect(renderedText()).toBe("initial")
      expect(consumerRuns).toBe(1)

      setActive(false)
      expect(renderedText()).toBe("initial")
      expect(consumerRuns).toBe(1)

      applyRegisteredConversationEvent(event("message.part.updated", {
        part: textPart("part_1", "ses_1", "msg_1", "hidden update one"),
      }))
      applyRegisteredConversationEvent(event("message.part.updated", {
        part: textPart("part_1", "ses_1", "msg_1", "hidden update two"),
      }))
      expect(renderedText()).toBe("initial")
      expect(consumerRuns).toBe(1)

      setActive(true)
      expect(renderedText()).toBe("hidden update two")
      expect(consumerRuns).toBe(2)

      // Reading the caught-up pane again is stable; the two hidden events were
      // coalesced into one canonical activation update.
      expect(renderedText()).toBe("hidden update two")
      expect(consumerRuns).toBe(2)
      dispose()
    })
  })

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
      expect(applyRegisteredConversationEvent(event("message.updated", { info: message("msg_1", "ses_a") }))).toBe(true)
      expect(registeredConversationSnapshot("ses_a").messages).toHaveLength(1)

      // A's reader recomputes; B's reader stays cached (per-session signal,
      // not a global version counter).
      expect(a()).toBe(1)
      expect(runsA).toBe(2)
      expect(b()).toBe(0)
      expect(runsB).toBe(1)

      dispose()
    })
  })

  // The timeline's per-message row memos (message-timeline.tsx) gate on the
  // OBJECT IDENTITY of each message's projected Message and Part[] — that is
  // what keeps a streaming part event from re-running constructMessageRows for
  // every turn. This pins the contract that identity holds: a part update to
  // one message must not mint new Message/Part[] objects for other messages.
  test("a part update keeps the untouched messages' Message and Part[] identities", () => {
    registerSessionConversationChat("ses_1")
    hydrateRegisteredConversationSnapshot({
      sessionID: "ses_1",
      messages: [message("msg_a", "ses_1"), message("msg_b", "ses_1")],
      parts: {
        msg_a: [textPart("part_a1", "ses_1", "msg_a", "settled turn")],
        msg_b: [textPart("part_b1", "ses_1", "msg_b", "streaming turn")],
      },
    })

    const before = registeredConversationSnapshot("ses_1")
    applyRegisteredConversationEvent(event("message.part.updated", {
      part: { id: "part_b1", sessionID: "ses_1", messageID: "msg_b", type: "text", text: "streaming turn grows" },
    }))
    const after = registeredConversationSnapshot("ses_1")

    // The streamed message re-projects…
    expect(after.parts.msg_b?.[0]).toMatchObject({ text: "streaming turn grows" })
    // …while the untouched message keeps both its Message and Part[] identity.
    const beforeA = before.messages.find((item) => item.id === "msg_a")
    const afterA = after.messages.find((item) => item.id === "msg_a")
    expect(afterA).toBe(beforeA as never)
    expect(after.parts.msg_a).toBe(before.parts.msg_a as never)
  })
})

function textPart(id: string, sessionID: string, messageID: string, text: string) {
  return { id, sessionID, messageID, type: "text", text } as never
}
