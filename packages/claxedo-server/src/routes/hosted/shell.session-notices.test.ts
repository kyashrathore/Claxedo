import { afterEach, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { storedD1Session } from "../../test-support/d1-stored-session"
import { signedD1Identity } from "../../test-support/signed-d1-identity"
import { inviteOrgMember } from "../../test-support/invite-org-member"
import { D1WorkspaceAuthority } from "../../authority/adapters/d1/workspace-authority"
import { D1TeamAuthority } from "../../authority/adapters/d1/team-authority"
import { HostedShellRoutes } from "./shell"

const active: ControlPlaneDatabase[] = []
afterEach(async () => { await Promise.all(active.splice(0).map((database) => database.dispose())) })
const ref = { sessionId: "ses", workspaceId: "ws" }
const wire = (payload: unknown, id: string) => `id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`

async function setup() {
  const backing = await miniflareControlPlaneDatabase()
  active.push(backing)
  const { auth: alice, sessions } = await storedD1Session(backing.database)
  const workspace = new D1WorkspaceAuthority(backing.database, { deploymentId: "test", product: { kind: "claxedo-hosted" } })
  const bob = await signedD1Identity(workspace, "bob")
  await inviteOrgMember(backing.database, alice, { userPublicId: bob.principal!.userId, orgId: "org", role: "member" })
  return { alice, bob, sessions, database: backing.database, teams: new D1TeamAuthority(workspace.accessContext()) }
}

function privateFrame(auth: SignedControlPlaneAuth, type = "session.status.changed") {
  return { type, ...ref, projectId: "project", orgId: "org", ownerUserId: auth.principal!.userId,
    title: "Private review title", ts: 5, attention: { generation: 1, sequence: 5, activitySequence: 5, activityAt: 5, working: false, awaitingInput: false },
    status: { kind: "idle", awaitingInput: false, at: 5 } }
}

function workingFrame(auth: SignedControlPlaneAuth) {
  return { ...privateFrame(auth), status: { kind: "busy", awaitingInput: false, at: 5 },
    attention: { generation: 1, sequence: 5, activitySequence: 5, activityAt: 5, working: true, awaitingInput: false } }
}

function app(s: Awaited<ReturnType<typeof setup>>, auth: SignedControlPlaneAuth, body: ReadableStream<Uint8Array> | string,
  roomNames: string[] = []) {
  return HostedShellRoutes({
    authConfig: { enabled: true, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks", audience: "claxedo-server" },
    verifier: async () => auth,
    resolveOrgId: async () => "different-active-org",
    sessionNoticeVisible: (signed, selected, kind) => s.sessions.sessionNoticeVisible(signed, selected, kind),
    liveSyncRoom: { idFromName(name) { roomNames.push(name); return name }, get: () => ({ fetch: async () => new Response(body,
      { headers: { "content-type": "text/event-stream" } }) }) },
  })
}

test("public replay checks revoked shares even when the room received no revocation notice", async () => {
  const s = await setup()
  await s.sessions.grantSessionShare(s.alice, { ...ref, grantedToUserId: s.bob.principal!.userId })
  const replay = wire({ ...workingFrame(s.bob), replayed: true }, "6")
  await s.sessions.revokeSessionShare(s.alice, { ...ref, grantedToUserId: s.bob.principal!.userId })
  const response = await app(s, s.bob, replay).request("http://control.test/api/cp/events", { headers: { authorization: "Bearer bob", "last-event-id": "5" } })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(wire({ type: "heartbeat" }, "6"))
})

test("public replay excludes team membership loss without relying on a room revocation map", async () => {
  const s = await setup()
  const team = await s.teams.createTeamInOrg(s.alice, { orgId: "org", name: "Reviewers" }) as { team_id: string }
  await s.teams.addTeamMember(s.alice, { teamId: team.team_id, userPublicId: s.bob.principal!.userId })
  await s.sessions.grantSessionShare(s.alice, { ...ref, grantedToTeamId: team.team_id })
  await s.teams.removeTeamMember(s.alice, { teamId: team.team_id, userPublicId: s.bob.principal!.userId })
  const replay = wire({ ...privateFrame(s.bob, "session.attention.raised"), replayed: true }, "7")
  const response = await app(s, s.bob, replay).request("http://control.test/api/cp/events", { headers: { authorization: "Bearer bob", "last-event-id": "5" } })
  expect(await response.text()).toBe(wire({ type: "heartbeat" }, "7"))
})

test("live delivery checks each event after permission changes and preserves the denied event cursor", async () => {
  const s = await setup()
  await s.sessions.grantSessionShare(s.alice, { ...ref, grantedToUserId: s.bob.principal!.userId })
  let source!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller } })
  const response = await app(s, s.bob, body).request("http://control.test/api/cp/events", { headers: { authorization: "Bearer bob" } })
  const reader = response.body!.getReader()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  source.enqueue(encoder.encode(wire(privateFrame(s.bob), "8")))
  expect(decoder.decode((await reader.read()).value)).toBe(wire(privateFrame(s.bob), "8"))
  await s.sessions.revokeSessionShare(s.alice, { ...ref, grantedToUserId: s.bob.principal!.userId })
  source.enqueue(encoder.encode(wire(privateFrame(s.bob, "session.reader.changed"), "9")))
  expect(decoder.decode((await reader.read()).value)).toBe(wire({ type: "heartbeat" }, "9"))
  source.enqueue(encoder.encode(wire(workingFrame(s.bob), "10")))
  expect(decoder.decode((await reader.read()).value)).toBe(wire({ type: "heartbeat" }, "10"))
  await reader.cancel()
})

test("account notices use the canonical private room across orgs and never reach another recipient", async () => {
  const s = await setup()
  const rooms: string[] = []
  const allowed = wire(privateFrame(s.alice), "10")
  const response = await app(s, s.alice, allowed, rooms).request("http://control.test/api/cp/events", { headers: { authorization: "Bearer alice" } })
  expect(await response.text()).toBe(allowed)
  expect(rooms).toEqual([`owner:${s.alice.principal!.userId}`])
  const denied = await app(s, s.bob, allowed).request("http://control.test/api/cp/events", { headers: { authorization: "Bearer bob" } })
  expect(await denied.text()).toBe(wire({ type: "heartbeat" }, "10"))
})

test("revoking one direct share preserves live and replay delivery through an active team share", async () => {
  const s = await setup()
  const team = await s.teams.createTeamInOrg(s.alice, { orgId: "org", name: "Reviewers" }) as { team_id: string }
  await s.teams.addTeamMember(s.alice, { teamId: team.team_id, userPublicId: s.bob.principal!.userId })
  await s.sessions.grantSessionShare(s.alice, { ...ref, grantedToTeamId: team.team_id })
  await s.sessions.grantSessionShare(s.alice, { ...ref, grantedToUserId: s.bob.principal!.userId })
  await s.sessions.revokeSessionShare(s.alice, { ...ref, grantedToUserId: s.bob.principal!.userId })
  const input = wire({ ...privateFrame(s.bob), replayed: true }, "11") + wire(privateFrame(s.bob), "12")
  const response = await app(s, s.bob, input).request("http://control.test/api/cp/events", { headers: { authorization: "Bearer bob", "last-event-id": "10" } })
  expect(await response.text()).toBe(input)
})

test("only minimal removal notices remain visible to active readers of a committed tombstone", async () => {
  const s = await setup()
  await s.sessions.grantSessionShare(s.alice, { ...ref, grantedToUserId: s.bob.principal!.userId })
  await s.database.prepare("UPDATE sessions SET deleted_at = 80 WHERE session_id = 'ses'").run()
  const notices = await s.sessions.sessionPublicationNotices([ref], [])
  expect(notices.every((notice) => notice.type === "session.removed")).toBe(true)
  expect(notices.map((notice) => notice.ownerUserId).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([s.alice.principal!.userId, s.bob.principal!.userId].sort((a, b) => a.localeCompare(b)))
  const bob = notices.find((notice) => notice.ownerUserId === s.bob.principal!.userId)!
  const input = wire({ ...bob, replayed: true }, "13") + wire(privateFrame(s.bob), "14")
  const response = await app(s, s.bob, input).request("http://control.test/api/cp/events", { headers: { authorization: "Bearer bob" } })
  const output = await response.text()
  const data = output.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(6)))
  expect(data).toEqual([{ ...bob, replayed: true }, { type: "heartbeat" }])
  expect(output).not.toContain("Private review title")
  expect(output).toContain("id: 14\n")
  await s.database.prepare("UPDATE session_share_grants SET revoked_at = 90 WHERE session_id = 'ses' AND target_user_id = ?")
    .bind(s.bob.principal!.userId).run()
  const denied = await app(s, s.bob, wire(bob, "15")).request("http://control.test/api/cp/events", { headers: { authorization: "Bearer bob" } })
  expect(await denied.text()).toBe(wire({ type: "heartbeat" }, "15"))
})

test("removed-session delivery withdraws with team membership and account suspension", async () => {
  const s = await setup()
  const team = await s.teams.createTeamInOrg(s.alice, { orgId: "org", name: "Reviewers" }) as { team_id: string }
  await s.teams.addTeamMember(s.alice, { teamId: team.team_id, userPublicId: s.bob.principal!.userId })
  await s.sessions.grantSessionShare(s.alice, { ...ref, grantedToTeamId: team.team_id })
  await s.database.prepare("UPDATE sessions SET deleted_at = 80 WHERE session_id = 'ses'").run()
  const notice = (await s.sessions.sessionPublicationNotices([ref], [])).find((event) => event.ownerUserId === s.bob.principal!.userId)!
  await s.teams.removeTeamMember(s.alice, { teamId: team.team_id, userPublicId: s.bob.principal!.userId })
  const denied = await app(s, s.bob, wire(notice, "16")).request("http://control.test/api/cp/events", { headers: { authorization: "Bearer bob" } })
  expect(await denied.text()).toBe(wire({ type: "heartbeat" }, "16"))
  await s.database.prepare("UPDATE users SET state = 'suspended', suspended_at = 90 WHERE user_id = ?").bind(s.alice.principal!.userId).run()
  expect(await s.sessions.sessionPublicationNotices([ref], [])).toEqual([])
})
