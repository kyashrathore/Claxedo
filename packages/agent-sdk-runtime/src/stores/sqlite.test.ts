import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  buildAssistantMessage,
  messagePartDelta,
  messageUpdated,
  permissionAsked,
  permissionReplied,
  questionAsked,
  questionRejected,
  questionReplied,
  todoUpdated,
} from "../compat-events"
import { removeTestTempDir } from "../harnesses/shared/test-temp-dir"
import { RuntimeStoreCorruptionError, SqliteRuntimeStore, UnsupportedRuntimeStoreSchemaError } from "./sqlite"

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

  test("coalesces a burst of message deltas into one normalized flush", () => {
    const root = tempRoot()
    const store = new SqliteRuntimeStore({ root })
    store.bindSession({ sessionId: "ses_1", directory: "/repo", agentSessionId: "native_1" })
    const db = new Database(path.join(root, "agent-runtime.db"))
    db.exec(`
      CREATE TABLE message_write_audit (writes INTEGER NOT NULL);
      INSERT INTO message_write_audit(writes) VALUES (0);
      CREATE TRIGGER count_message_insert AFTER INSERT ON runtime_messages
      BEGIN UPDATE message_write_audit SET writes = writes + 1; END;
      CREATE TRIGGER count_message_update AFTER UPDATE ON runtime_messages
      BEGIN UPDATE message_write_audit SET writes = writes + 1; END;
    `)
    store.appendEvent({ sessionId: "ses_1", payload: messageUpdated(buildAssistantMessage({
      id: "m1", sessionID: "ses_1", parentID: "u1", agent: "build",
      model: { providerID: "pi", modelID: "default" }, directory: "/repo",
    })) })
    for (let i = 0; i < 100; i++) {
      store.appendEvent({ sessionId: "ses_1", payload: messagePartDelta({
        sessionID: "ses_1", messageID: "m1", partID: "p1", field: "text", delta: String(i % 10),
      }) })
    }
    store.close()

    expect(db.query("SELECT writes FROM message_write_audit").get()).toEqual({ writes: 1 })
    db.close()
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
})
