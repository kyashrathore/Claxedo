import { afterAll, afterEach, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { SessionCleanupTarget, SessionReaderCommand } from "@claxedo/agent-runtime-contract"
import { SessionCleanupRoutes } from "@claxedo/server-core/session/cleanup-routes"
import { buildSessionListResponse, sessionListStorePageFilter } from "@claxedo/server-core/session/navigation-list"

const root = path.join(os.tmpdir(), `session-cleanup-reader-${randomUUID()}`)
const old = { data: process.env.CLAXEDO_DATA_DIR, state: process.env.CLAXEDO_STATE_DIR }
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")
const [{ syncSessionMeta, sessionMeta, listSessionNavigationMetas }, { ClaxedoDB }, { writeSessionReader, readSessionReader }, { admitLocalSessionCleanup }] = await Promise.all([
  import("@claxedo/server-core/session/meta/index"),
  import("@claxedo/server-core/platform/db/index"),
  import("@claxedo/server-core/session/reader"),
  import("./cleanup-reader"),
])
afterEach(async () => { ClaxedoDB.close(); await fs.rm(root, { recursive: true, force: true }) })
afterAll(() => {
  if (old.data === undefined) delete process.env.CLAXEDO_DATA_DIR; else process.env.CLAXEDO_DATA_DIR = old.data
  if (old.state === undefined) delete process.env.CLAXEDO_STATE_DIR; else process.env.CLAXEDO_STATE_DIR = old.state
})
const workspace = { id: "ws", directory: "/tmp/ws", kind: "local" as const, created_at: 1, updated_at: 1 }
const facts = { sequence: 5, generation: 1, activitySequence: 5, activityAt: 100, working: false, awaitingInput: false, outcome: { sequence: 5, completedAt: 100, status: "completed" as const } }
const selected = { sessionId: "root", workspaceId: "ws", generation: 1, activitySequence: 5, readerRevision: 0, descendants: [] }
async function seed() {
  await syncSessionMeta(workspace, { id: "root", title: "Root", time: { created: 1, updated: 100 }, attention: facts })
  return (await sessionMeta("root"))!.sessionRef!
}

test("a local reader change after selection conflicts at cleanup command admission", async () => {
  const sessionRef = await seed()
  admitLocalSessionCleanup(selected)
  const seen = writeSessionReader({ sessionRef, readerId: "local-owner", command: { kind: "seen", generation: 1, outcomeSequence: 5 }, now: 200 })
  expect(seen.ok).toBe(true)
  expect(() => admitLocalSessionCleanup(selected)).toThrow("reader state changed")
  admitLocalSessionCleanup({ ...selected, readerRevision: 1 })
})

test("other readers do not change the owner's admission and generation reuse conflicts", async () => {
  const sessionRef = await seed()
  writeSessionReader({ sessionRef, readerId: "other-reader", command: { kind: "seen", generation: 1, outcomeSequence: 5 }, now: 200 })
  admitLocalSessionCleanup(selected)
  await syncSessionMeta(workspace, { id: "root", time: { created: 1, updated: 300 }, attention: { ...facts, generation: 10, sequence: 12, activitySequence: 12, outcome: undefined } })
  expect(() => admitLocalSessionCleanup(selected)).toThrow("generation changed")
})

function cleanupRoute(input: { holdDeletion?: Promise<void>; onDispatch?: () => void } = {}) {
  const dispatched: SessionCleanupTarget[] = []
  const app = SessionCleanupRoutes({ authenticate: async () => ({
    list: async (query) => buildSessionListResponse({
      query,
      sessions: await listSessionNavigationMetas(sessionListStorePageFilter(query)),
      cursorApplied: true,
    }),
    prepare: async () => ({ descendants: [] }),
    admit: async (target) => { admitLocalSessionCleanup(target) },
    delete: async (target) => {
      dispatched.push(target)
      input.onDispatch?.()
      await input.holdDeletion
      return { deletedSessionIds: [target.sessionId] }
    },
  }) })
  return { app, dispatched }
}

async function selectCandidate(app: ReturnType<typeof SessionCleanupRoutes>) {
  const response = await app.request("http://fixture/api/claxedo/session-cleanup?workspaceId=ws&settled=all&seen=all")
  expect(response.status).toBe(200)
  const page = await response.json()
  expect(page.incompleteSources).toEqual([])
  expect(page.candidates).toHaveLength(1)
  const { sessionId, workspaceId, generation, activitySequence, readerRevision, descendants } = page.candidates[0]
  return { sessionId, workspaceId, generation, activitySequence, readerRevision, descendants } as SessionCleanupTarget
}

function requestDeletion(app: ReturnType<typeof SessionCleanupRoutes>, target: SessionCleanupTarget) {
  return app.request("http://fixture/api/claxedo/session-cleanup/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targets: [target], cascade: false }),
  })
}

async function prepareReaderMutation(kind: "seen" | "return") {
  const sessionRef = await seed()
  if (kind === "return") {
    expect(writeSessionReader({ sessionRef, readerId: "local-owner", now: 200,
      command: { kind: "settle", generation: 1, activitySequence: 5, outcomeSequence: 5, revision: 0 } }))
      .toMatchObject({ ok: true, state: { revision: 1, settledThrough: 5 } })
  }
  const command: SessionReaderCommand = kind === "seen"
    ? { kind: "seen", generation: 1, outcomeSequence: 5 }
    : { kind: "return", generation: 1, revision: 1 }
  return { sessionRef, command }
}

test.each(["seen", "return"] as const)("an owner's %s before route admission rejects the selected target without dispatch", async (kind) => {
  const { sessionRef, command } = await prepareReaderMutation(kind)
  const { app, dispatched } = cleanupRoute()
  const candidate = await selectCandidate(app)
  const changed = writeSessionReader({ sessionRef, readerId: "local-owner", command, now: 300 })
  expect(changed).toMatchObject({ ok: true, state: { revision: candidate.readerRevision + 1 } })

  const response = await requestDeletion(app, candidate)
  expect(await response.json()).toMatchObject({ results: [{ sessionId: "root", status: "failed", code: "session_cleanup_changed" }] })
  expect(dispatched).toEqual([])
  expect(await sessionMeta("root")).toBeDefined()
})

test("another reader's persisted change does not invalidate the owner selected through the route", async () => {
  const sessionRef = await seed()
  const { app, dispatched } = cleanupRoute()
  const candidate = await selectCandidate(app)
  expect(writeSessionReader({ sessionRef, readerId: "another-reader", command: { kind: "seen", generation: 1, outcomeSequence: 5 }, now: 300 }))
    .toMatchObject({ ok: true, state: { revision: 1 } })
  expect(readSessionReader(sessionRef, "local-owner")).toBeUndefined()

  const response = await requestDeletion(app, candidate)
  expect(await response.json()).toMatchObject({ results: [{ sessionId: "root", status: "deleted", deletedSessionIds: ["root"] }] })
  expect(dispatched).toEqual([candidate])
})

test.each(["seen", "return"] as const)("an owner's %s after route admission leaves that command valid and blocks later stale admission", async (kind) => {
  const { sessionRef, command } = await prepareReaderMutation(kind)
  const dispatch = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const { app, dispatched } = cleanupRoute({ holdDeletion: release.promise, onDispatch: dispatch.resolve })
  const candidate = await selectCandidate(app)
  const admittedRequest = requestDeletion(app, candidate)
  await dispatch.promise
  try {
    const changed = writeSessionReader({ sessionRef, readerId: "local-owner", command, now: 300 })
    expect(changed).toMatchObject({ ok: true, state: { revision: candidate.readerRevision + 1 } })
    expect(readSessionReader(sessionRef, "local-owner")).toMatchObject({ revision: candidate.readerRevision + 1 })
    const laterRequest = await requestDeletion(app, candidate)
    expect(await laterRequest.json()).toMatchObject({ results: [{ status: "failed", code: "session_cleanup_changed" }] })
    expect(dispatched).toEqual([candidate])
  } finally {
    release.resolve()
  }
  expect(await (await admittedRequest).json()).toMatchObject({ results: [{ status: "deleted", deletedSessionIds: ["root"] }] })
  expect(dispatched).toEqual([candidate])
})
