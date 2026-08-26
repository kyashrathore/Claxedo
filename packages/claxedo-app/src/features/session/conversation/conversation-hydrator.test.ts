import { afterEach, describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
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

describe("conversation hydrator", () => {
  test("keeps visible messages when a replace page is empty", () => {
    expect(
      resolveStoredMessages({ existing: [message("msg_1"), message("msg_2")], next: [] }).map((item) => item.id),
    ).toEqual(["msg_1", "msg_2"])
  })

  test("prepends older pages without dropping existing messages", () => {
    expect(
      resolveStoredMessages({ existing: [message("msg_2")], next: [message("msg_1")], mode: "prepend" }).map(
        (item) => item.id,
      ),
    ).toEqual(["msg_1", "msg_2"])
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
      { id: "part_1", text: "local" },
      { id: "part_2", text: "streamed" },
      { id: "part_3", text: "snapshot" },
    ])
  })

  test("hydrates fetched rows into the conversation registry", () => {
    registerSessionConversationChat("ses_1")

    expect(
      hydrateConversationPage({
        sessionID: "ses_1",
        rows: [{ info: message("msg_1"), parts: [part("part_1", "msg_1")] }],
      }),
    ).toBe(1)

    expect(registeredConversationSnapshot("ses_1")).toMatchObject({
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
    registerSessionConversationChat("ses_1")
    hydrateConversationPage({
      sessionID: "ses_1",
      messages: [settledMessage("msg_1")],
      parts: [{ id: "msg_1", parts: [part("prt_stream", "msg_1")] }],
    })

    hydrateConversationPage({
      sessionID: "ses_1",
      rows: [{ info: settledMessage("msg_1"), parts: [part("prt_final", "msg_1")] }],
    })

    expect(registeredConversationSnapshot("ses_1").parts.msg_1?.map((item) => item.id)).toEqual(["prt_final"])
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

    const canonical = canonicalPartMessageIds({ rows }, [settled, streaming])
    expect([...(canonical ?? [])]).toEqual(["msg_settled"])

    // A prepended history page and a prefetch seed are fragments: neither is
    // ever entitled to prune, regardless of settled state.
    expect(canonicalPartMessageIds({ rows, mode: "prepend" }, [settled])).toBeUndefined()
    expect(canonicalPartMessageIds({}, [settled])).toBeUndefined()
  })

  test("keeps a live part a canonical page has not persisted yet on an UNSETTLED message", () => {
    // The direction that must never prune. Mid-turn, a REST refetch describes
    // only what the server has persisted; a part SSE delivered moments ago is
    // legitimately absent from it. Dropping it would erase text the user is
    // actively watching stream in.
    registerSessionConversationChat("ses_1")
    hydrateConversationPage({
      sessionID: "ses_1",
      messages: [message("msg_1")],
      parts: [{ id: "msg_1", parts: [part("prt_live_new", "msg_1")] }],
    })

    hydrateConversationPage({
      sessionID: "ses_1",
      rows: [{ info: message("msg_1"), parts: [part("prt_earlier", "msg_1")] }],
    })

    expect(registeredConversationSnapshot("ses_1").parts.msg_1?.map((item) => item.id)).toEqual([
      "prt_earlier",
      "prt_live_new",
    ])
  })

  test("heals a duplicate that a previous session already persisted", () => {
    // The migration question. IndexedDB persistence dedupes by MESSAGE id
    // (`compactConversationSnapshot`) and never inspects parts, so a session
    // that rendered a duplicate before this fix has the duplicate on disk.
    // No migration is needed as long as the first canonical refetch after
    // reload prunes it — which is what this asserts, standing in for the
    // rehydrated-from-IDB state.
    registerSessionConversationChat("ses_1")
    hydrateConversationPage({
      sessionID: "ses_1",
      messages: [settledMessage("msg_1")],
      parts: [{ id: "msg_1", parts: [part("prt_stale", "msg_1"), part("prt_final", "msg_1")] }],
    })

    hydrateConversationPage({
      sessionID: "ses_1",
      rows: [{ info: settledMessage("msg_1"), parts: [part("prt_final", "msg_1")] }],
    })

    expect(registeredConversationSnapshot("ses_1").parts.msg_1?.map((item) => item.id)).toEqual(["prt_final"])
  })

  test("does not prune when an older history page is prepended", () => {
    // A `prepend` page is a fragment of older history, not a statement about
    // the current message's parts — pruning against it would delete the live
    // turn the user is watching.
    registerSessionConversationChat("ses_1")
    hydrateConversationPage({
      sessionID: "ses_1",
      messages: [settledMessage("msg_1")],
      parts: [{ id: "msg_1", parts: [part("prt_live", "msg_1")] }],
    })

    hydrateConversationPage({
      sessionID: "ses_1",
      rows: [{ info: settledMessage("msg_1"), parts: [part("prt_older", "msg_1")] }],
      mode: "prepend",
    })

    expect(registeredConversationSnapshot("ses_1").parts.msg_1?.map((item) => item.id)).toEqual([
      "prt_live",
      "prt_older",
    ])
  })

  test("keeps optimistic messages when a hydrate page is empty", () => {
    hydrateConversationPage({ sessionID: "ses_1", messages: [message("msg_local")] })

    expect(hydrateConversationPage({ sessionID: "ses_1", rows: [] })).toBe(1)
    expect(registeredConversationSnapshot("ses_1").messages.map((item) => item.id)).toEqual(["msg_local"])
  })
})

function settledMessage(id: string): Message {
  return { ...message(id), time: { created: 1, completed: 2 } } as Message
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
