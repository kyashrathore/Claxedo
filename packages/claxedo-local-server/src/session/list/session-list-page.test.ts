import { afterAll, describe, expect, test } from "vitest"
import { execFileSync } from "child_process"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import type { RuntimeStatusPath } from "@claxedo/server-core/session/runtime-activity"

const root = path.join(realpathSync.native(os.tmpdir()), `session-list-page-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = { CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR, CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR }
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
const { putSessionMeta, recordSessionLastTurn } = await import("@claxedo/server-core/session/meta/index")
const { ensureWorkspace } = await import("@claxedo/server-core/workspace/store/index")
const { parseSessionListQuery } = await import("@claxedo/server-core/session/navigation-list")
const { localSessionListPage, signedSessionListPage } = await import("./session-list-page")
ClaxedoDB.Drizzle()

afterAll(async () => {
  ClaxedoDB.close()
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(root, { recursive: true, force: true })
})

async function workspace(name: string) {
  const directory = path.join(root, `${name}-${randomUUID()}`)
  await fs.mkdir(directory, { recursive: true })
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" })
  const created = await ensureWorkspace({ workspaceId: `ws_${name}_${randomUUID()}`, directory })
  if (!created) throw new Error("test workspace was not created")
  return created
}

function runtime(answers: Record<string, Partial<Record<RuntimeStatusPath, unknown>>>) {
  const reads: string[] = []
  return {
    reads,
    read: async (workspaceId: string, readPath: RuntimeStatusPath) => {
      reads.push(`${workspaceId}${readPath}`)
      const answer = answers[workspaceId]
      if (!answer) return undefined
      return Response.json(answer[readPath] ?? (readPath === "/session/status" ? {} : []))
    },
  }
}

describe("localSessionListPage", () => {
  test("each row carries the status its runtime holds, read once per workspace in process", async () => {
    const running = await workspace("running")
    const asleep = await workspace("asleep")
    await putSessionMeta("ses_busy", { ws: running, title: "Busy", createdAt: 1, updatedAt: 1 })
    await putSessionMeta("ses_asking", { ws: running, title: "Asking", createdAt: 1, updatedAt: 1 })
    await putSessionMeta("ses_quiet", { ws: running, title: "Quiet", createdAt: 1, updatedAt: 1 })
    await putSessionMeta("ses_background", { ws: running, title: "Background", createdAt: 1, updatedAt: 1 })
    await putSessionMeta("ses_asleep", { ws: asleep, title: "Asleep", createdAt: 1, updatedAt: 1 })
    const fake = runtime({
      [running.id]: {
        "/session/status": { ses_busy: { type: "busy" }, ses_background: { type: "idle", backgroundWork: { agents: 2, shells: 0, other: 0 } } },
        "/question": [{ id: "que_1", sessionID: "ses_asking" }],
      },
    })

    const page = await Promise.all([running, asleep].map((ws) => localSessionListPage({
      query: parseSessionListQuery(new URL(`http://daemon.test/api/claxedo/session-list?scope=workspace&workspaceId=${ws.id}&limit=10`)),
      workspace: ws,
      coveredWorkspaces: async () => [],
      readRuntimeStatus: fake.read,
      now: () => 7_000,
    })))
    const statuses = Object.fromEntries(page.flatMap((response) => response.items ?? []).map((row) => [row.sessionId, row.status]))

    expect(statuses).toEqual({
      ses_busy: { kind: "busy", awaitingInput: false, at: 7_000 },
      ses_asking: { kind: "idle", awaitingInput: true, at: 7_000 },
      ses_quiet: { kind: "idle", awaitingInput: false, at: 7_000 },
      ses_background: { kind: "idle", awaitingInput: false, backgroundWork: { agents: 2, shells: 0, other: 0 }, at: 7_000 },
      ses_asleep: { kind: "idle", awaitingInput: false, at: 7_000 },
    })
    expect(fake.reads.filter((read) => read.endsWith("/session/status"))).toEqual([
      `${running.id}/session/status`,
      `${asleep.id}/session/status`,
    ])
  })

  test("each row carries its session's last turn as the runtime recorded it, and none before one ends", async () => {
    const ws = await workspace("turns")
    for (const id of ["ses_done", "ses_broke", "ses_stopped", "ses_fresh"]) await putSessionMeta(id, { ws, title: id, createdAt: 1, updatedAt: 1 })
    recordSessionLastTurn(ws.id, "ses_done", { status: "completed", completedAt: 10 })
    recordSessionLastTurn(ws.id, "ses_broke", { status: "failed", completedAt: 20 })
    recordSessionLastTurn(ws.id, "ses_stopped", { status: "cancelled", completedAt: 30 })

    const page = await localSessionListPage({
      query: parseSessionListQuery(new URL(`http://daemon.test/api/claxedo/session-list?scope=workspace&workspaceId=${ws.id}&limit=10`)),
      workspace: ws,
      coveredWorkspaces: async () => [],
      readRuntimeStatus: runtime({}).read,
    })

    expect(Object.fromEntries(page.items.map((row) => [row.sessionId, row.lastTurn ?? null]))).toEqual({
      ses_done: { status: "completed", completedAt: 10 },
      ses_broke: { status: "failed", completedAt: 20 },
      ses_stopped: { status: "cancelled", completedAt: 30 },
      ses_fresh: null,
    })
  })

  test("a page reads its rows' last turn with the row by primary key, and a turn's record finds its row by index", async () => {
    const ws = await workspace("plans")
    await putSessionMeta("ses_planned", { ws, title: "Planned", createdAt: 1, updatedAt: 1 })
    const db = ClaxedoDB.raw()
    const statements: Array<{ sql: string; params: unknown[] }> = []
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      const statement = prepare(sql)
      const recorded = (method: "all" | "get" | "run") => {
        const run = statement[method].bind(statement)
        return (...params: unknown[]) => (statements.push({ sql, params }), run(...params))
      }
      return Object.assign(statement, { all: recorded("all"), get: recorded("get"), run: recorded("run") })
    }) as typeof db.prepare
    try {
      recordSessionLastTurn(ws.id, "ses_planned", { status: "completed", completedAt: 10 })
      await localSessionListPage({
        query: parseSessionListQuery(new URL(`http://daemon.test/api/claxedo/session-list?scope=workspace&workspaceId=${ws.id}&limit=10`)),
        workspace: ws,
        coveredWorkspaces: async () => [],
        readRuntimeStatus: runtime({}).read,
      })
    } finally {
      db.prepare = prepare
    }
    const plan = ({ sql, params }: { sql: string; params: unknown[] }) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((step) => step.detail)
    const write = statements.find((statement) => statement.sql.startsWith('update "claxedo_session_meta" set "last_turn_status"'))
    const read = statements.find((statement) => /^select .*"last_turn_status".* from "claxedo_session_meta" where "claxedo_session_meta"."session_ref" in/.test(statement.sql))
    if (!write || !read) throw new Error(`the record or the row read was not observed: ${statements.map((statement) => statement.sql).join("\n")}`)

    expect(plan(write)).toEqual([expect.stringMatching(/^SEARCH claxedo_session_meta USING INDEX claxedo_session_meta_session_idx \(session_id=\?\)$/)])
    expect(plan(read)).toEqual([expect.stringMatching(/^SEARCH claxedo_session_meta USING INDEX sqlite_autoindex_claxedo_session_meta_1 \(session_ref=\?\)$/)])
  })

  test("an all-scoped page lists every live workspace's root sessions in one human-turn order, an exact session read answers that one row, and both read by index", async () => {
    const left = await workspace("all-left")
    const right = await workspace("all-right")
    const gone = await workspace("all-gone")
    const recent = 9_000_000_000_000
    await putSessionMeta("ses_all_old", { ws: left, title: "Old", createdAt: 1, updatedAt: 1, lastHumanTurnAt: recent + 10 })
    await putSessionMeta("ses_all_new", { ws: right, title: "New", createdAt: 2, updatedAt: 2, lastHumanTurnAt: recent + 30 })
    await putSessionMeta("ses_all_mid", { ws: left, title: "Mid", createdAt: 3, updatedAt: 3, lastHumanTurnAt: recent + 20 })
    await putSessionMeta("ses_all_child", { ws: right, title: "Child", parentID: "ses_all_new", createdAt: 4, updatedAt: 4, lastHumanTurnAt: recent + 40 })
    await putSessionMeta("ses_all_gone", { ws: gone, title: "Gone", createdAt: 6, updatedAt: 6, lastHumanTurnAt: recent + 35 })
    await putSessionMeta("ses_all_archived", { ws: right, title: "Archived", archived: 5, createdAt: 5, updatedAt: 5, lastHumanTurnAt: recent + 50 })
    const db = ClaxedoDB.raw()
    const statements: Array<{ sql: string; params: unknown[] }> = []
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      const statement = prepare(sql)
      const all = statement.all.bind(statement)
      return Object.assign(statement, { all: (...params: unknown[]) => (statements.push({ sql, params }), all(...params)) })
    }) as typeof db.prepare
    const read = (search: string) => localSessionListPage({
      query: parseSessionListQuery(new URL(`http://daemon.test/api/claxedo/session-list?scope=all&sort=human_turn_desc&limit=3${search}`)),
      workspace: undefined,
      coveredWorkspaces: async () => [left, right],
      readRuntimeStatus: runtime({}).read,
    })
    try {
      const page = await read("")
      const exact = await read("&sessionId=ses_all_mid")
      expect(page.items.map((row) => row.sessionId)).toEqual(["ses_all_new", "ses_all_mid", "ses_all_old"])
      expect(exact.items.map((row) => row.sessionId)).toEqual(["ses_all_mid"])
    } finally {
      db.prepare = prepare
    }
    const plan = ({ sql, params }: { sql: string; params: unknown[] }) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((step) => step.detail)
    const [list, exact] = statements.filter((statement) => statement.sql.includes("LEFT JOIN claxedo_session_reads"))
    if (!list || !exact) throw new Error("the list reads were not observed")
    expect(plan(list)).toContainEqual(expect.stringMatching(/^SEARCH m USING INDEX claxedo_session_meta_archive_human_turn_idx \(archived_at=\?\)$/))
    expect(plan(exact)).toContainEqual(expect.stringMatching(/^SEARCH m USING INDEX claxedo_session_meta_session_idx \(session_id=\?\)$/))
    expect([...plan(list), ...plan(exact)].filter((step) => step.startsWith("SCAN") || step.includes("TEMP B-TREE"))).toEqual([])
  })

  test("a signed caller's all-scoped page asks the authority for every session it may read", async () => {
    const asked: unknown[] = []
    const authority = { listSessionPage: async (_auth: unknown, input: unknown) => (asked.push(input), []) } as unknown as Parameters<typeof signedSessionListPage>[0]
    const query = parseSessionListQuery(new URL("http://daemon.test/api/claxedo/session-list?scope=all&sort=human_turn_desc&limit=5"))
    await signedSessionListPage(authority, {} as Parameters<typeof signedSessionListPage>[1], { query, workspace: undefined })
    expect(asked).toEqual([expect.objectContaining({ everyReadable: true, limit: 6 })])
  })
})
