import { afterEach, describe, expect, test } from "vitest"
import type { SessionAttentionBatch } from "@claxedo/server-core/platform/auth/session-attention-authority"
import { d1Authority } from "../../../test-support/d1-authority"
import { sessionAttentionStatements, readD1SessionAttention } from "./session-attention-history"
import { readD1SessionStateNotices } from "./session-state-notices"
import { readD1SessionPublicationNotices } from "./session-publication-notices"

const active: Array<Awaited<ReturnType<typeof d1Authority>>> = []
afterEach(async () => { await Promise.all(active.splice(0).map((fixture) => fixture.dispose())) })

async function setup() {
  const fixture = await d1Authority()
  active.push(fixture)
  const alice = await fixture.signIn("alice")
  const bob = await fixture.signIn("bob")
  const neighbor = await fixture.signIn("neighbor")
  await fixture.authority.createHostedOrganization(alice, { name: "Acme", orgId: "org" })
  await fixture.addMember(alice, bob, "org")
  await fixture.addMember(alice, neighbor, "org")
  const workspace = await fixture.authority.createWorkspace(alice, { workspaceId: "ws", orgId: "org", displayName: "Acme", backing: "cloud-vm" })
  await fixture.authority.reserveSession(alice, { operationId: "op", sessionId: "ses", workspaceId: "ws", kind: "create" })
  await fixture.authority.registerRuntimeSession({ principalKind: "user", actorId: alice.principal!.actorId, actorKind: "human",
    operationId: "op", sessionId: "ses", workspaceId: "ws", createdAt: 1, updatedAt: 1 })
  await fixture.database.prepare(`UPDATE sessions SET attention_json = ?, status = 'idle', status_at = 50, awaiting_input = 0 WHERE session_id = 'ses'`)
    .bind(JSON.stringify({ generation: 1, sequence: 50, activitySequence: 50, activityAt: 50,
      working: false, awaitingInput: false, outcome: { sequence: 50, status: "completed", completedAt: 50 } })).run()
  return { ...fixture, alice, bob, neighbor, projectId: workspace.project_id }
}

const ref = { sessionId: "ses", workspaceId: "ws" }
const batch: SessionAttentionBatch = { ...ref, generation: 1, through: 50, events: [
  { sequence: 5, kind: "question", openedAt: 5, requestId: "q" },
  { sequence: 10, kind: "permission", openedAt: 10, requestId: "p" },
  { sequence: 50, kind: "outcome", openedAt: 50, outcome: "completed" },
] }

describe("durable account session attention", () => {
  test("recovers transient attention in ordered pages after the current pending state cleared", async () => {
    const s = await setup()
    await s.database.batch(sessionAttentionStatements(s.database, [batch], [ref]))
    await s.database.batch(sessionAttentionStatements(s.database, [batch], [ref]))
    const first = await s.authority.listSessionAttention!(s.alice, { limit: 2 })
    expect(first.events.map((entry) => entry.event.kind)).toEqual(["question", "permission"])
    expect(first.events.every((entry) => entry.sessionId === "ses" && entry.projectId === s.projectId)).toBe(true)
    expect(first.next).toBe(first.events[1].cursor)
    const last = await s.authority.listSessionAttention!(s.alice, { after: first.next, limit: 2 })
    expect(last.events.map((entry) => entry.event.kind)).toEqual(["outcome"])
    expect(last.next).toBeUndefined()
    expect(last.through).toBe(first.through)
    expect((await s.database.prepare("SELECT COUNT(*) AS count FROM session_attention_events").first<{ count: number }>())!.count).toBe(3)
  })

  test("refuses unadmitted, stale-generation, future and fenced publication histories", async () => {
    const s = await setup()
    expect(sessionAttentionStatements(s.database, [batch], [])).toHaveLength(0)
    await s.database.batch(sessionAttentionStatements(s.database, [{ ...batch, generation: 0 }], [ref]))
    await s.database.batch(sessionAttentionStatements(s.database, [{ ...batch, through: 51 }], [ref]))
    await s.database.batch(sessionAttentionStatements(s.database, [batch], [ref], { sql: "0", bind: [] }))
    expect((await readD1SessionAttention(s.database, s.alice.principal!, { limit: 256 })).events).toEqual([])
    await s.database.batch(sessionAttentionStatements(s.database, [batch], [ref]))
    const changed = { ...batch, events: [{ ...batch.events[0], requestId: "changed" }] }
    await expect(s.database.batch(sessionAttentionStatements(s.database, [changed], [ref]))).rejects.toThrow(/NOT NULL/)
    expect((await readD1SessionAttention(s.database, s.alice.principal!, { limit: 256 })).events[0].event.requestId).toBe("q")
  })

  test("uses current read grants for history and private fanout, including revocation and membership loss", async () => {
    const s = await setup()
    await s.database.batch(sessionAttentionStatements(s.database, [batch], [ref]))
    await s.authority.grantProjectMember!(s.alice, { projectId: s.projectId, userPublicId: s.neighbor.principal!.userId, role: "admin" })
    expect((await readD1SessionAttention(s.database, s.neighbor.principal!, { limit: 256 })).events).toEqual([])
    expect((await readD1SessionStateNotices(s.database, [ref]))[0].recipients).toEqual([{ userId: s.alice.principal!.userId }])
    await s.authority.grantSessionShare!(s.alice, { ...ref, grantedToUserId: s.bob.principal!.userId, level: "follow" })
    expect((await readD1SessionAttention(s.database, s.bob.principal!, { limit: 256 })).events).toHaveLength(3)
    expect((await readD1SessionStateNotices(s.database, [ref]))[0].recipients.map((recipient) => recipient.userId).sort((a, b) => a.localeCompare(b))).toEqual([s.alice.principal!.userId, s.bob.principal!.userId].sort((a, b) => a.localeCompare(b)))
    await s.authority.revokeSessionShare!(s.alice, { ...ref, grantedToUserId: s.bob.principal!.userId })
    expect((await readD1SessionAttention(s.database, s.bob.principal!, { limit: 256 })).events).toEqual([])
    await s.authority.grantSessionShare!(s.alice, { ...ref, grantedToOrgId: "org", level: "follow" })
    await s.database.prepare("UPDATE org_memberships SET revoked_at = 1 WHERE org_id = 'org' AND user_id = ?").bind(s.neighbor.principal!.userId).run()
    expect((await readD1SessionStateNotices(s.database, [ref]))[0].recipients.map((recipient) => recipient.userId).sort((a, b) => a.localeCompare(b))).toEqual([s.alice.principal!.userId, s.bob.principal!.userId].sort((a, b) => a.localeCompare(b)))
  })

  test("publishes only stored canonical events and current subjects, keeping deleted history private", async () => {
    const s = await setup()
    await s.database.batch(sessionAttentionStatements(s.database, [batch], [ref]))
    await s.database.prepare("INSERT INTO auth_identities (adapter,issuer,subject,user_id,linked_at) VALUES ('better-auth','https://auth.test','alice-linked',?,1)")
      .bind(s.alice.principal!.userId).run()
    const unstored: SessionAttentionBatch = { ...batch, events: [{ kind: "question", sequence: 49, openedAt: 49, requestId: "unstored" }] }
    const notices = await readD1SessionPublicationNotices(s.database, [ref], [batch, unstored])
    expect(notices.filter((notice) => notice.type === "session.status.changed")).toHaveLength(1)
    expect(notices.filter((notice) => notice.type === "session.attention.raised")).toHaveLength(3)
    await s.database.prepare("UPDATE auth_identities SET unlinked_at = 1 WHERE subject = 'alice-linked'").run()
    expect((await readD1SessionStateNotices(s.database, [ref]))[0].recipients).toHaveLength(1)
    await s.database.prepare("UPDATE sessions SET deleted_at = 60 WHERE session_id = 'ses'").run()
    expect(await readD1SessionStateNotices(s.database, [ref])).toEqual([])
    expect((await readD1SessionAttention(s.database, s.alice.principal!, { limit: 256 })).events).toEqual([])
    expect((await s.database.prepare("SELECT COUNT(*) AS count FROM session_attention_events").first<{ count: number }>())!.count).toBe(3)
  })

  test("looks up selected canonical events by index without scanning retained history", async () => {
    const s = await setup()
    const current: SessionAttentionBatch = { ...batch, generation: 5001, through: 5050,
      events: batch.events.map((event) => ({ ...event, sequence: event.sequence + 5000, openedAt: event.openedAt + 5000 })) }
    await s.database.prepare("UPDATE sessions SET attention_json = ? WHERE session_id = 'ses'")
      .bind(JSON.stringify({ generation: 5001, sequence: 5050, activitySequence: 5050, activityAt: 5050,
        working: false, awaitingInput: false, outcome: { sequence: 5050, status: "completed", completedAt: 5050 } })).run()
    await s.database.prepare(`INSERT INTO session_attention_events
      (session_id, workspace_id, org_id, project_id, generation, sequence, event_json)
      SELECT s.session_id, s.workspace_id, s.org_id, s.project_id, 1, retained.value,
        json_object('sequence', retained.value, 'kind', 'question', 'openedAt', retained.value, 'requestId', 'retained-' || retained.value)
      FROM sessions s, json_each(?) retained WHERE s.session_id = 'ses'`)
      .bind(JSON.stringify(Array.from({ length: 4000 }, (_, index) => index + 100))).run()
    await s.database.batch(sessionAttentionStatements(s.database, [current], [ref]))
    await s.authority.grantSessionShare!(s.alice, { ...ref, grantedToUserId: s.bob.principal!.userId, level: "follow" })
    const selected = { ...current, events: [...current.events].reverse() }
    const queries: string[] = []
    const observed = new Proxy(s.database, { get(database, key) {
      if (key !== "prepare") return Reflect.get(database, key)
      return (query: string) => { queries.push(query); return database.prepare(query) }
    } })
    const notices = await readD1SessionPublicationNotices(observed, [ref], [selected, selected,
      { ...selected, workspaceId: "different-workspace" }, { ...selected, generation: 5002 },
      { ...selected, events: [{ ...selected.events[0], openedAt: 6000 }] }])
    const query = queries.find((query) => query.includes("session_attention_events e") && query.includes("json_each(?) selected"))
    for (const reader of [s.alice.principal!.userId, s.bob.principal!.userId]) {
      expect(notices.filter((notice) => notice.ownerUserId === reader && notice.type === "session.attention.raised")
        .map((notice) => notice.type === "session.attention.raised" && notice.event.sequence)).toEqual([5005, 5010, 5050])
    }
    expect(notices.filter((notice) => notice.type === "session.status.changed")).toHaveLength(2)
    expect(query).toBeDefined()
    const plan = await s.database.prepare(`EXPLAIN QUERY PLAN ${query!}`).bind("[]").all<{ detail: string }>()
    expect(plan.results.some((row) => /SEARCH e USING INDEX .+\(session_id=\? AND generation=\? AND sequence=\?\)/.test(row.detail))).toBe(true)
    expect(plan.results.some((row) => /SCAN e(?:\s|$)/.test(row.detail))).toBe(false)
  })

  test("keeps a user fork visible while excluding a runtime subsession", async () => {
    const s = await setup()
    await s.authority.reserveSession(s.alice, { operationId: "fork-op", sessionId: "fork", workspaceId: "ws", kind: "fork", parentSessionId: "ses" })
    await s.authority.registerRuntimeSession({ principalKind: "user", actorId: s.alice.principal!.actorId, actorKind: "human",
      operationId: "fork-op", sessionId: "fork", workspaceId: "ws", createdAt: 2, updatedAt: 2 })
    await s.database.prepare("UPDATE sessions SET attention_json = (SELECT attention_json FROM sessions WHERE session_id = 'ses'), status = 'idle', status_at = 50 WHERE session_id = 'fork'").run()
    const fork = { ...batch, sessionId: "fork" }
    await s.database.batch(sessionAttentionStatements(s.database, [fork], [fork]))
    expect((await readD1SessionAttention(s.database, s.alice.principal!, { limit: 256 })).events).toHaveLength(3)
    expect((await readD1SessionStateNotices(s.database, [fork]))[0].sessionId).toBe("fork")
    await s.database.prepare("UPDATE sessions SET parent_session_id = 'ses' WHERE session_id = 'fork'").run()
    expect((await readD1SessionAttention(s.database, s.alice.principal!, { limit: 256 })).events).toEqual([])
    expect(await readD1SessionStateNotices(s.database, [fork])).toEqual([])
  })

  test("uses live team grants and withdraws private delivery when a reader is suspended", async () => {
    const s = await setup()
    const team = await s.authority.createTeamInOrg!(s.alice, { orgId: "org", name: "Reviewers" }) as { team_id: string }
    await s.authority.addTeamMember!(s.alice, { teamId: team.team_id, userPublicId: s.bob.principal!.userId })
    await s.authority.grantSessionShare!(s.alice, { ...ref, grantedToTeamId: team.team_id, level: "follow" })
    const recipients = () => readD1SessionStateNotices(s.database, [ref]).then((notices) => notices[0].recipients.map((recipient) => recipient.userId))
    expect(await recipients()).toContain(s.bob.principal!.userId)
    await s.database.prepare("UPDATE users SET state = 'suspended', suspended_at = 70 WHERE user_id = ?").bind(s.bob.principal!.userId).run()
    expect(await recipients()).not.toContain(s.bob.principal!.userId)
  })

  test("fanouts committed removal to current owner, direct, team and organization readers without session content", async () => {
    const s = await setup()
    const team = await s.authority.createTeamInOrg!(s.alice, { orgId: "org", name: "Reviewers" }) as { team_id: string }
    await s.authority.addTeamMember!(s.alice, { teamId: team.team_id, userPublicId: s.bob.principal!.userId })
    await s.authority.grantSessionShare!(s.alice, { ...ref, grantedToTeamId: team.team_id })
    await s.authority.grantSessionShare!(s.alice, { ...ref, grantedToUserId: s.bob.principal!.userId })
    await s.authority.grantSessionShare!(s.alice, { ...ref, grantedToOrgId: "org" })
    await s.database.prepare("UPDATE sessions SET deleted_at = 80 WHERE session_id = 'ses'").run()
    const notices = await s.authority.sessionPublicationNotices!([ref], [])
    expect(notices.map((notice) => notice.ownerUserId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([s.alice.principal!.userId, s.bob.principal!.userId, s.neighbor.principal!.userId].sort((a, b) => a.localeCompare(b)))
    for (const notice of notices) {
      expect(notice.type).toBe("session.removed")
      expect(Object.keys(notice).sort((a, b) => a.localeCompare(b))).toEqual(["orgId", "ownerUserId", "projectId", "sessionId", "ts", "type", "workspaceId"])
      expect(notice.ts).toBe(80)
    }
    await s.database.prepare("UPDATE session_share_grants SET revoked_at = 90 WHERE session_id = 'ses' AND target_org_id = 'org'").run()
    await s.authority.removeTeamMember!(s.alice, { teamId: team.team_id, userPublicId: s.bob.principal!.userId })
    expect((await s.authority.sessionPublicationNotices!([ref], [])).map((notice) => notice.ownerUserId).sort((a, b) => String(a).localeCompare(String(b))))
      .toEqual([s.alice.principal!.userId, s.bob.principal!.userId].sort((a, b) => a.localeCompare(b)))
    await s.database.prepare("UPDATE users SET state = 'suspended', suspended_at = 100 WHERE user_id = ?").bind(s.bob.principal!.userId).run()
    expect((await s.authority.sessionPublicationNotices!([ref], [])).map((notice) => notice.ownerUserId)).toEqual([s.alice.principal!.userId])
    expect(await s.authority.sessionNoticeVisible!(s.alice, ref, "session.status.changed")).toBe(false)
    expect(await s.authority.sessionNoticeVisible!(s.alice, ref, "session.removed")).toBe(true)
  })
})
