import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createSqliteRuntimeStore } from "./sqlite"
import type { MemoryRuntimeStoreSnapshot } from "./memory"
import { removeTestTempDir } from "../harnesses/shared/test-temp-dir"
import { storeRows } from "../test-utils/store-internals"

const roots: string[] = []

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "agent-runtime-sqlite-"))
  roots.push(root)
  return root
}

/** The store shipped before the normalized tables: one JSON blob under id 'state'. */
function writeLegacySnapshot(root: string, snapshot: Partial<MemoryRuntimeStoreSnapshot>) {
  const db = new Database(path.join(root, "agent-runtime.db"))
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_store_snapshot (
      id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.prepare("INSERT OR REPLACE INTO runtime_store_snapshot (id, data_json, updated_at) VALUES ('state', ?, ?)")
    .run(JSON.stringify(snapshot), Date.now())
  db.close()
}

function tableNames(root: string) {
  const db = new Database(path.join(root, "agent-runtime.db"))
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name)
  } finally {
    db.close()
  }
}

function legacySnapshot(): Partial<MemoryRuntimeStoreSnapshot> {
  return {
    sessions: [{
      id: "ses_legacy",
      directory: "/repo",
      title: "Legacy session",
      agentSessionId: "thread_legacy",
      time: { created: 10, updated: 20 },
      status: null,
      recoveryError: null,
    }],
    configs: [{
      sessionId: "ses_legacy",
      config: { harness: { id: "pi", access: "native" }, variant: null, agent: "build" },
    }],
    messages: [{
      sessionId: "ses_legacy",
      messages: [{ info: { id: "msg_1", role: "user", sessionID: "ses_legacy" }, parts: [{ id: "prt_1", type: "text", text: "hello" }] }],
    }],
    todos: [{ sessionId: "ses_legacy", rows: [{ content: "Ship it", status: "pending", priority: "high" }] }],
    permissions: [{ directory: "/repo", rows: [{ id: "perm_1", sessionID: "ses_legacy" }] }],
    seq: [{ sessionId: "ses_legacy", seq: 7 }],
  }
}

afterEach(() => {
  while (roots.length) removeTestTempDir(roots.pop()!)
})

describe("createSqliteRuntimeStore", () => {
  test("imports a legacy snapshot database into the normalized tables exactly once", () => {
    const root = tempRoot()
    writeLegacySnapshot(root, legacySnapshot())

    const migrated = storeRows(createSqliteRuntimeStore({ root }))
    expect(migrated.getSession("ses_legacy")).toMatchObject({
      id: "ses_legacy",
      directory: "/repo",
      title: "Legacy session",
      agent_session_id: "thread_legacy",
    })
    expect(migrated.getSessionConfig("ses_legacy")).toEqual({
      harness: { id: "pi", access: "native" },
      variant: null,
      agent: "build",
    })
    expect(migrated.getMessages("ses_legacy")).toMatchObject([{ info: { id: "msg_1" } }])
    expect(migrated.getTodos("ses_legacy")).toEqual([{ content: "Ship it", status: "pending", priority: "high" }])
    expect(migrated.listPermissions("/repo")).toMatchObject([{ id: "perm_1" }])
    migrated.close()

    // The legacy table is dropped, so the import cannot replay over live rows.
    expect(tableNames(root)).not.toContain("runtime_store_snapshot")

    const reopened = storeRows(createSqliteRuntimeStore({ root }))
    expect(reopened.getSession("ses_legacy")).toMatchObject({ id: "ses_legacy", title: "Legacy session" })
    expect(reopened.getSessionConfig("ses_legacy")).toMatchObject({ harness: { id: "pi", access: "native" } })
    expect(reopened.getMessages("ses_legacy")).toMatchObject([{ info: { id: "msg_1" } }])
    reopened.close()
  })

  test("keeps normalized rows when a stale legacy snapshot is still present", () => {
    const root = tempRoot()
    const first = storeRows(createSqliteRuntimeStore({ root }))
    first.bindSession({ sessionId: "ses_current", directory: "/repo", title: "Current", agentSessionId: "thread_current" })
    first.updateSessionConfig("ses_current", { harness: { id: "pi", access: "native" } })
    first.close()
    writeLegacySnapshot(root, legacySnapshot())

    const reopened = storeRows(createSqliteRuntimeStore({ root }))
    expect(reopened.getSession("ses_current")).toMatchObject({ id: "ses_current", title: "Current" })
    expect(reopened.getSession("ses_legacy")).toBeNull()
    reopened.close()

    expect(tableNames(root)).not.toContain("runtime_store_snapshot")
  })
})
