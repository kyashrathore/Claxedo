import { afterAll, describe, expect, test } from "vitest"
import { execFileSync } from "child_process"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `session-reader-routes-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = { CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR, CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR }
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
const { controlBus } = await import("@claxedo/server-core/platform/runtime/lib/bus")
const { deleteSessionMeta, putSessionMeta, recordSessionLastTurn } = await import("@claxedo/server-core/session/meta/index")
const { ensureWorkspace } = await import("@claxedo/server-core/workspace/store/index")
const { parseSessionListQuery } = await import("@claxedo/server-core/session/navigation-list")
const { localSessionListPage } = await import("../list/session-list-page")
const { SessionMetaRoutes } = await import("./meta-routes")
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

const routes = SessionMetaRoutes()

function write(sessionId: string, action: "seen" | "settle", body: unknown, headers: Record<string, string> = {}) {
  return routes.request(`/api/claxedo/session/${sessionId}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

async function page(ws: { id: string }, settled?: "all") {
  const query = `scope=workspace&workspaceId=${ws.id}&sort=human_turn_desc&limit=10${settled ? "&settled=all" : ""}`
  const response = await localSessionListPage({
    query: parseSessionListQuery(new URL(`http://daemon.test/api/claxedo/session-list?${query}`)),
    workspace: ws as never,
    projectWorkspaces: async () => [],
    readRuntimeStatus: async () => undefined,
  })
  return Object.fromEntries(response.items.map((row) => [row.sessionId, { seenAt: row.seenAt, settledAt: row.settledAt }]))
}

describe("the machine user's seen and settled marks", () => {
  test("a seen mark only rises, rides the list row, and survives the store closing and reopening", async () => {
    const ws = await workspace("seen")
    await putSessionMeta("ses_seen", { ws, title: "Seen", createdAt: 1, updatedAt: 1 })
    recordSessionLastTurn(ws.id, "ses_seen", { status: "completed", completedAt: 100 })
    expect(await page(ws)).toEqual({ ses_seen: { seenAt: undefined, settledAt: undefined } })

    expect(await (await write("ses_seen", "seen", { completedAt: 100 })).json()).toEqual({ seenAt: 100 })
    expect(await (await write("ses_seen", "seen", { completedAt: 40 })).json()).toEqual({ seenAt: 100 })

    ClaxedoDB.close()
    ClaxedoDB.Drizzle()
    expect(await page(ws)).toEqual({ ses_seen: { seenAt: 100, settledAt: undefined } })
  })

  test("settle hides a row from the active list, Show settled lists it, and a later send or turn result returns it with no write", async () => {
    const ws = await workspace("settle")
    await putSessionMeta("ses_settled", { ws, title: "Settled", createdAt: 1, updatedAt: 1, lastHumanTurnAt: 50 })
    recordSessionLastTurn(ws.id, "ses_settled", { status: "completed", completedAt: 60 })
    await putSessionMeta("ses_other", { ws, title: "Other", createdAt: 2, updatedAt: 2 })

    expect(await (await write("ses_settled", "settle", { settled: true })).json()).toEqual({ settledAt: 60 })
    expect(Object.keys(await page(ws))).toEqual(["ses_other"])
    expect((await page(ws, "all")).ses_settled).toEqual({ seenAt: undefined, settledAt: 60 })

    recordSessionLastTurn(ws.id, "ses_settled", { status: "failed", completedAt: 70 })
    expect(Object.keys(await page(ws))).toEqual(["ses_settled", "ses_other"])

    await write("ses_settled", "settle", { settled: true })
    expect(Object.keys(await page(ws))).toEqual(["ses_other"])
    await putSessionMeta("ses_settled", { ws, lastHumanTurnAt: 80, updatedAt: 80 })
    expect(Object.keys(await page(ws))).toEqual(["ses_settled", "ses_other"])

    await write("ses_settled", "settle", { settled: true })
    expect(await (await write("ses_settled", "settle", { settled: false })).json()).toEqual({})
    expect(Object.keys(await page(ws))).toEqual(["ses_settled", "ses_other"])
  })

  test("each write rings the reader's notice with the marks it left", async () => {
    const ws = await workspace("notice")
    await putSessionMeta("ses_notice", { ws, title: "Notice", createdAt: 1, updatedAt: 1 })
    const heard: unknown[] = []
    const stop = controlBus.subscribe((event) => {
      if (event.type === "session.reader.changed") heard.push(event)
    })
    try {
      await write("ses_notice", "seen", { completedAt: 9 })
    } finally {
      stop()
    }
    expect(heard).toEqual([{ type: "session.reader.changed", ownerUserId: "local", sessionId: "ses_notice", workspaceId: ws.id, seenAt: 9, ts: expect.any(Number) }])
  })

  test("a malformed body, an unknown session and a signed caller are refused", async () => {
    const ws = await workspace("refused")
    await putSessionMeta("ses_refused", { ws, title: "Refused", createdAt: 1, updatedAt: 1 })
    expect((await write("ses_refused", "seen", { completedAt: "soon" })).status).toBe(400)
    expect((await write("ses_refused", "settle", {})).status).toBe(400)
    expect((await write("ses_missing", "seen", { completedAt: 5 })).status).toBe(404)

    const signed = SessionMetaRoutes({
      authConfig: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" },
      verifier: async (token, config) => ({ mode: "signed", user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer } }),
    })
    const refused = await signed.request("/api/claxedo/session/ses_refused/seen", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer user_1" },
      body: JSON.stringify({ completedAt: 5 }),
    })
    expect(refused.status).toBe(403)
  })

  test("deleting a session's metadata deletes its reader rows", async () => {
    const ws = await workspace("delete")
    await putSessionMeta("ses_gone", { ws, title: "Gone", createdAt: 1, updatedAt: 1 })
    await write("ses_gone", "seen", { completedAt: 3 })
    const rows = () => ClaxedoDB.raw().prepare("SELECT count(*) AS n FROM claxedo_session_reads WHERE session_ref LIKE ?").get("%:session:ses_gone")
    expect(rows()).toEqual({ n: 1 })
    await deleteSessionMeta("ses_gone")
    expect(rows()).toEqual({ n: 0 })
  })

  test("the list joins the reader's marks by primary key and its settled filter adds no scan", async () => {
    const ws = await workspace("plan")
    await putSessionMeta("ses_plan", { ws, title: "Plan", createdAt: 1, updatedAt: 1 })
    const db = ClaxedoDB.raw()
    const statements: Array<{ sql: string; params: unknown[] }> = []
    const prepare = db.prepare
    db.prepare = ((sql: string) => {
      const statement = prepare.call(db, sql)
      const all = statement.all.bind(statement)
      return Object.assign(statement, { all: (...params: unknown[]) => (statements.push({ sql, params }), all(...params)) })
    }) as typeof db.prepare
    try {
      await page(ws)
    } finally {
      db.prepare = prepare
    }
    const list = statements.find((statement) => statement.sql.includes("LEFT JOIN claxedo_session_reads"))
    if (!list) throw new Error("the list read was not observed")
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${list.sql}`).all(...list.params) as Array<{ detail: string }>).map((step) => step.detail)
    expect(plan).toContainEqual(expect.stringMatching(/^SEARCH m USING INDEX claxedo_session_meta_workspace_archive_human_turn_idx \(workspace_id=\? AND archived_at=\?\)$/))
    expect(plan).toContainEqual(expect.stringMatching(/^SEARCH r USING INDEX sqlite_autoindex_claxedo_session_reads_1 \(user_id=\? AND session_ref=\?\)/))
    expect(plan.filter((step) => step.startsWith("SCAN"))).toEqual([])
  })
})
