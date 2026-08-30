import { afterEach, describe, expect, test } from "bun:test"
import type { Event, Message } from "@opencode-ai/sdk/v2/client"
import type { UIMessage } from "@tanstack/ai"
import { queryClient } from "@/platform/query/query-client"
import { conversationScopeKey, conversationSnapshotKey } from "./conversation-chat-client"
import {
  addRegisteredConversationMessage as addScopedConversationMessage,
  applyRegisteredConversationEvent as applyScopedConversationEvent,
  clearConversationChatRegistryForTest,
  conversationEntryIdsForTest,
  hydrateRegisteredConversationSnapshot as hydrateScopedConversationSnapshot,
  registeredConversationHasUserMessage as scopedConversationHasUserMessage,
  registeredConversationSnapshot as scopedConversationSnapshot,
  registeredConversationUserMessages as scopedConversationUserMessages,
  registerSessionConversationChat as registerScopedConversationChat,
  removeRegisteredConversationMessage as removeScopedConversationMessage,
  revokeRegisteredSessionConversation,
  warmConversationMemorySnapshot,
} from "./conversation-registry"

const testDirectory = "/repo"
const registerSessionConversationChat = (sessionID: string, chat?: Parameters<typeof registerScopedConversationChat>[1]) =>
  registerScopedConversationChat({ directory: testDirectory, sessionID }, chat)
const applyRegisteredConversationEvent = (event: Event) => applyScopedConversationEvent({ directory: testDirectory, event })
const hydrateRegisteredConversationSnapshot = (input: Omit<Parameters<typeof hydrateScopedConversationSnapshot>[0], "directory">) =>
  hydrateScopedConversationSnapshot({ directory: testDirectory, ...input })
const registeredConversationSnapshot = (sessionID: string | undefined) => scopedConversationSnapshot(testDirectory, sessionID)
const registeredConversationUserMessages = (sessionID: string | undefined) => scopedConversationUserMessages(testDirectory, sessionID)
const registeredConversationHasUserMessage = (sessionID: string | undefined) => scopedConversationHasUserMessage(testDirectory, sessionID)
const addRegisteredConversationMessage = (input: Omit<Parameters<typeof addScopedConversationMessage>[0], "directory"> & { directory?: string }) =>
  addScopedConversationMessage({ ...input, directory: input.directory ?? testDirectory })
const removeRegisteredConversationMessage = (input: Omit<Parameters<typeof removeScopedConversationMessage>[0], "directory"> & { directory?: string }) =>
  removeScopedConversationMessage({ ...input, directory: input.directory ?? testDirectory })

function userMessage(id: string, sessionID: string): Message {
  return {
    id,
    role: "user",
    sessionID,
    time: { created: 1 },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt-4o" },
  } as Message
}

function textPart(id: string, sessionID: string, messageID: string, text: string) {
  return { id, sessionID, messageID, type: "text", text } as never
}

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

describe("conversation chat registry", () => {
  test("isolates the same session id in different directories", () => {
    const sessionID = "ses_shared"
    registerScopedConversationChat({ directory: "/repo/a", sessionID })
    registerScopedConversationChat({ directory: "/repo/b", sessionID })
    hydrateScopedConversationSnapshot({
      directory: "/repo/a",
      sessionID,
      messages: [message("msg_a", sessionID)],
      parts: {},
    })
    hydrateScopedConversationSnapshot({
      directory: "/repo/b",
      sessionID,
      messages: [message("msg_b", sessionID)],
      parts: {},
    })

    expect(scopedConversationSnapshot("/repo/a", sessionID).messages.map((item) => item.id)).toEqual(["msg_a"])
    expect(scopedConversationSnapshot("/repo/b", sessionID).messages.map((item) => item.id)).toEqual(["msg_b"])
  })

  test("applies registered conversation events to the session's owned client", () => {
    registerSessionConversationChat("ses_1")

    expect(applyRegisteredConversationEvent(event("message.updated", {
      info: message("msg_1", "ses_1"),
    }))).toBe(true)

    expect(registeredConversationSnapshot("ses_1")).toMatchObject({
      messages: [{ id: "msg_1", role: "assistant", sessionID: "ses_1" }],
      parts: { msg_1: [] },
    })
  })

  test("ignores events for sessions that were never materialized", () => {
    registerSessionConversationChat("ses_1")

    expect(applyRegisteredConversationEvent(event("message.updated", {
      info: message("msg_2", "ses_2"),
    }))).toBe(false)
  })

  test("conversation survives unmount: the client outlives the last reference", () => {
    const unregister = registerSessionConversationChat("ses_1")
    applyRegisteredConversationEvent(event("message.updated", { info: message("msg_1", "ses_1") }))

    unregister()
    // Unmounting does NOT forget the conversation — snapshot persists and live
    // events still apply, so reopening the session is instant.
    expect(registeredConversationSnapshot("ses_1")).toMatchObject({ messages: [{ id: "msg_1" }] })
    expect(applyRegisteredConversationEvent(event("message.updated", {
      info: message("msg_3", "ses_1"),
    }))).toBe(true)
    expect(registeredConversationSnapshot("ses_1").messages.map((m) => m.id)).toEqual(["msg_1", "msg_3"])
  })

  test("reports mounted and retained conversation payloads only when explicitly requested", () => {
    const unregister = registerSessionConversationChat("ses_1")
    hydrateRegisteredConversationSnapshot({
      sessionID: "ses_1",
      messages: [message("msg_1", "ses_1")],
      parts: { msg_1: [textPart("part_1", "ses_1", "msg_1", "large transcript")] },
    })

    expect(warmConversationMemorySnapshot()).toEqual([
      expect.objectContaining({ sessionId: "ses_1", mounted: true, recency: 0, messageCount: 1 }),
    ])
    expect(warmConversationMemorySnapshot()[0]!.buckets.totalBytes).toBeGreaterThan("large transcript".length)

    unregister()
    expect(warmConversationMemorySnapshot()[0]).toMatchObject({ sessionId: "ses_1", mounted: false })
  })

  test("hydrates over unstringifiable chat messages instead of overflowing equality", () => {
    const metadata: Record<string, unknown> = {}
    metadata.self = metadata
    registerSessionConversationChat("ses_1", {
      messages: () => [{
        id: "msg_1",
        role: "assistant",
        metadata,
        parts: [],
      } as UIMessage],
      setMessages: () => {},
    })

    expect(() =>
      hydrateRegisteredConversationSnapshot({
        sessionID: "ses_1",
        messages: [message("msg_1", "ses_1")],
        parts: { msg_1: [textPart("part_1", "ses_1", "msg_1", "hello")] },
      })
    ).not.toThrow()
    expect(registeredConversationSnapshot("ses_1").parts.msg_1?.map((part) => part.id)).toEqual(["part_1"])
  })

  test("exposes whether registered chat state has user messages", () => {
    registerSessionConversationChat("ses_1")

    expect(registeredConversationHasUserMessage("ses_1")).toBe(false)
    applyRegisteredConversationEvent(event("message.updated", {
      info: {
        id: "msg_user",
        role: "user",
        sessionID: "ses_1",
        time: { created: 1 },
        agent: "assistant",
        model: { providerID: "openai", modelID: "gpt-4o" },
      },
    }))

    expect(registeredConversationHasUserMessage("ses_1")).toBe(true)
    expect(registeredConversationUserMessages("ses_1")).toEqual([{ id: "msg_user", role: "user" }])
  })

  test("exposes a de-duplicated OpenCode-shaped snapshot from the owned client", () => {
    registerSessionConversationChat("ses_1")

    applyRegisteredConversationEvent(event("message.updated", {
      info: message("msg_1", "ses_1"),
    }))

    expect(registeredConversationSnapshot("ses_1")).toMatchObject({
      messages: [{ id: "msg_1", role: "assistant", sessionID: "ses_1" }],
      parts: { msg_1: [] },
    })
  })

  test("projects an unchanged session array once and invalidates only when that session changes", () => {
    registerSessionConversationChat("ses_1")
    registerSessionConversationChat("ses_2")
    applyRegisteredConversationEvent(event("message.updated", { info: message("msg_1", "ses_1") }))
    applyRegisteredConversationEvent(event("message.updated", { info: message("msg_2", "ses_2") }))

    const first = registeredConversationSnapshot("ses_1")
    expect(registeredConversationSnapshot("ses_1")).toBe(first)

    applyRegisteredConversationEvent(event("message.part.updated", {
      part: textPart("part_2", "ses_2", "msg_2", "unrelated"),
    }))
    expect(registeredConversationSnapshot("ses_1")).toBe(first)

    applyRegisteredConversationEvent(event("message.part.updated", {
      part: textPart("part_1", "ses_1", "msg_1", "changed"),
    }))
    const changed = registeredConversationSnapshot("ses_1")
    expect(changed).not.toBe(first)
    expect(changed.parts.msg_1?.[0]).toMatchObject({ id: "part_1", text: "changed" })
  })

  test("hydrates the owned client from fetched message snapshots", () => {
    registerSessionConversationChat("ses_1")

    expect(hydrateRegisteredConversationSnapshot({
      sessionID: "ses_1",
      messages: [message("msg_1", "ses_1")],
      parts: {},
    })).toBe(true)

    expect(registeredConversationSnapshot("ses_1")).toMatchObject({
      messages: [{ id: "msg_1", role: "assistant", sessionID: "ses_1" }],
    })
  })

  test("re-hydrating an unchanged snapshot is a no-op", () => {
    registerSessionConversationChat("ses_1")

    expect(hydrateRegisteredConversationSnapshot({
      sessionID: "ses_1",
      messages: [message("msg_1", "ses_1")],
      parts: {},
    })).toBe(true)

    expect(hydrateRegisteredConversationSnapshot({
      sessionID: "ses_1",
      messages: [message("msg_1", "ses_1")],
      parts: {},
    })).toBe(false)
  })

  test("retains hydrated snapshots before any chat mounts", () => {
    expect(registeredConversationSnapshot("ses_1").messages).toEqual([])
    expect(hydrateRegisteredConversationSnapshot({
      sessionID: "ses_1",
      messages: [message("msg_1", "ses_1")],
      parts: {},
    })).toBe(true)

    expect(registeredConversationSnapshot("ses_1")).toMatchObject({
      messages: [{ id: "msg_1", role: "assistant", sessionID: "ses_1" }],
    })
    expect(queryClient.getQueryData<UIMessage[]>(conversationSnapshotKey({ directory: testDirectory, sessionID: "ses_1" }))).toMatchObject([
      { id: "msg_1" },
    ])

    // Mounting after hydration sees the retained snapshot.
    registerSessionConversationChat("ses_1")
    expect(registeredConversationSnapshot("ses_1")).toMatchObject({ messages: [{ id: "msg_1" }] })
  })

  test("adds and removes optimistic messages through the owned client", () => {
    registerSessionConversationChat("ses_1")

    expect(addRegisteredConversationMessage({
      sessionID: "ses_1",
      message: {
        id: "msg_user",
        role: "user",
        sessionID: "ses_1",
        time: { created: 1 },
        agent: "assistant",
        model: { providerID: "openai", modelID: "gpt-4o" },
      } as Message,
      parts: [{
        id: "part_1",
        type: "text",
        text: "hello",
        sessionID: "ses_1",
        messageID: "msg_user",
      } as never],
    })).toBe(true)

    expect(registeredConversationSnapshot("ses_1")).toMatchObject({
      messages: [{ id: "msg_user", role: "user" }],
      parts: { msg_user: [{ id: "part_1", type: "text", text: "hello" }] },
    })

    expect(removeRegisteredConversationMessage({ sessionID: "ses_1", messageID: "msg_user" })).toBe(true)
    expect(registeredConversationSnapshot("ses_1").messages).toEqual([])
    expect(queryClient.getQueryData<UIMessage[]>(conversationSnapshotKey({ directory: testDirectory, sessionID: "ses_1" }))).toEqual([])
  })

  test("rollback does not delete a message the server already confirmed", () => {
    registerSessionConversationChat("ses_1")
    addRegisteredConversationMessage({
      sessionID: "ses_1",
      message: userMessage("msg_user", "ses_1"),
      parts: [textPart("part_1", "ses_1", "msg_user", "hello")],
    })

    // Server echoes the same message id (clears the optimistic flag).
    applyRegisteredConversationEvent(event("message.updated", { info: userMessage("msg_user", "ses_1") }))

    // A late dispatch failure must NOT remove the now-confirmed message.
    expect(removeRegisteredConversationMessage({ sessionID: "ses_1", messageID: "msg_user" })).toBe(false)
    expect(registeredConversationSnapshot("ses_1").messages.map((m) => m.id)).toEqual(["msg_user"])
  })

  test("a merged hydrate row does not confirm an optimistic message without canonical producer membership", () => {
    registerSessionConversationChat("ses_1")
    addRegisteredConversationMessage({
      sessionID: "ses_1",
      message: userMessage("msg_user", "ses_1"),
      parts: [textPart("part_1", "ses_1", "msg_user", "hello")],
    })

    // Conversation hydration carries the merged working set, including local
    // optimistic rows. The producer membership set is what distinguishes a
    // server-confirmed row from that client overlay.
    hydrateRegisteredConversationSnapshot({
      sessionID: "ses_1",
      messages: [userMessage("msg_user", "ses_1")],
      parts: { msg_user: [textPart("part_1", "ses_1", "msg_user", "hello")] },
      resolvedMembership: true,
      canonicalMessageIDs: new Set(),
    })

    expect(removeRegisteredConversationMessage({ sessionID: "ses_1", messageID: "msg_user" })).toBe(true)
    expect(registeredConversationSnapshot("ses_1").messages).toEqual([])
  })

  test("caps in-memory entries (LRU) and never evicts a mounted session", () => {
    // ses_keep is created first (would be the LRU victim) but stays mounted.
    const release = registerSessionConversationChat("ses_keep")
    for (let i = 0; i < 40; i++) {
      hydrateRegisteredConversationSnapshot({
        sessionID: `ses_${i}`,
        messages: [message(`m_${i}`, `ses_${i}`)],
        parts: {},
      })
    }

    const ids = conversationEntryIdsForTest()
    expect(ids.length).toBeLessThanOrEqual(32)
    expect(ids).toContain(conversationScopeKey({ directory: testDirectory, sessionID: "ses_keep" })) // mounted survives
    expect(ids).not.toContain(conversationScopeKey({ directory: testDirectory, sessionID: "ses_0" }))

    // Evicted data is not lost — its snapshot remains in the query cache.
    expect(queryClient.getQueryData<UIMessage[]>(conversationSnapshotKey({ directory: testDirectory, sessionID: "ses_0" }))).toBeDefined()
    release()
  })

  test("revokes every directory alias without disturbing another session", async () => {
    hydrateScopedConversationSnapshot({
      directory: "/repo/a",
      sessionID: "ses_revoked",
      messages: [message("msg_a", "ses_revoked")],
      parts: {},
    })
    hydrateScopedConversationSnapshot({
      directory: "/repo/b",
      sessionID: "ses_revoked",
      messages: [message("msg_b", "ses_revoked")],
      parts: {},
    })
    hydrateScopedConversationSnapshot({
      directory: "/repo/a",
      sessionID: "ses_keep",
      messages: [message("msg_keep", "ses_keep")],
      parts: {},
    })

    await revokeRegisteredSessionConversation("ses_revoked")

    expect(scopedConversationSnapshot("/repo/a", "ses_revoked").messages).toEqual([])
    expect(scopedConversationSnapshot("/repo/b", "ses_revoked").messages).toEqual([])
    expect(scopedConversationSnapshot("/repo/a", "ses_keep").messages.map((item) => item.id)).toEqual(["msg_keep"])
    expect(conversationEntryIdsForTest()).toEqual([conversationScopeKey({ directory: "/repo/a", sessionID: "ses_keep" })])
  })
})
