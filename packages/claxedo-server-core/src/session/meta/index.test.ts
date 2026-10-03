import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import type { SessionAttentionFacts } from "@claxedo/agent-runtime-contract"

const root = path.join(realpathSync(os.tmpdir()), `session-meta-order-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const [{ deleteSessionMeta, listSessionNavigationMetas, countSessionNavigation, onSessionMetaChange, putSessionMeta, sessionMeta, syncSessionMeta, syncSessionMetas }, { ClaxedoDB }, { controlBus }] = await Promise.all([
  import("./index"),
  import("../../platform/db"),
  import("../../platform/runtime/lib/bus"),
])
const { readSessionReader, writeSessionReader } = await import("../reader")
const { appendLocalSessionAttention, listLocalSessionAttention } = await import("../attention-ledger")

const ws = {
  id: "ws_order",
  project_id: "proj_order",
  directory: "/tmp/order",
  kind: "local" as const,
  created_at: 1,
  updated_at: 1,
}

beforeEach(async () => {
  await fs.mkdir(root, { recursive: true })
})

afterEach(async () => {
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  if (prev.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  if (prev.CLAXEDO_STATE_DIR === undefined) delete process.env.CLAXEDO_STATE_DIR
  else process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
})

function engineSession(input: { id: string; created: number; updated: number; lastHumanTurn?: number }) {
  return {
    id: input.id,
    title: input.id,
    time: {
      created: input.created,
      updated: input.updated,
      ...(input.lastHumanTurn !== undefined ? { lastHumanTurn: input.lastHumanTurn } : {}),
    },
  }
}

function order(rows: Array<{ sessionID: string }>) {
  return rows.map((row) => row.sessionID)
}

describe("persistent session reader inventory", () => {
  const facts: SessionAttentionFacts = { sequence: 10, generation: 1, activitySequence: 10, activityAt: 500, working: false, awaitingInput: false, outcome: { sequence: 10, completedAt: 500, status: "completed" } }
  const page = (readerId: string, extra: object = {}) => listSessionNavigationMetas({ workspaceID: ws.id, readerId, sort: "human_turn_desc", limit: 1, ...extra })
  const seed = (id: string, created: number, attention = facts) => syncSessionMeta(ws, { ...engineSession({ id, created, updated: 500 }), attention })

  test("inventory persists the canonical terminal identity and clears it with a newer empty generation", async () => {
    const lastTurn = { status: "failed", completedAt: 500, assistantMessageId: "msg_terminal", error: "Provider failed", detail: { provider: "test" } } as const
    const attention = { ...facts, outcome: { ...facts.outcome!, status: "failed" as const } }
    await syncSessionMeta(ws, { ...engineSession({ id: "terminal", created: 100, updated: 500 }), attention, lastTurn })
    ClaxedoDB.close()
    expect((await page("alice"))[0]?.lastTurn).toEqual(lastTurn)
    await syncSessionMeta(ws, { ...engineSession({ id: "terminal", created: 100, updated: 400 }), attention: { ...attention, sequence: 9, activitySequence: 9, outcome: { sequence: 9, status: "completed", completedAt: 400 } }, lastTurn: { status: "completed", completedAt: 400, assistantMessageId: "msg_stale" } })
    expect((await page("alice"))[0]?.lastTurn).toEqual(lastTurn)
    await syncSessionMeta(ws, { ...engineSession({ id: "terminal", created: 100, updated: 600 }), attention: { ...facts, sequence: 11, generation: 2, outcome: undefined } })
    expect((await page("alice"))[0]?.lastTurn).toBeUndefined()
  })

  test("settlement persists, stays private, and is filtered before the page limit", async () => {
    await seed("older", 100)
    await seed("newer", 200)
    const sessionRef = (await sessionMeta("newer"))!.sessionRef!
    const result = writeSessionReader({ sessionRef, readerId: "alice", command: { kind: "settle", generation: 1, activitySequence: 10, outcomeSequence: 10, revision: 0 }, now: 600 })
    expect(result.ok).toBe(true)
    ClaxedoDB.close()
    expect(readSessionReader(sessionRef, "alice")?.settledAt).toBe(600)
    expect(readSessionReader(sessionRef, "bob")).toBeUndefined()
    expect(order(await page("alice"))).toEqual(["older"])
    expect(order(await page("bob"))).toEqual(["newer"])
    expect(order(await page("alice", { settled: "settled" }))).toEqual(["newer"])
  })

  test("Seen and date predicates select old attention before paging with exclusive upper bounds", async () => {
    await seed("waiting", 100, { ...facts, awaitingInput: true, working: true })
    await seed("working", 200, { ...facts, working: true })
    await seed("idle", 300, { ...facts, outcome: undefined })
    await seed("settled", 400)
    writeSessionReader({ sessionRef: (await sessionMeta("settled"))!.sessionRef!, readerId: "alice",
      command: { kind: "settle", generation: 1, activitySequence: 10, outcomeSequence: 10, revision: 0 }, now: 600 })
    expect(order(await page("alice", { settled: "settled" }))).toEqual(["settled"])
    expect(order(await page("alice", { seen: "seen" }))).toEqual(["idle"])
    expect(order(await page("alice", { seen: "unseen", limit: 10 }))).toEqual(["working", "waiting"])
    expect(order(await page("alice", { dateField: "created", from: 100, until: 200 }))).toEqual(["waiting"])
    expect(order(await page("alice", { dateField: "activity", from: 501 }))).toEqual([])
    expect(order(await page("alice", { settled: "all", dateField: "settled", from: 600, until: 601 }))).toEqual(["settled"])
    expect(order(await page("alice", { settled: "all", dateField: "settled", until: 600 }))).toEqual([])
    expect(countSessionNavigation({ workspaceID: ws.id, readerId: "alice", limit: 1 }))
      .toEqual(3)
    expect(countSessionNavigation({ workspaceID: ws.id, readerId: "alice", settled: "all", limit: 1 }))
      .toEqual(4)
    expect(order(await page("alice", { activity: "working" }))).toEqual(["working"])
    expect(order(await page("alice", { activity: "needs-you" }))).toEqual(["idle"])
    expect(order(await page("alice", { activity: "needs-you", seen: "unseen" }))).toEqual(["waiting"])
    expect(countSessionNavigation({ workspaceID: ws.id, readerId: "alice", activity: "working", limit: 1 })).toBe(1)
    expect(countSessionNavigation({ workspaceID: ws.id, readerId: "alice", activity: "needs-you", limit: 1 })).toBe(2)
  })

  test("Seen preserves active membership while Settle and Return change only that reader's lifecycle", async () => {
    await seed("s", 100)
    const sessionRef = (await sessionMeta("s"))!.sessionRef!
    const total = (readerId: string) => countSessionNavigation({ workspaceID: ws.id, readerId, settled: "all", limit: 1 })
    expect(writeSessionReader({ sessionRef, readerId: "alice", command: { kind: "seen", generation: 1, outcomeSequence: 10 }, now: 600 }))
      .toMatchObject({ ok: true, state: { revision: 1, seenThrough: 10 } })
    expect(order(await page("alice", { seen: "seen" }))).toEqual(["s"])
    expect(total("alice")).toEqual(1)
    expect(order(await page("bob", { seen: "unseen" }))).toEqual(["s"])
    expect(writeSessionReader({ sessionRef, readerId: "alice",
      command: { kind: "settle", generation: 1, activitySequence: 10, outcomeSequence: 10, revision: 1 }, now: 700 }))
      .toMatchObject({ ok: true, state: { revision: 2, seenThrough: 10, settledThrough: 10 } })
    ClaxedoDB.close()
    expect(order(await page("alice"))).toEqual([])
    expect(order(await page("alice", { settled: "settled", seen: "seen" }))).toEqual(["s"])
    expect(total("alice")).toEqual(1)
    expect(total("bob")).toEqual(1)
    expect(writeSessionReader({ sessionRef, readerId: "alice", command: { kind: "return", generation: 1, revision: 2 }, now: 800 }))
      .toMatchObject({ ok: true, state: { revision: 3, seenThrough: 10 } })
    expect(order(await page("alice", { seen: "seen" }))).toEqual(["s"])
    expect(order(await page("alice", { settled: "settled" }))).toEqual([])
    expect(total("alice")).toEqual(1)
  })




  test("a mutation compares canonical facts inside the transaction and cannot create orphan state", async () => {
    await seed("s", 100, { ...facts, sequence: 11, activitySequence: 11 })
    const sessionRef = (await sessionMeta("s"))!.sessionRef!
    expect(writeSessionReader({ sessionRef, readerId: "alice", command: { kind: "settle", generation: 1, activitySequence: 10, outcomeSequence: 10, revision: 0 }, now: 600 }))
      .toEqual({ ok: false, reason: "activity_changed" })
    await deleteSessionMeta("s")
    expect(() => writeSessionReader({ sessionRef, readerId: "alice", command: { kind: "seen", generation: 1, outcomeSequence: 10 }, now: 600 }))
      .toThrow("Session not found")
    expect(readSessionReader(sessionRef, "alice")).toBeUndefined()
  })

  test("a canonical snapshot that drops activity facts is rejected without erasing them", async () => {
    await seed("s", 100)
    await expect(syncSessionMeta(ws, engineSession({ id: "s", created: 100, updated: 600 })))
      .rejects.toThrow("snapshot omitted canonical activity facts")
    expect((await sessionMeta("s"))?.attention).toEqual(facts)
  })

  test("reader state follows a workspace ref change and its latest persisted revision wins", async () => {
    const workspaceRef = `workspace:${ws.id}:session:s`
    const localRef = `local:${ws.directory}:session:s`
    await syncSessionMeta({ ...ws, kind: "cloud" }, { ...engineSession({ id: "s", created: 100, updated: 500 }), attention: facts })
    writeSessionReader({ sessionRef: workspaceRef, readerId: "alice", command: { kind: "seen", generation: 1, outcomeSequence: 10 }, now: 600 })
    appendLocalSessionAttention(workspaceRef, { sessionId: "s", workspaceId: ws.id, generation: 1, through: 10,
      events: [{ kind: "outcome", sequence: 10, openedAt: 500, outcome: "completed" }] })
    await seed("s", 100)
    expect(readSessionReader(workspaceRef, "alice")).toBeUndefined()
    expect(readSessionReader(localRef, "alice")).toMatchObject({ revision: 1, seenThrough: 10 })
    expect(listLocalSessionAttention({ after: 0, limit: 10 }).events).toMatchObject([{ sessionId: "s", generation: 1 }])
  })

  test("newer activity restores settlement even when runtime updated time did not move", async () => {
    await seed("s", 100)
    const sessionRef = (await sessionMeta("s"))!.sessionRef!
    writeSessionReader({ sessionRef, readerId: "alice", command: { kind: "settle", generation: 1, activitySequence: 10, outcomeSequence: 10, revision: 0 }, now: 600 })
    await seed("s", 100, { ...facts, sequence: 12, activitySequence: 11, activityAt: 700 })
    await seed("s", 100, facts)
    expect((await sessionMeta("s"))?.attention?.sequence).toBe(12)
    expect(order(await page("alice"))).toEqual(["s"])
    expect(order(await page("alice", { settled: "settled" }))).toEqual([])
    expect(order(await page("alice", { seen: "seen" }))).toEqual(["s"])
  })

  test("deletion removes private state so reusing a session id cannot inherit acknowledgement", async () => {
    await seed("s", 100)
    const sessionRef = (await sessionMeta("s"))!.sessionRef!
    writeSessionReader({ sessionRef, readerId: "alice", command: { kind: "seen", generation: 1, outcomeSequence: 10 }, now: 600 })
    appendLocalSessionAttention(sessionRef, { sessionId: "s", workspaceId: ws.id, generation: 1, through: 10,
      events: [{ kind: "outcome", sequence: 10, openedAt: 500, outcome: "completed" }] })
    expect(listLocalSessionAttention({ after: 0, limit: 10 }).events).toHaveLength(1)
    await deleteSessionMeta("s")
    await seed("s", 200)
    expect(readSessionReader(sessionRef, "alice")).toBeUndefined()
    expect(listLocalSessionAttention({ after: 0, limit: 10 }).events).toEqual([])
  })
})

describe("session navigation order", () => {
  test("the engine snapshot's last human turn survives the sync and orders the list", async () => {
    await syncSessionMetas(ws, [
      engineSession({ id: "spoken-early", created: 3_000, updated: 9_000, lastHumanTurn: 4_000 }),
      engineSession({ id: "spoken-late", created: 2_000, updated: 3_000, lastHumanTurn: 6_000 }),
      engineSession({ id: "agents-only-old", created: 500, updated: 9_500 }),
      engineSession({ id: "agents-only-new", created: 700, updated: 800 }),
    ])

    expect((await sessionMeta("spoken-late"))?.lastHumanTurnAt).toBe(6_000)
    expect((await sessionMeta("agents-only-new"))?.lastHumanTurnAt).toBeUndefined()

    const rows = await listSessionNavigationMetas({
      workspaceID: ws.id,
      archived: "active",
      sort: "human_turn_desc",
      limit: 10,
    })
    expect(order(rows)).toEqual(["spoken-late", "spoken-early", "agents-only-new", "agents-only-old"])
  })

  test("an agent's turn does not move a row, and the reader's next prompt does", async () => {
    await syncSessionMetas(ws, [
      engineSession({ id: "a", created: 1_000, updated: 1_000, lastHumanTurn: 1_000 }),
      engineSession({ id: "b", created: 2_000, updated: 2_000, lastHumanTurn: 2_000 }),
    ])
    const list = () =>
      listSessionNavigationMetas({ workspaceID: ws.id, archived: "active", sort: "human_turn_desc", limit: 10 })
        .then(order)

    expect(await list()).toEqual(["b", "a"])

    await syncSessionMetas(ws, [
      engineSession({ id: "a", created: 1_000, updated: 5_000, lastHumanTurn: 1_000 }),
      engineSession({ id: "b", created: 2_000, updated: 2_000, lastHumanTurn: 2_000 }),
    ])
    expect(await list()).toEqual(["b", "a"])

    await syncSessionMetas(ws, [
      engineSession({ id: "a", created: 1_000, updated: 6_000, lastHumanTurn: 6_000 }),
      engineSession({ id: "b", created: 2_000, updated: 2_000, lastHumanTurn: 2_000 }),
    ])
    expect(await list()).toEqual(["a", "b"])
  })

  test("a snapshot taken before the reader's last prompt does not erase it", async () => {
    await syncSessionMetas(ws, [engineSession({ id: "a", created: 1_000, updated: 8_000, lastHumanTurn: 8_000 })])
    await syncSessionMetas(ws, [engineSession({ id: "a", created: 1_000, updated: 2_000, lastHumanTurn: 2_000 })])
    expect((await sessionMeta("a"))?.lastHumanTurnAt).toBe(8_000)

    await syncSessionMetas(ws, [engineSession({ id: "a", created: 1_000, updated: 2_000 })])
    expect((await sessionMeta("a"))?.lastHumanTurnAt).toBe(8_000)
  })

  test("the keyset cursor pages across the boundary into the never-prompted rows", async () => {
    await syncSessionMetas(ws, [
      engineSession({ id: "spoken-3", created: 100, updated: 100, lastHumanTurn: 3_000 }),
      engineSession({ id: "spoken-2", created: 200, updated: 200, lastHumanTurn: 2_000 }),
      engineSession({ id: "spoken-1", created: 300, updated: 300, lastHumanTurn: 1_000 }),
      engineSession({ id: "quiet-new", created: 900, updated: 900 }),
      engineSession({ id: "quiet-old", created: 400, updated: 400 }),
    ])
    const page = (cursor?: { createdAt: number; lastHumanTurnAt?: number; sessionID: string; sessionRef: string }) =>
      listSessionNavigationMetas({
        workspaceID: ws.id,
        archived: "active",
        sort: "human_turn_desc",
        limit: 2,
        ...(cursor ? { cursor: { updatedAt: cursor.createdAt, ...cursor } } : {}),
      })

    const seen: string[] = []
    let rows = await page()
    while (rows.length) {
      seen.push(...order(rows))
      const last = rows[rows.length - 1]
      if (rows.length < 2 || !last?.sessionRef) break
      rows = await page({
        createdAt: last.createdAt,
        ...(last.lastHumanTurnAt !== undefined ? { lastHumanTurnAt: last.lastHumanTurnAt } : {}),
        sessionID: last.sessionID,
        sessionRef: last.sessionRef,
      })
    }
    expect(seen).toEqual(["spoken-3", "spoken-2", "spoken-1", "quiet-new", "quiet-old"])
  })
})

describe("session inventory notices on cp/events", () => {
  test("an identical or stale canonical refresh publishes no change and cannot feedback into its publisher", async () => {
    const changes: string[] = []
    const remove = onSessionMetaChange((change) => { changes.push(change.kind) })
    try {
      const snapshot = engineSession({ id: "ses_same", created: 1, updated: 2 })
      await syncSessionMeta(ws, snapshot)
      expect(changes).toEqual(["changed"])
      changes.length = 0
      await syncSessionMeta(ws, snapshot)
      await syncSessionMetas(ws, [snapshot])
      await syncSessionMeta(ws, engineSession({ id: "ses_same", created: 1, updated: 1 }))
      expect(changes).toEqual([])
      await syncSessionMeta(ws, { ...snapshot, title: "Changed" })
      expect(changes).toEqual(["changed"])
    } finally { remove() }
  })
  test("a row's creation and deletion ring the workspace once each; an update rings nothing", async () => {
    const notices: string[] = []
    const unsubscribe = controlBus.subscribe((event) => {
      if (event.type === "session.inventory.changed") notices.push(event.workspaceId)
    })
    try {
      await putSessionMeta("ses_new", { ws, directory: ws.directory, title: "new", createdAt: 1, updatedAt: 1 })
      await putSessionMeta("ses_new", { ws, directory: ws.directory, title: "renamed" })
      await syncSessionMeta(ws, engineSession({ id: "ses_new", created: 1, updated: 2 }))
      await syncSessionMetas(ws, [
        engineSession({ id: "ses_new", created: 1, updated: 3 }),
        engineSession({ id: "ses_snapshot", created: 2, updated: 3 }),
      ])
      expect(notices).toEqual([ws.id, ws.id])
      await deleteSessionMeta("ses_new")
      expect(notices).toEqual([ws.id, ws.id, ws.id])
      expect(await sessionMeta("ses_new")).toBeUndefined()
    } finally {
      unsubscribe()
    }
  })
})

describe("a synced session's times come only from its runtime", () => {
  test.each([
    ["no time", {}],
    ["no creation time", { time: { updated: 2 } }],
    ["no update time", { time: { created: 1 } }],
    ["only snake_case times", { created_at: 1, updated_at: 2 }],
  ] as const)("a session with %s is refused and writes nothing", async (_label, stamp) => {
    const session = { id: "ses_untimed", title: "Untimed", ...stamp }

    await expect(syncSessionMeta(ws, session)).rejects.toThrow("Session ses_untimed has no runtime time.created and time.updated")
    await expect(syncSessionMetas(ws, [session])).rejects.toThrow("Session ses_untimed has no runtime time.created and time.updated")
    expect(await sessionMeta("ses_untimed")).toBeUndefined()
  })
})

describe("a put session row's times come only from its runtime", () => {
  test("an older runtime put cannot replace newer metadata or its attachments and tags", async () => {
    await putSessionMeta("ses_ordered", {
      ws, title: "Newer", createdAt: 1, updatedAt: 200,
      model: { providerID: "provider", modelID: "new" },
      tags: ["new"], attachments: [{ kind: "page", targetID: "new" }],
    })
    await putSessionMeta("ses_ordered", {
      ws, title: "Older", createdAt: 1, updatedAt: 100,
      model: { providerID: "provider", modelID: "old" },
      tags: ["old"], attachments: [{ kind: "page", targetID: "old" }],
    })
    expect(await sessionMeta("ses_ordered")).toMatchObject({
      title: "Newer", updatedAt: 200, model: { providerID: "provider", modelID: "new" },
      tags: ["new"], attachments: [{ kind: "page", targetID: "new" }],
    })
    await putSessionMeta("ses_ordered", { title: "Equal", updatedAt: 200 })
    expect((await sessionMeta("ses_ordered"))?.title).toBe("Equal")
    await putSessionMeta("ses_ordered", { title: "Local edit" })
    expect((await sessionMeta("ses_ordered"))?.title).toBe("Local edit")
    await putSessionMeta("ses_ordered", { title: "Latest runtime", updatedAt: 300 })
    expect((await sessionMeta("ses_ordered"))?.title).toBe("Latest runtime")
  })

  test.each([
    ["no times", {}],
    ["no creation time", { updatedAt: 2 }],
    ["no update time", { createdAt: 1 }],
  ] as const)("a put that would create a row with %s is refused and writes nothing", async (_label, times) => {
    await expect(putSessionMeta("ses_untimed", { ws, directory: ws.directory, title: "Untimed", ...times }))
      .rejects.toThrow("Session ses_untimed has no runtime time.created and time.updated")
    expect(await sessionMeta("ses_untimed")).toBeUndefined()
  })

  test("a put on an existing row keeps the runtime's creation time", async () => {
    await syncSessionMeta(ws, engineSession({ id: "ses_timed", created: 5, updated: 6 }))
    await putSessionMeta("ses_timed", { tags: ["kept"] })
    expect(await sessionMeta("ses_timed")).toMatchObject({ createdAt: 5, tags: ["kept"] })
  })
})
