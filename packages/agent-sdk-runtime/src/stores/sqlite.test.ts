import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  buildAssistantMessage,
  buildSession,
  messagePartDelta,
  messageUpdated,
  permissionAsked,
  permissionReplied,
  questionAsked,
  questionRejected,
  questionReplied,
  sessionUpdated,
  todoUpdated,
} from "../compat-events"
import { removeTestTempDir } from "../harnesses/shared/test-temp-dir"
import { AgentRuntimeStaleTurnError } from "../harnesses/shared/runtime-store"
import { RuntimeStoreCorruptionError, SqliteRuntimeStore, UnsupportedRuntimeStoreSchemaError } from "./sqlite"

function recoveryFact<V extends string>(value: V) {
  return { value, source: "test", observedAt: 10, generation: "lease-1" }
}

function recoveryOperation(overrides: { operationId?: string; requestId?: string } = {}) {
  return {
    operationId: overrides.operationId ?? "op-1",
    requestId: overrides.requestId ?? "req-1",
    target: { scope: "turn" as const, workspaceId: "w1", sessionId: "s1", turnId: "u1", ownerGeneration: "lease-1" },
    action: "cancel_turn" as const,
    scopeRevision: "rev-1",
    attempt: 1,
    state: "accepted" as const,
    phase: "ack" as const,
    phaseDeadlineAt: 20,
    facts: {
      execution: recoveryFact("running" as const),
      cleanup: recoveryFact("owned" as const),
      persistence: recoveryFact("pending" as const),
    },
    cleanupErrors: [],
    nextActions: [],
    receipt: "durable" as const,
    createdAt: 10,
    updatedAt: 10,
  }
}

const roots: string[] = []

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-sqlite-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestTempDir(root)
})

describe("SqliteRuntimeStore", () => {
  test("persists and replaces agent session command lists without crossing sessions", () => {
    const root = tempRoot()
    const store = new SqliteRuntimeStore({ root })
    for (const sessionId of ["one", "two"]) store.bindSession({ sessionId, directory: "/repo", agentSessionId: `agent-${sessionId}` })
    const commands = [{ name: "review", description: "Review changes", input: { hint: "<path>" } }]
    store.appendEvent({ sessionId: "one", payload: { type: "session.commands", properties: { sessionID: "one", commands } } })
    expect(store.getSession("one")?.commands).toEqual(commands)
    expect(store.getSession("two")?.commands).toBeUndefined()
    store.close()
    const reopened = new SqliteRuntimeStore({ root })
    expect(reopened.getSession("one")?.commands).toEqual(commands)
    reopened.bindSession({ sessionId: "one", directory: "/repo", agentSessionId: "agent-one-resumed" })
    expect(reopened.getSession("one")?.commands).toEqual(commands)
    reopened.appendEvent({ sessionId: "one", payload: { type: "session.commands", properties: { sessionID: "one", commands: [] } } })
    reopened.close()
    const cleared = new SqliteRuntimeStore({ root })
    expect(cleared.getSession("one")?.commands).toEqual([])
    cleared.updateSessionConfig("one", { harness: { id: "example", access: "connection" } })
    cleared.appendEvent({ sessionId: "one", payload: { type: "session.commands", properties: { sessionID: "one", commands } } })
    cleared.updateSessionConfig("one", { harness: { id: "codex", access: "native" } })
    expect(cleared.getSession("one")?.commands).toBeUndefined()
    cleared.close()
  })
  test("ranks title writers: a user rename survives harness and prompt writes, and reopen", () => {
    const root = tempRoot()
    const store = new SqliteRuntimeStore({ root })
    store.bindSession({ sessionId: "titled", directory: "/repo", agentSessionId: "native-1", title: "New session - 2026-09-15T00:00:00.000Z" })
    const write = (title: string, titleSource?: "prompt" | "harness" | "user") => store.appendEvent({
      sessionId: "titled",
      payload: sessionUpdated(buildSession({ id: "titled", directory: "/repo", title, ...(titleSource ? { titleSource } : {}) })),
    })

    write("first prompt", "prompt")
    expect(store.getSession("titled")).toMatchObject({ title: "first prompt", titleSource: "prompt" })
    write("Generated", "harness")
    expect(store.getSession("titled")).toMatchObject({ title: "Generated", titleSource: "harness" })
    write("second prompt", "prompt")
    expect(store.getSession("titled")).toMatchObject({ title: "Generated", titleSource: "harness" })
    write("Regenerated", "harness")
    expect(store.getSession("titled")).toMatchObject({ title: "Regenerated", titleSource: "harness" })
    store.updateSession("titled", { title: "Mine" })
    expect(store.getSession("titled")).toMatchObject({ title: "Mine", titleSource: "user" })
    write("Generated again", "harness")
    write("legacy frame without provenance")
    expect(store.getSession("titled")).toMatchObject({ title: "Mine", titleSource: "user" })
    store.close()

    const reopened = new SqliteRuntimeStore({ root })
    expect(reopened.getSession("titled")).toMatchObject({ title: "Mine", titleSource: "user" })
    reopened.close()
  })

  test("persists permission modes through reopen and clears them on a harness change", () => {
    const root = tempRoot()
    const first = new SqliteRuntimeStore({ root })
    first.bindSession({ sessionId: "restricted", directory: "/repo", agentSessionId: "native-1" })
    first.updateSessionConfig("restricted", { harness: { id: "codex", access: "native" }, permissionCeiling: "ask", permissionMode: "read-only", permissionState: { allow: ["Bash(printf approved-write *)"] } })
    first.updateSessionConfig("restricted", { agent: "build" })
    first.close()
    const reopened = new SqliteRuntimeStore({ root })
    expect(reopened.getSessionConfig("restricted")?.permissionCeiling).toBe("ask")
    expect(reopened.getSessionConfig("restricted")?.permissionMode).toBe("read-only")
    expect(reopened.getSessionConfig("restricted")?.permissionState).toEqual({ allow: ["Bash(printf approved-write *)"] })
    reopened.updateSessionConfig("restricted", { harness: { id: "claude", access: "native" } })
    expect(reopened.getSessionConfig("restricted")?.permissionCeiling).toBe("ask")
    expect(reopened.getSessionConfig("restricted")?.permissionMode).toBeUndefined()
    expect(reopened.getSessionConfig("restricted")?.permissionState).toBeUndefined()
    reopened.close()
  })

  test("persists normalized interactions, todos, recovery, and subagents across reopen", () => {
    const root = tempRoot()
    const first = new SqliteRuntimeStore({ root })
    first.bindSession({ sessionId: "ses_1", directory: "/repo", agentSessionId: "native_1" })
    first.updateSessionConfig("ses_1", { harness: { id: "pi", access: "native" } })
    first.appendEvent({
      sessionId: "ses_1",
      payload: permissionAsked({
        id: "perm_1",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["*"],
        always: [],
        metadata: {},
      }),
    })
    first.appendEvent({
      sessionId: "ses_1",
      payload: questionAsked({
        id: "question_1",
        sessionID: "ses_1",
        questions: [{ question: "Continue?", header: "Confirm", options: [] }],
      }),
    })
    first.appendEvent({
      sessionId: "ses_1",
      payload: todoUpdated("ses_1", [{ content: "Ship", status: "pending", priority: "high" }]),
    })
    first.markRecovering("ses_1", "restart required")
    first.admit({
      parentSessionId: "ses_1",
      observation: { observationId: "spawn", harnessExecutionId: "run", status: "running" },
      allocateKey: () => "child_1",
    })
    first.markPublished("ses_1", "spawn")
    first.close()

    const reopened = new SqliteRuntimeStore({ root })
    expect(reopened.listPermissions("/repo")).toHaveLength(1)
    expect(reopened.listQuestions("/repo")).toHaveLength(1)
    expect(reopened.getTodos("ses_1")).toEqual([{ content: "Ship", status: "pending", priority: "high" }])
    expect(reopened.consumeRecoveryError("ses_1")).toBe("restart required")
    expect(reopened.listSubagentEvents("ses_1")).toHaveLength(1)
    reopened.close()
  })

  test("restores the in-memory projection when a SQL transaction fails", () => {
    const root = tempRoot()
    const store = new SqliteRuntimeStore({ root })
    store.bindSession({ sessionId: "ses_1", directory: "/repo", title: "Original", agentSessionId: "native_1" })
    const db = new Database(path.join(root, "agent-runtime.db"))
    db.exec(`
      CREATE TRIGGER reject_session_update
      BEFORE UPDATE ON runtime_sessions
      WHEN OLD.id = 'ses_1'
      BEGIN SELECT RAISE(ABORT, 'write rejected'); END;
    `)

    expect(() => store.updateSession("ses_1", { title: "Uncommitted" })).toThrow("write rejected")
    expect(store.getSession("ses_1")).toMatchObject({ title: "Original" })

    db.close()
    store.close()
  })

  test("preserves active turn leases when an unrelated SQL transaction fails", () => {
    const root = tempRoot()
    const store = new SqliteRuntimeStore({ root })
    store.bindSession({ sessionId: "ses_active", directory: "/repo", agentSessionId: "native_active" })
    store.bindSession({ sessionId: "ses_write", directory: "/repo", agentSessionId: "native_write" })
    const lease = store.acquireTurnLease("ses_active")!
    const db = new Database(path.join(root, "agent-runtime.db"))
    db.exec(`
      CREATE TRIGGER reject_other_update
      BEFORE UPDATE ON runtime_sessions
      WHEN OLD.id = 'ses_write'
      BEGIN SELECT RAISE(ABORT, 'write rejected'); END;
    `)

    expect(() => store.updateSession("ses_write", { title: "Uncommitted" })).toThrow("write rejected")
    expect(store.acquireTurnLease("ses_active")).toBeUndefined()
    store.releaseTurnLease("ses_active", lease)
    expect(typeof store.acquireTurnLease("ses_active")).toBe("string")

    db.close()
    store.close()
  })

  test("does not resurrect answered interactions after reopen", () => {
    const root = tempRoot()
    const first = new SqliteRuntimeStore({ root })
    first.bindSession({ sessionId: "ses_1", directory: "/repo", agentSessionId: "native_1" })
    first.appendEvent({ sessionId: "ses_1", payload: permissionAsked({
      id: "perm_1", sessionID: "ses_1", permission: "bash", patterns: ["*"], always: [], metadata: {},
    }) })
    first.appendEvent({ sessionId: "ses_1", payload: questionAsked({
      id: "question_1", sessionID: "ses_1", questions: [{ question: "Continue?", header: "Confirm", options: [] }],
    }) })
    first.appendEvent({ sessionId: "ses_1", payload: questionAsked({
      id: "question_2", sessionID: "ses_1", questions: [{ question: "Cancel?", header: "Confirm", options: [] }],
    }) })
    first.appendEvent({ sessionId: "ses_1", payload: permissionReplied("ses_1", "perm_1", "once") })
    first.appendEvent({ sessionId: "ses_1", payload: questionReplied("ses_1", "question_1", [["yes"]]) })
    first.appendEvent({ sessionId: "ses_1", payload: questionRejected("ses_1", "question_2") })
    first.close()

    const reopened = new SqliteRuntimeStore({ root })
    expect(reopened.listPermissions("/repo")).toEqual([])
    expect(reopened.listQuestions("/repo")).toEqual([])
    reopened.close()
  })

  test("preserves message order when an older message is updated", () => {
    const root = tempRoot()
    const first = new SqliteRuntimeStore({ root })
    first.bindSession({ sessionId: "ses_1", directory: "/repo", agentSessionId: "native_1" })
    const message = (id: string, finish?: string) => buildAssistantMessage({
      id, sessionID: "ses_1", parentID: "user_1", agent: "build",
      model: { providerID: "pi", modelID: "default" }, directory: "/repo", finish,
    })
    first.appendEvent({ sessionId: "ses_1", payload: messageUpdated(message("m1")) })
    first.appendEvent({ sessionId: "ses_1", payload: messageUpdated(message("m2")) })
    first.appendEvent({ sessionId: "ses_1", payload: messageUpdated(message("m1", "stop")) })
    expect(first.getMessages("ses_1").map((row) => row.info.id)).toEqual(["m1", "m2"])
    first.close()

    const reopened = new SqliteRuntimeStore({ root })
    expect(reopened.getMessages("ses_1").map((row) => row.info.id)).toEqual(["m1", "m2"])
    reopened.close()
  })

  test("commits every acknowledged message mutation before returning", () => {
    const root = tempRoot()
    const store = new SqliteRuntimeStore({ root })
    store.bindSession({ sessionId: "ses_1", directory: "/repo", agentSessionId: "native_1" })
    const db = new Database(path.join(root, "agent-runtime.db"))
    store.appendEvent({ sessionId: "ses_1", payload: messageUpdated(buildAssistantMessage({
      id: "m1", sessionID: "ses_1", parentID: "u1", agent: "build",
      model: { providerID: "pi", modelID: "default" }, directory: "/repo",
    })) })
    expect(db.query("SELECT COUNT(*) AS count FROM runtime_messages").get()).toEqual({ count: 1 })

    store.appendEvent({ sessionId: "ses_1", payload: messagePartDelta({
      sessionID: "ses_1", messageID: "m1", partID: "p1", field: "text", delta: "hello",
    }) })
    const persisted = db.query("SELECT data_json FROM runtime_messages WHERE message_id = ?").get("m1") as { data_json: string }
    expect(JSON.parse(persisted.data_json)).toMatchObject({ parts: [{ text: "hello" }] })

    db.close()
    store.close()
  })

  test("rolls back memory and SQLite when a message projection write fails", () => {
    const root = tempRoot()
    const store = new SqliteRuntimeStore({ root })
    store.bindSession({ sessionId: "ses_1", directory: "/repo", agentSessionId: "native_1" })
    store.appendEvent({ sessionId: "ses_1", payload: messageUpdated(buildAssistantMessage({
      id: "m1", sessionID: "ses_1", parentID: "u1", agent: "build",
      model: { providerID: "pi", modelID: "default" }, directory: "/repo",
    })) })
    store.appendEvent({ sessionId: "ses_1", payload: messagePartDelta({
      sessionID: "ses_1", messageID: "m1", partID: "p1", field: "text", delta: "before",
    }) })
    const db = new Database(path.join(root, "agent-runtime.db"))
    db.exec(`
      CREATE TRIGGER reject_message_update
      BEFORE UPDATE ON runtime_messages
      WHEN OLD.message_id = 'm1'
      BEGIN SELECT RAISE(ABORT, 'message write rejected'); END;
    `)

    expect(() => store.appendEvent({ sessionId: "ses_1", payload: messagePartDelta({
      sessionID: "ses_1", messageID: "m1", partID: "p1", field: "text", delta: "-after",
    }) })).toThrow("message write rejected")
    expect(store.getMessages("ses_1")).toMatchObject([{ parts: [{ text: "before" }] }])

    db.close()
    store.close()
    const reopened = new SqliteRuntimeStore({ root })
    expect(reopened.getMessages("ses_1")).toMatchObject([{ parts: [{ text: "before" }] }])
    reopened.close()
  })

  test("rejects the removed whole-snapshot schema", () => {
    const root = tempRoot()
    const db = new Database(path.join(root, "agent-runtime.db"))
    db.exec("CREATE TABLE runtime_store_snapshot (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at INTEGER NOT NULL)")
    db.close()

    expect(() => new SqliteRuntimeStore({ root })).toThrow(UnsupportedRuntimeStoreSchemaError)
    const reopened = new Database(path.join(root, "agent-runtime.db"))
    expect(() => reopened.exec("DROP TABLE runtime_store_snapshot")).not.toThrow()
    reopened.close()
  })

  test("reports the exact table and key for corrupt persisted JSON", () => {
    const root = tempRoot()
    const first = new SqliteRuntimeStore({ root })
    first.bindSession({ sessionId: "ses_bad", directory: "/repo", agentSessionId: "native_bad" })
    first.close()
    const db = new Database(path.join(root, "agent-runtime.db"))
    db.query("UPDATE runtime_sessions SET data_json = ? WHERE id = ?").run("{", "ses_bad")
    db.close()

    expect(() => new SqliteRuntimeStore({ root })).toThrow(RuntimeStoreCorruptionError)
    expect(() => new SqliteRuntimeStore({ root })).toThrow("runtime_sessions at ses_bad")
  })
  test("upgrades a version 2 store in place and keeps its rows", () => {
    const root = tempRoot()
    const first = new SqliteRuntimeStore({ root })
    first.bindSession({ sessionId: "ses_old", directory: "/repo", agentSessionId: "native_old" })
    first.close()
    const db = new Database(path.join(root, "agent-runtime.db"))
    db.exec("DROP TABLE runtime_recovery_operations")
    db.query("UPDATE runtime_schema SET version = ?").run(2)
    db.close()

    const upgraded = new SqliteRuntimeStore({ root })
    expect(upgraded.getSession("ses_old")?.directory).toBe("/repo")
    expect(upgraded.readRecoveryOperation("none")).toBeUndefined()
    upgraded.recordRecoveryOperation(recoveryOperation(), { callerId: "caller-a" })
    expect(upgraded.readRecoveryOperation("op-1")?.requestId).toBe("req-1")
    upgraded.close()

    const version = new Database(path.join(root, "agent-runtime.db"))
    expect(version.query("SELECT version FROM runtime_schema").get()).toEqual({ version: 3 })
    version.close()
    expect(() => new SqliteRuntimeStore({ root })).not.toThrow()
  })

  test("refuses a schema version this build has no upgrade for", () => {
    const root = tempRoot()
    new SqliteRuntimeStore({ root }).close()
    const db = new Database(path.join(root, "agent-runtime.db"))
    db.query("UPDATE runtime_schema SET version = ?").run(9)
    db.close()
    expect(() => new SqliteRuntimeStore({ root })).toThrow(UnsupportedRuntimeStoreSchemaError)
  })

  test("one caller's repeated recovery request joins its own operation", () => {
    const root = tempRoot()
    const store = new SqliteRuntimeStore({ root })
    expect(store.recordRecoveryOperation(recoveryOperation(), { callerId: "caller-a" })).toEqual({ created: true })
    const again = store.recordRecoveryOperation(recoveryOperation({ operationId: "op-2" }), { callerId: "caller-a" })
    expect(again.created).toBe(false)
    expect(again.created === false && again.existing.operationId).toBe("op-1")
    expect(store.readRecoveryOperation("op-2")).toBeUndefined()
    expect(store.recordRecoveryOperation(recoveryOperation({ operationId: "op-3" }), { callerId: "caller-b" })).toEqual({ created: true })
    expect(store.listRecoveryOperations({ sessionId: "s1" }).map((op) => op.operationId).sort()).toEqual(["op-1", "op-3"])
    expect(() => store.updateRecoveryOperation(recoveryOperation({ operationId: "absent" }))).toThrow("never recorded")
    store.close()

    const reopened = new SqliteRuntimeStore({ root })
    expect(reopened.readRecoveryOperation("op-1")?.state).toBe("accepted")
    reopened.close()
  })

  test("finishTurn refuses a writer whose turn lease was replaced", () => {
    const root = tempRoot()
    const store = new SqliteRuntimeStore({ root })
    store.bindSession({ sessionId: "s1", directory: "/repo", agentSessionId: "native_1" })
    const leaseId = store.acquireTurnLease("s1")
    expect(leaseId).toBeDefined()
    expect(store.readTurnAuthority("s1")?.leaseId).toBe(leaseId!)
    store.startTurn({
      sessionId: "s1",
      agentSessionId: "native_1",
      userMessageId: "u1",
      assistantMessageId: "m1",
      agent: "build",
      model: { providerID: "anthropic", modelID: "opus" },
      parts: [{ type: "text", text: "go" }],
    })
    store.releaseTurnLease("s1", leaseId!)
    const replacement = store.acquireTurnLease("s1")
    expect(replacement).not.toBe(leaseId)

    expect(() => store.finishTurn({ sessionId: "s1", assistantMessageId: "m1", outcome: { status: "completed", completedAt: 5 }, leaseId })).toThrow(AgentRuntimeStaleTurnError)
    expect(store.getSession("s1")?.status).toBe("busy")
    store.finishTurn({ sessionId: "s1", assistantMessageId: "m1", outcome: { status: "completed", completedAt: 5 }, leaseId: replacement })
    expect(store.getSession("s1")?.status).not.toBe("busy")
    store.close()
  })
})
