import { afterEach, describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  clearConversationChatRegistryForTest,
  registeredConversationSnapshot,
  registerSessionConversationChat,
} from "./conversation-registry"
import { hydrateConversationPage, resolveStoredMessages, resolveStoredParts } from "./conversation-hydrator"

afterEach(() => {
  clearConversationChatRegistryForTest()
})

describe("conversation hydrator", () => {
  test("keeps visible messages when a replace page is empty", () => {
    expect(resolveStoredMessages({ existing: [message("msg_1"), message("msg_2")], next: [] }).map((item) => item.id))
      .toEqual(["msg_1", "msg_2"])
  })

  test("prepends older pages without dropping existing messages", () => {
    expect(resolveStoredMessages({ existing: [message("msg_2")], next: [message("msg_1")], mode: "prepend" }).map((item) => item.id))
      .toEqual(["msg_1", "msg_2"])
  })

  test("merges parts by id so streamed parts survive stale snapshots", () => {
    expect(resolveStoredParts([{ id: "part_2", text: "streamed" }, { id: "part_1", text: "local" }], [{ id: "part_2", text: "stale" }, { id: "part_3", text: "snapshot" }]))
      .toEqual([{ id: "part_1", text: "local" }, { id: "part_2", text: "streamed" }, { id: "part_3", text: "snapshot" }])
  })

  test("hydrates fetched rows into the conversation registry", () => {
    registerSessionConversationChat("ses_1")

    expect(hydrateConversationPage({
      sessionID: "ses_1",
      rows: [{ info: message("msg_1"), parts: [part("part_1", "msg_1")] }],
    })).toBe(1)

    expect(registeredConversationSnapshot("ses_1")).toMatchObject({
      messages: [{ id: "msg_1", sessionID: "ses_1" }],
      parts: { msg_1: [{ id: "part_1" }] },
    })
  })

  test("keeps optimistic messages when a hydrate page is empty", () => {
    hydrateConversationPage({ sessionID: "ses_1", messages: [message("msg_local")] })

    expect(hydrateConversationPage({ sessionID: "ses_1", rows: [] })).toBe(1)
    expect(registeredConversationSnapshot("ses_1").messages.map((item) => item.id)).toEqual(["msg_local"])
  })
})

function message(id: string): Message {
  return {
    id,
    role: "assistant",
    sessionID: "ses_1",
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

function part(id: string, messageID: string): Part {
  return { id, type: "text", sessionID: "ses_1", messageID, text: "hello" } as Part
}
