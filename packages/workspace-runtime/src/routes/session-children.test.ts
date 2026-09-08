import { describe, expect, test } from "bun:test"
import type { AgentMessage, AgentSession } from "@claxedo/agent-sdk-runtime"
import { MemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import type { RuntimeEventEnvelopeInput } from "../runtime-event-hub"
import type { CompatEnvelope } from "../compat-events"
import { permissionAsked, permissionReplied, questionAsked, questionRejected } from "../compat-events"
import { childSummary, createChildSessionHost, wakeMessageId, type ChildSessionHostInput } from "./session-children"

const DIRECTORY = "/workspace"

function assistant(id: string, text: string, error?: { name: string; data: { message?: string } }): AgentMessage {
  return {
    info: { id, role: "assistant", sessionID: "child", ...(error ? { error } : {}) },
    parts: [{ id: `${id}-text`, sessionID: "child", messageID: id, type: "text", text }],
  }
}

function harness(input: {
  sessions?: Record<string, Partial<AgentSession>>
  messages?: Record<string, AgentMessage[]>
  startTurn?: ChildSessionHostInput["startTurn"]
  subscribe?: (fn: (event: CompatEnvelope) => void) => () => void
} = {}) {
  const store = new MemoryRuntimeStore()
  const sessions = new Map<string, AgentSession>()
  for (const [id, session] of Object.entries(input.sessions ?? {})) {
    sessions.set(id, { id, directory: DIRECTORY, time: { created: 1, updated: 1 }, ...session })
  }
  const published: RuntimeEventEnvelopeInput[] = []
  const turns: Array<{ parentSessionId: string; messageID?: string; text: string; author: string }> = []
  const settle: Array<() => void> = []
  const host = createChildSessionHost({
    admission: { admit: (row) => store.admit(row), markPublished: (parent, id) => store.markPublished(parent, id) },
    secret: () => "test-secret",
    listSubagents: (parentSessionId) => store.listSubagents(parentSessionId),
    pendingWakes: () => store.listSubagents("parent")
      .filter((row) => row.wake === "pending" && row.childSessionId)
      .map((row) => ({ parentSessionId: "parent", childSessionId: row.childSessionId!, directory: DIRECTORY })),
    getSession: (sessionId) => sessions.get(sessionId) ?? null,
    getMessages: (sessionId) => input.messages?.[sessionId] ?? [],
    publishRuntime: (event) => {
      published.push(event)
    },
    ...(input.subscribe ? { subscribeGlobal: input.subscribe } : {}),
    startTurn: input.startTurn ?? (async (turn) => {
      turns.push({
        parentSessionId: turn.parentSessionId,
        messageID: turn.body.messageID,
        text: turn.body.parts?.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "",
        author: turn.author.id,
      })
      settle.push(turn.onSettled)
      return "started"
    }),
  })
  return { host, store, sessions, published, turns, settle }
}

describe("host-owned child sessions", () => {
  test("derives idempotent child ids from the secret, caller identity and request id", () => {
    const { host } = harness()
    const first = host.deriveSessionId({ callerIdentity: "parent", clientRequestId: "req-1" })
    expect(first).toBe(host.deriveSessionId({ callerIdentity: "parent", clientRequestId: "req-1" }))
    expect(first).not.toBe(host.deriveSessionId({ callerIdentity: "other-caller", clientRequestId: "req-1" }))
    expect(first).not.toBe(host.deriveSessionId({ callerIdentity: "parent", clientRequestId: "req-2" }))
    expect(first).toMatch(/^ses_[0-9a-f]{32}$/)
  })

  test("admits the created child as a pending host row the parent can list", async () => {
    const { host, store, published } = harness({ sessions: { parent: {}, child: { parentID: "parent" } } })
    const { subagentKey } = await host.admitCreated({
      parentSessionId: "parent",
      childSessionId: "child",
      directory: DIRECTORY,
      harness: "codex",
      role: "reviewer",
      title: "Consult on the plan",
    })

    expect(subagentKey).toMatch(/^subagent_/)
    expect(store.listSubagents("parent")).toMatchObject([{
      subagentKey,
      status: "pending",
      mode: "background",
      label: "Consult on the plan",
      subagentType: "reviewer",
      providerKind: "claxedo",
      providerId: "child",
      childSessionId: "child",
      transcript: { kind: "live" },
    }])
    expect(published).toMatchObject([{ directory: DIRECTORY, sessionId: "parent", payload: { type: "subagent-updated", subagentKey, status: "pending" } }])
    expect(await host.children("parent", DIRECTORY)).toMatchObject([{ subagentKey, childSessionId: "child", status: "pending" }])
    expect(await host.childOf("child", DIRECTORY)).toMatchObject({ subagentKey })
    expect(await host.activeChildren("parent", DIRECTORY)).toHaveLength(1)
  })

  test("a finished child wakes an idle parent exactly once with its summary", async () => {
    const item = harness({
      sessions: { parent: { status: "idle" }, child: { parentID: "parent" } },
      messages: { child: [assistant("m1", "The plan is sound; ship it.")] },
    })
    const { subagentKey } = await item.host.admitCreated({ parentSessionId: "parent", childSessionId: "child", directory: DIRECTORY, harness: "codex", title: "Consult" })
    await item.host.onTurnStarted("child", DIRECTORY)
    expect(item.store.listSubagents("parent")).toMatchObject([{ status: "running" }])

    await item.host.onTurnSettled("child", DIRECTORY)

    expect(item.turns).toEqual([{
      parentSessionId: "parent",
      messageID: "msg_wake_child_m1",
      text: 'Subagent "Consult" (codex) completed.\n\nThe plan is sound; ship it.',
      author: "child",
    }])
    expect(item.store.listSubagents("parent")).toMatchObject([{ subagentKey, status: "completed", wake: "delivered" }])

    await item.host.onTurnSettled("child", DIRECTORY)
    expect(item.turns).toHaveLength(1)
  })

  test("the wake turn's message id is msg_-shaped and derived from the child and its reply", () => {
    // The OpenCode engine refuses any other shape and reconciles a repeat of
    // the same id instead of opening a second turn, so this id is both the
    // admission ticket and the exactly-once key.
    expect(wakeMessageId("ses_child", "msg_reply_r")).toBe("msg_wake_ses_child_msg_reply_r")
    expect(wakeMessageId("ses_child", "msg_reply_r")).toBe(wakeMessageId("ses_child", "msg_reply_r"))
    expect(wakeMessageId("ses_child", undefined)).toBe("msg_wake_ses_child_none")
    expect(wakeMessageId("ses_child", "msg_a_r")).not.toBe(wakeMessageId("ses_child", "msg_b_r"))
    expect(wakeMessageId("ses_other", "msg_reply_r")).not.toBe(wakeMessageId("ses_child", "msg_reply_r"))
  })

  test("a busy parent holds the wake until its own turn settles", async () => {
    const parent: Partial<AgentSession> = { status: "busy" }
    const item = harness({
      sessions: { parent, child: { parentID: "parent" } },
      messages: { child: [assistant("m1", "done")] },
    })
    await item.host.admitCreated({ parentSessionId: "parent", childSessionId: "child", directory: DIRECTORY, harness: "claude" })
    await item.host.onTurnSettled("child", DIRECTORY)

    expect(item.turns).toHaveLength(0)
    expect(item.store.listSubagents("parent")).toMatchObject([{ status: "completed", wake: "pending" }])

    item.sessions.set("parent", { ...item.sessions.get("parent")!, status: "idle" })
    await item.host.onTurnSettled("parent", DIRECTORY)

    expect(item.turns).toMatchObject([{ parentSessionId: "parent", messageID: "msg_wake_child_m1" }])
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "delivered" }])
  })

  test("a wake refused as busy stays pending and is re-offered by recovery under the same message id", async () => {
    const offered: Array<string | undefined> = []
    const item = harness({
      sessions: { parent: { status: "idle" }, child: { parentID: "parent" } },
      messages: { child: [assistant("m1", "done")] },
      startTurn: async (turn) => {
        offered.push(turn.body.messageID)
        return offered.length === 1 ? "busy" : "started"
      },
    })
    await item.host.admitCreated({ parentSessionId: "parent", childSessionId: "child", directory: DIRECTORY, harness: "claude" })
    await item.host.onTurnSettled("child", DIRECTORY)
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])

    await item.host.recover()

    // Two offers, one message id: the retry is the same wake, so the engine
    // reconciles it rather than admitting a second turn for the same child.
    expect(offered).toEqual(["msg_wake_child_m1", "msg_wake_child_m1"])
    expect(item.store.listSubagents("parent")).toMatchObject([{ wake: "delivered" }])

    await item.host.recover()
    expect(offered).toHaveLength(2)
  })

  test("wakes queue behind each other: the next is offered when the wake turn settles", async () => {
    const item = harness({
      sessions: { parent: { status: "idle" }, a: { parentID: "parent" }, b: { parentID: "parent" } },
      messages: { a: [assistant("ma", "A")], b: [assistant("mb", "B")] },
    })
    await item.host.admitCreated({ parentSessionId: "parent", childSessionId: "a", directory: DIRECTORY, harness: "claude" })
    await item.host.admitCreated({ parentSessionId: "parent", childSessionId: "b", directory: DIRECTORY, harness: "claude" })
    await item.host.onTurnSettled("a", DIRECTORY)
    item.sessions.set("parent", { ...item.sessions.get("parent")!, status: "busy" })
    await item.host.onTurnSettled("b", DIRECTORY)
    expect(item.turns.map((turn) => turn.messageID)).toEqual(["msg_wake_a_ma"])

    item.sessions.set("parent", { ...item.sessions.get("parent")!, status: "idle" })
    item.settle.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(item.turns.map((turn) => turn.messageID)).toEqual(["msg_wake_a_ma", "msg_wake_b_mb"])
  })

  test("an archived parent gets an interrupted child and no wake", async () => {
    const item = harness({
      sessions: { parent: { time: { created: 1, updated: 1, archived: 5 } }, child: { parentID: "parent" } },
      messages: { child: [assistant("m1", "done")] },
    })
    await item.host.admitCreated({ parentSessionId: "parent", childSessionId: "child", directory: DIRECTORY, harness: "claude" })
    await item.host.onTurnSettled("child", DIRECTORY)

    expect(item.turns).toHaveLength(0)
    expect(item.store.listSubagents("parent")).toMatchObject([{ status: "interrupted" }])
    expect(item.store.listSubagents("parent")[0]?.wake).toBeUndefined()
  })

  test("permission and question requests on a child raise and lower the parent's attention count", async () => {
    let deliver: ((event: CompatEnvelope) => void) | undefined
    const item = harness({
      sessions: { parent: { status: "busy" }, child: { parentID: "parent" } },
      subscribe: (fn) => {
        deliver = fn
        return () => {}
      },
    })
    const { subagentKey } = await item.host.admitCreated({ parentSessionId: "parent", childSessionId: "child", directory: DIRECTORY, harness: "claude" })
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

    deliver!({ directory: DIRECTORY, payload: permissionAsked({ id: "perm-1", sessionID: "child", title: "Run tests", type: "bash", metadata: {}, time: { created: 1 } } as never) })
    await settled()
    deliver!({ directory: DIRECTORY, payload: questionAsked({ id: "q-1", sessionID: "child", questions: [] } as never) })
    await settled()
    expect(item.store.listSubagents("parent")).toMatchObject([{ subagentKey, attention: 2 }])
    expect(item.published.at(-1)).toMatchObject({ sessionId: "parent", payload: { type: "subagent-updated", attention: 2 } })

    deliver!({ directory: DIRECTORY, payload: permissionReplied("child", "perm-1", "once") })
    await settled()
    deliver!({ directory: DIRECTORY, payload: questionRejected("child", "q-1") })
    await settled()
    expect(item.store.listSubagents("parent")).toMatchObject([{ attention: 0 }])

    deliver!({ directory: DIRECTORY, payload: permissionAsked({ id: "perm-2", sessionID: "unrelated", title: "x", type: "bash", metadata: {}, time: { created: 1 } } as never) })
    await settled()
    expect(item.store.listSubagents("parent")).toMatchObject([{ attention: 0 }])
  })

  test("summarises the child's last assistant message and classifies failures", () => {
    expect(childSummary([assistant("m1", "first"), assistant("m2", "last")])).toEqual({ status: "completed", text: "last", assistantMessageId: "m2" })
    expect(childSummary([assistant("m1", "partial", { name: "UnknownError", data: { message: "boom" } })])).toEqual({
      status: "failed",
      text: "partial\n\nError: boom",
      assistantMessageId: "m1",
    })
    expect(childSummary([assistant("m1", "", { name: "MessageAbortedError", data: { message: "Aborted by user" } })])).toMatchObject({ status: "killed" })
    expect(childSummary([])).toEqual({ status: "completed", text: "" })
  })
})
