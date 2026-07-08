import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import {
  messagePartUpdated,
  messageUpdated,
  messagePartDelta,
  permissionAsked,
  questionAsked,
  sessionIdle,
  sessionUpdated,
  todoUpdated,
} from "./compat-events"
import { RuntimeStore } from "./store"

const roots: string[] = []

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-store-"))
  roots.push(root)
  return root
}

function journal(root: string, sessionId: string) {
  const store = new RuntimeStore(root)
  const rows = (store as unknown as {
    db: {
      prepare(sql: string): {
        all(...params: unknown[]): unknown[]
      }
    }
  }).db.prepare(`
    SELECT seq, kind, type, payload_json
    FROM runtime_journal
    WHERE session_id = ?
    ORDER BY seq ASC
  `).all(sessionId) as Array<{ seq: number; kind: string; type: string; payload_json: string }>
  store.close()
  return rows.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }))
}

function sessionColumns(store: RuntimeStore) {
  return ((store as unknown as {
    db: {
      prepare(sql: string): {
        all(...params: unknown[]): unknown[]
      }
    }
  }).db.prepare("PRAGMA table_info(session)").all() as Array<{ name: string }>).map((row) => row.name)
}

function db(store: RuntimeStore) {
  return (store as unknown as {
    db: {
      exec(sql: string): unknown
      prepare(sql: string): {
        run(...params: unknown[]): unknown
      }
    }
  }).db
}

afterEach(() => {
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
    assert(!columns.some((name) => name.startsWith("runner_")))
  })

  it("migrates legacy runner columns into harness session config fields", () => {
    const store = new RuntimeStore(tmp())
    db(store).exec("ALTER TABLE session ADD COLUMN runner_type TEXT")
    db(store).exec("ALTER TABLE session ADD COLUMN runner_binary TEXT")
    db(store).exec("ALTER TABLE session ADD COLUMN runner_model TEXT")
    db(store).prepare(`
      INSERT INTO session (
        id,
        directory,
        runner_type,
        runner_binary,
        runner_model,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("legacy", "/work", "claude-acp", "/bin/claude-agent-acp", "sonnet", 1, 2)

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
    const db = (store as unknown as {
      db: {
        exec(sql: string): unknown
        prepare(sql: string): {
          all(...params: unknown[]): unknown[]
        }
      }
    }).db
    db.exec("DROP TABLE session")

    assert.throws(() => {
      store.bindSession({
        sessionId: "s1",
        directory: "/work",
        agentSessionId: "a1",
        createdAt: 1,
      })
    })

    const journal = db.prepare("SELECT type FROM runtime_journal WHERE session_id = ?").all("s1") as Array<{ type: string }>
    assert.deepEqual(journal.map((row) => row.type), ["session.bind"])
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

    const db = (store as unknown as {
      db: {
        prepare(sql: string): {
          run(...params: unknown[]): unknown
          get(...params: unknown[]): unknown
          all(...params: unknown[]): unknown[]
        }
      }
    }).db
    const prepare = db.prepare.bind(db)
    let failTodoInsert = true
    db.prepare = (sql) => {
      const stmt = prepare(sql)
      if (!failTodoInsert || !sql.includes("INSERT INTO todo")) return stmt
      return {
        ...stmt,
        run() {
          throw new Error("todo insert failed")
        },
      }
    }

    assert.throws(() => {
      store.appendEvent({
        sessionId: "s1",
        agentSessionId: "a1",
        payload: todoUpdated("s1", [{ content: "New", status: "completed", priority: "high" }]),
      })
    }, /todo insert failed/)
    failTodoInsert = false

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
    assert.deepEqual(output.events.map((event) => event.type), [
      "session.status",
      "message.updated",
      "message.part.updated",
      "message.updated",
    ])
    assert.deepEqual(store.getMessages("s1").map((message) => message.info.id), ["msg-user", "msg-user_r"])
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
        questions: [{
          question: "Ship it?",
          header: "Ship it?",
          options: [{ label: "Yes", description: "Ship it" }],
          custom: false,
        }],
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
    assert.deepEqual(rows.map((row) => row.type), [
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
    ])
    assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    assert.equal(rows.find((row) => row.type === "notice.created")?.payload.message, "created notice")
    assert.equal(rows.find((row) => row.type === "projection.reset_requested")?.payload.reason, "operator requested rebuild")

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

    const rows = store.exportJournalJsonl("s1").trim().split("\n").map((line) => JSON.parse(line))
    assert.deepEqual(rows.map((row) => row.control.type), ["session.bind"])
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

    const db = (store as unknown as {
      db: {
        prepare(sql: string): {
          run(...params: unknown[]): unknown
          get(...params: unknown[]): unknown
          all(...params: unknown[]): unknown[]
        }
      }
    }).db
    const prepare = db.prepare.bind(db)
    let failMessageDelete = true
    db.prepare = (sql) => {
      const stmt = prepare(sql)
      if (!failMessageDelete || !sql.includes("DELETE FROM message")) return stmt
      return {
        ...stmt,
        run() {
          throw new Error("message delete failed")
        },
      }
    }

    assert.throws(() => store.deleteSession("s1"), /message delete failed/)
    failMessageDelete = false

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

    assert.throws(() => store.appendEvent({
      sessionId: "s1",
      agentSessionId: "a1",
      payload: sessionUpdated({
        id: "s1",
        directory: "/work",
        title: "Late",
        time: { created: 1, updated: 2 },
      } as never),
    }), /deleted/)

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
        questions: [{
          question: "Ship it?",
          header: "Ship it?",
          options: [{ label: "Yes", description: "Ship it" }],
          custom: false,
        }],
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
        questions: [{
          question: "Ship it?",
          header: "Ship it?",
          options: [{ label: "Yes", description: "Ship it" }],
          custom: false,
        }],
      }),
    })
    first.close()

    const next = new RuntimeStore(root)
    assert.deepEqual(next.listQuestions("/work").map((row) => row.id), ["q1"])
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
    assert.deepEqual(next.listPermissions("/work").map((row) => row.id), ["p2"])
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
    assert.equal((next.getSession("s1") as any)?.recovery_error, "ACP process restarted; pending interactive state must be rerun")
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
      ((store.getSession("s1") as { lastTurn?: { assistantMessageId?: string } } | null)?.lastTurn)?.assistantMessageId,
      "m1",
    )

    const rows = journal(root, "s1")
    assert.equal(rows.at(-2)?.type, "message.completed")
    assert.equal(rows.at(-1)?.type, "session.idle")

    const replayed = new RuntimeStore(root)
    assert.equal((replayed.getSession("s1") as { status?: string } | null)?.status, "idle")
    assert.equal((replayed.getMessages("s1")[1]?.info.time as { completed?: number } | undefined)?.completed !== undefined, true)
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
    first.updateSessionConfig("s-opencode", {
      runner: { type: "opencode" },
      model: {
        providerID: "opencode",
        modelID: "deepseek-v4-flash-free",
      },
      variant: null,
      agent: "build",
    }, { directory: "/work" })

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
