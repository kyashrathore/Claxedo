import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import { createSubagentAdmissionBoundary } from "@claxedo/agent-sdk-runtime"
import { AgentMessagePageError } from "@claxedo/agent-sdk-runtime/adapters"
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

describe("RuntimeStore", () => {
  it("creates new session storage with harness columns instead of runner columns", () => {
    const store = new RuntimeStore(tmp())
    const columns = sessionColumns(store)
    assert(columns.includes("harness_id"))
    assert(columns.includes("harness_access"))
    assert(columns.includes("parent_id"))
    assert(!columns.some((name) => name.startsWith("runner_")))
  })

  it("persists explicit child Session ownership across updates and reopen", () => {
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

  it("durably admits revisioned subagents and rehydrates correlation after reopen", async () => {
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

  it("serializes key and revision admission across concurrently open stores", () => {
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

  it("preserves terminal subagent status after a late active observation and reopen", () => {
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

  it("interrupts active children on archive while preserving durable history", () => {
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

  it("reconciles disconnected foreground children and deletes child ownership atomically", () => {
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

  it("migrates legacy runner columns into harness session config fields", () => {
    const store = new RuntimeStore(tmp())
    db(store).exec("ALTER TABLE session ADD COLUMN runner_type TEXT")
    db(store).exec("ALTER TABLE session ADD COLUMN runner_binary TEXT")
    db(store).exec("ALTER TABLE session ADD COLUMN runner_model TEXT")
    db(store)
      .prepare(
        `
      INSERT INTO session (
        id,
        directory,
        runner_type,
        runner_binary,
        runner_model,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run("legacy", "/work", "claude-acp", "/bin/claude-agent-acp", "sonnet", 1, 2)

    ;(store as unknown as { migrateLegacyRunnerColumns(): void }).migrateLegacyRunnerColumns()

    assert.deepEqual(store.getSessionConfig("legacy"), {
      harness: {
        id: "claude",
        access: "acp",
        connection: {
          kind: "process",
          binary: "/bin/claude-agent-acp",
        },
      },
      model: {
        providerID: "claude-acp",
        modelID: "sonnet",
      },
      variant: null,
      agent: null,
    })
  })

  it("journals before projecting so replay recovers when projection fails", () => {
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

  it("rolls back failed projection transactions and replays the journaled row later", () => {
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

  it("returns committed append output after projection commits", () => {
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

  it("returns committed turn-start output after projection commits", () => {
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

  it("pages projected messages backward with an opaque cursor and bounded hydration", () => {
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

  it("returns the chronological latest turn and continues before its user boundary", () => {
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

  it("returns only the owning user and final message for the latest surface without losing intermediates", () => {
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
    assert.deepEqual((complete.messages[0]?.info as Record<string, unknown>).summary, {
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

  it("bounds oversized user/assistant text, assistant errors, and many small parts while latest-turn stays complete", () => {
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
    assert.deepEqual(surface.messages[0]?.parts, [])
    assert.equal((surface.messages[1]?.info as Record<string, unknown>).error, undefined)
    assert.deepEqual(
      surface.messages[1]?.parts.map((part: any) => part.id),
      Array.from({ length: LATEST_SURFACE_MAX_TEXT_PARTS }, (_, index) => `assistant-small-${index + 4}`),
    )

    const complete = store.getMessagePage("s1", { view: "latest-turn" })
    assert.ok(complete)
    assert.equal((complete.messages[0]?.parts[0] as any).text, oversizedUser)
    assert.equal((complete.messages[1]?.parts[0] as any).text, oversizedAssistant)
    assert.deepEqual((complete.messages[1]?.info as Record<string, unknown>).error, error)
    assert.equal(complete.messages[1]?.parts.length, 21)
    store.close()
  })

  it("does not invent a surface cursor for an adjacent user and final assistant", () => {
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

  it("rejects a latest surface whose assistant is not owned by its user boundary", () => {
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

  it("returns a user-only live turn without inventing an older-history cursor", () => {
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

  it("rejects invalid, cross-session, and missing-session message page cursors", () => {
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

  it("journals every public durable runtime mutation before projection state", () => {
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
      runner: { type: "opencode" },
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
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

  it("closes idempotently and allows the store root to reopen", () => {
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

  it("reopens checkpointed projections without resetting or replaying durable history", () => {
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

  it("imports legacy JSONL once and replays from the SQLite journal", () => {
    const root = tmp()
    fs.mkdirSync(path.join(root, "sessions"), { recursive: true })
    fs.writeFileSync(
      path.join(root, "sessions", "s1.jsonl"),
      JSON.stringify({
        seq: 1,
        ts: 1,
        sessionId: "s1",
        agentSessionId: "a1",
        kind: "control",
        control: {
          type: "session.bind",
          directory: "/work",
          agentSessionId: "a1",
          createdAt: 1,
        },
      }) + "\n",
    )

    const first = new RuntimeStore(root)
    assert.equal(first.getAgentSessionId("s1"), "a1")
    first.close()

    fs.rmSync(path.join(root, "sessions", "s1.jsonl"), { force: true })

    const next = new RuntimeStore(root)
    assert.equal(next.getAgentSessionId("s1"), "a1")
    next.close()
  })

  it("exports JSONL debug output from the SQLite runtime journal", () => {
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

  it("replays journaled messages and todos", () => {
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
      payload: todoUpdated("s1", [{ content: "Ship", status: "pending", priority: "high" }]),
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
    assert.deepEqual(next.getTodos("s1"), [{ content: "Ship", status: "pending", priority: "high" }])
  })

  it("retains only the latest full snapshot for each message part", () => {
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
    assert.equal(JSON.parse(snapshots[0]!.payload_json).properties.part.text, "latest")
    store.close()

    const reopened = new RuntimeStore(root)
    const messages = reopened.getMessages("s1") as Array<{ parts: Array<{ id: string; text?: string }> }>
    assert.equal(messages[1]?.parts.find((part) => part.id === "streaming-part")?.text, "latest")
    reopened.close()
  })

  it("rolls back failed session deletes and successful deletes survive replay", () => {
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

  it("rejects late event appends after session delete and does not resurrect on replay", () => {
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

  it("preserves agent_session_id through status updates", () => {
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

  it("preserves an active turn status through session metadata updates", () => {
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

  it("marks pending interactives stale after interruption", () => {
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

  it("lists replayed pending questions from the durable projection", () => {
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

  it("marks only matching owner-key sessions stale after interruption", () => {
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

  it("terminalizes running tool parts after interruption", () => {
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

  it("renders stale running tools in completed error messages as interrupted", () => {
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

  it("marks busy sessions recovering through explicit runtime recovery", () => {
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

  it("recoverBusySessions is a no-op when no sessions are busy", () => {
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

  it("finishTurn clears a busy turn through replayable terminal events", () => {
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

  it("commits exact usage before terminal lifecycle records", () => {
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

  it("finishTurn does not duplicate terminal events already committed by an adapter", () => {
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

  it("finishTurn durably preserves a cancelled outcome", () => {
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

  it("finishTurn records failed turns on the assistant message", () => {
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
      outcome: { status: "failed", completedAt: 123, error: "The database connection is not open" },
    })

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

  it("recoverBusySessions is idempotent once a session is recovering", () => {
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

  it("returns normalized session objects from the store", () => {
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

  it("persists session config across replay", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.updateSessionConfig("s1", {
      runner: {
        type: "claude-acp",
        binary: "/tmp/claude-agent-acp",
        model: "sonnet",
        transport: "streamable-http",
        url: "http://127.0.0.1:7331/acp",
        headers: {
          Authorization: "Bearer test-token",
        },
      },
      model: {
        providerID: "claude-acp",
        modelID: "sonnet",
      },
      variant: "max",
      agent: "plan",
    })

    const expectedConfig = {
      harness: {
        id: "claude",
        access: "acp",
        connection: {
          kind: "remote",
          transport: "streamable-http",
          url: "http://127.0.0.1:7331/acp",
          headers: {
            Authorization: "Bearer test-token",
          },
        },
      },
      model: {
        providerID: "claude-acp",
        modelID: "sonnet",
      },
      variant: "max",
      agent: "plan",
    }
    assert.deepEqual(first.getSessionConfig("s1"), expectedConfig)

    const next = new RuntimeStore(root)
    assert.deepEqual(next.getSessionConfig("s1"), expectedConfig)
  })

  it("persists and clears a pending cross-harness handoff", () => {
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

  it("normalizes http transport spelling across replay", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    first.updateSessionConfig("s1", {
      runner: {
        type: "claude-acp",
        transport: "http",
        url: "http://127.0.0.1:7331/acp",
      },
    } as unknown as Parameters<RuntimeStore["updateSessionConfig"]>[1])

    assert.deepEqual(first.getSessionConfig("s1"), {
      harness: {
        id: "claude",
        access: "acp",
        connection: {
          kind: "remote",
          transport: "streamable-http",
          url: "http://127.0.0.1:7331/acp",
        },
      },
      variant: null,
      agent: null,
    })

    const next = new RuntimeStore(root)
    assert.deepEqual(next.getSessionConfig("s1"), {
      harness: {
        id: "claude",
        access: "acp",
        connection: {
          kind: "remote",
          transport: "streamable-http",
          url: "http://127.0.0.1:7331/acp",
        },
      },
      variant: null,
      agent: null,
    })
  })

  it("persists config-only OpenCode sessions across replay", () => {
    const root = tmp()
    const first = new RuntimeStore(root)
    first.updateSessionConfig(
      "s-opencode",
      {
        runner: { type: "opencode" },
        model: {
          providerID: "opencode",
          modelID: "deepseek-v4-flash-free",
        },
        variant: null,
        agent: "build",
      },
      { directory: "/work" },
    )

    const expectedConfig = {
      harness: { id: "opencode", access: "native" },
      model: {
        providerID: "opencode",
        modelID: "deepseek-v4-flash-free",
      },
      variant: null,
      agent: "build",
    }
    assert.deepEqual(first.getSessionConfig("s-opencode"), expectedConfig)

    const next = new RuntimeStore(root)
    assert.deepEqual(next.getSessionConfig("s-opencode"), expectedConfig)
    assert.equal((next.getSession("s-opencode") as { directory?: string } | null)?.directory, "/work")
  })

  it("does not carry stale ACP binary when runner type changes", () => {
    const store = new RuntimeStore(tmp())
    store.bindSession({
      sessionId: "s1",
      directory: "/work",
      agentSessionId: "a1",
      createdAt: 1,
    })
    store.updateSessionConfig("s1", {
      runner: {
        type: "claude-acp",
        binary: "/tmp/claude-agent-acp",
        model: "sonnet",
      },
      model: {
        providerID: "claude-acp",
        modelID: "sonnet",
      },
    })

    store.updateSessionConfig("s1", {
      runner: {
        type: "codex-acp",
        model: "gpt-5.5",
      },
      model: {
        providerID: "codex-acp",
        modelID: "gpt-5.5",
      },
    })

    assert.deepEqual(store.getSessionConfig("s1"), {
      harness: { id: "codex", access: "acp" },
      model: {
        providerID: "codex-acp",
        modelID: "gpt-5.5",
      },
      variant: null,
      agent: null,
    })
  })
})

describe("session inventory import marker", () => {
  it("records the import per directory and survives reopen", () => {
    const root = tmp()
    const store = new RuntimeStore(root)

    assert(!store.sessionInventoryImported("/work/a"))
    store.markSessionInventoryImported("/work/a", 100)
    assert(store.sessionInventoryImported("/work/a"))
    // A sibling directory has its own inventory and its own import.
    assert(!store.sessionInventoryImported("/work/b"))

    // Marking twice is idempotent and keeps the first timestamp, so a repeated
    // import cannot look like a fresh one.
    store.markSessionInventoryImported("/work/a", 200)
    const reopened = new RuntimeStore(root)
    assert(reopened.sessionInventoryImported("/work/a"))
    assert(!reopened.sessionInventoryImported("/work/b"))
  })
})

describe("provisional user parts", () => {
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

  const adapterProvisional = (messageId: string, text: string) =>
    messagePartUpdated({ id: `000000_${messageId}-input`, sessionID: "s1", messageID: messageId, type: "text", text })

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
      model: { providerID: "opencode", modelID: "big-pickle" },
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

  it("renders one part when all three writers record the same prompt", () => {
    const store = seeded(tmp())
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: adapterProvisional("u1", "UNIQUE-PROMPT-XYZ") })
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: engineCanonical("u1", "UNIQUE-PROMPT-XYZ") })

    assert.deepEqual(userParts(store), ["prt_fbf520445001MRpnaorKB7bmPL"])
    store.close()
  })

  it("supersedes regardless of arrival order — the canonical part may land first", () => {
    // Superseding only when the CANONICAL part arrives leaves this ordering
    // broken: a provisional written after the canonical would sit beside it
    // until the canonical happened to be rewritten, and if the engine never
    // wrote that part again the prompt stayed doubled — the same defect, in
    // the other order. Supersession must therefore be checked at both writes.
    const store = seeded(tmp())
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: engineCanonical("u1", "UNIQUE-PROMPT-XYZ") })
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: adapterProvisional("u1", "UNIQUE-PROMPT-XYZ") })

    assert.deepEqual(userParts(store), ["prt_fbf520445001MRpnaorKB7bmPL"])
    store.close()
  })

  it("keeps provisional parts while NO canonical part exists — nothing is dropped without a replacement", () => {
    // The durability case these writers exist for: the engine never responds.
    const store = seeded(tmp())
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: adapterProvisional("u1", "UNIQUE-PROMPT-XYZ") })

    const parts = userParts(store)
    assert.ok(parts.length > 0, "a turn whose engine never answered must still show the user's prompt")
    assert.ok(parts.every((id) => id === "u1-part-0" || id === "000000_u1-input"))
    store.close()
  })

  it("keeps a multi-part prompt whole while the engine has persisted only some of it", () => {
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
      model: { providerID: "opencode", modelID: "big-pickle" },
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

  it("a canonical part on ONE user message leaves another's provisionals alone", () => {
    // The mutation this exists to catch: a predicate matching id SHAPE alone
    // (any `*-part-N` / `*-input`) rather than THIS message's id would retire
    // a second turn's provisionals the moment the first turn's engine part
    // landed. Needs two user messages, each holding provisionals, to discriminate.
    const store = seeded(tmp())
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: adapterProvisional("u1", "FIRST") })
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "a1",
      userMessageId: "u2",
      assistantMessageId: "m2",
      agent: "general",
      model: { providerID: "opencode", modelID: "big-pickle" },
      parts: [{ type: "text", text: "SECOND" }],
    })
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: adapterProvisional("u2", "SECOND") })

    // u1's engine part lands; u2's turn is still in flight.
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: engineCanonical("u1", "FIRST") })

    const u2 = (
      (store.getMessages("s1") as Array<{ info: { id: string }; parts: Array<{ id: string }> }>).find(
        (message) => message.info.id === "u2",
      )?.parts ?? []
    ).map((part) => part.id)
    assert.deepEqual(u2.sort(), ["000000_u2-input", "u2-part-0"], "u2's provisionals must survive u1's canonical part")
    store.close()
  })

  it("does not retire another message's provisional parts", () => {
    const store = seeded(tmp())
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: adapterProvisional("u1", "UNIQUE-PROMPT-XYZ") })
    // A canonical part on the ASSISTANT message must not touch the user's.
    store.appendEvent({ sessionId: "s1", agentSessionId: "a1", payload: engineCanonical("m1", "OK") })

    // BOTH of the user's provisionals must survive: a predicate that matched on
    // id SHAPE alone (any `*-part-N` / `*-input`) rather than on THIS message's
    // id would retire them from under an unrelated message's canonical part.
    assert.deepEqual(userParts(store).sort(), ["000000_u1-input", "u1-part-0"])
    store.close()
  })
})
