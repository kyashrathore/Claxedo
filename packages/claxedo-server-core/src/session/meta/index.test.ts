import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `session-meta-order-${randomUUID().slice(0, 8)}`)
const prev = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const [{ deleteSessionMeta, listSessionNavigationMetas, putSessionMeta, sessionMeta, syncSessionMeta, syncSessionMetas }, { ClaxedoDB }, { controlBus }] = await Promise.all([
  import("./index"),
  import("../../platform/db"),
  import("../../platform/runtime/lib/bus"),
])

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
  process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_STATE_DIR = prev.CLAXEDO_STATE_DIR
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
  test("a row's creation and deletion ring the workspace once each; an update rings nothing", async () => {
    const notices: string[] = []
    const unsubscribe = controlBus.subscribe((event) => {
      if (event.type === "session.inventory.changed") notices.push(event.workspaceId)
    })
    try {
      await putSessionMeta("ses_new", { ws, directory: ws.directory, title: "new" })
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
