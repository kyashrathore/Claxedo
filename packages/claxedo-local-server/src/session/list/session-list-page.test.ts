import { afterAll, describe, expect, test } from "vitest"
import { execFileSync } from "child_process"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import type { RuntimeStatusPath } from "../runtime-activity"

const root = path.join(realpathSync(os.tmpdir()), `session-list-page-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = { CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR, CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR }
process.env.CLAXEDO_DATA_DIR = root
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

const { ClaxedoDB, and, eq, inArray } = await import("@claxedo/server-core/platform/db/index")
const { ClaxedoSessionMetaTable } = await import("@claxedo/server-core/session/meta.sql")
const { putSessionMeta, recordSessionLastTurn } = await import("@claxedo/server-core/session/meta/index")
const { ensureWorkspace } = await import("@claxedo/server-core/workspace/store/index")
const { parseSessionListQuery } = await import("@claxedo/server-core/session/navigation-list")
const { localSessionListPage } = await import("./session-list-page")
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
      projectWorkspaces: async () => [],
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
      projectWorkspaces: async () => [],
      readRuntimeStatus: runtime({}).read,
    })

    expect(Object.fromEntries(page.items.map((row) => [row.sessionId, row.lastTurn ?? null]))).toEqual({
      ses_done: { status: "completed", completedAt: 10 },
      ses_broke: { status: "failed", completedAt: 20 },
      ses_stopped: { status: "cancelled", completedAt: 30 },
      ses_fresh: null,
    })
  })

  test("a page reads its rows' last turn with the row, by primary key", () => {
    const db = ClaxedoDB.raw()
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((step) => step.detail)
    const hydrate = ClaxedoDB.use((client) =>
      client.select().from(ClaxedoSessionMetaTable).where(inArray(ClaxedoSessionMetaTable.session_ref, ["a", "b"])).toSQL().sql)

    const record = ClaxedoDB.use((client) =>
      client.update(ClaxedoSessionMetaTable).set({ last_turn_status: "completed", last_turn_completed_at: 1 })
        .where(and(eq(ClaxedoSessionMetaTable.session_id, "s"), eq(ClaxedoSessionMetaTable.workspace_id, "w"))).toSQL().sql)

    expect(plan(record.replace(/\?/g, "'x'"))).toEqual([expect.stringMatching(/^SEARCH claxedo_session_meta USING INDEX claxedo_session_meta_session_idx \(session_id=\?\)$/)])
    expect(hydrate).toContain("\"last_turn_status\"")
    expect(plan(hydrate.replace(/\?/g, "'x'"))).toEqual([expect.stringMatching(/^SEARCH claxedo_session_meta USING INDEX sqlite_autoindex_claxedo_session_meta_1 \(session_ref=\?\)$/)])
  })
})
