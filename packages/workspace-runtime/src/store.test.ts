// `node:test`'s `describe`/`test` return a promise the runner already owns: it
// settles when the suite finishes and reports failures through the runner
// rather than rejecting, so every registration below is deliberately `void`ed.
import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import { createSubagentAdmissionBoundary } from "@claxedo/agent-sdk-runtime"
import { AgentMessagePageError, AgentRuntimeStaleTurnError } from "@claxedo/agent-sdk-runtime/adapters"
import {
  LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES,
  LATEST_SURFACE_MAX_TEXT_BYTES,
  LATEST_SURFACE_MAX_TEXT_PART_BYTES,
  LATEST_SURFACE_MAX_TEXT_PARTS,
} from "@claxedo/agent-sdk-runtime/message-page"
import {
  messagePartUpdated,
  messageUpdated,
  messageCompleted,
  messagePartDelta,
  permissionAsked,
  questionAsked,
  sessionIdle,
  sessionUsage,
  sessionUpdated,
  todoUpdated,
} from "./compat-events"
import { RuntimeStore as RuntimeStoreImpl } from "./store"

const roots: string[] = []
const stores: RuntimeStoreImpl[] = []

class RuntimeStore extends RuntimeStoreImpl {
  constructor(...args: ConstructorParameters<typeof RuntimeStoreImpl>) {
    super(...args)
    stores.push(this)
  }
}

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-store-"))
  roots.push(root)
  return root
}

function journal(root: string, sessionId: string) {
  const store = new RuntimeStore(root)
  const rows = (
    store as unknown as {
      db: {
        prepare(sql: string): {
          all(...params: unknown[]): unknown[]
        }
      }
    }
  ).db
    .prepare(
      `
    SELECT seq, kind, type, payload_json
    FROM runtime_journal
    WHERE session_id = ?
    ORDER BY seq ASC
  `,
    )
    .all(sessionId) as Array<{ seq: number; kind: string; type: string; payload_json: string }>
  store.close()
  return rows.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }))
}

function sessionColumns(store: RuntimeStore) {
  return (
    (
      store as unknown as {
        db: {
          prepare(sql: string): {
            all(...params: unknown[]): unknown[]
          }
        }
      }
    ).db
      .prepare("PRAGMA table_info(session)")
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

function db(store: RuntimeStore) {
  return (
    store as unknown as {
      db: {
        exec(sql: string): unknown
        prepare(sql: string): {
          run(...params: unknown[]): unknown
          get(...params: unknown[]): unknown
          all(...params: unknown[]): unknown[]
        }
      }
    }
  ).db
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  while (roots.length > 0) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

void describe("RuntimeStore", () => {
  void it("turn leases survive runtime-store reconstruction", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    const reconstructed = new RuntimeStore(root)
    const lease = first.acquireTurnLease("ses_durable_turn")
    assert.equal(typeof lease, "string")
    assert.equal(reconstructed.acquireTurnLease("ses_durable_turn"), undefined)

    reconstructed.recoverBusySessions()
    const recoveredLease = reconstructed.acquireTurnLease("ses_durable_turn")
    assert.equal(typeof recoveredLease, "string")

    // A delayed release from the pre-recovery owner must not delete the new
    // runtime's lease.
    first.releaseTurnLease("ses_durable_turn", lease!)
    assert.equal(reconstructed.acquireTurnLease("ses_durable_turn"), undefined)
    reconstructed.releaseTurnLease("ses_durable_turn", recoveredLease!)
    assert.equal(typeof reconstructed.acquireTurnLease("ses_durable_turn"), "string")
  })

  void it("creates new session storage with harness columns instead of runner columns", () => {
    const store = new RuntimeStore(tmp())
    const columns = sessionColumns(store)
    assert(columns.includes("harness_id"))
    assert(columns.includes("harness_access"))
    assert(columns.includes("parent_id"))
    assert(!columns.some((name) => name.startsWith("runner_")))
  })

  void it("persists explicit child Session ownership across updates and reopen", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/work", agentSessionId: "provider-parent", createdAt: 1 })
    store.bindSession({
      sessionId: "child",
      parentSessionId: "parent",
      directory: "/work",
      agentSessionId: "provider-child",
      createdAt: 2,
    })
    store.updateSession("child", { title: "Child transcript", time: { archived: 3 } })
    store.bindSession({ sessionId: "child", directory: "/work", agentSessionId: "provider-child", createdAt: 4 })

    assert.partialDeepStrictEqual(store.getSession("child"), {
      id: "child",
      parentID: "parent",
      title: "Child transcript",
      time: { archived: 3 },
    })
    store.close()

    const reopened = new RuntimeStore(root)
    assert.equal((reopened.getSession("child") as { parentID?: string } | null)?.parentID, "parent")
    reopened.close()
  })

  void it("durably admits revisioned subagents and rehydrates correlation after reopen", async () => {
    const root = tmp()
    const published: Array<{ parentSessionId: string; revision: number }> = []
    const store = new RuntimeStore(root)
    const boundary = createSubagentAdmissionBoundary({
      store,
      allocateKey: () => "host-child",
      publish: (parentSessionId, event) => {
        published.push({ parentSessionId, revision: event.revision })
      },
    })
    const spawn = await boundary.admit("parent", {
      observationId: "spawn",
      harnessExecutionId: "run",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      status: "running",
      transcript: { kind: "messages", ref: "handle-1" },
    })
    const bound = await boundary.admit("parent", {
      observationId: "bound",
      harnessExecutionId: "run",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      providerKind: "claude-agent",
      providerId: "agent-1",
      childSessionId: "child-session",
      status: "completed",
    })

    assert.equal(bound.subagentKey, spawn.subagentKey)
    assert.equal(bound.revision, 2)
    assert.deepEqual(published, [
      { parentSessionId: "parent", revision: 1 },
      { parentSessionId: "parent", revision: 2 },
    ])
    store.close()

    const reopened = new RuntimeStore(root)
    const next = createSubagentAdmissionBoundary({
      store: reopened,
      allocateKey: () => "replacement-must-not-be-used",
      publish: () => {},
    })
    const interaction = await next.admit("parent", {
      observationId: "interaction",
      harnessExecutionId: "run",
      providerKind: "claude-agent",
      providerId: "agent-1",
      toolCallId: "send-1",
      toolCallRole: "interaction",
      status: "completed",
    })

    assert.equal(interaction.subagentKey, spawn.subagentKey)
    assert.equal(interaction.revision, 3)
    const rows = reopened.listSubagents("parent")
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.subagentKey, spawn.subagentKey)
    assert.equal(rows[0]?.revision, 3)
    assert.equal(rows[0]?.providerId, "agent-1")
    assert.equal(rows[0]?.childSessionId, "child-session")
    assert.deepEqual(rows[0]?.transcript, { kind: "messages", ref: "handle-1" })
    assert.deepEqual(rows[0]?.toolCallEdges, [
      { toolCallId: "tool-1", role: "spawn", revision: 1 },
      { toolCallId: "send-1", role: "interaction", revision: 3 },
    ])
    reopened.close()
  })

  void it("persists attention counts, wake state and a stable runtime secret across reopen", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    const secret = store.runtimeSecret("child-session")
    assert.match(secret, /^[0-9a-f]{64}$/)
    assert.equal(store.runtimeSecret("child-session"), secret)
    assert.notEqual(store.runtimeSecret("other"), secret)
    store.bindSession({ sessionId: "parent", directory: "/workspace", agentSessionId: "parent" })
    store.bindSession({ sessionId: "child", directory: "/workspace", agentSessionId: "child", parentSessionId: "parent" })
    const observations: Array<[string, Record<string, unknown>]> = [
      ["create", { status: "pending", providerKind: "claxedo", providerId: "child", childSessionId: "child", transcript: { kind: "live" } }],
      ["attention-2", { attention: 2 }],
      ["attention-0", { attention: 0 }],
      ["finished", { status: "completed", wake: "pending" }],
    ]
    for (const [observationId, observation] of observations) {
      store.admit({
        parentSessionId: "parent",
        observation: { observationId, subagentKey: "subagent_host", ...observation },
        allocateKey: () => "unused",
      })
      store.markPublished("parent", observationId)
    }
    assert.deepEqual(store.listPendingSubagentWakes(), [
      { parentSessionId: "parent", subagentKey: "subagent_host", childSessionId: "child", directory: "/workspace" },
    ])
    store.close()

    const reopened = new RuntimeStore(root)
    assert.equal(reopened.runtimeSecret("child-session"), secret)
    const row = reopened.listSubagents("parent")[0]
    assert.equal(row?.status, "completed")
    assert.equal(row?.attention, 0)
    assert.equal(row?.wake, "pending")
    reopened.admit({
      parentSessionId: "parent",
      observation: { observationId: "woken", subagentKey: "subagent_host", wake: "delivered" },
      allocateKey: () => "unused",
    })
    assert.equal(reopened.listSubagents("parent")[0]?.wake, "delivered")
    assert.deepEqual(reopened.listPendingSubagentWakes(), [])
    reopened.close()
  })

  void it("routes an observation carrying an already-owned child session to the owning row (claude dual-channel split)", () => {
    // Repro of the live crash "UNIQUE constraint failed:
    // session_subagent.child_session_id": the claude harness reports one Task
    // through two channels — an `agent-tool` observation keyed by toolCallId
    // and a `background-task` observation keyed by stableCorrelationId — so
    // admission opens TWO rows for one subagent. The linking `task_started`
    // observation then arrived carrying the FIRST row's child session while
    // resolving (by stable key) to the SECOND row, and the child-column write
    // collided with the unique child index, killing the whole turn.
    const root = tmp()
    const store = new RuntimeStore(root)

    // Channel 1: Task tool block — toolCallId only, child session allocated.
    const spawn = store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "claude:agent-tool:w:tool-1",
        harnessExecutionId: "run",
        toolCallId: "tool-1",
        toolCallRole: "spawn",
        status: "pending",
        providerKind: "claude-agent",
        childSessionId: "child-a",
        transcript: { kind: "messages" },
      },
      allocateKey: () => "unused-a",
    })

    // Channel 2: background_tasks_changed — stable task id only, no child yet.
    const background = store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "claude:background-task:w:task-1",
        harnessExecutionId: "run",
        stableCorrelationId: "task-1",
        status: "running",
        providerKind: "claude-agent",
        transcript: { kind: "messages" },
      },
      allocateKey: () => "unused-b",
    })
    assert.notEqual(background.event.subagentKey, spawn.event.subagentKey)

    // The link: carries the stable key of row B and the child of row A. Child
    // identity is the strongest correlator — this must land on row A, never
    // write child-a into row B (which is what crashed with the UNIQUE error).
    const linked = store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "claude:task_started:w",
        harnessExecutionId: "run",
        stableCorrelationId: "task-1",
        toolCallId: "tool-1",
        toolCallRole: "spawn",
        status: "running",
        providerKind: "claude-agent",
        childSessionId: "child-a",
        transcript: { kind: "messages" },
      },
      allocateKey: () => "unused-c",
    })
    assert.equal(linked.event.subagentKey, spawn.event.subagentKey)

    const rows = store.listSubagents("parent")
    const owners = rows.filter((row) => row.childSessionId === "child-a")
    assert.equal(owners.length, 1)
    assert.equal(owners[0]?.subagentKey, spawn.event.subagentKey)
    store.close()

    // The poisoned durable state must also rehydrate (the live failure mode
    // was every later admission crashing after restart).
    const reopened = new RuntimeStore(root)
    assert.equal(reopened.listSubagents("parent").length, rows.length)
    reopened.close()
  })

  void it("gives an admitted delegation's child session the parent it belongs to", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/work", agentSessionId: "parent", createdAt: 1 })
    // A delegating harness owns this child, so the runtime's only row for it is
    // the placeholder a session-scoped read binds. Admission is where the
    // parent link enters this store, and `GET /session/:id` answers from here.
    store.bindSession({ sessionId: "child", directory: "/work", agentSessionId: "child", createdAt: 2 })

    store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "harness:task:tool-1",
        harnessExecutionId: "run",
        toolCallId: "tool-1",
        toolCallRole: "spawn",
        status: "running",
        providerKind: "harness-task",
        childSessionId: "child",
        transcript: { kind: "messages" },
      },
      allocateKey: () => "key-1",
    })

    assert.equal((store.getSession("child") as { parentID?: string } | null)?.parentID, "parent")
    assert.equal((store.getSession("child") as { directory?: string } | null)?.directory, "/work")
    store.close()

    // Journaled like every other session write, so a rehydrate keeps it.
    const reopened = new RuntimeStore(root)
    assert.equal((reopened.getSession("child") as { parentID?: string } | null)?.parentID, "parent")
    reopened.close()
  })

  void it("binds a child session admission names before this store has any row for it", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/work", agentSessionId: "parent", createdAt: 1 })

    store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "harness:task:tool-2",
        harnessExecutionId: "run",
        toolCallId: "tool-2",
        toolCallRole: "spawn",
        status: "running",
        providerKind: "harness-task",
        childSessionId: "unseen-child",
        transcript: { kind: "messages" },
      },
      allocateKey: () => "key-2",
    })

    assert.partialDeepStrictEqual(store.getSession("unseen-child"), {
      id: "unseen-child",
      parentID: "parent",
      directory: "/work",
    })
    store.close()
  })

  void it("serializes key and revision admission across concurrently open stores", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    const second = new RuntimeStore(root)
    const spawn = first.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "spawn",
        stableCorrelationId: "task-1",
        status: "running",
      },
      allocateKey: () => "first-key",
    })
    const completion = second.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "completion",
        stableCorrelationId: "task-1",
        status: "completed",
      },
      allocateKey: () => "second-key",
    })

    assert.equal(completion.event.subagentKey, spawn.event.subagentKey)
    assert.equal(completion.event.revision, 2)
    first.close()
    second.close()
  })

  void it("preserves terminal subagent status after a late active observation and reopen", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    const spawn = store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "spawn",
        status: "running",
      },
      allocateKey: () => "child-key",
    })
    store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "completed",
        subagentKey: spawn.event.subagentKey,
        status: "completed",
      },
      allocateKey: () => "unused",
    })
    store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "late-running",
        subagentKey: spawn.event.subagentKey,
        status: "running",
      },
      allocateKey: () => "unused",
    })
    store.close()

    const reopened = new RuntimeStore(root)

    assert.equal(reopened.listSubagents("parent")[0]?.revision, 3)
    assert.equal(reopened.listSubagents("parent")[0]?.status, "completed")
    reopened.close()
  })

  void it("interrupts active children on archive while preserving durable history", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/work", agentSessionId: "provider-parent", createdAt: 1 })
    store.bindSession({
      sessionId: "child-session",
      parentSessionId: "parent",
      directory: "/work",
      agentSessionId: "provider-child",
      createdAt: 2,
    })
    const admitted = store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "spawn",
        subagentKey: "child-key",
        mode: "background",
        status: "running",
        childSessionId: "child-session",
        transcript: { kind: "live", ref: "opaque-handle" },
      },
      allocateKey: () => "unused",
    })
    store.markPublished("parent", "spawn")

    store.updateSession("parent", { time: { archived: 50 } })

    const rows = store.listSubagents("parent")
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.subagentKey, "child-key")
    assert.equal(rows[0]?.revision, admitted.event.revision + 1)
    assert.equal(rows[0]?.status, "interrupted")
    assert.equal(rows[0]?.childSessionId, "child-session")
    assert.deepEqual(rows[0]?.transcript, { kind: "live", ref: "opaque-handle" })
    assert.equal((store.getSession("child-session") as { parentID?: string } | null)?.parentID, "parent")
    store.close()

    const reopened = new RuntimeStore(root)
    assert.equal((reopened.listSubagents("parent")[0] as { status?: string }).status, "interrupted")
    assert.ok(reopened.getSession("child-session"))
    reopened.close()
  })

  void it("reconciles disconnected foreground children and deletes child ownership atomically", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "parent", directory: "/work", agentSessionId: "provider-parent", createdAt: 1 })
    store.bindSession({
      sessionId: "child-session",
      parentSessionId: "parent",
      directory: "/work",
      agentSessionId: "provider-child",
      createdAt: 2,
    })
    store.admit({
      parentSessionId: "parent",
      observation: {
        observationId: "spawn",
        subagentKey: "child-key",
        mode: "foreground",
        status: "running",
        childSessionId: "child-session",
        toolCallId: "tool-1",
        toolCallRole: "spawn",
      },
      allocateKey: () => "unused",
    })
    store.markPublished("parent", "spawn")
    store.close()

    const reopened = new RuntimeStore(root)
    assert.equal((reopened.listSubagents("parent")[0] as { status?: string }).status, "interrupted")
    reopened.deleteSession("parent")

    assert.deepEqual(reopened.listSubagents("parent"), [])
    assert.equal(reopened.getSession("parent"), null)
    assert.equal(reopened.getSession("child-session"), null)
    const edgeCount = db(reopened)
      .prepare("SELECT COUNT(*) AS count FROM session_subagent_tool_call WHERE parent_session_id = ?")
      .get("parent") as { count: number }
    assert.equal(edgeCount.count, 0)
    reopened.close()
  })


  void it("journals before projecting so replay recovers when projection fails", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    const db = (
      store as unknown as {
        db: {
          exec(sql: string): unknown
          prepare(sql: string): {
            all(...params: unknown[]): unknown[]
          }
        }
      }
    ).db
    db.exec("DROP TABLE session")

    assert.throws(() => {
      store.bindSession({
        sessionId: "s1",
        directory: "/work",
        agentSessionId: "a1",
        createdAt: 1,
      })
    })

    const journal = db.prepare("SELECT type FROM runtime_journal WHERE session_id = ?").all("s1") as Array<{
      type: string
    }>
    assert.deepEqual(
      journal.map((row) => row.type),
      ["session.bind"],
    )
    store.close()

    const next = new RuntimeStore(root)
    assert.equal(next.getAgentSessionId("s1"), "a1")
    next.close()
  })

  void it("rolls back failed projection transactions and replays the journaled row later", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: todoUpdated("s1", [{ content: "Old", status: "pending", priority: "low" }]),
    })

    db(store).exec(`
      CREATE TRIGGER fail_todo_insert
      BEFORE INSERT ON todo
      WHEN NEW.content = 'New'
      BEGIN
        SELECT RAISE(FAIL, 'todo insert failed');
      END
    `)

    assert.throws(() => {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: todoUpdated("s1", [{ content: "New", status: "completed", priority: "high" }]),
      })
    }, /todo insert failed/)
    db(store).exec("DROP TRIGGER fail_todo_insert")

    assert.deepEqual(store.getTodos("s1"), [{ content: "Old", status: "pending", priority: "low" }])
    store.close()

    const next = new RuntimeStore(root)
    assert.deepEqual(next.getTodos("s1"), [{ content: "New", status: "completed", priority: "high" }])
    next.close()
  })

  void it("returns committed append output after projection commits", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })

    const payload = todoUpdated("s1", [{ content: "Done", status: "completed", priority: "high" }])
    const output = store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload,
      source: {
        dir: "in",
        method: "test.append",
        requestId: "req-1",
      },
    })

    assert.equal(output.sessionId, "s1")
    assert.equal(output.agentSessionId, "a1")
    assert.equal(output.seq, 2)
    assert.equal(output.createdAt > 0, true)
    assert.deepEqual(output.payload, payload)
    assert.deepEqual(output.source, {
      dir: "in",
      method: "test.append",
      requestId: "req-1",
    })
    assert.deepEqual(store.getTodos("s1"), [{ content: "Done", status: "completed", priority: "high" }])
    store.close()
  })

  void it("returns committed turn-start output after projection commits", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })

    const output = store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "msg-user",
      assistantMessageId: "msg-user_r",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })

    assert.equal(output.sessionId, "s1")
    assert.equal(output.agentSessionId, "a1")
    assert.equal(output.seq, 2)
    assert.equal(output.createdAt > 0, true)
    assert.deepEqual(
      output.events.map((event) => event.type),
      ["session.status", "message.updated", "message.part.updated", "message.updated"],
    )
    const replay = store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "msg-user",
      assistantMessageId: "msg-user_r",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    assert.equal(replay.seq, output.seq)
    assert.equal(replay.createdAt, output.createdAt)
    assert.deepEqual(replay.events, [])
    assert.equal(journal(root, "s1").filter((row) => row.type === "turn.start").length, 1)
    assert.deepEqual(
      store.getMessages("s1").map((message) => message.info.id),
      ["msg-user", "msg-user_r"],
    )
    store.close()
  })

  void it("persists Goal continuations under their original user boundary through reopen", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "goal-session", directory: "/work", agentSessionId: "native-goal", createdAt: 1 })
    const common = { sessionId: "goal-session", agent: "build", model: { providerID: "openai", modelID: "codex" } }
    store.startTurn({ ...common, userMessageId: "goal-request", assistantMessageId: "first", parts: [{ type: "text", text: "Finish the requested work" }] })
    const user = store.getMessages("goal-session").find((message) => message.info.role === "user")
    store.startTurn({ ...common, parentMessageId: "goal-request", assistantMessageId: "continuation", parts: [] })
    assert.deepEqual(store.getMessages("goal-session").filter((message) => message.info.role === "user"), [user])
    assert.equal(store.getMessages("goal-session").find((message) => message.info.id === "continuation")?.info.parentID, "goal-request")
    assert.ok(store.getMessagePage("goal-session", { view: "latest-surface" }))
    store.close()
    const reopened = new RuntimeStore(root)
    assert.equal(reopened.getMessages("goal-session").find((message) => message.info.id === "continuation")?.info.parentID, "goal-request")
    assert.ok(reopened.getMessagePage("goal-session", { view: "latest-surface" }))
    reopened.close()
  })

  void it("pages projected messages backward with an opaque cursor and bounded hydration", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    for (let index = 1; index <= 6; index++) {
      const messageId = `m${index}`
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({
          id: messageId,
          sessionID: "s1",
          role: "user",
          time: { created: index },
        } as any),
      })
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messagePartUpdated({
          id: `${messageId}-text`,
          sessionID: "s1",
          messageID: messageId,
          type: "text",
          text: `message ${index}`,
        }),
      })
    }

    // A page must not parse parts for messages outside its bounded selection.
    db(store).prepare("UPDATE part SET data_json = ? WHERE id = ?").run("not-json", "m1-text")

    const first = store.getMessagePage("s1", { limit: 2 })
    assert.ok(first)
    assert.deepEqual(
      first.messages.map((message) => message.info.id),
      ["m5", "m6"],
    )
    assert.deepEqual(
      first.messages.map((message) => (message.parts[0] as { text?: string } | undefined)?.text),
      ["message 5", "message 6"],
    )
    assert.match(first.nextCursor ?? "", /^wrmp1:/)

    const second = store.getMessagePage("s1", { limit: 2, before: first.nextCursor })
    assert.ok(second)
    assert.deepEqual(
      second.messages.map((message) => message.info.id),
      ["m3", "m4"],
    )
    assert.ok(second.nextCursor)

    const indexes = db(store)
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('message', 'part')")
      .all() as Array<{ name: string }>
    assert(indexes.some((row) => row.name === "message_session_ord_idx"))
    assert(indexes.some((row) => row.name === "part_session_message_ord_idx"))
    store.close()
  })

  void it("returns the chronological latest turn and continues before its user boundary", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    const append = (info: Record<string, unknown>) =>
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({ sessionID: "s1", time: { created: Date.now() }, ...info } as any),
      })
    append({ id: "user-1", role: "user" })
    append({ id: "assistant-1", role: "assistant", parentID: "user-1" })
    append({ id: "user-2", role: "user" })
    append({ id: "assistant-2a", role: "assistant", parentID: "user-2" })
    append({ id: "assistant-2b", role: "assistant", parentID: "user-2" })

    const latest = store.getMessagePage("s1", { view: "latest-turn" })
    assert.ok(latest)
    assert.deepEqual(
      latest.messages.map((message) => message.info.id),
      ["user-2", "assistant-2a", "assistant-2b"],
    )
    assert.match(latest.nextCursor ?? "", /^wrmp1:/)

    const older = store.getMessagePage("s1", { limit: 10, before: latest.nextCursor })
    assert.ok(older)
    assert.deepEqual(
      older.messages.map((message) => message.info.id),
      ["user-1", "assistant-1"],
    )
    store.close()
  })

  void it("returns only the owning user and final message for the latest surface without losing intermediates", () => {
    const store = new RuntimeStore(tmp())
    const omittedDecodeMarker = "LATEST_SURFACE_OMITTED_PAYLOAD_MUST_NOT_BE_PARSED"
    const omittedPayload = `${omittedDecodeMarker}:${"x".repeat(256 * 1024)}`
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    const append = (info: Record<string, unknown>) =>
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({ sessionID: "s1", time: { created: Date.now() }, ...info } as any),
      })
    append({ id: "user-1", role: "user" })
    append({ id: "assistant-1", role: "assistant", parentID: "user-1" })
    append({
      id: "user-2",
      role: "user",
      summary: { body: "deferred summary", diffs: [{ patch: "large diff" }] },
      system: "deferred system prompt",
      tools: { read: true },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    })
    append({ id: "assistant-2a", role: "assistant", parentID: "user-2" })
    append({ id: "assistant-2b", role: "assistant", parentID: "user-2" })
    for (const part of [
      { id: "user-2-text", messageID: "user-2", type: "text", text: "complete prompt" },
      { id: "user-2-file", messageID: "user-2", type: "file", url: "data:large" },
      { id: "assistant-2b-reasoning", messageID: "assistant-2b", type: "reasoning", text: "large reasoning" },
      { id: "assistant-2b-text", messageID: "assistant-2b", type: "text", text: "complete final reply" },
      {
        id: "assistant-2b-tool",
        messageID: "assistant-2b",
        type: "tool",
        state: { status: "completed", output: omittedPayload },
      },
    ]) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messagePartUpdated({ sessionID: "s1", ...part } as any),
      })
    }

    db(store)
      .prepare("UPDATE message SET info_json = json_set(info_json, '$.system', ?) WHERE id = ?")
      .run(omittedPayload, "user-2")
    const originalParse = JSON.parse
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      assert.equal(text.includes(omittedDecodeMarker), false, "latest-surface decoded an omitted JSON payload")
      return originalParse(text, reviver)
    }) as typeof JSON.parse
    let surface: ReturnType<RuntimeStore["getMessagePage"]>
    try {
      surface = store.getMessagePage("s1", { view: "latest-surface" })
    } finally {
      JSON.parse = originalParse
    }
    assert.ok(surface)
    assert.deepEqual(
      surface.messages.map((message) => message.info.id),
      ["user-2", "assistant-2b"],
    )
    assert.deepEqual(surface.messages[0]?.info, {
      id: "user-2",
      sessionID: "s1",
      role: "user",
      time: surface.messages[0]?.info.time,
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    })
    assert.deepEqual(
      surface.messages.map((message) => message.parts),
      [
        [{ id: "user-2-text", sessionID: "s1", messageID: "user-2", type: "text", text: "complete prompt" }],
        [
          {
            id: "assistant-2b-text",
            sessionID: "s1",
            messageID: "assistant-2b",
            type: "text",
            text: "complete final reply",
          },
        ],
      ],
    )
    assert.match(surface.nextCursor ?? "", /^wrmp1:/)

    const complete = store.getMessagePage("s1", { view: "latest-turn" })
    assert.ok(complete)
    const completeFirst = complete.messages[0]
    assert.ok(completeFirst)
    assert.deepEqual(completeFirst.info.summary, {
      body: "deferred summary",
      diffs: [{ patch: "large diff" }],
    })
    assert.deepEqual(
      complete.messages.at(-1)?.parts.map((part: any) => part.type),
      ["reasoning", "text", "tool"],
    )

    const older = store.getMessagePage("s1", { limit: 10, before: surface.nextCursor })
    assert.ok(older)
    assert.deepEqual(
      older.messages.map((message) => message.info.id),
      ["user-1", "assistant-1", "user-2", "assistant-2a"],
    )
    store.close()
  })

  void it("bounds oversized user/assistant text, assistant errors, and many small parts while latest-turn stays complete", () => {
    const store = new RuntimeStore(tmp())
    const oversizedUser = "u".repeat(LATEST_SURFACE_MAX_TEXT_PART_BYTES + 1)
    const oversizedAssistant = "a".repeat(LATEST_SURFACE_MAX_TEXT_PART_BYTES + 1)
    const error = { name: "ProviderError", data: { body: "e".repeat(LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES) } }
    const chunk = "x".repeat(Math.floor(LATEST_SURFACE_MAX_TEXT_BYTES / LATEST_SURFACE_MAX_TEXT_PARTS) - 256)
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    for (const info of [
      { id: "user-budget", role: "user" },
      { id: "assistant-budget", role: "assistant", parentID: "user-budget", error },
    ]) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({ sessionID: "s1", time: { created: Date.now(), completed: Date.now() }, ...info } as any),
      })
    }
    const parts = [
      { id: "user-oversized", messageID: "user-budget", type: "text", text: oversizedUser },
      { id: "assistant-oversized", messageID: "assistant-budget", type: "text", text: oversizedAssistant },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `assistant-small-${index}`,
        messageID: "assistant-budget",
        type: "text",
        text: chunk,
      })),
    ]
    for (const value of parts) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messagePartUpdated({ sessionID: "s1", ...value } as any),
      })
    }

    const surface = store.getMessagePage("s1", { view: "latest-surface" })
    assert.ok(surface)
    const surfaceAssistant = surface.messages[1]
    assert.ok(surfaceAssistant)
    assert.deepEqual(surface.messages[0]?.parts, [])
    assert.equal(surfaceAssistant.info.error, undefined)
    assert.deepEqual(
      surfaceAssistant.parts.map((part) => part.id),
      Array.from({ length: LATEST_SURFACE_MAX_TEXT_PARTS }, (_, index) => `assistant-small-${index + 4}`),
    )

    const complete = store.getMessagePage("s1", { view: "latest-turn" })
    assert.ok(complete)
    const completeUser = complete.messages[0]
    const completeAssistant = complete.messages[1]
    assert.ok(completeUser)
    assert.ok(completeAssistant)
    assert.equal((completeUser.parts[0] as any).text, oversizedUser)
    assert.equal((completeAssistant.parts[0] as any).text, oversizedAssistant)
    assert.deepEqual(completeAssistant.info.error, error)
    assert.equal(completeAssistant.parts.length, 21)
    store.close()
  })

  void it("does not invent a surface cursor for an adjacent user and final assistant", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    for (const info of [
      { id: "user-adjacent", role: "user" },
      { id: "assistant-adjacent", role: "assistant", parentID: "user-adjacent" },
    ]) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({ sessionID: "s1", time: { created: Date.now() }, ...info } as any),
      })
    }

    const surface = store.getMessagePage("s1", { view: "latest-surface" })
    assert.ok(surface)
    assert.deepEqual(
      surface.messages.map((message) => message.info.id),
      ["user-adjacent", "assistant-adjacent"],
    )
    assert.equal(surface.nextCursor, undefined)
    store.close()
  })

  void it("rejects a latest surface whose assistant is not owned by its user boundary", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    for (const info of [
      { id: "owner", role: "user" },
      { id: "wrong-owner", role: "assistant", parentID: "different-user" },
    ]) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messageUpdated({ sessionID: "s1", time: { created: Date.now() }, ...info } as any),
      })
    }

    assert.throws(
      () => store.getMessagePage("s1", { view: "latest-surface" }),
      (error: unknown) => error instanceof AgentMessagePageError && error.status === 409,
    )
    store.close()
  })

  void it("returns a user-only live turn without inventing an older-history cursor", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messageUpdated({
        id: "user-live",
        sessionID: "s1",
        role: "user",
        time: { created: 1 },
      } as any),
    })

    const latest = store.getMessagePage("s1", { view: "latest-turn" })
    assert.ok(latest)
    assert.deepEqual(
      latest.messages.map((message) => message.info.id),
      ["user-live"],
    )
    assert.equal(latest.nextCursor, undefined)
    store.close()
  })

  void it("rejects invalid, cross-session, and missing-session message page cursors", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.bindSession({ sessionId: "s2", directory: "/work", agentSessionId: "a2", createdAt: 2 })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messageUpdated({
        id: "m1",
        sessionID: "s1",
        role: "user",
        time: { created: 1 },
      } as any),
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messageUpdated({
        id: "m2",
        sessionID: "s1",
        role: "user",
        time: { created: 2 },
      } as any),
    })
    store.appendEvent({
      sessionId: "s2",
      agentSessionId: "a2",
      payload: messageUpdated({
        id: "s2-m1",
        sessionID: "s2",
        role: "user",
        time: { created: 1 },
      } as any),
    })
    const result = store.getMessagePage("s1", { limit: 1 })
    assert.ok(result)
    const cursor = result.nextCursor
    assert.ok(cursor)

    for (const run of [
      () => store.getMessagePage("s1", { limit: 1, before: "not-a-cursor" }),
      () => store.getMessagePage("s2", { limit: 1, before: cursor }),
    ]) {
      assert.throws(
        run,
        (error: unknown) =>
          error instanceof AgentMessagePageError &&
          error.status === 400 &&
          error.message === "Invalid message page cursor",
      )
    }
    assert.throws(
      () => store.getMessagePage("missing", { limit: 1 }),
      (error: unknown) => error instanceof AgentMessagePageError && error.status === 404,
    )
    store.close()
  })

  void it("journals every public durable runtime mutation before projection state", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "Demo",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: permissionAsked({
        id: "p1",
        sessionID: "s1",
        permission: "bash",
        patterns: ["/tmp"],
        metadata: {},
        always: ["/tmp"],
      }),
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: questionAsked({
        id: "q1",
        sessionID: "s1",
        questions: [
          {
            question: "Ship it?",
            header: "Ship it?",
            options: [{ label: "Yes", description: "Ship it" }],
            custom: false,
          },
        ],
      }),
    })

    store.stalePermission("p1")
    store.staleQuestion("q1")
    store.markRecovering("s1", "recovering")
    assert.equal(store.consumeRecoveryError("s1"), "recovering")
    store.createNotice("s1", { notice: "recovery_error", message: "created notice" })
    store.requestProjectionReset("s1", "operator requested rebuild")
    store.updateSession("s1", { title: "Updated", time: { archived: 123 } })
    store.updateSessionConfig("s1", {
      harness: { id: "codex", access: "native" },
      model: { providerID: "openai", modelID: "gpt-5.4" },
    })
    store.deleteSession("s1")
    store.close()

    const rows = journal(root, "s1")
    assert.deepEqual(
      rows.map((row) => row.type),
      [
        "session.bind",
        "permission.asked",
        "question.asked",
        "permission.staled",
        "question.staled",
        "session.recovering",
        "notice.acknowledged",
        "notice.created",
        "projection.reset_requested",
        "session.update",
        "config.update",
        "session.delete",
      ],
    )
    assert.deepEqual(
      rows.map((row) => row.seq),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    )
    assert.equal(rows.find((row) => row.type === "notice.created")?.payload.message, "created notice")
    assert.equal(
      rows.find((row) => row.type === "projection.reset_requested")?.payload.reason,
      "operator requested rebuild",
    )

    const next = new RuntimeStore(root)
    assert.equal(next.getSession("s1"), null)
    next.close()
  })

  void it("closes idempotently and allows the store root to reopen", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })

    first.close()
    first.close()

    const next = new RuntimeStore(root)
    assert.equal(next.getAgentSessionId("s1"), "a1")
    next.close()
  })

  void it("reopens checkpointed projections without resetting or replaying durable history", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    db(first).exec(`
      CREATE TRIGGER reject_session_projection_reset
      BEFORE DELETE ON session
      BEGIN
        SELECT RAISE(ABORT, 'checkpointed projections must not be reset');
      END
    `)
    first.close()

    const next = new RuntimeStore(root)
    assert.equal(next.getAgentSessionId("s1"), "a1")
    next.close()
  })

  void it("exports JSONL debug output from the SQLite runtime journal", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })

    const rows = store
      .exportJournalJsonl("s1")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      rows.map((row) => row.control.type),
      ["session.bind"],
    )
    assert.equal(rows[0]?.sessionId, "s1")
    assert.equal(rows[0]?.agentSessionId, "a1")
  })

  void it("replays journaled messages and todos", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "Demo",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messagePartDelta({
        sessionID: "s1",
        messageID: "m1",
        partID: "m1-text",
        field: "text",
        delta: "world",
      }),
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: todoUpdated("s1", [{ id: "native-task-42", content: "Ship", status: "pending", priority: "high" }]),
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: sessionIdle("s1"),
    })

    const next = new RuntimeStore(root)
    const msgs = next.getMessages("s1") as Array<{
      info: { role: string }
      parts: Array<{ type: string; text?: string }>
    }>

    assert.equal(msgs.length, 2)
    assert.equal(msgs[0]?.info.role, "user")
    assert.equal(msgs[0]?.parts[0]?.type, "text")
    assert.equal(msgs[0]?.parts[0]?.text, "hello")
    assert.equal(msgs[1]?.info.role, "assistant")
    assert.equal(msgs[1]?.parts[0]?.type, "text")
    assert.equal(msgs[1]?.parts[0]?.text, "world")
    assert.deepEqual(next.getTodos("s1"), [{ id: "native-task-42", content: "Ship", status: "pending", priority: "high" }])
  })

  void it("migrates task identity without discarding existing todo rows", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    first.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: todoUpdated("s1", [
      { content: "Existing", status: "pending", priority: "medium" },
    ]) })
    db(first).exec("ALTER TABLE todo DROP COLUMN task_id")
    first.close()
    const next = new RuntimeStore(root)
    assert.deepEqual(next.getTodos("s1"), [{ content: "Existing", status: "pending", priority: "medium" }])
    next.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: todoUpdated("s1", [
      { id: "provider-task-7", content: "Existing", status: "completed", priority: "medium" },
    ]) })
    next.close()
    const reopened = new RuntimeStore(root)
    assert.deepEqual(reopened.getTodos("s1"), [{ id: "provider-task-7", content: "Existing", status: "completed", priority: "medium" }])
    reopened.close()
  })

  void it("retains only the latest full snapshot for each message part", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "opencode", modelID: "big-pickle" },
      parts: [{ type: "text", text: "hello" }],
    })
    for (const text of ["first", "second", "latest"]) {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: messagePartUpdated({
          id: "streaming-part",
          sessionID: "s1",
          messageID: "m1",
          type: "text",
          text,
        }),
      })
    }

    const snapshots = db(store)
      .prepare(
        `
      SELECT payload_json
      FROM runtime_journal
      WHERE session_id = ?
        AND type = 'message.part.updated'
        AND part_id = ?
      ORDER BY seq ASC
    `,
      )
      .all("s1", "streaming-part") as Array<{ payload_json: string }>
    assert.equal(snapshots.length, 1)
    assert.equal(JSON.parse(snapshots[0].payload_json).properties.part.text, "latest")
    store.close()

    const reopened = new RuntimeStore(root)
    const messages = reopened.getMessages("s1") as Array<{ parts: Array<{ id: string; text?: string }> }>
    assert.equal(messages[1]?.parts.find((part) => part.id === "streaming-part")?.text, "latest")
    reopened.close()
  })

  void it("rolls back failed session deletes and successful deletes survive replay", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "Demo",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: todoUpdated("s1", [{ content: "Ship", status: "pending", priority: "high" }]),
    })

    db(store).exec(`
      CREATE TRIGGER fail_message_delete
      BEFORE DELETE ON message
      BEGIN
        SELECT RAISE(FAIL, 'message delete failed');
      END
    `)

    assert.throws(() => store.deleteSession("s1"), /message delete failed/)
    db(store).exec("DROP TRIGGER fail_message_delete")

    assert.equal((store.getSession("s1") as any)?.title, "Demo")
    assert.equal(store.getMessages("s1").length, 2)
    assert.deepEqual(store.getTodos("s1"), [{ content: "Ship", status: "pending", priority: "high" }])

    store.deleteSession("s1")
    assert.equal(store.getSession("s1"), null)
    assert.deepEqual(store.getMessages("s1"), [])
    assert.deepEqual(store.getTodos("s1"), [])
    assert.equal(fs.existsSync(path.join(root, "sessions", "s1.jsonl")), false)
    store.close()

    const next = new RuntimeStore(root)
    assert.equal(next.getSession("s1"), null)
    assert.deepEqual(next.getMessages("s1"), [])
    assert.deepEqual(next.getTodos("s1"), [])
    next.close()
  })

  void it("rejects late event appends after session delete and does not resurrect on replay", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "Demo",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.deleteSession("s1")

    assert.throws(
      () =>
        store.appendEvent({
          sessionId: "s1",
          agentSessionId: "a1",
          payload: sessionUpdated({
            id: "s1",
            directory: "/work",
            title: "Late",
            time: { created: 1, updated: 2 },
          } as never),
        }),
      /deleted/,
    )

    const next = new RuntimeStore(root)
    assert.equal(next.getSession("s1"), null)
    next.close()
  })

  void it("preserves agent_session_id through status updates", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "agent-abc",
      createdAt: 1,
    })

    // agent_session_id is present after bind
    assert.equal(store.getAgentSessionId("s1"), "agent-abc")

    // startTurn calls upsertSession without agentSessionId — must not clear it
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "agent-abc",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    assert.equal(store.getAgentSessionId("s1"), "agent-abc")

    // session.idle event also must not clear it
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "agent-abc",
      payload: sessionIdle("s1"),
    })
    assert.equal(store.getAgentSessionId("s1"), "agent-abc")

    // Replay also preserves it
    const next = new RuntimeStore(root)
    assert.equal(next.getAgentSessionId("s1"), "agent-abc")
  })

  void it("preserves an active turn status through session metadata updates", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "New Session",
      agentSessionId: "agent-abc",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "agent-abc",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "openai", modelID: "gpt-5" },
      parts: [{ type: "text", text: "hello" }],
    })

    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "agent-abc",
      payload: sessionUpdated({
        id: "s1",
        directory: "/work",
        title: "Generated title",
        time: { created: 1, updated: 2 },
      } as never),
    })

    assert.equal((store.getSession("s1") as { status?: string } | null)?.status, "busy")

    const replay = new RuntimeStore(root)
    assert.equal((replay.getSession("s1") as { status?: string } | null)?.status, "busy")
  })

  void it("marks pending interactives stale after interruption", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: permissionAsked({
        id: "p1",
        sessionID: "s1",
        permission: "bash",
        patterns: ["/tmp"],
        metadata: {},
        always: ["/tmp"],
      }),
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: questionAsked({
        id: "q1",
        sessionID: "s1",
        questions: [
          {
            question: "Ship it?",
            header: "Ship it?",
            options: [{ label: "Yes", description: "Ship it" }],
            custom: false,
          },
        ],
      }),
    })
    first.markDirectorySessionsInterrupted("/work", "ACP process restarted")

    const next = new RuntimeStore(root)
    assert.deepEqual(next.listPermissions("/work"), [])
    assert.equal((next.getSession("s1") as any)?.status, "recovering")
    assert.equal(next.consumeRecoveryError("s1"), "ACP process restarted")
    assert.equal(next.consumeRecoveryError("s1"), null)

    const afterAck = new RuntimeStore(root)
    assert.equal(afterAck.consumeRecoveryError("s1"), null)
  })

  void it("lists replayed pending questions from the durable projection", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: questionAsked({
        id: "q1",
        sessionID: "s1",
        questions: [
          {
            question: "Ship it?",
            header: "Ship it?",
            options: [{ label: "Yes", description: "Ship it" }],
            custom: false,
          },
        ],
      }),
    })
    first.close()

    const next = new RuntimeStore(root)
    assert.deepEqual(
      next.listQuestions("/work").map((row) => row.id),
      ["q1"],
    )
    next.close()
  })

  void it("marks only matching owner-key sessions stale after interruption", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      ownerKey: "process-a",
      createdAt: 1,
    })
    first.bindSession({
      sessionId: "s2",
      directory: "/work",
      agentSessionId: "a2",
      ownerKey: "process-b",
      createdAt: 2,
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: permissionAsked({
        id: "p1",
        sessionID: "s1",
        permission: "bash",
        patterns: ["/tmp/a"],
        metadata: {},
        always: ["/tmp/a"],
      }),
    })
    first.appendEvent({
      sessionId: "s2",
      agentSessionId: "a2",
      payload: permissionAsked({
        id: "p2",
        sessionID: "s2",
        permission: "bash",
        patterns: ["/tmp/b"],
        metadata: {},
        always: ["/tmp/b"],
      }),
    })
    first.markSessionsInterruptedByOwner("process-a", "ACP shared process exited")

    const next = new RuntimeStore(root)
    assert.equal(next.getSessionOwnerKey("s1"), "process-a")
    assert.deepEqual(next.listSessionsByOwnerKey("process-b"), ["s2"])
    assert.deepEqual(
      next.listPermissions("/work").map((row) => row.id),
      ["p2"],
    )
    assert.equal((next.getSession("s1") as { status?: string } | null)?.status, "recovering")
    assert.equal((next.getSession("s2") as { status?: string } | null)?.status, undefined)
  })

  void it("terminalizes running tool parts after interruption", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messagePartUpdated({
        id: "tool-1",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        callID: "call-1",
        tool: "task",
        state: {
          status: "running",
          input: {},
          time: { start: 2 },
        },
      }),
    })

    first.markDirectorySessionsInterrupted("/work", "ACP process restarted; pending interactive state must be rerun")

    const current = first.getMessages("s1") as Array<{
      parts: Array<{ id: string; type: string; state?: { status?: string; error?: string } }>
    }>
    const toolPart = current[1]?.parts.find((part) => part.id === "tool-1")
    assert.equal(toolPart?.id, "tool-1")
    assert.equal(toolPart?.type, "tool")
    assert.equal(toolPart?.state?.status, "error")
    assert.equal(toolPart?.state?.error, "Tool execution interrupted by ACP restart")

    const next = new RuntimeStore(root)
    const replayed = next.getMessages("s1") as Array<{
      parts: Array<{ id: string; type: string; state?: { status?: string; error?: string } }>
    }>
    const replayedPart = replayed[1]?.parts.find((part) => part.id === "tool-1")
    assert.equal(replayedPart?.id, "tool-1")
    assert.equal(replayedPart?.type, "tool")
    assert.equal(replayedPart?.state?.status, "error")
    assert.equal(replayedPart?.state?.error, "Tool execution interrupted by ACP restart")
    assert.equal((next.getSession("s1") as any)?.status, "recovering")
  })

  void it("renders stale running tools in completed error messages as interrupted", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messagePartUpdated({
        id: "tool-1",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        callID: "call-1",
        tool: "read",
        state: {
          status: "running",
          input: {},
          time: { start: 2 },
        },
      }),
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messageUpdated({
        id: "m1",
        sessionID: "s1",
        role: "assistant",
        parentID: "u1",
        time: { created: 1, completed: 3 },
        error: {
          name: "UnknownError",
          data: { message: "ACP prompt timed out after 300000ms of inactivity" },
        },
      } as any),
    })

    const current = store.getMessages("s1") as Array<{
      parts: Array<{ id: string; type: string; state?: { status?: string; error?: string } }>
    }>
    const toolPart = current[1]?.parts.find((part) => part.id === "tool-1")
    assert.equal(toolPart?.state?.status, "error")
    assert.equal(toolPart?.state?.error, "Tool execution interrupted")
  })

  void it("marks busy sessions recovering through explicit runtime recovery", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    first.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messagePartUpdated({
        id: "tool-1",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        callID: "call-1",
        tool: "read",
        state: {
          status: "running",
          input: {},
          time: { start: 2 },
        },
      }),
    })

    const next = new RuntimeStore(root)
    assert.equal((next.getSession("s1") as any)?.status, "busy")
    next.recoverBusySessions()
    assert.equal((next.getSession("s1") as any)?.status, "recovering")
    assert.equal(
      (next.getSession("s1") as any)?.recovery_error,
      "ACP process restarted; pending interactive state must be rerun",
    )
    const current = next.getMessages("s1") as Array<{
      parts: Array<{ id: string; type: string; state?: { status?: string; error?: string } }>
    }>
    const toolPart = current[1]?.parts.find((part) => part.id === "tool-1")
    assert.equal(toolPart?.state?.status, "error")
    assert.equal(toolPart?.state?.error, "Tool execution interrupted by ACP restart")
  })

  void it("recoverBusySessions is a no-op when no sessions are busy", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    // No turn started, so the session is idle rather than busy.
    first.close()

    const next = new RuntimeStore(root)
    const before = (next.getSession("s1") as { status?: string } | null)?.status ?? null
    next.recoverBusySessions()
    const after = next.getSession("s1") as { status?: string; recovery_error?: string | null } | null
    // Idle sessions are left untouched: not flipped to "recovering", no marker.
    assert.equal(after?.status ?? null, before)
    assert.notEqual(after?.status, "recovering")
    assert.equal(after?.recovery_error ?? null, null)
  })

  void it("finishTurn clears a busy turn through replayable terminal events", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      parts: [{ type: "text", text: "hello" }],
    })

    assert.equal((store.getSession("s1") as { status?: string } | null)?.status, "busy")
    store.finishTurn({
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "completed", completedAt: 123 },
    })
    assert.equal((store.getSession("s1") as { status?: string } | null)?.status, "idle")
    assert.equal(
      (store.getSession("s1") as { lastTurn?: { assistantMessageId?: string } } | null)?.lastTurn?.assistantMessageId,
      "m1",
    )

    const rows = journal(root, "s1")
    assert.equal(rows.at(-3)?.type, "message.completed")
    assert.equal(rows.at(-2)?.type, "session.idle")
    assert.equal(rows.at(-1)?.type, "turn.finish")

    const replayed = new RuntimeStore(root)
    assert.equal((replayed.getSession("s1") as { status?: string } | null)?.status, "idle")
    assert.equal(
      (replayed.getMessages("s1")[1]?.info.time as { completed?: number } | undefined)?.completed !== undefined,
      true,
    )
  })

  void it("persists the durable generation and rejects every stale producer write after takeover", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    const start = (assistantMessageId: string, fencingToken: number) => first.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: `${assistantMessageId}_user`,
      assistantMessageId,
      agent: "general",
      model: { providerID: "opencode", modelID: "test" },
      parts: [{ type: "text", text: assistantMessageId }],
      fencingToken,
    })

    start("m1", 4)
    first.appendEvent({ sessionId: "s1", payload: sessionIdle("s1"), fencingToken: 4 })
    start("m2", 5)
    assert.throws(
      () => first.appendEvent({ sessionId: "s1", payload: sessionIdle("s1"), fencingToken: 4 }),
      AgentRuntimeStaleTurnError,
    )
    assert.throws(
      () => first.finishTurn({
        sessionId: "s1",
        assistantMessageId: "m1",
        outcome: { status: "completed", completedAt: 10 },
        fencingToken: 4,
      }),
      AgentRuntimeStaleTurnError,
    )
    first.close()

    const reconstructed = new RuntimeStore(root)
    assert.throws(
      () => reconstructed.appendEvent({ sessionId: "s1", payload: sessionIdle("s1"), fencingToken: 4 }),
      AgentRuntimeStaleTurnError,
    )
    reconstructed.appendEvent({ sessionId: "s1", payload: sessionIdle("s1"), fencingToken: 5 })
    reconstructed.finishTurn({
      sessionId: "s1",
      assistantMessageId: "m2",
      outcome: { status: "completed", completedAt: 11 },
      fencingToken: 5,
    })
  })

  void it("commits exact usage before terminal lifecycle records", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "claude-sdk", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: sessionUsage({
        sessionID: "s1",
        messageID: "m1",
        contextSize: 200_000,
        contextUsed: 24_542,
        observation: {
          kind: "cumulative",
          tokens: {
            input: 4,
            output: 679,
            reasoning: null,
            cache: { read: 21_144, write: 2_715 },
          },
        },
      }),
    })
    store.finishTurn({
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "completed", completedAt: 123 },
    })

    const rows = journal(root, "s1")
    assert.deepEqual(
      rows.slice(-4).map((row) => row.type),
      ["session.usage", "message.completed", "session.idle", "turn.finish"],
    )
    assert.deepEqual((rows.at(-4)?.payload.properties as { observation?: unknown } | undefined)?.observation, {
      kind: "cumulative",
      tokens: {
        input: 4,
        output: 679,
        reasoning: null,
        cache: { read: 21_144, write: 2_715 },
      },
    })
  })

  void it("finishTurn does not duplicate terminal events already committed by an adapter", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "opencode", modelID: "big-pickle" },
      parts: [{ type: "text", text: "hello" }],
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: messageCompleted("s1", "m1"),
    })
    store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: sessionIdle("s1"),
    })

    store.finishTurn({
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "completed", completedAt: 123 },
    })

    const rows = journal(root, "s1")
    assert.equal(rows.filter((row) => row.type === "message.completed").length, 1)
    assert.equal(rows.filter((row) => row.type === "session.idle").length, 1)
    assert.equal(
      (store.getSession("s1") as { lastTurn?: { assistantMessageId?: string } } | null)?.lastTurn?.assistantMessageId,
      "m1",
    )
  })

  void it("finishTurn durably preserves a cancelled outcome", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "build",
      model: { providerID: "codex-app-server", modelID: "gpt-5.5" },
      parts: [{ type: "text", text: "hello" }],
    })

    store.finishTurn({
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "cancelled", completedAt: 123, reason: "abort" },
    })

    assert.deepEqual((store.getSession("s1") as { lastTurn?: unknown } | null)?.lastTurn, {
      status: "cancelled",
      completedAt: 123,
      reason: "abort",
      assistantMessageId: "m1",
    })
    store.finishTurn({
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "completed", completedAt: 124 },
    })
    assert.deepEqual((store.getSession("s1") as { lastTurn?: unknown } | null)?.lastTurn, {
      status: "cancelled",
      completedAt: 123,
      reason: "abort",
      assistantMessageId: "m1",
    })
    assert.equal(journal(root, "s1").filter((row) => row.type === "turn.finish").length, 1)

    const replayed = new RuntimeStore(root)
    assert.deepEqual((replayed.getSession("s1") as { lastTurn?: unknown } | null)?.lastTurn, {
      status: "cancelled",
      completedAt: 123,
      reason: "abort",
      assistantMessageId: "m1",
    })
  })

  void it("finishTurn records failed turns on the assistant message", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "build",
      model: { providerID: "codex-app-server", modelID: "gpt-5.5" },
      parts: [{ type: "text", text: "hello" }],
    })

    const finished = store.finishTurn({
      sessionId: "s1",
      assistantMessageId: "m1",
      outcome: { status: "failed", completedAt: 123, error: "The database connection is not open" },
    })

    assert.deepEqual(finished?.events.map((event) => event.type), ["message.updated", "session.error"])

    const assistant = store.getMessages("s1")[1]?.info as {
      error?: { data?: { message?: string; firstTurnErrorClass?: string } }
    }
    assert.equal(assistant.error?.data?.message, "The database connection is not open")
    assert.equal(assistant.error?.data?.firstTurnErrorClass, "unknown")
    assert.equal(
      (store.getSession("s1") as { lastTurn?: { assistantMessageId?: string } } | null)?.lastTurn?.assistantMessageId,
      "m1",
    )

    const rows = journal(root, "s1")
    assert.equal(rows.at(-3)?.type, "message.updated")
    assert.equal(rows.at(-2)?.type, "session.error")
    assert.equal(rows.at(-1)?.type, "turn.finish")

    const replayed = new RuntimeStore(root)
    const replayedAssistant = replayed.getMessages("s1")[1]?.info as {
      error?: { data?: { message?: string; firstTurnErrorClass?: string } }
    }
    assert.equal(replayedAssistant.error?.data?.message, "The database connection is not open")
    assert.equal(replayedAssistant.error?.data?.firstTurnErrorClass, "unknown")
  })

  void it("recoverBusySessions is idempotent once a session is recovering", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    })

    const next = new RuntimeStore(root)
    const session = () => next.getSession("s1") as { status?: string; recovery_error?: string | null } | null
    assert.equal(session()?.status, "busy")
    next.recoverBusySessions()
    const firstError = session()?.recovery_error
    assert.equal(session()?.status, "recovering")
    assert.equal(firstError, "ACP process restarted; pending interactive state must be rerun")

    // A second recovery pass finds no busy sessions (the first pass flipped it to
    // "recovering"), so the marker is unchanged.
    next.recoverBusySessions()
    assert.equal(session()?.status, "recovering")
    assert.equal(session()?.recovery_error, firstError)
  })

  void it("returns normalized session objects from the store", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      title: "Demo",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.updateSession("s1", { time: { archived: 0 } })

    const sessions = store.listSessions("/work") as any[]
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.id, "s1")
    assert.equal(sessions[0]?.title, "Demo")
    assert.equal(sessions[0]?.directory, "/work")
    assert.equal(sessions[0]?.agent_session_id, "a1")
    assert.equal(sessions[0]?.time?.created, 1)
    assert.equal(typeof sessions[0]?.time?.updated, "number")
    assert.equal(sessions[0]?.time?.archived, 0)

    const session = store.getSession("s1") as any
    assert.equal(session?.id, "s1")
    assert.equal(session?.title, "Demo")
    assert.equal(session?.directory, "/work")
    assert.equal(session?.agent_session_id, "a1")
    assert.equal(session?.time?.created, 1)
    assert.equal(session?.time?.archived, 0)

    const next = new RuntimeStore(root)
    assert.equal((next.getSession("s1") as any)?.time?.archived, 0)
  })

  void it("persists permission selection across reopen and clears it on a harness change", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({ sessionId: "restricted", directory: "/work", agentSessionId: "a1" })
    first.updateSessionConfig("restricted", { harness: { id: "codex", access: "native" }, permissionCeiling: "ask", permissionMode: "read-only", permissionState: { allow: ["Bash(printf approved-write *)"] } })
    first.updateSessionConfig("restricted", { agent: "build" })
    const reopened = new RuntimeStore(root)
    assert.equal(reopened.getSessionConfig("restricted")?.permissionCeiling, "ask")
    assert.equal(reopened.getSessionConfig("restricted")?.permissionMode, "read-only")
    assert.deepEqual(reopened.getSessionConfig("restricted")?.permissionState, { allow: ["Bash(printf approved-write *)"] })
    reopened.updateSessionConfig("restricted", { harness: { id: "claude", access: "native" } })
    assert.equal(reopened.getSessionConfig("restricted")?.permissionCeiling, "ask")
    assert.equal(reopened.getSessionConfig("restricted")?.permissionMode, undefined)
    assert.equal(reopened.getSessionConfig("restricted")?.permissionState, undefined)
  })

  void it("persists session config across replay", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.updateSessionConfig("s1", {
      harness: {
        id: "openclaw",
        access: "connection",
      },
      model: {
        providerID: "acp:openclaw",
        modelID: "sonnet",
      },
      variant: "max",
      agent: "plan",
    })

    const expectedConfig = {
      harness: {
        id: "openclaw",
        access: "connection",
      },
      model: {
        providerID: "acp:openclaw",
        modelID: "sonnet",
      },
      variant: "max",
      agent: "plan",
    }
    assert.deepEqual(first.getSessionConfig("s1"), expectedConfig)

    const next = new RuntimeStore(root)
    assert.deepEqual(next.getSessionConfig("s1"), expectedConfig)
  })

  void it("persists and clears a pending cross-harness handoff", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    first.updateSessionConfig("s1", {
      harness: { id: "claude", access: "native" },
      handoff: {
        from: { id: "pi", access: "native" },
        pending: true,
        transcript: '<session-handoff from="pi">\n\nremember Tommy\n\n</session-handoff>',
      },
    })

    const replayed = new RuntimeStore(root)
    assert.deepEqual(replayed.getSessionConfig("s1")?.handoff, {
      from: { id: "pi", access: "native" },
      pending: true,
      transcript: '<session-handoff from="pi">\n\nremember Tommy\n\n</session-handoff>',
    })

    replayed.updateSessionConfig("s1", { handoff: null })
    assert.equal(replayed.getSessionConfig("s1")?.handoff, undefined)
    assert.equal(new RuntimeStore(root).getSessionConfig("s1")?.handoff, undefined)
  })

})

void describe("RuntimeStore session projection cost", () => {
  void it("resolves lastTurn through the terminal-row partial index instead of walking the journal", () => {
    const root = tmp()
    const store = new RuntimeStoreImpl(root)
    const db = (store as unknown as { db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } } }).db
    // The same statement `lastTurn` runs. If the predicate drifts from the
    // index predicate the planner silently falls back to the primary key and
    // every session read scans that session's whole journal again.
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT seq, type, created_at, payload_json
      FROM runtime_journal
      WHERE session_id = ?
        AND (
          (kind = 'control' AND type = 'turn.finish')
          OR (kind = 'event' AND type IN ('message.completed', 'session.error'))
        )
      ORDER BY seq DESC
      LIMIT 1
    `).all("s1") as Array<{ detail: string }>
    assert.ok(
      plan.some((row) => row.detail.includes("runtime_journal_turn_outcome_idx")),
      `lastTurn does not use runtime_journal_turn_outcome_idx: ${plan.map((row) => row.detail).join(" | ")}`,
    )
    store.close()
  })
})

void describe("canonical execution binding", () => {
  void it("persists the complete binding and never derives it from provider inventory", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      directory: "/work/a",
      connectionId: "native:pi",
      upstreamSessionId: "thread-1",
      agentSessionId: "thread-1",
    })
    assert.deepEqual(store.getExecutionBinding("session-1"), {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      directory: "/work/a",
      connectionId: "native:pi",
      upstreamSessionId: "thread-1",
    })
    assert.equal((store.getSession("session-1") as { workspaceId?: string })?.workspaceId, "workspace-1")
    assert.equal((store.listSessions("/work/a")[0] as { workspaceId?: string })?.workspaceId, "workspace-1")
    const reopened = new RuntimeStore(root)
    assert.deepEqual(reopened.getExecutionBinding("session-1"), store.getExecutionBinding("session-1"))
    assert.equal(reopened.getExecutionBinding("provider-only"), null)
  })
})

void describe("provisional user parts", () => {
  /**
   * Three layers each record the user's prompt, each minting its own id:
   *   `${messageId}-part-N`       — this store's `inputParts` (via startTurn)
   *   `NNNNNN_${messageId}-input` — the opencode adapter's `promptParts`
   *   `prt_…`                     — the engine's own persisted part
   * Captured live: ONE send produced all three, so the transcript rendered the
   * prompt three times. The provider request always carried one part, so this
   * was transcript fidelity, never model input.
   */
  const engineCanonical = (messageId: string, text: string) =>
    messagePartUpdated({
      id: "prt_fbf520445001MRpnaorKB7bmPL",
      sessionID: "s1",
      messageID: messageId,
      type: "text",
      text,
    })

  function seeded(root: string) {
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    // startTurn writes this store's own provisional part: `u1-part-0`.
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "test-provider", modelID: "test-model" },
      parts: [{ type: "text", text: "UNIQUE-PROMPT-XYZ" }],
    })
    return store
  }

  const userParts = (store: RuntimeStore) =>
    (
      (store.getMessages("s1") as Array<{ info: { id: string }; parts: Array<{ id: string }> }>).find(
        (message) => message.info.id === "u1",
      )?.parts ?? []
    ).map((part) => part.id)

  void it("keeps provisional parts while NO canonical part exists — nothing is dropped without a replacement", () => {
    // The durability case these writers exist for: the engine never responds.
    const store = seeded(tmp())

    const parts = userParts(store)
    assert.ok(parts.length > 0, "a turn whose engine never answered must still show the user's prompt")
    assert.deepEqual(parts, ["u1-part-0"])
    store.close()
  })

  void it("keeps a multi-part prompt whole while the engine has persisted only some of it", () => {
    // The engine mints its own ids (`prt_…`), so there is NO id correspondence
    // between a canonical part and the provisional it replaces. Retiring every
    // provisional the moment ONE canonical part landed therefore erased the
    // second half of a two-part prompt outright — the attachment case. A
    // replacement must be in hand for each provisional before any is dropped,
    // and with no id to match on, count is the only honest proxy.
    const store = new RuntimeStore(tmp())
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "general",
      model: { providerID: "test-provider", modelID: "test-model" },
      parts: [
        { type: "text", text: "PROMPT" },
        { type: "text", text: "ATTACHED" },
      ],
    })
    const canonical = (id: string, text: string) =>
      messagePartUpdated({ id, sessionID: "s1", messageID: "u1", type: "text", text })

    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: canonical("prt_first", "PROMPT") })
    assert.deepEqual(
      userParts(store).sort(),
      ["prt_first", "u1-part-0", "u1-part-1"],
      "one canonical part cannot replace two provisionals — the prompt must stay whole",
    )

    // Once the engine has persisted the whole prompt, the provisionals go.
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: canonical("prt_second", "ATTACHED") })
    assert.deepEqual(userParts(store).sort(), ["prt_first", "prt_second"])
    store.close()
  })

  void it("a canonical part on ONE user message leaves another's provisionals alone", () => {
    // The mutation this exists to catch: a predicate matching id SHAPE alone
    // (any `*-part-N`) rather than THIS message's id would retire
    // a second turn's provisionals the moment the first turn's engine part
    // landed. Needs two user messages, each holding provisionals, to discriminate.
    const store = seeded(tmp())
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u2",
      assistantMessageId: "m2",
      agent: "general",
      model: { providerID: "test-provider", modelID: "test-model" },
      parts: [{ type: "text", text: "SECOND" }],
    })
    // u1's engine part lands; u2's turn is still in flight.
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: engineCanonical("u1", "FIRST") })

    const u2 = (
      (store.getMessages("s1") as Array<{ info: { id: string }; parts: Array<{ id: string }> }>).find(
        (message) => message.info.id === "u2",
      )?.parts ?? []
    ).map((part) => part.id)
    assert.deepEqual(u2, ["u2-part-0"], "u2's provisional must survive u1's canonical part")
    store.close()
  })

  void it("does not retire another message's provisional parts", () => {
    const store = seeded(tmp())
    // A canonical part on the ASSISTANT message must not touch the user's.
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: engineCanonical("m1", "OK") })

    // The user's provisional must survive: a predicate that matched on id shape
    // alone rather than on this message's id would retire it.
    assert.deepEqual(userParts(store), ["u1-part-0"])
    store.close()
  })
})


void it("persists Goal state across reopen and clears it with the session", () => {
  const root = tmp()
  const store = new RuntimeStore(root)
  store.bindSession({ sessionId: "goal-session", directory: "/work", agentSessionId: "pi-native" })
  const goal = { sessionId: "goal-session", objective: "Verify the workspace", status: "active" as const, iteration: 0, createdAt: 1, updatedAt: 1 }
  store.setGoal("goal-session", goal)
  assert.deepEqual(store.getGoal("goal-session"), goal)
  assert.ok(journal(root, "goal-session").some((row) => row.type === "goal.update"))
  const reopened = new RuntimeStore(root)
  assert.deepEqual(reopened.getGoal("goal-session"), goal)
  reopened.setGoal("goal-session", { ...goal, status: "paused", updatedAt: 2 })
  assert.equal(store.getGoal("goal-session")?.status, "paused")
  reopened.setGoal("goal-session", null)
  assert.equal(new RuntimeStore(root).getGoal("goal-session"), null)
  reopened.setGoal("goal-session", goal)
  reopened.deleteSession("goal-session")
  assert.equal(store.getGoal("goal-session"), null)
})

void describe("session ordering timestamps", () => {
  void it("recovery does not restamp the session the way a turn does", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1_000 })
    store.startTurn({
      sessionId: "s1",
      assistantMessageId: "m1",
      agent: "claude",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      parts: [{ type: "text", text: "hi" }],
    })

    // A turn and a recovery both stamp `Date.now()`, so within one test run they are
    // the same millisecond and indistinguishable. Pin the turn's stamp to a value the
    // clock cannot produce, so a restamp is visible.
    const db = (store as unknown as { db: { prepare(sql: string): { run(...p: unknown[]): unknown } } }).db
    db.prepare("UPDATE session SET updated_at = ? WHERE id = ?").run(111, "s1")

    // The three recovery paths: the runtime's own bookkeeping, never the reader
    // speaking to the session, so the sidebar must not reorder behind them.
    store.markRecovering("s1", "recovering")
    store.createNotice("s1", { notice: "recovery_error", message: "created notice" })
    store.markDirectorySessionsInterrupted("/work", "ACP process restarted")

    const after = store.getSession("s1") as
      | { status?: string; time?: { created?: number; updated?: number } }
      | null
    assert.equal(after?.status, "recovering")
    assert.equal(after?.time?.updated, 111)
    assert.equal(after?.time?.created, 1_000)
  })

  void it("only a human turn records lastHumanTurn; an agent turn moves updated alone", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    const turn = (sessionId: string, actorKind?: "human" | "agent") =>
      store.startTurn({
        sessionId,
        assistantMessageId: `m-${sessionId}-${actorKind ?? "none"}`,
        agent: "claude",
        model: { providerID: "anthropic", modelID: "claude-opus-5" },
        parts: [{ type: "text", text: "hi" }],
        ...(actorKind ? { actorId: "actor-1", actorKind } : {}),
      })
    const read = (id: string) =>
      store.getSession(id) as { time?: { updated?: number; lastHumanTurn?: number } } | null

    store.bindSession({ sessionId: "human", directory: "/work", agentSessionId: "ah", createdAt: 1 })
    store.bindSession({ sessionId: "agent", directory: "/work", agentSessionId: "aa", createdAt: 1 })
    turn("human", "human")
    turn("agent", "agent")

    assert.ok(typeof read("human")?.time?.lastHumanTurn === "number")
    // A wake or subagent driving a session must not make it look freshly spoken to.
    assert.equal(read("agent")?.time?.lastHumanTurn, undefined)
    assert.ok(typeof read("agent")?.time?.updated === "number")
  })

  void it("an agent turn after a human one leaves the human stamp where it was", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.startTurn({
      sessionId: "s1",
      assistantMessageId: "m1",
      agent: "claude",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      parts: [{ type: "text", text: "hi" }],
      actorId: "actor-1",
      actorKind: "human",
    })
    const db = (store as unknown as { db: { prepare(sql: string): { run(...p: unknown[]): unknown } } }).db
    db.prepare("UPDATE session SET last_human_turn_at = ? WHERE id = ?").run(222, "s1")

    store.startTurn({
      sessionId: "s1",
      assistantMessageId: "m2",
      agent: "claude",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      parts: [{ type: "text", text: "wake" }],
      actorId: "wake-1",
      actorKind: "agent",
    })

    const after = store.getSession("s1") as { time?: { lastHumanTurn?: number } } | null
    assert.equal(after?.time?.lastHumanTurn, 222)
  })

  void it("the directory listing carries lastHumanTurn, which is what the session list orders on", () => {
    const root = tmp()
    const store = new RuntimeStore(root)
    store.bindSession({ sessionId: "spoken", directory: "/work", agentSessionId: "a1", createdAt: 1 })
    store.bindSession({ sessionId: "quiet", directory: "/work", agentSessionId: "a2", createdAt: 2 })
    store.startTurn({
      sessionId: "spoken",
      assistantMessageId: "m1",
      agent: "claude",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      parts: [{ type: "text", text: "hi" }],
      actorId: "actor-1",
      actorKind: "human",
    })
    store.startTurn({
      sessionId: "quiet",
      assistantMessageId: "m2",
      agent: "claude",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
      parts: [{ type: "text", text: "wake" }],
      actorId: "wake-1",
      actorKind: "agent",
    })

    const rows = store.listSessions("/work") as Array<{ id: string; time?: { lastHumanTurn?: number } }>
    const by = new Map(rows.map((row) => [row.id, row.time?.lastHumanTurn]))
    assert.ok(typeof by.get("spoken") === "number")
    assert.equal(by.get("quiet"), undefined)
  })
})
