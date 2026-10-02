import { hmacChildSessionId } from "../test-support/child-identity"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, test } from "bun:test"
import type { AgentMessage, AgentSession, AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import type { SessionTurnOrigin } from "../session-access-policy"
import type { RuntimeStore } from "../store"
import { openTestRuntimeStore } from "../test-support/store"
import { HOST_CHILD_PROVIDER_KIND, childSummary, createChildSessionHost, hostChildRow, wakeMessageId, type ChildSessionHostInput } from "./session-children"
import { permissionAsked, questionAsked } from "../projection/presentation-events"

const DIRECTORY = "/workspace"

const opened: Array<{ store: RuntimeStore; root: string }> = []

afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.store.close()
    rmSync(entry.root, { recursive: true, force: true })
  }
})

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "wr-child-host-"))
  const store = openTestRuntimeStore(root)
  opened.push({ store, root })
  return store
}

function assistant(id: string, text: string, error?: { name: string; data: { message?: string } }, parentID?: string): AgentMessage {
  return {
    info: { id, role: "assistant", sessionID: "child", ...(error ? { error } : {}), ...(parentID ? { parentID } : {}) },
    parts: [{ id: `${id}-text`, sessionID: "child", messageID: id, type: "text", text }],
  }
}

function harness(input: {
  sessions?: Record<string, Partial<AgentSession>>
  messages?: Record<string, AgentMessage[]>
  startTurn?: ChildSessionHostInput["startTurn"]
  subscribe?: (fn: (event: AgentEventEnvelope) => void) => () => void
  /** Durable state a "restart" keeps: pass both to rebuild a host over them. */
  store?: RuntimeStore
  origins?: Map<string, SessionTurnOrigin>
  /** Runs inside the origin write, where a racing caller would land. */
  onRecord?: () => Promise<void>
  getSession?: ChildSessionHostInput["getSession"]
} = {}) {
  const store = input.store ?? openStore()
  const origins = input.origins ?? new Map<string, SessionTurnOrigin>()
  const sessions = new Map<string, AgentSession>()
  for (const [id, session] of Object.entries(input.sessions ?? {})) {
    sessions.set(id, { id, directory: DIRECTORY, time: { created: 1, updated: 1 }, ...session })
    if (!session.parentID && !store.getSession(id)) {
      store.bindSession({ owner: { kind: "machine-owner" }, sessionId: id, directory: DIRECTORY, agentSessionId: id })
    }
  }
  /** Every observation the host asked the broker to admit, in order; the broker publishes what it admits. */
  const admitted: Array<{ parentSessionId: string; event: SubagentUpdatedEvent }> = []
  const turns: Array<{
    parentSessionId: string
    messageID?: string
    text: string
    author: string
    origin?: SessionTurnOrigin
  }> = []
  const settle: Array<() => void> = []
  const originKey = (parentSessionId: string, subagentKey: string) => `${parentSessionId}\0${subagentKey}`
  const host = createChildSessionHost({
    admit: async (parentSessionId, observation) => {
      const row = store.admit({ parentSessionId, observation, allocateKey: () => `subagent_${randomUUID()}` })
      if (!row.published) store.markPublished(parentSessionId, row.observationId)
      admitted.push({ parentSessionId, event: row.event })
      return row.event
    },
    deriveSessionId: (identity) => hmacChildSessionId("test-secret", identity),
    origins: {
      record: async (parentSessionId, subagentKey, origin) => {
        await input.onRecord?.()
        if (!origins.has(originKey(parentSessionId, subagentKey))) origins.set(originKey(parentSessionId, subagentKey), origin)
      },
      read: (parentSessionId, subagentKey) => origins.get(originKey(parentSessionId, subagentKey)),
    },
    listSubagents: (parentSessionId) => store.listSubagents(parentSessionId),
    pendingWakes: () => store.listPendingSubagentWakes(),
    getSession: input.getSession ?? ((sessionId) => sessions.get(sessionId) ?? null),
    getMessages: (sessionId) => input.messages?.[sessionId] ?? [],
    ...(input.subscribe ? { subscribeGlobal: input.subscribe } : {}),
    startTurn: input.startTurn ?? (async (turn) => {
      turns.push({
        parentSessionId: turn.parentSessionId,
        messageID: turn.body.messageID,
        text: turn.body.parts?.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "",
        author: turn.author.id,
        ...(turn.origin ? { origin: turn.origin } : {}),
      })
      settle.push(turn.onSettled)
      return "started"
    }),
  })
  return { host, store, origins, sessions, admitted, turns, settle }
}

const ORIGIN: SessionTurnOrigin = {
  provenance: "relay-replayed",
  actor: { actorId: "https://idp.example|bob", actorKind: "human" },
  authority: { managed: true, workspaceId: "workspace_1", orgId: "org_1", role: "editor" },
}

describe("host-owned child sessions", () => {
  test("a late first settlement records its own result without settling the second run", async () => {
    const messages = { child: [assistant("reply-first", "First only", undefined, "first"), assistant("reply-second", "Second only", undefined, "second")] }
    const item = harness({ sessions: { parent: { status: "busy" }, child: { parentID: "parent" } }, messages })
    await item.host.admitCreated({ parentSessionId: "parent", childSessionId: "child", directory: DIRECTORY, harness: "codex" })
    await item.host.onTurnStarted("child", DIRECTORY, "first")
    await item.host.onTurnStarted("child", DIRECTORY, "second")
    await item.host.onTurnSettled("child", DIRECTORY, "first")
    expect(item.store.listSubagents("parent")[0]?.status).toBe("running")
    expect(item.store.listPendingSubagentWakes().map((wake) => wake.result?.summary.text)).toEqual(["First only"])
    await item.host.onTurnSettled("child", DIRECTORY, "second")
    expect(item.store.listSubagents("parent")[0]?.status).toBe("completed")
    expect(item.store.listPendingSubagentWakes().map((wake) => wake.result?.summary.text)).toEqual(["First only", "Second only"])
    await item.host.dispose()
  })

  test("every result survives a busy parent, a later child run and a store restart", async () => {
    const messages = { child: [assistant("reply-z", "First result", undefined, "first")] }
    const item = harness({ sessions: { parent: { status: "busy" }, child: { parentID: "parent" } }, messages })
    await item.host.admitCreated({ parentSessionId: "parent", childSessionId: "child", directory: DIRECTORY, harness: "codex" })
    await item.host.onTurnStarted("child", DIRECTORY, "first")
    await item.host.onTurnSettled("child", DIRECTORY, "first")
    await item.host.onTurnStarted("child", DIRECTORY, "second")
    expect(await item.host.activeChildren("parent", DIRECTORY)).toHaveLength(1)
    await item.host.onTurnSettled("child", DIRECTORY, "first")
    expect(item.store.listSubagents("parent")[0]?.status).toBe("running")
    messages.child.push(assistant("reply-a", "Partial second", { name: "MessageAbortedError", data: {} }, "second"))
    await item.host.onTurnSettled("child", DIRECTORY, "second")
    expect(item.store.listPendingSubagentWakes().map((wake) => wake.result?.summary.assistantMessageId)).toEqual(["reply-z", "reply-a"])
    expect(item.turns).toEqual([])
    await item.host.dispose()
    const openedStore = opened.find((entry) => entry.store === item.store)!
    item.store.close()
    openedStore.store = openTestRuntimeStore(openedStore.root)
    const restarted = harness({ store: openedStore.store, sessions: { parent: { status: "idle" }, child: { parentID: "parent" } } })
    await restarted.host.recover()
    expect(restarted.turns).toHaveLength(1)
    expect(restarted.turns[0]?.messageID).toBe(wakeMessageId("child", "reply-z"))
    expect(restarted.turns[0]?.text).toContain("First result")
    await restarted.host.onTurnSettled("parent", DIRECTORY)
    expect(restarted.turns).toHaveLength(2)
    expect(restarted.turns[1]?.messageID).toBe(wakeMessageId("child", "reply-a"))
    expect(restarted.turns[1]?.text).toContain("Partial second")
    expect(restarted.turns[1]?.text).toContain("killed")
    expect(restarted.store.listPendingSubagentWakes()).toEqual([])
    await restarted.host.onTurnStarted("child", DIRECTORY, "second")
    expect(restarted.store.listSubagents("parent")[0]?.status).toBe("killed")
    await restarted.host.dispose()
  })

  test("late turn callbacks do not read a disposed runtime", async () => {
    const item = harness({ getSession: () => { throw new Error("Workspace runtime is disposed") } })
    await item.host.dispose()
    await item.host.onTurnStarted("child", DIRECTORY, "turn")
    await item.host.onTurnSettled("child", DIRECTORY)
    expect(item.turns).toEqual([])
    expect(item.admitted).toEqual([])
  })

  test("derives idempotent child ids from the secret, caller identity and request id", async () => {
    const { host } = harness()
    const first = await host.deriveSessionId({ callerIdentity: "parent", clientRequestId: "req-1" })
    expect(first).toBe(await host.deriveSessionId({ callerIdentity: "parent", clientRequestId: "req-1" }))
    expect(first).not.toBe(await host.deriveSessionId({ callerIdentity: "other-caller", clientRequestId: "req-1" }))
    expect(first).not.toBe(await host.deriveSessionId({ callerIdentity: "parent", clientRequestId: "req-2" }))
    expect(first).toMatch(/^ses_[0-9a-f]{32}$/)
  })

  test("admits the created child as a pending host row the parent can list", async () => {
    const { host, store, admitted } = harness({ sessions: { parent: {}, child: { parentID: "parent" } } })
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
    expect(admitted).toMatchObject([{ parentSessionId: "parent", event: { type: "subagent-updated", subagentKey, status: "pending" } }])
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
    await item.host.onTurnStarted("child", DIRECTORY, "turn")
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

  test("a wake runs as the actor that created the child, and shows the child as its author", async () => {
    const item = harness({
      sessions: { parent: { status: "idle" }, child: { parentID: "parent" } },
      messages: { child: [assistant("m1", "done")] },
    })
    await item.host.admitCreated({ parentSessionId: "parent", childSessionId: "child", directory: DIRECTORY, harness: "claude", origin: ORIGIN })
    await item.host.onTurnSettled("child", DIRECTORY)

    expect(item.turns).toMatchObject([{
      parentSessionId: "parent",
      author: "child",
      origin: ORIGIN,
    }])
  })

  test("nothing can wake a child whose origin write has not landed: the row becomes wakeable only at settlement", async () => {
    // The window a racing recovery would have to exploit is between admitting
    // the child and writing its origin. A row is only offered once its wake is
    // pending, and only settlement sets that, so the window has nothing in it.
    let item: ReturnType<typeof harness>
    const duringWrite: Array<{ wake?: string; turns: number }> = []
    item = harness({
      sessions: { parent: { status: "idle" }, child: { parentID: "parent" } },
      messages: { child: [assistant("m1", "done")] },
      onRecord: async () => {
        await item.host.recover()
        duringWrite.push({ wake: item.store.listSubagents("parent")[0]?.wake, turns: item.turns.length })
      },
    })
    await item.host.admitCreated({ parentSessionId: "parent", childSessionId: "child", directory: DIRECTORY, harness: "claude", origin: ORIGIN })

    expect(duringWrite).toEqual([{ wake: undefined, turns: 0 }])

    await item.host.onTurnSettled("child", DIRECTORY)
    expect(item.turns).toMatchObject([{ messageID: "msg_wake_child_m1", origin: ORIGIN }])
  })

  test("a restart re-offers the wake under the stored actor, once, and a second recovery adds nothing", async () => {
    const first = harness({
      sessions: { parent: { status: "idle" }, child: { parentID: "parent" } },
      messages: { child: [assistant("m1", "done")] },
      startTurn: async () => "busy",
    })
    await first.host.admitCreated({ parentSessionId: "parent", childSessionId: "child", directory: DIRECTORY, harness: "claude", origin: ORIGIN })
    await first.host.onTurnSettled("child", DIRECTORY)
    expect(first.store.listSubagents("parent")).toMatchObject([{ wake: "pending" }])

    const restarted = harness({
      store: first.store,
      origins: first.origins,
      sessions: { parent: { status: "idle" }, child: { parentID: "parent" } },
      messages: { child: [assistant("m1", "done")] },
    })
    await restarted.host.recover()

    expect(restarted.turns).toMatchObject([{ messageID: "msg_wake_child_m1", origin: ORIGIN }])
    expect(restarted.store.listSubagents("parent")).toMatchObject([{ wake: "delivered" }])
    await restarted.host.recover()
    expect(restarted.turns).toHaveLength(1)
  })

  test("a child admitted with no origin offers a wake naming no actor, which a managed host refuses", async () => {
    const item = harness({
      sessions: { parent: { status: "idle" }, child: { parentID: "parent" } },
      messages: { child: [assistant("m1", "done")] },
    })
    await item.host.admitCreated({ parentSessionId: "parent", childSessionId: "child", directory: DIRECTORY, harness: "claude" })
    await item.host.onTurnSettled("child", DIRECTORY)

    expect(item.turns).toMatchObject([{ messageID: "msg_wake_child_m1" }])
    expect(item.turns[0].origin).toBeUndefined()
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
    let deliver: ((event: AgentEventEnvelope) => void) | undefined
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
    expect(item.admitted.at(-1)).toMatchObject({ parentSessionId: "parent", event: { type: "subagent-updated", attention: 2 } })

    deliver!({ directory: DIRECTORY, payload: { id: "permission.replied:perm-1", type: "permission.replied", properties: { sessionID: "child", requestID: "perm-1", reply: "once" } } })
    await settled()
    deliver!({ directory: DIRECTORY, payload: { id: "question.rejected:q-1", type: "question.rejected", properties: { sessionID: "child", requestID: "q-1" } } })
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

describe("hostChildRow", () => {
  test("projects only the named public fields, so a stored grant or origin never reaches a reader", () => {
    const grant = "eyJ.deferred-grant-token.sig"
    const row = hostChildRow("parent", {
      providerKind: HOST_CHILD_PROVIDER_KIND,
      subagentKey: "subagent_1",
      childSessionId: "child",
      status: "completed",
      label: "Reviewer",
      subagentType: "review",
      attention: 1,
      wake: "pending",
      wakeGrant: grant,
      grant,
      origin: { provenance: "relay-replayed", actor: { actorId: "bob", actorKind: "human" }, grant },
    })
    expect(row).toEqual({
      parentSessionId: "parent",
      subagentKey: "subagent_1",
      childSessionId: "child",
      status: "completed",
      label: "Reviewer",
      subagentType: "review",
      attention: 1,
      wake: "pending",
    })
    expect(JSON.stringify(row)).not.toContain(grant)
  })
})
