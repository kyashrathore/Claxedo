import { afterEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeTestTempDir } from "../harnesses/shared/test-temp-dir"
import { MemoryRuntimeStore } from "./memory"
import { SqliteRuntimeStore } from "./sqlite"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeTestTempDir(root) })
const binding = { sessionId: "starting", workspaceId: "workspace", directory: "/work", connectionId: "connection:agent", operationId: "creation" }

test("pending creation has immutable ownership but no executable or visible session", () => {
  const store = new MemoryRuntimeStore()
  const record = store.sessionStarts.begin(binding)
  expect(record.status).toBe("starting")
  expect(store.getSession(binding.sessionId)).toBeNull()
  expect(store.getExecutionBinding(binding.sessionId)).toBeNull()
  expect(store.listSessions(binding.directory)).toEqual([])
  for (const key of ["workspaceId", "directory", "connectionId", "operationId"] as const) {
    expect(() => store.sessionStarts.begin({ ...binding, [key]: "different" })).toThrow("another operation")
  }
  record.binding.directory = "/tampered"
  expect(store.sessionStarts.get(binding.sessionId)?.binding.directory).toBe("/work")
  expect(() => store.sessionStarts.begin({ ...binding, upstreamSessionId: "fabricated" } as typeof binding)).toThrow("Invalid pending")
})

test("terminal creation cannot be promoted by stale or competing completion", () => {
  const store = new MemoryRuntimeStore()
  store.sessionStarts.begin(binding)
  expect(() => store.sessionStarts.finish({ ...binding, operationId: "other" }, { status: "created", upstreamSessionId: "agent-session" })).toThrow("does not match")
  expect(() => store.sessionStarts.finish({ ...binding, connectionId: "other" }, { status: "created", upstreamSessionId: "agent-session" })).toThrow("does not match")
  store.sessionStarts.finish(binding, { status: "failed", error: "agent disconnected" })
  expect(() => store.sessionStarts.finish(binding, { status: "created", upstreamSessionId: "agent-session" })).toThrow("already settled")
  expect(store.sessionStarts.finish(binding, { status: "failed", error: "agent disconnected" }).status).toBe("failed")
})

test("a retired creation frees the id and a stale operation cannot reach its replacement", () => {
  const store = new MemoryRuntimeStore()
  store.sessionStarts.begin(binding)
  store.sessionStarts.finish(binding, { status: "created", upstreamSessionId: "agent-session" })
  for (const key of ["workspaceId", "directory", "connectionId", "operationId"] as const) {
    expect(store.sessionStarts.retire({ ...binding, [key]: "different" })).toBe(false)
  }
  expect(store.sessionStarts.get(binding.sessionId)?.status).toBe("created")
  expect(store.sessionStarts.retire(binding)).toBe(true)
  expect(store.sessionStarts.get(binding.sessionId)).toBeUndefined()
  expect(store.sessionStarts.retire(binding)).toBe(false)

  const replacement = { ...binding, operationId: "retry" }
  expect(store.sessionStarts.begin(replacement).status).toBe("starting")
  expect(store.sessionStarts.retire(binding)).toBe(false)
  expect(() => store.sessionStarts.finish(binding, { status: "failed", error: "late" })).toThrow("does not match")
  expect(store.sessionStarts.get(binding.sessionId)).toMatchObject({ status: "starting", binding: { operationId: "retry" } })
})

test("SQLite retirement compares binding fields, not the stored record, and outlives the process", () => {
  const root = mkdtempSync(join(tmpdir(), "session-start-retire-")); roots.push(root)
  let store = new SqliteRuntimeStore({ root })
  store.sessionStarts.begin(binding)
  store.sessionStarts.finish(binding, { status: "created", upstreamSessionId: "real-upstream" })
  store.close()

  store = new SqliteRuntimeStore({ root })
  // Same five fields, written in the order no serialized record would carry.
  const reordered = {
    operationId: binding.operationId,
    connectionId: binding.connectionId,
    directory: binding.directory,
    workspaceId: binding.workspaceId,
    sessionId: binding.sessionId,
  }
  expect(store.sessionStarts.retire({ ...reordered, connectionId: "connection:other" })).toBe(false)
  expect(store.sessionStarts.get(binding.sessionId)?.status).toBe("created")
  expect(store.sessionStarts.retire(reordered)).toBe(true)
  store.close()

  store = new SqliteRuntimeStore({ root })
  expect(store.sessionStarts.get(binding.sessionId)).toBeUndefined()
  expect(store.sessionStarts.begin({ ...binding, operationId: "retry" }).status).toBe("starting")
  store.close()
  store = new SqliteRuntimeStore({ root })
  expect(store.sessionStarts.get(binding.sessionId)?.binding.operationId).toBe("retry")
  store.close()
})

test("SQLite preserves startup ownership and pending question before any provider binding", () => {
  const root = mkdtempSync(join(tmpdir(), "session-start-store-")); roots.push(root)
  let store = new SqliteRuntimeStore({ root })
  const starting = store.sessionStarts.begin(binding)
  store.appendEvent({ sessionId: binding.sessionId, payload: { id: "event-start-question", type: "question.asked", properties: {
    id: "question", sessionID: binding.sessionId, questions: [{ header: "Agent", question: "Choose", options: [] }],
  } } })
  store.close()
  store = new SqliteRuntimeStore({ root })
  expect(store.sessionStarts.get(binding.sessionId)).toEqual(starting)
  expect(store.listQuestions("/work").map(row => row.id)).toEqual(["question"])
  expect(store.getSession(binding.sessionId)).toBeNull()
  store.bindSession({ ...binding, agentSessionId: "real-upstream", upstreamSessionId: "real-upstream" })
  store.sessionStarts.finish(binding, { status: "created", upstreamSessionId: "real-upstream" })
  expect(store.listQuestions("/work").map(row => row.id)).toEqual(["question"])
  store.close()
  store = new SqliteRuntimeStore({ root })
  expect(store.sessionStarts.get(binding.sessionId)?.status).toBe("created")
  expect(store.getExecutionBinding(binding.sessionId)?.upstreamSessionId).toBe("real-upstream")
  store.close()
})
