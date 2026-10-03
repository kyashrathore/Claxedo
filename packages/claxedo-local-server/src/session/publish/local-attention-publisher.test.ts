import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { SessionAttentionEvent, SessionAttentionFacts } from "@claxedo/agent-runtime-contract"
import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"
import type { SessionStateEvent } from "@claxedo/server-core/platform/runtime/lib/session-state-events"
import { eventVisibleTo } from "@claxedo/server-core/platform/http/event-visibility"
import type { SessionRowSource } from "./local-session-rows"
import { createLocalSessionAttentionPublisher } from "./local-attention-publisher"
import { createLocalSessionAttentionRoutes } from "../routes/attention"

const root = path.join(os.tmpdir(), `local-attention-${randomUUID()}`)
const previous = { data: process.env.CLAXEDO_DATA_DIR, state: process.env.CLAXEDO_STATE_DIR }
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
const [{ ClaxedoDB }, meta, ledger] = await Promise.all([
  import("@claxedo/server-core/platform/db/index"), import("@claxedo/server-core/session/meta/index"), import("@claxedo/server-core/session/attention-ledger"),
])
const workspace = { id: "ws_local", project_id: "project_local", directory: "/tmp/local", kind: "local" as const, created_at: 1, updated_at: 1 }
const facts: SessionAttentionFacts = { generation: 1, sequence: 10, activitySequence: 10, activityAt: 100, working: false, awaitingInput: false }
const stopped: Array<{ stop(): void }> = []
beforeEach(async () => { await fs.mkdir(root, { recursive: true }) })
afterEach(async () => { for (const item of stopped.splice(0)) item.stop(); vi.useRealTimers(); ClaxedoDB.close(); await fs.rm(root, { recursive: true, force: true }) })
afterAll(() => {
  if (previous.data === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous.data
  if (previous.state === undefined) delete process.env.CLAXEDO_STATE_DIR
  else process.env.CLAXEDO_STATE_DIR = previous.state
})

function harness(initialWorkspaceIds = [workspace.id]) {
  let row: HostSessionRow = { sessionId: "session", workspaceId: workspace.id, title: "Session", createdAt: 1, updatedAt: 100,
    status: { kind: "idle", awaitingInput: false, at: 100 }, attention: facts }
  const events: SessionAttentionEvent[] = [{ kind: "outcome", sequence: 10, openedAt: 100, outcome: "completed" }]
  const notices: SessionStateEvent[] = []
  let failed = false
  let child = false
  const reads: number[] = []
  const source: SessionRowSource = {
    prepareWorkspace: async () => {},
    attentionSnapshot: () => child ? [] : [{ sessionId: row.sessionId, attention: row.attention! }],
    removedRows: async () => [],
    listRows: async () => [row],
    readRow: async () => child ? { kind: "child" } : { kind: "row", row },
    attentionPage: async (_workspaceId, _sessionId, after) => {
      reads.push(after)
      if (failed) throw new Error("Runtime unavailable")
      const held = events.filter((event) => event.sequence > after)
      const page = held.slice(0, 2)
      return { generation: row.attention!.generation, through: row.attention!.sequence, events: page,
        ...(held.length > 2 ? { next: page[page.length - 1].sequence } : {}) }
    },
  }
  const create = (beforePublish?: (event: SessionStateEvent) => void) => {
    const publisher = createLocalSessionAttentionPublisher({ source, projection: { session_meta: meta.sessionMeta }, workspaceIds: async () => initialWorkspaceIds,
      publish: (event) => { beforePublish?.(event); notices.push(event) }, onError: () => {} })
    stopped.push(publisher)
    return publisher
  }
  const put = async (attention = facts) => {
    row = { ...row, attention }
    await meta.syncSessionMeta(workspace, { id: row.sessionId, title: row.title, time: { created: 1, updated: 100 }, attention })
  }
  return { create, put, events, notices, reads, rename: (title: string) => { row = { ...row, title } },
    fail: (value: boolean) => { failed = value }, child: () => { child = true } }
}

test("startup is silent, a request answered inside the batching window emits once, and restart recovers it durably", async () => {
  const h = harness()
  await h.put()
  const publisher = h.create()
  await publisher.start()
  expect(h.notices.map((notice) => notice.replayed)).toEqual([true, true])
  h.events.push({ kind: "question", sequence: 11, requestId: "question", openedAt: 110 })
  await h.put({ ...facts, sequence: 12, activitySequence: 11, activityAt: 110 })
  await Promise.all([publisher.sessionChanged(workspace.id, "session"), publisher.sessionChanged(workspace.id, "session")])
  const live = h.notices.filter((notice) => !notice.replayed)
  expect(live.map((notice) => notice.type)).toEqual(["session.attention.raised", "session.status.changed"])
  expect(live[0]).toMatchObject({ event: { kind: "question", requestId: "question" }, projectId: workspace.project_id })
  publisher.stop()
  ClaxedoDB.close()
  h.notices.length = 0
  await h.create().start()
  expect(h.notices.map((notice) => notice.type)).toEqual(["session.status.changed"])
  expect(h.reads).toEqual([0, 10])
  expect(ledger.listLocalSessionAttention({ after: 0, limit: 256 }).events.map((event) => event.event.kind)).toEqual(["outcome", "question"])
})

test("all history pages are persisted and children never raise independent attention", async () => {
  const h = harness()
  h.events.push({ kind: "permission", sequence: 13, requestId: "permission", openedAt: 130 },
    { kind: "outcome", sequence: 20, outcome: "failed", openedAt: 200 })
  await h.put({ ...facts, sequence: 20, activitySequence: 20, activityAt: 200 })
  const publisher = h.create()
  await publisher.start()
  expect(h.reads).toEqual([0, 13])
  expect(ledger.listLocalSessionAttention({ after: 0, limit: 256 }).events).toHaveLength(3)
  h.notices.length = 0
  h.child()
  await publisher.sessionChanged(workspace.id, "child")
  expect(h.notices).toEqual([])
})

test("source failures retain the checkpoint and automatically retry the historical scan silently", async () => {
  vi.useFakeTimers()
  const h = harness()
  await h.put()
  h.fail(true)
  const publisher = h.create()
  await expect(publisher.start()).rejects.toThrow("snapshot is incomplete")
  expect(ledger.listLocalSessionAttention({ after: 0, limit: 256 }).events).toEqual([])
  h.fail(false)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(ledger.listLocalSessionAttention({ after: 0, limit: 256 }).events).toHaveLength(1)
  expect(h.notices.every((notice) => notice.replayed === true)).toBe(true)
  h.events.push({ kind: "question", sequence: 11, requestId: "after-recovery", openedAt: 110 })
  await h.put({ ...facts, sequence: 12, activitySequence: 11, activityAt: 110 })
  await publisher.sessionChanged(workspace.id, "session")
  const raised = h.notices.filter((notice) => notice.type === "session.attention.raised")
  expect(raised[1]).toMatchObject({ event: { requestId: "after-recovery" } })
  expect(raised[1]?.replayed).not.toBe(true)
})

test("the unsigned recovery endpoint exposes the persisted canonical page through its public route", async () => {
  const h = harness()
  await h.put()
  await h.create().start()
  const app = createLocalSessionAttentionRoutes({ authenticate: async () => undefined })
  const response = await app.request("/api/claxedo/session-attention?after=0&limit=1")
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ through: 1, events: [{ cursor: 1, sessionId: "session", workspaceId: workspace.id,
    projectId: workspace.project_id, generation: 1, event: { kind: "outcome", sequence: 10, outcome: "completed" } }] })
  expect(await (await app.request("/api/claxedo/session-attention?after=1&limit=1")).json()).toEqual({ through: 1, events: [] })
  expect(h.notices.every((notice) => eventVisibleTo({ mode: "unsigned-local" }, notice))).toBe(true)
  expect(h.notices.some((notice) => eventVisibleTo({ mode: "signed", subject: "other-subject", orgId: "org" }, notice))).toBe(false)
})

test("a malformed source page is refused before its checkpoint or events can be persisted", async () => {
  const h = harness()
  h.events.push({ kind: "permission", sequence: 5, requestId: "out-of-order", openedAt: 50 })
  await h.put()
  await expect(h.create().start()).rejects.toThrow("snapshot is incomplete")
  expect(ledger.listLocalSessionAttention({ after: 0, limit: 256 })).toEqual({ through: 0, events: [] })
  expect(ledger.localSessionAttentionPosition((await meta.sessionMeta("session"))!.sessionRef!, 1)).toBe(0)
  expect(h.notices).toEqual([])
})

test("a workspace created after an empty startup raises completed work live and stays live on later snapshots", async () => {
  const h = harness([])
  const publisher = h.create()
  await publisher.start()
  expect(h.notices).toEqual([])
  await h.put()
  await publisher.sessionChanged(workspace.id, "session")
  const completion = h.notices.filter((notice) => notice.type === "session.attention.raised")
  expect(completion).toHaveLength(1)
  expect(completion[0]).toMatchObject({ event: { kind: "outcome", outcome: "completed" } })
  expect(completion[0]?.replayed).not.toBe(true)
  h.events.push({ kind: "permission", sequence: 11, requestId: "new-request", openedAt: 110 })
  await h.put({ ...facts, sequence: 12, activitySequence: 11, activityAt: 110 })
  await publisher.workspaceChanged(workspace.id)
  const raised = h.notices.filter((notice) => notice.type === "session.attention.raised")
  expect(raised).toHaveLength(2)
  expect(raised.every((notice) => notice.replayed !== true)).toBe(true)
})
