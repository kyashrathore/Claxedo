import { afterEach, describe, expect, test } from "bun:test"
import type { UIMessage } from "@tanstack/ai"
import { queryClient } from "@/platform/query/query-client"
import {
  conversationSnapshotKey,
  createConversationChatClient,
  readConversationSnapshot,
} from "./conversation-chat-client"

function uiMessage(id: string, content: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", content }] } as UIMessage
}

afterEach(() => {
  queryClient.removeQueries({ queryKey: ["shell", "session"] })
})

describe("createConversationChatClient", () => {
  test("rehydrates from the cached snapshot on construct", () => {
    queryClient.setQueryData(conversationSnapshotKey("ses_seed"), [uiMessage("msg_1", "hi")])
    const entry = createConversationChatClient("ses_seed")
    expect(entry.client.getMessages().map((m) => m.id)).toEqual(["msg_1"])
    expect(entry.handle.messages().map((m) => m.id)).toEqual(["msg_1"])
  })

  test("compacts duplicate cached messages on construct and write", () => {
    queryClient.setQueryData(conversationSnapshotKey("ses_dupe"), [
      uiMessage("msg_1", "stale"),
      uiMessage("msg_1", "fresh"),
    ])
    const entry = createConversationChatClient("ses_dupe")
    expect(entry.handle.messages().map((m) => m.id)).toEqual(["msg_1"])
    expect(entry.handle.messages()[0]?.parts).toEqual([{ type: "text", content: "fresh" }])

    entry.handle.setMessages([
      uiMessage("msg_2", "older"),
      uiMessage("msg_2", "newer"),
    ])
    expect(readConversationSnapshot("ses_dupe")?.map((m) => m.id)).toEqual(["msg_2"])
    expect(readConversationSnapshot("ses_dupe")?.[0]?.parts).toEqual([{ type: "text", content: "newer" }])
  })

  test("starts empty with no cached snapshot", () => {
    const entry = createConversationChatClient("ses_empty")
    expect(entry.handle.messages()).toEqual([])
  })

  test("setMessages updates client, persists to cache, and bumps version", () => {
    const entry = createConversationChatClient("ses_set")
    const before = entry.version()
    entry.handle.setMessages([uiMessage("msg_2", "yo")])
    expect(entry.handle.messages().map((m) => m.id)).toEqual(["msg_2"])
    expect(readConversationSnapshot("ses_set")?.map((m) => m.id)).toEqual(["msg_2"])
    expect(entry.version()).toBeGreaterThan(before)
  })

  test("each session gets an isolated version signal", () => {
    const a = createConversationChatClient("ses_a")
    const b = createConversationChatClient("ses_b")
    const bBefore = b.version()
    a.handle.setMessages([uiMessage("msg_a", "a")])
    expect(b.version()).toBe(bBefore)
  })
})
