import { afterEach, describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { SessionAttentionFacts } from "@claxedo/agent-runtime-contract"
import type { ControlPlaneServices } from "../../services"
import { d1Authority } from "../../../test-support/d1-authority"
import { parseSessionListQuery, signedSessionList } from "../../../session/list"
import { publishD1CloudSessionRows } from "./cloud-session-rows"

const active: Array<Awaited<ReturnType<typeof d1Authority>>> = []
afterEach(async () => { await Promise.all(active.splice(0).map((fixture) => fixture.dispose())) })

async function fixture() {
  const input = await d1Authority()
  active.push(input)
  const alice = await input.signIn("alice")
  const bob = await input.signIn("bob")
  const neighbor = await input.signIn("neighbor")
  await input.authority.createHostedOrganization(alice, { name: "Acme", orgId: "org" })
  await input.addMember(alice, bob, "org")
  await input.addMember(alice, neighbor, "org")
  const workspace = await input.authority.createWorkspace(alice, { workspaceId: "ws", orgId: "org", displayName: "Exact cloud",
    repoUrl: "https://github.com/acme/exact.git", backing: "cloud-vm" })
  await input.database.prepare(`INSERT INTO sandbox_leases
    (workspace_id,lease_id,epoch,status,driver,created_at,updated_at) VALUES ('ws','cloud-runtime',7,'ready','cloudflare',1,1)`).run()
  const register = async (sessionId: string, createdAt = 1) => {
    const operationId = `op_${sessionId}`
    await input.authority.reserveSession(alice, { operationId, sessionId, workspaceId: "ws", kind: "create" })
    await input.authority.registerRuntimeSession({ operationId, sessionId, workspaceId: "ws", principalKind: "user",
      actorId: alice.principal!.actorId, actorKind: "human", createdAt, updatedAt: createdAt })
  }
  const publish = async (attention: SessionAttentionFacts) => {
    const result = await publishD1CloudSessionRows(input.database, Date.now(), { workspaceId: "ws", hostId: "cloud-runtime", epoch: 7,
      userId: alice.principal!.userId, actorId: alice.principal!.actorId, orgId: "org", projectId: workspace.project_id }, {
      rows: [{ sessionId: "ses_old", workspaceId: "ws", title: "Canonical old session", createdAt: 1, updatedAt: attention.sequence,
        status: { kind: attention.working ? "busy" : "idle", awaitingInput: attention.awaitingInput, at: attention.sequence }, attention,
        lastTurn: { status: "completed", completedAt: 9, assistantMessageId: "msg_previous" } }], removed: [],
    })
    expect(result.refused).toEqual([])
  }
  const read = (auth: SignedControlPlaneAuth, search: string) => signedSessionList({ authority: input.authority } as unknown as ControlPlaneServices, auth,
    parseSessionListQuery(new URL(`https://control.test/api/control/session-list?scope=workspace&workspaceId=ws&sort=human_turn_desc&${search}`)))
  await register("ses_old")
  return { ...input, alice, bob, neighbor, workspace, register, publish, read }
}

const working: SessionAttentionFacts = { generation: 1, sequence: 13, activitySequence: 10, activityAt: 10,
  working: true, awaitingInput: false }

describe("D1 exact canonical session navigation", () => {
  test("reads one off-page root with canonical rich facts and exact counts before pagination", async () => {
    const input = await fixture()
    await input.publish(working)
    for (let index = 0; index < 30; index += 1) await input.register(`ses_new_${index}`, index + 20)
    const first = await input.read(input.alice, "limit=25")
    expect(first.items).toHaveLength(25)
    expect(first.items.some((row) => row.sessionId === "ses_old")).toBe(false)
    expect(first.totalKnown).toBe(31)
    const page = vi.spyOn(input.authority, "listSessionPage")
    const count = vi.spyOn(input.authority, "countSessions")
    const exact = await input.read(input.alice, "sessionId=ses_old&limit=2&settled=all&seen=all")
    const project = await input.database.prepare("SELECT repo_key FROM projects WHERE project_id = ?")
      .bind(input.workspace.project_id).first<{ repo_key: string }>()
    expect(exact).toMatchObject({ items: [{ sessionId: "ses_old", workspaceId: "ws", projectId: input.workspace.project_id,
      title: "Canonical old session", ownership: "owned", projectName: project!.repo_key,
      placement: { kind: "cloud", cloudName: "Exact cloud" }, attention: working,
      lastTurn: { status: "completed", completedAt: 9, assistantMessageId: "msg_previous" } }],
      totalKnown: 1 })
    expect(exact.nextCursor).toBeUndefined()
    expect(page).toHaveBeenCalledTimes(1)
    expect(count).toHaveBeenCalledTimes(1)
  })

  test("the same exact query reads a settled session only with the explicit all filter", async () => {
    const input = await fixture()
    const attention: SessionAttentionFacts = { generation: 1, sequence: 10, activitySequence: 10, activityAt: 10,
      working: false, awaitingInput: false, outcome: { sequence: 10, status: "completed", completedAt: 10 } }
    await input.publish(attention)
    expect(await input.authority.writeSessionReader!(input.alice, { sessionId: "ses_old", workspaceId: "ws",
      command: { kind: "settle", generation: 1, activitySequence: 10, outcomeSequence: 10, revision: 0 } })).toMatchObject({ ok: true })
    expect(await input.read(input.alice, "sessionId=ses_old&limit=2")).toMatchObject({ items: [], totalKnown: 0 })
    expect(await input.read(input.alice, "sessionId=ses_old&limit=2&settled=all&seen=all"))
      .toMatchObject({ items: [{ sessionId: "ses_old", reader: { settledThrough: 10, seenThrough: 10 } }], totalKnown: 1 })
  })

  test("current share permission gates the exact row and surrounding metadata independently", async () => {
    const input = await fixture()
    await input.publish(working)
    const search = "sessionId=ses_old&limit=2&settled=all&seen=all"
    expect(await input.read(input.bob, search)).toMatchObject({ items: [], totalKnown: 0 })
    await input.authority.grantSessionShare!(input.alice, { sessionId: "ses_old", workspaceId: "ws", grantedToUserId: input.bob.principal!.userId, level: "follow" })
    const shared = await input.read(input.bob, search)
    expect(shared).toMatchObject({ items: [{ sessionId: "ses_old", title: "Canonical old session", ownership: "shared", attention: working,
      projectName: "github.com/acme/exact" }], totalKnown: 1 })
    expect(shared.items[0]).not.toHaveProperty("placement")
    expect(await input.read(input.neighbor, search)).toMatchObject({ items: [], totalKnown: 0 })
    await input.authority.revokeSessionShare!(input.alice, { sessionId: "ses_old", workspaceId: "ws", grantedToUserId: input.bob.principal!.userId })
    expect(await input.read(input.bob, search)).toMatchObject({ items: [], totalKnown: 0 })
  })

  test("missing, wrong-workspace, child and deleted identities return no row or metadata", async () => {
    const input = await fixture()
    await input.publish(working)
    const empty = { items: [], totalKnown: 0 }
    expect(await input.read(input.alice, "sessionId=ses_missing&limit=2&settled=all")).toMatchObject(empty)
    const wrong = await signedSessionList({ authority: input.authority } as unknown as ControlPlaneServices, input.alice,
      parseSessionListQuery(new URL("https://control.test/api/control/session-list?scope=workspace&workspaceId=ws_wrong&sessionId=ses_old&limit=2&settled=all")))
    expect(wrong).toMatchObject(empty)
    await input.database.prepare("UPDATE sessions SET parent_session_id = 'ses_parent' WHERE session_id = 'ses_old'").run()
    expect(await input.read(input.alice, "sessionId=ses_old&limit=2&settled=all")).toMatchObject(empty)
    await input.database.prepare("UPDATE sessions SET parent_session_id = NULL, deleted_at = 99 WHERE session_id = 'ses_old'").run()
    expect(await input.read(input.alice, "sessionId=ses_old&limit=2&settled=all")).toMatchObject(empty)
  })
})
