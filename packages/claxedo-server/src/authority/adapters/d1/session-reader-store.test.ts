import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { d1Authority } from "../../../test-support/d1-authority"
import { D1SessionAuthority } from "./session-authority"
import { recordD1SessionReader } from "./session-reader-store"
import type { SessionReaderWrite } from "@claxedo/server-core/session/reader"

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
})

async function sharedSession() {
  const plane = await d1Authority()
  disposals.push(plane.dispose)
  const { authority } = plane
  const alice = await plane.signIn("alice")
  const bob = await plane.signIn("bob")
  const outsider = await plane.signIn("outsider")
  await authority.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
  await plane.addMember(alice, bob, "org_acme")
  const workspace = await authority.createWorkspace(alice, { workspaceId: "ws_main", orgId: "org_acme", displayName: "main", backing: "cloud-vm" })
  const projectId = (workspace as { project_id: string }).project_id
  for (const sessionId of ["ses_shared", "ses_other"]) {
    await authority.reserveSession(alice, { operationId: `op_${sessionId}`, sessionId, workspaceId: "ws_main", kind: "create" })
    await authority.registerRuntimeSession({
      principalKind: "user", actorId: alice.principal!.actorId, actorKind: "human",
      operationId: `op_${sessionId}`, sessionId, workspaceId: "ws_main", createdAt: 1, updatedAt: 1,
    })
  }
  await authority.grantSessionShare!(alice, { sessionId: "ses_shared", workspaceId: "ws_main", grantedToUserId: bob.principal!.userId, level: "follow" })
  const lastActivity = (sessionId: string, at: { humanTurn?: number; turnEnd?: number }) =>
    plane.database
      .prepare("update sessions set last_human_turn_at = coalesce(?, last_human_turn_at), last_turn_status = 'completed', last_turn_completed_at = coalesce(?, last_turn_completed_at) where session_id = ?")
      .bind(at.humanTurn ?? null, at.turnEnd ?? null, sessionId)
      .run()
  const page = async (auth: SignedControlPlaneAuth, settled: "active" | "all" = "active") =>
    Object.fromEntries((await authority.listSessionPage(auth, { projectId, sort: "human_turn_desc", archived: "active", settled, limit: 50 }))
      .map((row) => {
        const item = row as { session_id: string; seen_at?: number; settled_at?: number }
        return [item.session_id, { seen: item.seen_at, settled: item.settled_at }]
      }))
  return { plane, authority, alice, bob, outsider, projectId, lastActivity, page }
}

describe("D1 session reader marks", () => {
  test("two readers of one shared session each keep their own seen mark", async () => {
    const { authority, alice, bob, lastActivity, page } = await sharedSession()
    await lastActivity("ses_shared", { turnEnd: 500 })

    await expect(authority.recordSessionReader(bob, { sessionId: "ses_shared", write: { seenThrough: 500 } }))
      .resolves.toEqual({ workspaceId: "ws_main", seenAt: 500 })
    await expect(authority.recordSessionReader(bob, { sessionId: "ses_shared", write: { seenThrough: 200 } }))
      .resolves.toEqual({ workspaceId: "ws_main", seenAt: 500 })

    expect((await page(bob)).ses_shared).toEqual({ seen: 500, settled: undefined })
    expect((await page(alice)).ses_shared).toEqual({ seen: undefined, settled: undefined })
  })

  test("settle hides a session from its settler's active page only, Show settled lists it, and new activity returns it with no write", async () => {
    const { authority, alice, bob, lastActivity, page } = await sharedSession()
    await lastActivity("ses_shared", { humanTurn: 300, turnEnd: 400 })

    await expect(authority.recordSessionReader(alice, { sessionId: "ses_shared", write: { settled: true, through: 0 } }))
      .resolves.toEqual({ workspaceId: "ws_main", settledAt: 400 })
    expect(Object.keys(await page(alice))).toEqual(["ses_other"])
    expect((await page(alice, "all")).ses_shared).toEqual({ seen: undefined, settled: 400 })
    expect(Object.keys(await page(bob))).toEqual(["ses_shared"])

    await lastActivity("ses_shared", { turnEnd: 450 })
    expect(Object.keys(await page(alice))).toEqual(["ses_shared", "ses_other"])

    await authority.recordSessionReader(alice, { sessionId: "ses_shared", write: { settled: true, through: 0 } })
    await lastActivity("ses_shared", { humanTurn: 460 })
    expect(Object.keys(await page(alice))).toEqual(["ses_shared", "ses_other"])

    await authority.recordSessionReader(alice, { sessionId: "ses_shared", write: { settled: true, through: 0 } })
    await expect(authority.recordSessionReader(alice, { sessionId: "ses_shared", write: { settled: false } }))
      .resolves.toEqual({ workspaceId: "ws_main" })
    expect(Object.keys(await page(alice))).toEqual(["ses_shared", "ses_other"])
  })

  test("a settle holds through the activity the reader saw when this row lags the machine, and a seen mark never passes the clock", async () => {
    const { plane, alice, lastActivity, page } = await sharedSession()
    await lastActivity("ses_shared", { humanTurn: 300, turnEnd: 400 })
    const record = (write: SessionReaderWrite, now = 10_000) =>
      recordD1SessionReader(plane.database, "test", alice, { sessionId: "ses_shared", write }, now)

    await expect(record({ settled: true, through: 600 })).resolves.toEqual({ workspaceId: "ws_main", settledAt: 600 })
    await lastActivity("ses_shared", { turnEnd: 600 })
    expect(Object.keys(await page(alice))).toEqual(["ses_other"])
    await lastActivity("ses_shared", { turnEnd: 700 })
    expect(Object.keys(await page(alice))).toEqual(["ses_shared", "ses_other"])
    await expect(record({ settled: true, through: 100 })).resolves.toEqual({ workspaceId: "ws_main", settledAt: 700 })

    await expect(record({ seenThrough: 9_000 })).resolves.toMatchObject({ seenAt: 9_000 })
    await expect(record({ seenThrough: 5_000_000 })).resolves.toMatchObject({ seenAt: 10_000 })
  })

  test("a caller who may not read the session records nothing", async () => {
    const { plane, authority, outsider } = await sharedSession()
    await expect(authority.recordSessionReader(outsider, { sessionId: "ses_shared", write: { seenThrough: 5 } })).resolves.toBeUndefined()
    await expect(authority.recordSessionReader(outsider, { sessionId: "ses_missing", write: { settled: true, through: 0 } })).resolves.toBeUndefined()
    expect(await plane.database.prepare("select count(*) as n from session_reads").first()).toEqual({ n: 0 })
  })

  test("the page joins the reader's marks by primary key and filters settled rows with no scan", async () => {
    const { plane, alice, projectId } = await sharedSession()
    const reads: Array<{ sql: string; binds: unknown[] }> = []
    const recording = new Proxy(plane.database, {
      get(target, property) {
        if (property !== "prepare") return Reflect.get(target, property).bind(target)
        return (sql: string) => {
          const statement = target.prepare(sql)
          return { bind: (...binds: unknown[]) => (reads.push({ sql, binds }), statement.bind(...binds)) }
        }
      },
    })
    await new D1SessionAuthority(recording, { deploymentId: "test" })
      .listSessionPage(alice, { projectId, sort: "human_turn_desc", archived: "active", settled: "active", limit: 50 })
    const listRead = reads.find((read) => read.sql.includes("left join session_reads"))
    if (!listRead) throw new Error("the list read was not observed")
    const plan = await plane.database.prepare(`explain query plan ${listRead.sql}`).bind(...listRead.binds).all<{ detail: string }>()
    const details = plan.results.map((step) => step.detail)
    expect(details).toContainEqual(expect.stringMatching(/^SEARCH s USING INDEX sessions_by_project_human_turn/))
    expect(details).toContainEqual(expect.stringMatching(/^SEARCH r USING INDEX sqlite_autoindex_session_reads_1 \(user_id=\? AND session_id=\?\)/))
    expect(details.filter((detail) => /^SCAN (s|r)\b/.test(detail))).toEqual([])
  })
})
