import { afterEach, describe, expect, test } from "bun:test"
import type { UIMessage } from "@tanstack/ai"
import { flush } from "solid-js"
import { queryClient } from "@/platform/query/query-client"
import {
  conversationSnapshotKey,
  createConversationChatClient,
  readConversationSnapshot,
  recoveringChatClientRuntime,
} from "./conversation-chat-client"

const scope = (sessionID: string) => ({ directory: "/repo", sessionID })

function uiMessage(id: string, content: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", content }] } as UIMessage
}

afterEach(() => {
  queryClient.removeQueries({ queryKey: ["shell", "session"] })
})

describe("createConversationChatClient", () => {
  test("rehydrates from the cached snapshot on construct", () => {
    queryClient.setQueryData(conversationSnapshotKey(scope("ses_seed")), [uiMessage("msg_1", "hi")])
    const entry = createConversationChatClient(scope("ses_seed"))
    expect(entry.handle.messages().map((m) => m.id)).toEqual(["msg_1"])
  })

  test("keeps messages across the lazy ChatClient swap", async () => {
    queryClient.setQueryData(conversationSnapshotKey(scope("ses_swap")), [uiMessage("msg_1", "hi")])
    const entry = createConversationChatClient(scope("ses_swap"))
    // Buffer phase: sync reads/writes work before @tanstack/ai-client resolves.
    entry.handle.setMessages([uiMessage("msg_1", "hi"), uiMessage("msg_2", "yo")])
    await entry.ready
    // Real-client phase: the ChatClient took over with the buffered messages.
    expect(entry.handle.messages().map((m) => m.id)).toEqual(["msg_1", "msg_2"])
    const before = entry.version()
    entry.handle.setMessages([uiMessage("msg_3", "sup")])
    // `version` is a reactivity token the app only ever reads from a memo, i.e.
    // after a flush. Solid 2 stages the signal write until then.
    flush()
    expect(entry.handle.messages().map((m) => m.id)).toEqual(["msg_3"])
    expect(readConversationSnapshot(scope("ses_swap"))?.map((m) => m.id)).toEqual(["msg_3"])
    expect(entry.version()).toBeGreaterThan(before)
  })

  test("the same mounted entry recovers after its first lazy chunk load fails", async () => {
    let attempts = 0
    const loadRuntime = recoveringChatClientRuntime(
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error("chunk unavailable")
        const [clientModule, aiClientModule] = await Promise.all([
          import("@tanstack/ai-client"),
          import("@tanstack/ai/client"),
        ])
        return { ChatClient: clientModule.ChatClient, EventType: aiClientModule.EventType }
      },
      { delay: 0, maxDelay: 0 },
    )
    const entry = createConversationChatClient(scope("ses_recover"), { loadRuntime })
    entry.handle.setMessages([uiMessage("msg_1", "survives")])

    await entry.ready

    expect(attempts).toBe(2)
    expect(entry.handle.messages().map((message) => message.id)).toEqual(["msg_1"])
    expect(readConversationSnapshot(scope("ses_recover"))?.map((message) => message.id)).toEqual(["msg_1"])
  })

  test("compacts duplicate cached messages on construct and write", () => {
    queryClient.setQueryData(conversationSnapshotKey(scope("ses_dupe")), [
      uiMessage("msg_1", "stale"),
      uiMessage("msg_1", "fresh"),
    ])
    const entry = createConversationChatClient(scope("ses_dupe"))
    expect(entry.handle.messages().map((m) => m.id)).toEqual(["msg_1"])
    expect(entry.handle.messages()[0]?.parts).toEqual([{ type: "text", content: "fresh" }])

    entry.handle.setMessages([uiMessage("msg_2", "older"), uiMessage("msg_2", "newer")])
    expect(readConversationSnapshot(scope("ses_dupe"))?.map((m) => m.id)).toEqual(["msg_2"])
    expect(readConversationSnapshot(scope("ses_dupe"))?.[0]?.parts).toEqual([{ type: "text", content: "newer" }])
  })

  test("starts empty with no cached snapshot", () => {
    const entry = createConversationChatClient(scope("ses_empty"))
    expect(entry.handle.messages()).toEqual([])
  })

  test("setMessages updates client, persists to cache, and bumps version", () => {
    const entry = createConversationChatClient(scope("ses_set"))
    const before = entry.version()
    entry.handle.setMessages([uiMessage("msg_2", "yo")])
    flush()
    expect(entry.handle.messages().map((m) => m.id)).toEqual(["msg_2"])
    expect(readConversationSnapshot(scope("ses_set"))?.map((m) => m.id)).toEqual(["msg_2"])
    expect(entry.version()).toBeGreaterThan(before)
  })

  test("each session gets an isolated version signal", () => {
    const a = createConversationChatClient(scope("ses_a"))
    const b = createConversationChatClient(scope("ses_b"))
    const bBefore = b.version()
    a.handle.setMessages([uiMessage("msg_a", "a")])
    expect(b.version()).toBe(bBefore)
  })
})
