import {
  messagePartUpdated,
  messageUpdated,
  permissionAsked,
  questionAsked,
  todoUpdated,
} from "../projection/presentation-events"
import type { RuntimeStore } from "../store"
import { RuntimeStoreSchemaMismatchError } from "../store-schema"

/**
 * The store's core scenarios, written once against whatever SQLite the caller
 * opens them on. Each `open()` is a new `RuntimeStore` over the same database,
 * so a scenario that opens twice checks what survives a reopen.
 *
 * No `node:assert`: these also run inside workerd.
 */
export type StoreHarness = {
  open(): RuntimeStore
  /** Run SQL beside the store, as another writer of the same database would. */
  exec(sql: string): void
}

const OWNER = { kind: "person", userId: "user-owner" } as const

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
}

function same(actual: unknown, expected: unknown, what: string) {
  const [a, e] = [JSON.stringify(canonical(actual)), JSON.stringify(canonical(expected))]
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`)
}

function bound(store: RuntimeStore, sessionId = "s1") {
  store.bindSession({ owner: OWNER, sessionId, directory: "/work", agentSessionId: `agent-${sessionId}`, createdAt: 1 })
}

function userMessage(store: RuntimeStore, index: number) {
  const id = `m${index}`
  store.appendEvent({ sessionId: "s1", payload: messageUpdated({ id, sessionID: "s1", role: "user", time: { created: index } }) })
  store.appendEvent({ sessionId: "s1", payload: messagePartUpdated({ id: `${id}-text`, sessionID: "s1", messageID: id, type: "text", text: `message ${index}` }) })
}

export const storeCoreScenarios: Record<string, (harness: StoreHarness) => void> = {
  "a created session keeps its owner and binding across reopen"({ open }) {
    const store = open()
    bound(store)
    same(store.sessionOwner("s1"), OWNER, "owner")
    const reopened = open()
    same(reopened.getSession("s1")?.directory, "/work", "directory")
    same(reopened.sessionOwner("s1"), OWNER, "owner after reopen")
    same(reopened.getAgentSessionId("s1"), "agent-s1", "agent session")
    same(reopened.listSessions("/work").map((session) => session.id), ["s1"], "listing")
  },

  "an appended event is journaled and projected, and replays after reopen"({ open }) {
    const store = open()
    bound(store)
    store.appendEvent({ sessionId: "s1", payload: todoUpdated("s1", [{ id: "t1", content: "Write it", status: "pending", priority: "high" }]) })
    same(store.getTodos("s1"), [{ id: "t1", content: "Write it", status: "pending", priority: "high" }], "todos")
    same(open().getTodos("s1"), [{ id: "t1", content: "Write it", status: "pending", priority: "high" }], "todos after reopen")
  },

  "a turn commits under its lease and projects both messages and the idle session"({ open }) {
    const store = open()
    bound(store)
    const leaseId = store.acquireTurnLease("s1")
    if (!leaseId) throw new Error("no turn lease")
    store.startTurn({
      sessionId: "s1", agentSessionId: "agent-s1", userMessageId: "u1", assistantMessageId: "a1", agent: "build",
      model: { providerID: "anthropic", modelID: "opus" }, parts: [{ type: "text", text: "go" }],
    })
    same(store.getSession("s1")?.status, "busy", "status while running")
    store.appendEvent({ sessionId: "s1", payload: messagePartUpdated({ id: "a1-text", sessionID: "s1", messageID: "a1", type: "text", text: "done" }) })
    store.finishTurn({ sessionId: "s1", assistantMessageId: "a1", outcome: { status: "completed", completedAt: 5 }, leaseId })
    const reopened = open()
    same(reopened.getSession("s1")?.status, "idle", "status after finish")
    same(reopened.getMessages("s1").map((message) => [message.info.id, message.parts.map((part) => part.type === "text" ? part.text : part.type)]),
      [["u1", ["go"]], ["a1", ["done"]]], "messages")
  },

  "messages page backward through an opaque cursor"({ open }) {
    const store = open()
    bound(store)
    for (let index = 1; index <= 5; index++) userMessage(store, index)
    const first = store.getMessagePage("s1", { limit: 2 })
    same(first?.messages.map((message) => message.info.id), ["m4", "m5"], "first page")
    const second = open().getMessagePage("s1", { limit: 2, ...(first?.nextCursor ? { before: first.nextCursor } : {}) })
    same(second?.messages.map((message) => message.info.id), ["m2", "m3"], "second page")
  },

  "pending permissions and questions are listed for the session's directory across reopen"({ open }) {
    const store = open()
    bound(store)
    const permission = { id: "p1", sessionID: "s1", permission: "command", patterns: ["ls"], always: [], metadata: {}, options: [] }
    store.appendEvent({ sessionId: "s1", payload: permissionAsked(permission) })
    store.appendEvent({ sessionId: "s1", payload: questionAsked({
      id: "q1", sessionID: "s1", questions: [{ question: "Ship it?", header: "Ship", options: [{ label: "Yes", description: "Ship it" }], custom: false }],
    }) })
    const reopened = open()
    same(reopened.listPermissions("/work"), [permission], "permissions")
    same(reopened.listQuestions("/work").map((question) => question.id), ["q1"], "questions")
    same(reopened.listPermissions("/other"), [], "another directory")
  },

  "a projection that fails rolls back while its journal row stays, and replays once repaired"({ open, exec }) {
    const store = open()
    exec("CREATE TRIGGER refuse_session BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT, 'session projection refused'); END")
    let refused = false
    try {
      bound(store)
    } catch {
      refused = true
    }
    same(refused, true, "bind refused")
    same(store.getSession("s1"), null, "no half-written session")
    exec("DROP TRIGGER refuse_session")
    same(open().sessionOwner("s1"), OWNER, "owner after replay")
  },

  "a store written by another schema is refused at open, naming it"({ open, exec }) {
    open()
    exec("UPDATE runtime_store_schema SET identity = 'CREATE TABLE session (id TEXT)'")
    try {
      open()
    } catch (error) {
      if (!(error instanceof RuntimeStoreSchemaMismatchError)) throw error
      same(error.code, "runtime_store_schema_mismatch", "code")
      return
    }
    throw new Error("a store with another schema opened")
  },
}
