import { afterEach, describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  addRegisteredConversationMessage,
  clearConversationChatRegistryForTest,
  registeredConversationSnapshot,
  registerSessionConversationChat,
} from "./conversation-registry"
import {
  canonicalPartMessageIds,
  hydrateConversationPage,
  resolveStoredMessages,
  resolveStoredParts,
} from "./conversation-hydrator"

afterEach(() => {
  clearConversationChatRegistryForTest()
})

const scope = (sessionID: string) => ({ directory: "/repo", sessionID })
const canonicalPage = { messageCompleteness: "canonical", partCompleteness: "canonical" } as const
const fragmentPage = { messageCompleteness: "fragment", partCompleteness: "fragment" } as const

describe("conversation hydrator", () => {
  test("an empty canonical page removes stale server messages", () => {
    expect(
      resolveStoredMessages({
        existing: [message("msg_1"), message("msg_2")],
        next: [],
        completeness: "canonical",
      }).map((item) => item.id),
    ).toEqual([])
  })

  test("prepends older pages without dropping existing messages", () => {
    expect(
      resolveStoredMessages({
        existing: [message("assistant-aa")],
        next: [message("user-zz")],
        completeness: "canonical",
        mode: "prepend",
      }).map((item) => item.id),
    ).toEqual(["user-zz", "assistant-aa"])
  })

  test("replaces the projected latest-turn window in producer order", () => {
    const resolved = resolveStoredMessages({
      existing: [message("older-zz"), message("user-zz"), message("assistant-aa")],
      next: [message("user-zz"), message("assistant-middle"), message("assistant-aa")],
      completeness: "canonical",
      mode: "replace-window",
    })
    expect(resolved.map((item) => item.id)).toEqual(["older-zz", "user-zz", "assistant-middle", "assistant-aa"])
  })

  test("merges parts by id so streamed parts survive stale snapshots", () => {
    expect(
      resolveStoredParts(
        [
          { id: "part_2", text: "streamed" },
          { id: "part_1", text: "local" },
        ],
        [
          { id: "part_2", text: "stale" },
          { id: "part_3", text: "snapshot" },
        ],
      ),
    ).toEqual([
      { id: "part_2", text: "streamed" },
      { id: "part_1", text: "local" },
      { id: "part_3", text: "snapshot" },
    ])
  })

  test("hydrates fetched rows into the conversation registry", () => {
    registerSessionConversationChat(scope("ses_1"))

    expect(
      hydrateConversationPage({
        directory: "/repo",
        ...canonicalPage,
        sessionID: "ses_1",
        rows: [{ info: message("msg_1"), parts: [part("part_1", "msg_1")] }],
      }),
    ).toBe(1)

    expect(registeredConversationSnapshot("/repo", "ses_1")).toMatchObject({
      messages: [{ id: "msg_1", sessionID: "ses_1" }],
      parts: { msg_1: [{ id: "part_1" }] },
    })
  })

  test("prunes a stale streaming part when a canonical page replaces a SETTLED message", () => {
    // The duplicate-render bug end to end. The client accumulated a
    // provisional streaming part id; the server's canonical
    // `GET /session/:id/message` then reports the persisted part alone.
    // Keeping both renders the same reply in two assistant rows
    // (`message-timeline.data.ts`'s `groupParts` renders one row per part).
    //
    // `mergeChatMessage` already treats a settled snapshot's parts as
    // authoritative, but it can only compare what the hydrator handed it: the
    // union built here arrives already carrying the stale id, so the prune
    // has nothing left to drop. This is the seam that fix did not reach.
    registerSessionConversationChat(scope("ses_1"))
    hydrateConversationPage({
      directory: "/repo",
      ...fragmentPage,
      sessionID: "ses_1",
      messages: [settledMessage("msg_1")],
      parts: [{ id: "msg_1", parts: [part("prt_stream", "msg_1")] }],
    })

    hydrateConversationPage({
      directory: "/repo",
      ...canonicalPage,
      sessionID: "ses_1",
      rows: [{ info: settledMessage("msg_1"), parts: [part("prt_final", "msg_1")] }],
    })

    expect(registeredConversationSnapshot("/repo", "ses_1").parts.msg_1?.map((item) => item.id)).toEqual(["prt_final"])
  })

  test("only a settled assistant message on a replacing rows page is canonical for parts", () => {
    // Tested directly, because end-to-end this rule is currently masked:
    // `mergeChatParts` would re-add a live part the hydrator dropped, so an
    // over-broad prune does not visibly lose text today. The rule still has
    // to hold on its own — a mid-turn refetch cannot see parts the server has
    // not persisted yet, so it is not entitled to delete them.
    const settled = settledMessage("msg_settled")
    const streaming = message("msg_streaming")
    const rows = [{ info: settled }, { info: streaming }]

    const canonical = canonicalPartMessageIds({ rows, partCompleteness: "canonical" }, [settled, streaming])
    expect([...(canonical ?? [])]).toEqual(["msg_settled"])

    // Message-list merge direction does not define part completeness. Numeric
    // and latest-turn rows are canonical even when their messages prepend.
    expect([...(canonicalPartMessageIds({ rows, partCompleteness: "canonical" }, [settled]) ?? [])]).toEqual([
      "msg_settled",
    ])
    expect(canonicalPartMessageIds({ rows, partCompleteness: "fragment" }, [settled])).toBeUndefined()
    expect(canonicalPartMessageIds({ partCompleteness: "canonical" }, [settled])).toBeUndefined()
  })

  test("keeps a live part a canonical page has not persisted yet on an UNSETTLED message", () => {
    // The direction that must never prune. Mid-turn, a REST refetch describes
    // only what the server has persisted; a part SSE delivered moments ago is
    // legitimately absent from it. Dropping it would erase text the user is
    // actively watching stream in.
    registerSessionConversationChat(scope("ses_1"))
    hydrateConversationPage({
      directory: "/repo",
      ...fragmentPage,
      sessionID: "ses_1",
      messages: [message("msg_1")],
      parts: [{ id: "msg_1", parts: [part("prt_live_new", "msg_1")] }],
    })

    hydrateConversationPage({
      directory: "/repo",
      ...canonicalPage,
      sessionID: "ses_1",
      rows: [{ info: message("msg_1"), parts: [part("prt_earlier", "msg_1")] }],
    })

    expect(registeredConversationSnapshot("/repo", "ses_1").parts.msg_1?.map((item) => item.id)).toEqual([
      "prt_live_new",
      "prt_earlier",
    ])
  })

  test("heals a duplicate that a previous session already persisted", () => {
    // The migration question. IndexedDB persistence dedupes by MESSAGE id
    // (`compactConversationSnapshot`) and never inspects parts, so a session
    // that rendered a duplicate before this fix has the duplicate on disk.
    // No migration is needed as long as the first canonical refetch after
    // reload prunes it — which is what this asserts, standing in for the
    // rehydrated-from-IDB state.
    registerSessionConversationChat(scope("ses_1"))
    hydrateConversationPage({
      directory: "/repo",
      ...fragmentPage,
      sessionID: "ses_1",
      messages: [settledMessage("msg_1")],
      parts: [{ id: "msg_1", parts: [part("prt_stale", "msg_1"), part("prt_final", "msg_1")] }],
    })

    hydrateConversationPage({
      directory: "/repo",
      ...canonicalPage,
      sessionID: "ses_1",
      rows: [{ info: settledMessage("msg_1"), parts: [part("prt_final", "msg_1")] }],
    })

    expect(registeredConversationSnapshot("/repo", "ses_1").parts.msg_1?.map((item) => item.id)).toEqual(["prt_final"])
  })

  test("canonical parts remain authoritative when their messages are prepended", () => {
    registerSessionConversationChat(scope("ses_1"))
    hydrateConversationPage({
      directory: "/repo",
      ...fragmentPage,
      sessionID: "ses_1",
      messages: [settledMessage("msg_1")],
      parts: [{ id: "msg_1", parts: [part("prt_live", "msg_1")] }],
    })

    hydrateConversationPage({
      directory: "/repo",
      ...canonicalPage,
      sessionID: "ses_1",
      rows: [{ info: settledMessage("msg_1"), parts: [part("prt_older", "msg_1")] }],
      mode: "prepend",
    })

    expect(registeredConversationSnapshot("/repo", "ses_1").parts.msg_1?.map((item) => item.id)).toEqual(["prt_older"])
  })

  test("canonical empty parts clear a settled message and shorter canonical text wins", () => {
    registerSessionConversationChat(scope("ses_1"))
    hydrateConversationPage({
      directory: "/repo",
      sessionID: "ses_1",
      ...canonicalPage,
      rows: [
        { info: settledMessage("msg_1"), parts: [{ ...part("prt_text", "msg_1"), text: "a much longer stale value" }] },
      ],
    })

    hydrateConversationPage({
      directory: "/repo",
      sessionID: "ses_1",
      ...canonicalPage,
      rows: [{ info: settledMessage("msg_1"), parts: [{ ...part("prt_text", "msg_1"), text: "short" }] }],
    })
    expect((registeredConversationSnapshot("/repo", "ses_1").parts.msg_1?.[0] as { text?: string }).text).toBe("short")

    hydrateConversationPage({
      directory: "/repo",
      sessionID: "ses_1",
      ...canonicalPage,
      rows: [{ info: settledMessage("msg_1"), parts: [] }],
    })
    expect(registeredConversationSnapshot("/repo", "ses_1").parts.msg_1).toEqual([])
  })

  test("a latest-surface fragment never prunes omitted canonical parts", () => {
    registerSessionConversationChat(scope("ses_1"))
    hydrateConversationPage({
      directory: "/repo",
      ...fragmentPage,
      sessionID: "ses_1",
      messages: [settledMessage("msg_1")],
      parts: [{ id: "msg_1", parts: [part("prt_reasoning", "msg_1")] }],
    })

    hydrateConversationPage({
      directory: "/repo",
      ...fragmentPage,
      sessionID: "ses_1",
      rows: [{ info: settledMessage("msg_1"), parts: [part("prt_text", "msg_1")] }],
    })

    expect(registeredConversationSnapshot("/repo", "ses_1").parts.msg_1?.map((item) => item.id)).toEqual([
      "prt_reasoning",
      "prt_text",
    ])
  })

  test("a latest-surface fragment overlays anchors without deleting canonical messages or parts", () => {
    const ids = ["opaque-older-z", "opaque-user-a", "opaque-middle-q", "opaque-final-b"]
    hydrateConversationPage({
      directory: "/repo",
      sessionID: "ses_1",
      ...canonicalPage,
      rows: ids.map((id) => ({
        info:
          id === ids[1] ? { ...userMessage(id), summary: { title: "canonical title", diffs: [] } } : settledMessage(id),
        parts: [part(`part-${id}`, id)],
      })),
    })

    hydrateConversationPage({
      directory: "/repo",
      sessionID: "ses_1",
      ...fragmentPage,
      rows: [
        { info: userMessage(ids[1]!), parts: [part("surface-user", ids[1]!)] },
        { info: { ...settledMessage(ids[3]!), finish: "stop" }, parts: [part("surface-final", ids[3]!)] },
      ],
    })

    const snapshot = registeredConversationSnapshot("/repo", "ses_1")
    expect(snapshot.messages.map((item) => item.id)).toEqual(ids)
    expect((snapshot.messages[1] as Extract<Message, { role: "user" }>).summary).toEqual({
      title: "canonical title",
      diffs: [],
    })
    expect(Object.fromEntries(ids.map((id) => [id, snapshot.parts[id]?.map((item) => item.id)]))).toEqual({
      "opaque-older-z": ["part-opaque-older-z"],
      "opaque-user-a": ["part-opaque-user-a", "surface-user"],
      "opaque-middle-q": ["part-opaque-middle-q"],
      "opaque-final-b": ["part-opaque-final-b", "surface-final"],
    })
  })

  test("an empty canonical page drops stale rows but keeps explicitly optimistic messages", () => {
    hydrateConversationPage({
      directory: "/repo",
      sessionID: "ses_1",
      ...canonicalPage,
      rows: [{ info: settledMessage("msg_stale"), parts: [] }],
    })
    addRegisteredConversationMessage({
      directory: "/repo",
      sessionID: "ses_1",
      message: message("msg_local"),
      parts: [],
    })

    expect(hydrateConversationPage({ directory: "/repo", sessionID: "ses_1", ...canonicalPage, rows: [] })).toBe(1)
    expect(registeredConversationSnapshot("/repo", "ses_1").messages.map((item) => item.id)).toEqual(["msg_local"])
  })
})

function settledMessage(id: string): Message {
  return { ...message(id), time: { created: 1, completed: 2 } } as Message
}

function userMessage(id: string): Message {
  return {
    id,
    role: "user",
    sessionID: "ses_1",
    time: { created: 1 },
    agent: "assistant",
    model: { modelID: "gpt-4o", providerID: "openai" },
  } as Message
}

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
