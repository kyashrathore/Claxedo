import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openTestRuntimeStore, openTestRuntimeStoreDatabase } from "../test-support/store"
import { RuntimeStore } from "../store"
import { BrokerBackgroundWork } from "../broker-ports/background-work"
import { BrokerEventDelivery } from "../broker-ports/delivery"
import { buildAssistantMessage, messageUpdated, messageCompleted, sessionBackgroundWork, sessionError, questionAsked, questionReplied, todoUpdated } from "../projection/presentation-events"
import { SESSION_ATTENTION_TERMINAL_QUERY } from "./attention"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(open = openTestRuntimeStore) {
  const root = mkdtempSync(join(tmpdir(), "session-attention-"))
  roots.push(root)
  const store = open(root)
  store.bindSession({ sessionId: "s", directory: root, workspaceId: "w", connectionId: "native", upstreamSessionId: "up", agentSessionId: "up", owner: { kind: "machine-owner" }, createdAt: 100 })
  return { root, store }
}

function start(store: RuntimeStore) {
  const leaseId = store.acquireTurnLease("s")!
  store.startTurn({ sessionId: "s", agentSessionId: "up", userMessageId: "prompt", assistantMessageId: "answer", agent: "build", parts: [{ type: "text", text: "Work" }] })
  return leaseId
}

void test("standalone failures after a managed turn remain durable attention outcomes", () => {
  const { store } = fixture()
  try {
    const leaseId = start(store)
    store.finishTurn({ sessionId: "s", assistantMessageId: "answer", outcome: { status: "completed", completedAt: 200 }, leaseId })
    store.releaseTurnLease("s", leaseId)
    store.appendEvent({ sessionId: "s", payload: sessionError("Background transport failed", "s") })
    const row = store.getSession("s")!
    assert.equal(row.attention!.outcome!.status, "failed")
    assert.equal(row.lastTurn!.status, "failed")
    if (row.lastTurn!.status === "failed") assert.equal(row.lastTurn!.error, "Background transport failed")
    assert.deepEqual(store.sessionAttentionHistory("s", 0, 256).events.map((event) => event.outcome), ["completed", "failed"])
  } finally { store.close() }
})

void test("a steered turn's outcome names the final reply while retaining its managed turn identity", () => {
  const { store } = fixture()
  try {
    const leaseId = start(store)
    store.appendEvent({ sessionId: "s", payload: messageCompleted("s", "answer") })
    store.appendEvent({ sessionId: "s", payload: messageUpdated(buildAssistantMessage({ id: "steered-answer", sessionID: "s", parentID: "steered-prompt", agent: "build", directory: "/repo", created: 150 })) })
    store.finishTurn({ sessionId: "s", assistantMessageId: "answer", outcome: { status: "completed", completedAt: 200 }, leaseId })
    assert.equal(store.getSession("s")!.lastTurn!.assistantMessageId, "steered-answer")
    const terminal = store.database().prepare<{ assistant_message_id: string; payload_json: string }>("SELECT assistant_message_id, payload_json FROM runtime_journal WHERE session_id = ? AND type = 'turn.finish'").get("s")!
    assert.equal(terminal.assistant_message_id, "answer")
    assert.equal(JSON.parse(terminal.payload_json).outcome.assistantMessageId, "steered-answer")
    assert.equal(store.sessionAttentionHistory("s", 0, 256).events.length, 1)
  } finally { store.close() }
})

void test("attention cache resets during projection rebuild and a new session generation", () => {
  const { store } = fixture()
  try {
    const leaseId = start(store)
    store.finishTurn({ sessionId: "s", assistantMessageId: "answer", outcome: { status: "completed", completedAt: 200 }, leaseId })
    store.releaseTurnLease("s", leaseId)
    store.appendEvent({ sessionId: "s", payload: sessionBackgroundWork("s", { agents: 1, shells: 0, other: 0 }) })
    const before = store.getSession("s")!
    store.rebuildProjection("s")
    assert.deepEqual(store.getSession("s")!.attention, before.attention)
    assert.deepEqual(store.getSession("s")!.backgroundWork, before.backgroundWork)
    store.deleteSession("s")
    store.bindSession({ sessionId: "s", directory: "/new", workspaceId: "w", connectionId: "native", upstreamSessionId: "new-up", agentSessionId: "new-up", owner: { kind: "machine-owner" }, createdAt: 300 })
    store.appendEvent({ sessionId: "s", payload: sessionError("New session failed", "s") })
    const next = store.getSession("s")!
    assert.ok(next.attention!.generation > before.attention!.generation)
    assert.equal(next.backgroundWork, undefined)
    assert.equal(next.lastTurn!.assistantMessageId, undefined)
    assert.deepEqual(store.sessionAttentionHistory("s", 0, 256).events.map((event) => event.outcome), ["failed"])
  } finally { store.close() }
})

void test("broker background work is journaled once per change and survives restart", () => {
  const { root, store } = fixture()
  const delivery = new BrokerEventDelivery(store, { publishGlobal: () => {}, publishRuntime: () => {} })
  const producer = new BrokerBackgroundWork(store, delivery)
  producer.record("s", { agents: 1, shells: 0, other: 0 })
  const working = store.getSession("s")!.attention!
  producer.record("s", { agents: 1, shells: 0, other: 0 })
  assert.deepEqual(store.getSession("s")!.attention, working)
  assert.equal(working.working, true)
  producer.retireAll()
  const ended = store.getSession("s")!.attention!
  assert.equal(ended.working, false)
  assert.equal(store.database().prepare<{ count: number }>("SELECT COUNT(*) AS count FROM runtime_journal WHERE type = 'session.background-work'").get()!.count, 2)
  store.close()
  const reopened = openTestRuntimeStore(root)
  try { assert.deepEqual(reopened.getSession("s")!.attention, ended) } finally { reopened.close() }
})

void test("a restarted background producer compares its counts with the durable work state", () => {
  const { root, store } = fixture()
  const producer = new BrokerBackgroundWork(store, new BrokerEventDelivery(store, { publishGlobal: () => {}, publishRuntime: () => {} }))
  producer.record("s", { agents: 1, shells: 0, other: 0 })
  const active = store.getSession("s")!.attention!
  store.close()
  const reopened = openTestRuntimeStore(root)
  try {
    const restored = new BrokerBackgroundWork(reopened, new BrokerEventDelivery(reopened, { publishGlobal: () => {}, publishRuntime: () => {} }))
    restored.record("s", { agents: 0, shells: 0, other: 0 })
    const ended = reopened.getSession("s")!.attention!
    assert.equal(ended.working, false)
    assert.ok(ended.activitySequence > active.activitySequence)
    assert.equal(restored.read("s"), undefined)
  } finally { reopened.close() }
})

void test("long transcript reads use the terminal index and fold only newly applied attention", () => {
  const reads: { from: number; through: number }[] = []
  const { store } = fixture((root) => {
    const opened = openTestRuntimeStoreDatabase(root)
    const database = opened.db
    const prepare = database.prepare.bind(database)
    database.prepare = (<T>(sql: string) => {
      const statement = prepare<T>(sql)
      if (!sql.includes("'session.background-work'")) return statement
      const all = statement.all.bind(statement)
      return { ...statement, all: (...params: unknown[]) => { reads.push({ from: Number(params[1]), through: Number(params[2]) }); return all(...params) } }
    })
    return new RuntimeStore(opened)
  })
  try {
    const leaseId = start(store)
    store.finishTurn({ sessionId: "s", assistantMessageId: "answer", outcome: { status: "completed", completedAt: 200 }, leaseId })
    store.releaseTurnLease("s", leaseId)
    for (let index = 0; index < 2_000; index++) store.appendEvent({ sessionId: "s", payload: todoUpdated("s", []) })
    const initial = store.getSession("s")!.attention!
    const plan = store.database().prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${SESSION_ATTENTION_TERMINAL_QUERY}`).all("s", initial.generation, initial.sequence, initial.generation)
    assert.ok(plan.some((row) => row.detail.includes("runtime_journal_turn_outcome_idx")), JSON.stringify(plan))
    reads.length = 0
    for (let index = 0; index < 100; index++) assert.deepEqual(store.getSession("s")!.attention, initial)
    assert.deepEqual(reads, [])
    store.appendEvent({ sessionId: "s", payload: sessionBackgroundWork("s", { agents: 1, shells: 0, other: 0 }) })
    assert.equal(store.getSession("s")!.attention!.working, true)
    assert.deepEqual(reads, [{ from: initial.sequence, through: initial.sequence + 1 }])
  } finally { store.close() }
})

void test("session reads expose stable journal activity across title edits and restart", () => {
  const { root, store } = fixture()
  const initial = store.getSession("s")!.attention!
  assert.deepEqual(initial, { sequence: 1, generation: 1, activitySequence: 1, activityAt: 100, working: false, awaitingInput: false })
  assert.equal(store.getSession("s")!.status, "idle")
  store.updateSession("s", { title: "Renamed" })
  assert.deepEqual(store.getSession("s")!.attention, { ...initial, sequence: 2 })
  store.appendEvent({ sessionId: "s", payload: sessionError("Failed", "s") })
  const failed = store.getSession("s")!.attention!
  assert.equal(failed.outcome!.sequence, 3)
  assert.equal(failed.outcome!.status, "failed")
  store.close()
  const reopened = openTestRuntimeStore(root)
  try { assert.deepEqual(reopened.getSession("s")!.attention, failed) } finally { reopened.close() }
})

void test("background activity changes its boundary only when work actually changes", () => {
  const { store } = fixture()
  try {
    const initial = store.getSession("s")!.attention!
    store.appendEvent({ sessionId: "s", payload: sessionBackgroundWork("s", { agents: 0, shells: 0, other: 0 }) })
    assert.equal(store.getSession("s")!.attention!.activitySequence, initial.activitySequence)
    store.appendEvent({ sessionId: "s", payload: sessionBackgroundWork("s", { agents: 1, shells: 0, other: 0 }) })
    const active = store.getSession("s")!.attention!
    assert.equal(active.working, true)
    store.appendEvent({ sessionId: "s", payload: sessionBackgroundWork("s", { agents: 1, shells: 0, other: 0 }) })
    assert.equal(store.getSession("s")!.attention!.activitySequence, active.activitySequence)
    store.appendEvent({ sessionId: "s", payload: sessionBackgroundWork("s", { agents: 0, shells: 0, other: 0 }) })
    const ended = store.getSession("s")!.attention!
    assert.equal(ended.working, false)
    assert.ok(ended.activitySequence > active.activitySequence)
    assert.deepEqual(store.getSession("s")!.backgroundWork, { agents: 0, shells: 0, other: 0 })
  } finally { store.close() }
})

void test("a managed reply segment completion cannot publish a second turn outcome", () => {
  const { store } = fixture()
  try {
    const leaseId = store.acquireTurnLease("s")!
    store.startTurn({ sessionId: "s", agentSessionId: "up", userMessageId: "prompt", assistantMessageId: "answer", agent: "build", parts: [{ type: "text", text: "Work" }] })
    store.appendEvent({ sessionId: "s", payload: messageCompleted("s", "answer") })
    assert.equal(store.getSession("s")!.attention!.outcome, undefined)
    assert.deepEqual(store.sessionAttentionHistory("s", 0, 256).events, [])
    store.finishTurn({ sessionId: "s", assistantMessageId: "answer", outcome: { status: "completed", completedAt: 200 }, leaseId })
    const page = store.sessionAttentionHistory("s", 0, 256)
    assert.equal(page.events.length, 1)
    assert.equal(page.events[0].outcome, "completed")
    assert.equal(page.events[0].sequence, store.getSession("s")!.attention!.outcome!.sequence)
  } finally { store.close() }
})

void test("transient questions survive resolution, pagination and process restart", () => {
  const { root, store } = fixture()
  for (let index = 0; index < 260; index++) {
    store.appendEvent({ sessionId: "s", payload: questionAsked({ sessionID: "s", id: `q${index}`, questions: [] }) })
    store.appendEvent({ sessionId: "s", payload: questionReplied("s", `q${index}`, []) })
  }
  assert.equal(store.getSession("s")!.attention!.awaitingInput, false)
  const first = store.sessionAttentionHistory("s", 0, 256)
  assert.equal(first.events.length, 256)
  assert.equal(first.events[0].requestId, "q0")
  assert.ok(first.next)
  store.close()
  const reopened = openTestRuntimeStore(root)
  try {
    const last = reopened.sessionAttentionHistory("s", first.next, 256)
    assert.deepEqual(last.events.map((event) => event.requestId), ["q256", "q257", "q258", "q259"])
    assert.equal(last.next, undefined)
    assert.equal(last.through, 521)
    assert.deepEqual(reopened.sessionAttentionHistory("s", last.through, 256).events, [])
    assert.throws(() => reopened.sessionAttentionHistory("s", last.through + 1, 256), /ahead/)
  } finally { reopened.close() }
})

void test("workspace inventory and removal records preserve exact scope and generation", () => {
  const { store } = fixture()
  try {
    store.bindSession({ sessionId: "child", directory: "/child", workspaceId: "w", connectionId: "native", upstreamSessionId: "child-up", agentSessionId: "child-up", parentSessionId: "s", owner: { kind: "machine-owner" } })
    store.bindSession({ sessionId: "child", directory: "/child", agentSessionId: "child-up" })
    store.bindSession({ sessionId: "s", directory: "/s", agentSessionId: "up" })
    store.bindSession({ sessionId: "other", directory: "/other", workspaceId: "other", connectionId: "native", upstreamSessionId: "other-up", agentSessionId: "other-up", owner: { kind: "machine-owner" } })
    assert.deepEqual(store.sessionDescendants("s"), ["child"])
    assert.deepEqual(new Set(store.listWorkspaceSessionIds("w")), new Set(["s", "child"]))
    store.deleteSession("s")
    assert.deepEqual(store.listWorkspaceSessionIds("w"), [])
    assert.equal(store.getSession("child"), null)
    assert.deepEqual(store.listWorkspaceDeletedRootSessionIds("w"), ["s"])
    assert.deepEqual(store.listWorkspaceDeletedRootSessionIds("other"), [])
  } finally { store.close() }
})
