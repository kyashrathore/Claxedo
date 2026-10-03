import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { d1Authority } from "../../../test-support/d1-authority"
import { D1SessionAuthority } from "./session-authority"

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
})

async function twoOwners() {
  const plane = await d1Authority()
  disposals.push(plane.dispose)
  const { authority } = plane
  const alice = await plane.signIn("alice")
  const bob = await plane.signIn("bob")
  const outsider = await plane.signIn("outsider")
  await authority.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
  await plane.addMember(alice, bob, "org_acme")
  await plane.addMember(alice, outsider, "org_acme")
  const sessions: Array<[SignedControlPlaneAuth, string, string, number]> = [
    [alice, "ws_alice", "ses_alice_shared", 300],
    [alice, "ws_alice", "ses_alice_own", 400],
    [bob, "ws_bob", "ses_bob", 200],
  ]
  await authority.createHostedOrganization(bob, { name: "Bob", orgId: "org_bob" })
  for (const [owner, workspaceId, orgId] of [[alice, "ws_alice", "org_acme"], [bob, "ws_bob", "org_bob"]] as const) {
    await authority.createWorkspace(owner, { workspaceId, orgId, displayName: workspaceId, backing: "cloud-vm" })
  }
  for (const [owner, workspaceId, sessionId, humanTurn] of sessions) {
    await authority.reserveSession(owner, { operationId: `op_${sessionId}`, sessionId, workspaceId, kind: "create" })
    await authority.registerRuntimeSession({
      principalKind: "user", actorId: owner.principal!.actorId, actorKind: "human",
      operationId: `op_${sessionId}`, sessionId, workspaceId, createdAt: 1, updatedAt: 1,
    })
    await plane.database.prepare("update sessions set last_human_turn_at = ? where session_id = ?").bind(humanTurn, sessionId).run()
  }
  await authority.grantSessionShare!(alice, { sessionId: "ses_alice_shared", workspaceId: "ws_alice", grantedToUserId: bob.principal!.userId, level: "follow" })
  const page = async (auth: SignedControlPlaneAuth, sessionId?: string) =>
    (await authority.listSessionPage(auth, { everyReadable: true, ...(sessionId ? { sessionId } : {}), sort: "human_turn_desc", archived: "active", settled: "active", limit: 50 }))
      .map((row) => (row as { session_id: string }).session_id)
  return { plane, authority, alice, bob, outsider, page }
}

describe("D1 page of every session a reader may read", () => {
  test("holds the reader's own workspaces' sessions and the sessions shared to it, in one human-turn order, and a revoked share leaves it", async () => {
    const { authority, alice, bob, outsider, page } = await twoOwners()

    expect(await page(alice)).toEqual(["ses_alice_own", "ses_alice_shared"])
    expect(await page(bob)).toEqual(["ses_alice_shared", "ses_bob"])
    expect(await page(outsider)).toEqual([])

    await authority.revokeSessionShare!(alice, { sessionId: "ses_alice_shared", workspaceId: "ws_alice", grantedToUserId: bob.principal!.userId })
    expect(await page(bob)).toEqual(["ses_bob"])
  })

  test("an exact read answers one session only to a reader who may read it", async () => {
    const { bob, outsider, page } = await twoOwners()

    expect(await page(bob, "ses_alice_shared")).toEqual(["ses_alice_shared"])
    expect(await page(bob, "ses_alice_own")).toEqual([])
    expect(await page(outsider, "ses_bob")).toEqual([])
  })

  test("reads the candidates through the owner and share indexes and an exact read by primary key, never scanning sessions", async () => {
    const { plane, bob } = await twoOwners()
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
    const authority = new D1SessionAuthority(recording, { deploymentId: "test" })
    const query = { everyReadable: true as const, sort: "human_turn_desc" as const, archived: "active" as const, settled: "active" as const, limit: 50 }
    await authority.listSessionPage(bob, query)
    await authority.listSessionPage(bob, { ...query, sessionId: "ses_bob" })
    const [list, exact] = reads.filter((read) => read.sql.includes("left join session_reads"))
    if (!list || !exact) throw new Error("the list reads were not observed")
    const plan = async (read: { sql: string; binds: unknown[] }) =>
      (await plane.database.prepare(`explain query plan ${read.sql}`).bind(...read.binds).all<{ detail: string }>()).results.map((step) => step.detail)
    const listed = await plan(list)
    const one = await plan(exact)

    expect(listed).toContainEqual(expect.stringMatching(/^SEARCH s USING INDEX sessions_by_workspace_human_turn \(workspace_id=\?/))
    expect(listed).toContainEqual(expect.stringMatching(/^SEARCH s USING INDEX sqlite_autoindex_sessions_1 \(session_id=\?\)/))
    expect(listed).toContainEqual(expect.stringMatching(/^SEARCH w USING (COVERING )?INDEX workspaces_by_owner/))
    expect(listed).toContainEqual(expect.stringMatching(/^SEARCH g USING (COVERING )?INDEX session_share_grants_by_user/))
    expect(one).toContainEqual(expect.stringMatching(/^SEARCH s USING INDEX sqlite_autoindex_sessions_1 \(session_id=\?\)/))
    expect([...listed, ...one].filter((detail) => /^SCAN (s|w|g|r)\b/.test(detail))).toEqual([])
  })
})
