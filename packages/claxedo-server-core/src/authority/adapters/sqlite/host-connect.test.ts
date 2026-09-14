import { generateKeyPairSync, sign as signData, type KeyObject } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { sha256Hex } from "@claxedo/helpers/crypto"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { asProjectId } from "@claxedo/server-core/platform/auth/branded-id"
import type { HostScopeDefinition, MachinePrincipal } from "@claxedo/server-core/platform/auth/authority"
import {
  MACHINE_REQUEST_HEADERS,
  invitationRedeemPayload,
  invitationTokenParts,
  machineRequestPayload,
  publicKeyFingerprint,
} from "@claxedo/server-core/platform/auth/host-connect-contract"
import { verifyMachineRequest, type MachineAuthResult } from "@claxedo/server-core/platform/auth/machine-auth"
import { createSqliteWorkspaceAuthority } from "./workspace-authority"
import { closeAuthorityDatabases, openAuthorityDb, type SqliteAuthorityDb } from "./workspace-authority-store"

/**
 * The SQLite half of P1: the machine caller, serving generations, readiness
 * as the one routing predicate, invitations, and scope. Where D1 and SQLite
 * differ in schema the assertions here are on the SQLite mapping — owner by
 * `owner_token_identifier`, owner eligibility as users-row existence, one
 * tenant with a nullable invitation org.
 */

const HEARTBEAT_PATH = "/api/claxedo/host/enrollments/heartbeat"
const ACQUIRE_PATH = "/api/claxedo/host/enrollments/acquire"

function signedAuth(subject: string): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: `tok_${subject}`,
    user: { subject, tokenIdentifier: `https://idp.example.test|${subject}`, issuer: "https://idp.example.test" },
  }
}

const owner = signedAuth("user_owner")
const other = signedAuth("user_other")
const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  closeAuthorityDatabases()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-host-connect-"))
  roots.push(root)
  const file = path.join(root, "authority.db")
  return { api: createSqliteWorkspaceAuthority({ path: file }), db: openAuthorityDb({ path: file }) }
}

type Api = ReturnType<typeof setup>["api"]

function hostKeyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  return { publicKey: JSON.stringify(pair.publicKey.export({ format: "jwk" })), privateKey: pair.privateKey }
}
type Keys = ReturnType<typeof hostKeyPair>

function signPayload(privateKey: KeyObject, payload: string) {
  return signData("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")
}

async function enrollByAccount(api: Api, input: { auth?: SignedControlPlaneAuth; hostId?: string; keys?: Keys; displayName?: string } = {}) {
  const auth = input.auth ?? owner
  const hostId = input.hostId ?? "host_laptop"
  const keys = input.keys ?? hostKeyPair()
  const request = await api.createHostEnrollmentRequest(auth, { hostId })
  const payload = [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${hostId}`,
    `request_id=${request.request_id}`,
    `nonce=${request.nonce}`,
  ].join("\n")
  const enrollment = await api.enrollHost(auth, {
    hostId,
    publicKey: keys.publicKey,
    requestId: request.request_id,
    signature: signPayload(keys.privateKey, payload),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  })
  return { enrollment, keys, hostId }
}

async function accountBeat(api: Api, input: { auth?: SignedControlPlaneAuth; hostId: string; keys: Keys; workspaceIds: string[] }) {
  const payload = [
    "claxedo.host-enrollment.heartbeat.v2",
    `host_id=${input.hostId}`,
    "ttl_ms=",
    `workspaces=${[...input.workspaceIds].sort().join(",")}`,
  ].join("\n")
  return api.heartbeatHostEnrollment(input.auth ?? owner, {
    hostId: input.hostId,
    workspaceIds: input.workspaceIds,
    signature: signPayload(input.keys.privateKey, payload),
  })
}

let nonceCounter = 0

async function machineRequest(keys: Keys, input: { enrollmentId: string; pathname: string; body: unknown; ts?: number; nonce?: string }) {
  const bodyText = JSON.stringify(input.body)
  const ts = input.ts ?? Date.now()
  const nonce = input.nonce ?? `nonce_${String(++nonceCounter).padStart(12, "0")}`
  const signature = signPayload(keys.privateKey, machineRequestPayload({
    method: "POST",
    pathname: input.pathname,
    bodySha256Hex: await sha256Hex(bodyText),
    ts,
    nonce,
    enrollmentId: input.enrollmentId,
  }))
  const headers = new Map<string, string>([
    [MACHINE_REQUEST_HEADERS.enrollmentId, input.enrollmentId],
    [MACHINE_REQUEST_HEADERS.ts, String(ts)],
    [MACHINE_REQUEST_HEADERS.nonce, nonce],
    [MACHINE_REQUEST_HEADERS.signature, signature],
  ])
  return { method: "POST", pathname: input.pathname, headers: { get: (name: string) => headers.get(name) ?? null }, bodyText }
}

async function verify(api: Api, keys: Keys, input: { enrollmentId: string; pathname: string; body: unknown; nonce?: string }): Promise<MachineAuthResult> {
  return verifyMachineRequest(await machineRequest(keys, input), { ...api.machineAuth!, now: Date.now })
}

async function principalFor(api: Api, keys: Keys, enrollmentId: string) {
  const result = await verify(api, keys, { enrollmentId, pathname: ACQUIRE_PATH, body: { enrollmentId } })
  if (!result.ok) throw new Error(`verifier refused: ${result.code}`)
  return result.machine
}

type BeatBody = { enrollmentId: string; hostId: string; generation: number; acks: Array<{ workspaceId: string; revision: number }> }

async function machineBeat(api: Api, keys: Keys, body: BeatBody, machine?: MachinePrincipal) {
  const principal = machine ?? await (async () => {
    const result = await verify(api, keys, { enrollmentId: body.enrollmentId, pathname: HEARTBEAT_PATH, body })
    if (!result.ok) throw new Error(`verifier refused: ${result.code}`)
    return result.machine
  })()
  return api.heartbeatHostEnrollmentByMachine!(principal, body)
}

async function acquire(api: Api, keys: Keys, enrollmentId: string) {
  return api.acquireHostServingGeneration!(await principalFor(api, keys, enrollmentId))
}

async function invite(api: Api, input: { auth?: SignedControlPlaneAuth; scope?: HostScopeDefinition; displayName?: string; expiresInMs?: number } = {}) {
  return api.createHostInvitation!(input.auth ?? owner, {
    scope: input.scope ?? { allowed_roots: ["/srv"], visibility: "owner" },
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.expiresInMs !== undefined ? { expiresInMs: input.expiresInMs } : {}),
  })
}

async function redeem(api: Api, input: { token: string; hostId: string; keys: Keys; secret?: string; displayName?: string }) {
  const parts = invitationTokenParts(input.token)
  if (!parts) throw new Error("bad token")
  const publicKeySha256 = await publicKeyFingerprint(JSON.parse(input.keys.publicKey))
  return api.redeemHostInvitation!({
    invitationId: parts.invitationId,
    secret: input.secret ?? parts.secret,
    hostId: input.hostId,
    publicKey: input.keys.publicKey,
    signature: signPayload(input.keys.privateKey, invitationRedeemPayload({ invitationId: parts.invitationId, hostId: input.hostId, publicKeySha256 })),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  })
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as { code?: string; status?: number; details?: Record<string, unknown> }
  }
  throw new Error("expected a failure")
}

async function online(api: Api, auth = owner) {
  return Object.fromEntries(
    (await api.listWorkspaces(auth) as Array<{ workspace_id: string; host_online?: boolean }>)
      .map((row) => [row.workspace_id, row.host_online]),
  )
}

function enrollmentRow(db: () => SqliteAuthorityDb, enrollmentId: string) {
  return db().prepare<unknown[], Record<string, unknown>>(`SELECT * FROM host_enrollments WHERE enrollment_id = ?`).get(enrollmentId)!
}

function addOrgMember(db: () => SqliteAuthorityDb, orgId: string, tokenIdentifier: string, role = "member") {
  const now = Date.now()
  db().prepare(`
    INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  `).run(orgId, tokenIdentifier, role, now, now)
}

describe("machine verifier through the SQLite adapter", () => {
  test("a fresh machine request is accepted with the owner read from the row", async () => {
    const { api } = setup()
    const { enrollment, keys, hostId } = await enrollByAccount(api)
    const result = await verify(api, keys, {
      enrollmentId: enrollment.enrollment_id,
      pathname: HEARTBEAT_PATH,
      body: { enrollmentId: enrollment.enrollment_id, hostId, generation: 0, acks: [] },
    })
    expect(result).toEqual({
      ok: true,
      machine: {
        enrollmentId: enrollment.enrollment_id,
        hostId,
        ownerUserId: owner.user.tokenIdentifier,
        ownerActorId: owner.user.tokenIdentifier,
        scope: undefined,
        keyVersion: 1,
        generation: 0,
      },
    })
  })

  test("the identical request twice is a replay: the nonce row is insert-or-fail", async () => {
    const { api, db } = setup()
    const { enrollment, keys } = await enrollByAccount(api)
    const input = { enrollmentId: enrollment.enrollment_id, pathname: HEARTBEAT_PATH, body: {}, nonce: "nonce_replay_0001" }
    expect((await verify(api, keys, input)).ok).toBe(true)
    expect(await verify(api, keys, input)).toMatchObject({ ok: false, status: 401, code: "machine_nonce_replayed" })
    expect(db().prepare(`SELECT COUNT(*) AS count FROM host_request_nonces WHERE enrollment_id = ?`).get(enrollment.enrollment_id))
      .toEqual({ count: 1 })
  })

  test("the heartbeat sweeps only nonces past their expiry; a live one stays refused", async () => {
    const { api, db } = setup()
    const { enrollment, keys, hostId } = await enrollByAccount(api)
    db().prepare(`INSERT INTO host_request_nonces (enrollment_id, nonce, expires_at) VALUES (?, 'nonce_stale_000001', ?)`)
      .run(enrollment.enrollment_id, Date.now() - 1)
    const live = { enrollmentId: enrollment.enrollment_id, pathname: HEARTBEAT_PATH, body: {}, nonce: "nonce_live_0000001" }
    expect((await verify(api, keys, live)).ok).toBe(true)

    await machineBeat(api, keys, { enrollmentId: enrollment.enrollment_id, hostId, generation: 0, acks: [] })
    expect(db().prepare(`SELECT nonce FROM host_request_nonces WHERE enrollment_id = ? ORDER BY nonce`).all(enrollment.enrollment_id))
      .toEqual(expect.not.arrayContaining([{ nonce: "nonce_stale_000001" }]))
    expect(await verify(api, keys, live)).toMatchObject({ ok: false, code: "machine_nonce_replayed" })
  })

  test("an owner whose users row is gone is ineligible — the SQLite predicate is row existence", async () => {
    const { api, db } = setup()
    const { enrollment, keys } = await enrollByAccount(api)
    db().prepare(`DELETE FROM users WHERE token_identifier = ?`).run(owner.user.tokenIdentifier)
    expect(await verify(api, keys, { enrollmentId: enrollment.enrollment_id, pathname: HEARTBEAT_PATH, body: {} }))
      .toMatchObject({ ok: false, status: 403, code: "enrollment_owner_ineligible" })
  })

  test("an unknown enrollment id, and a revoked or paused one, are refused before any signature work", async () => {
    const { api } = setup()
    const { enrollment, keys, hostId } = await enrollByAccount(api)
    expect(await verify(api, keys, { enrollmentId: "enr_nope", pathname: HEARTBEAT_PATH, body: {} }))
      .toMatchObject({ ok: false, status: 401, code: "machine_enrollment_unknown" })
    await api.pauseHostEnrollment(owner, { hostId, paused: true })
    expect(await verify(api, keys, { enrollmentId: enrollment.enrollment_id, pathname: HEARTBEAT_PATH, body: {} }))
      .toMatchObject({ ok: false, status: 403, code: "enrollment_paused" })
    await api.pauseHostEnrollment(owner, { hostId, paused: false })
    await api.revokeHostEnrollment(owner, { hostId })
    expect(await verify(api, keys, { enrollmentId: enrollment.enrollment_id, pathname: HEARTBEAT_PATH, body: {} }))
      .toMatchObject({ ok: false, status: 403, code: "enrollment_revoked" })
  })

  test("the account re-enroll bumps key_version only when the key changes, and the old key stops verifying", async () => {
    const { api, db } = setup()
    const { enrollment, keys, hostId } = await enrollByAccount(api)
    await enrollByAccount(api, { hostId, keys })
    expect(enrollmentRow(db, enrollment.enrollment_id)).toMatchObject({ key_version: 1 })

    const replacement = hostKeyPair()
    await enrollByAccount(api, { hostId, keys: replacement })
    expect(enrollmentRow(db, enrollment.enrollment_id)).toMatchObject({ key_version: 2, public_key: replacement.publicKey })
    expect(await verify(api, keys, { enrollmentId: enrollment.enrollment_id, pathname: HEARTBEAT_PATH, body: {} }))
      .toMatchObject({ ok: false, code: "machine_signature_invalid" })
    expect(await verify(api, replacement, { enrollmentId: enrollment.enrollment_id, pathname: HEARTBEAT_PATH, body: {} }))
      .toMatchObject({ ok: true, machine: { keyVersion: 2 } })
  })
})

describe("machine heartbeat, readiness and generations", () => {
  test("a machine beat renews the lease, acks a revision, and routes exactly as the account beat does", async () => {
    const { api, db } = setup()
    const { enrollment, keys, hostId } = await enrollByAccount(api, { displayName: "Laptop" })
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_a", hostId, remoteDirectory: "/srv/a" })
    expect(await api.activeWorkspaceHost(owner, { workspaceId: "ws_a" })).toEqual({ active: false })

    const before = enrollmentRow(db, enrollment.enrollment_id)
    const beat = await machineBeat(api, keys, {
      enrollmentId: enrollment.enrollment_id,
      hostId,
      generation: 0,
      acks: [{ workspaceId: "ws_a", revision: 1 }],
    })
    expect(beat).toMatchObject({
      assignments: [{ workspace_id: "ws_a", remote_directory: "/srv/a", revision: 1 }],
      assigned_workspace_ids: ["ws_a"],
      scope: undefined,
    })
    expect(beat.expires_at).toBeGreaterThan(before.expires_at as number)
    expect(enrollmentRow(db, enrollment.enrollment_id)).toMatchObject({
      owner_token_identifier: owner.user.tokenIdentifier,
      acked_workspace_ids: '["ws_a"]',
    })
    expect(await api.activeWorkspaceHost(owner, { workspaceId: "ws_a" })).toMatchObject({ active: true, host_id: hostId, display_name: "Laptop" })
    expect(await online(api)).toEqual({ ws_a: true })
    expect(await api.listHostEnrollments!(owner)).toMatchObject([{ acked: [{ workspaceId: "ws_a", revision: 1 }] }])

    // The account path lands its acks at the current revision.
    await accountBeat(api, { hostId, keys, workspaceIds: [] })
    expect(await online(api)).toEqual({ ws_a: false })
    await accountBeat(api, { hostId, keys, workspaceIds: ["ws_a"] })
    expect(await online(api)).toEqual({ ws_a: true })
  })

  test("descriptions and scope come back only for this enrollment", async () => {
    const { api } = setup()
    const first = await enrollByAccount(api, { hostId: "host_one" })
    const second = await enrollByAccount(api, { hostId: "host_two" })
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_one", hostId: "host_one", remoteDirectory: "/srv/one" })
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_two", hostId: "host_two", remoteDirectory: "/srv/two" })

    const beat = await machineBeat(api, first.keys, { enrollmentId: first.enrollment.enrollment_id, hostId: "host_one", generation: 0, acks: [] })
    expect(beat.assignments.map((assignment) => assignment.workspace_id)).toEqual(["ws_one"])
    const otherBeat = await machineBeat(api, second.keys, { enrollmentId: second.enrollment.enrollment_id, hostId: "host_two", generation: 0, acks: [] })
    expect(otherBeat.assignments.map((assignment) => assignment.workspace_id)).toEqual(["ws_two"])
  })

  test("re-pointing bumps the revision with the directory; routing waits for the new revision's ack", async () => {
    const { api, db } = setup()
    const { enrollment, keys, hostId } = await enrollByAccount(api)
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_a", hostId, remoteDirectory: "/srv/a" })
    await machineBeat(api, keys, { enrollmentId: enrollment.enrollment_id, hostId, generation: 0, acks: [{ workspaceId: "ws_a", revision: 1 }] })
    expect(await online(api)).toEqual({ ws_a: true })

    await api.assignWorkspaceHost(owner, { workspaceId: "ws_a", hostId, remoteDirectory: "/srv/a-moved" })
    expect(db().prepare(`SELECT revision FROM host_workspace_assignments WHERE workspace_id = 'ws_a'`).get()).toEqual({ revision: 2 })
    expect(await api.activeWorkspaceHost(owner, { workspaceId: "ws_a" })).toEqual({ active: false })
    expect(await online(api)).toEqual({ ws_a: false })

    // An ack for the revision the assignment no longer holds writes nothing.
    const stale = await machineBeat(api, keys, { enrollmentId: enrollment.enrollment_id, hostId, generation: 0, acks: [{ workspaceId: "ws_a", revision: 1 }] })
    expect(stale.assignments).toEqual([{ workspace_id: "ws_a", remote_directory: "/srv/a-moved", display_name: "ws_a", revision: 2 }])
    expect(await online(api)).toEqual({ ws_a: false })

    await machineBeat(api, keys, { enrollmentId: enrollment.enrollment_id, hostId, generation: 0, acks: [{ workspaceId: "ws_a", revision: 2 }] })
    expect(await api.activeWorkspaceHost(owner, { workspaceId: "ws_a" })).toMatchObject({ active: true })
    expect(await online(api)).toEqual({ ws_a: true })
  })

  test("acquire moves the generation, drops prior readiness, and refuses the older instance's beat", async () => {
    const { api, db } = setup()
    const { enrollment, keys, hostId } = await enrollByAccount(api)
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_a", hostId, remoteDirectory: "/srv/a" })
    const body: BeatBody = { enrollmentId: enrollment.enrollment_id, hostId, generation: 0, acks: [{ workspaceId: "ws_a", revision: 1 }] }
    await machineBeat(api, keys, body)
    expect(await online(api)).toEqual({ ws_a: true })

    const acquired = await acquire(api, keys, enrollment.enrollment_id)
    expect(acquired).toMatchObject({ generation: 1 })
    expect(db().prepare(`SELECT COUNT(*) AS count FROM host_assignment_readiness`).get()).toEqual({ count: 0 })
    expect(await online(api)).toEqual({ ws_a: false })
    expect(db().prepare(`SELECT action FROM audit_events WHERE action = 'host_enrollment.generation_acquired'`).all()).toHaveLength(1)

    const refused = await failure(machineBeat(api, keys, body))
    expect(refused).toMatchObject({ code: "enrollment_generation_superseded", status: 409, details: { serving_generation: 1 } })
    expect(await online(api)).toEqual({ ws_a: false })

    await machineBeat(api, keys, { ...body, generation: 1 })
    expect(await online(api)).toEqual({ ws_a: true })
    expect(await api.listHostEnrollments!(owner)).toMatchObject([
      { serving_generation: 1, generation_acquired_at: acquired.generation_acquired_at, acked: [{ workspaceId: "ws_a", revision: 1 }] },
    ])
  })

  test("a restart before the lease expires acquires immediately and displaces the previous generation", async () => {
    const { api, keys, enrollment } = await (async () => {
      const { api } = setup()
      const enrolled = await enrollByAccount(api)
      return { api, keys: enrolled.keys, enrollment: enrolled.enrollment }
    })()
    const first = await acquire(api, keys, enrollment.enrollment_id)
    const second = await acquire(api, keys, enrollment.enrollment_id)
    expect(second.generation).toBe(first.generation + 1)
    const refused = await failure(machineBeat(api, keys, { enrollmentId: enrollment.enrollment_id, hostId: "host_laptop", generation: first.generation, acks: [] }))
    expect(refused).toMatchObject({ code: "enrollment_generation_superseded" })
  })

  test("a beat verified against a replaced key or a removed owner writes nothing", async () => {
    const { api, db } = setup()
    const { enrollment, keys, hostId } = await enrollByAccount(api)
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_a", hostId, remoteDirectory: "/srv/a" })
    const body: BeatBody = { enrollmentId: enrollment.enrollment_id, hostId, generation: 0, acks: [{ workspaceId: "ws_a", revision: 1 }] }
    const verified = await principalFor(api, keys, enrollment.enrollment_id)
    const before = enrollmentRow(db, enrollment.enrollment_id)

    await enrollByAccount(api, { hostId, keys: hostKeyPair() })
    const keyRefusal = await failure(machineBeat(api, keys, body, verified))
    expect(keyRefusal).toMatchObject({ code: "enrollment_key_version_mismatch", status: 403 })
    expect(await failure(api.acquireHostServingGeneration!(verified))).toMatchObject({ code: "enrollment_key_version_mismatch" })
    expect(enrollmentRow(db, enrollment.enrollment_id)).toMatchObject({ acked_workspace_ids: before.acked_workspace_ids, serving_generation: 0 })
    expect(await online(api)).toEqual({ ws_a: false })

    const current = await principalFor(api, keys, enrollment.enrollment_id).catch(() => undefined)
    expect(current).toBeUndefined()
    const replacement = hostKeyPair()
    await enrollByAccount(api, { hostId, keys: replacement })
    const fresh = await principalFor(api, replacement, enrollment.enrollment_id)
    db().prepare(`DELETE FROM users WHERE token_identifier = ?`).run(owner.user.tokenIdentifier)
    expect(await failure(machineBeat(api, replacement, body, fresh))).toMatchObject({ code: "enrollment_owner_ineligible", status: 403 })
    expect(db().prepare(`SELECT COUNT(*) AS count FROM host_assignment_readiness`).get()).toEqual({ count: 0 })
  })

  test("unassign and revoke drop readiness with the assignment", async () => {
    const { api, db } = setup()
    const { enrollment, keys, hostId } = await enrollByAccount(api)
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_a", hostId, remoteDirectory: "/srv/a" })
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_b", hostId, remoteDirectory: "/srv/b" })
    await machineBeat(api, keys, {
      enrollmentId: enrollment.enrollment_id,
      hostId,
      generation: 0,
      acks: [{ workspaceId: "ws_a", revision: 1 }, { workspaceId: "ws_b", revision: 1 }],
    })
    const ready = () => db().prepare<unknown[], { workspace_id: string }>(`SELECT workspace_id FROM host_assignment_readiness ORDER BY workspace_id`).all()
    expect(ready()).toEqual([{ workspace_id: "ws_a" }, { workspace_id: "ws_b" }])
    await api.unassignWorkspaceHost(owner, { workspaceId: "ws_a" })
    expect(ready()).toEqual([{ workspace_id: "ws_b" }])
    await api.revokeHostEnrollment(owner, { hostId })
    expect(ready()).toEqual([])
  })
})

describe("invitations", () => {
  test("the token is chx_inv_1.<id>.<secret>, only the secret's hash is stored, and the list shows the row", async () => {
    const { api, db } = setup()
    const created = await invite(api, { displayName: "Build box", scope: { allowed_roots: ["/srv/"], visibility: "org" } })
    const parts = invitationTokenParts(created.token)
    expect(parts).toEqual({ invitationId: created.invitationId, secret: expect.any(String) })
    const row = db().prepare<unknown[], Record<string, unknown>>(`SELECT * FROM host_invitations WHERE invitation_id = ?`).get(created.invitationId)!
    expect(JSON.stringify(row)).not.toContain(parts!.secret)
    expect(row.secret_hash).toBe(await sha256Hex(parts!.secret))
    expect(row.org_id).toEqual(expect.stringMatching(/^org_/))
    expect(created.expiresAt - (row.created_at as number)).toBe(60 * 60_000)
    expect(await api.listHostInvitations!(owner)).toEqual([{
      invitation_id: created.invitationId,
      display_name: "Build box",
      scope: { allowed_roots: ["/srv"], visibility: "org" },
      org_id: row.org_id,
      created_at: row.created_at,
      expires_at: created.expiresAt,
    }])
    expect(await api.listHostInvitations!(other)).toEqual([])
    expect(await api.revokeHostInvitation!(other, { invitationId: created.invitationId })).toEqual({ revoked: false })
  })

  test("expiry is clamped to [5 min, 24 h] and a relative root is refused", async () => {
    const { api } = setup()
    const now = Date.now()
    expect((await invite(api, { expiresInMs: 1 })).expiresAt - now).toBeGreaterThanOrEqual(5 * 60_000)
    expect((await invite(api, { expiresInMs: 10 * 24 * 60 * 60_000 })).expiresAt - now).toBeLessThanOrEqual(24 * 60 * 60_000 + 1_000)
    expect(await failure(invite(api, { scope: { allowed_roots: ["srv"], visibility: "owner" } }))).toMatchObject({ code: "invalid_input" })
  })

  test("a fresh redeem enrolls the machine for the inviter with the invitation's scope and org", async () => {
    const { api, db } = setup()
    await api.usersMe(owner)
    db().prepare(`UPDATE users SET name = 'Owner Person' WHERE token_identifier = ?`).run(owner.user.tokenIdentifier)
    const created = await invite(api, { displayName: "Build box" })
    const keys = hostKeyPair()
    const result = await redeem(api, { token: created.token, hostId: "host_build", keys })
    expect(result).toMatchObject({
      resumed: false,
      enrollment: { host_id: "host_build", display_name: "Build box" },
      owner_user_id: owner.user.tokenIdentifier,
      owner_actor_id: owner.user.tokenIdentifier,
      org_id: expect.stringMatching(/^org_/),
      owner_display_name: "Owner Person",
      key_version: 1,
      serving_generation: 0,
      scope: { allowed_roots: ["/srv"], visibility: "owner", revision: 1 },
    })
    expect(enrollmentRow(db, result.enrollment.enrollment_id)).toMatchObject({
      owner_token_identifier: owner.user.tokenIdentifier,
      enrolled_via: "invitation",
      // Stored normalized to the four public members, whatever the caller sent.
      public_key: JSON.stringify((({ kty, crv, x, y }) => ({ kty, crv, x, y }))(JSON.parse(keys.publicKey))),
      key_version: 1,
      serving_generation: 0,
      scope_revision: 1,
    })
    expect(await api.listHostInvitations!(owner)).toMatchObject([{ redeemed_host_id: "host_build", redeemed_enrollment_id: result.enrollment.enrollment_id }])
    expect(await api.listHostEnrollments!(owner)).toMatchObject([{
      enrollment_id: result.enrollment.enrollment_id,
      enrolled_via: "invitation",
      public_key_fingerprint: await publicKeyFingerprint(JSON.parse(keys.publicKey)),
      scope: { allowed_roots: ["/srv"], visibility: "owner", revision: 1 },
    }])
    // The machine can now speak for itself.
    expect(await verify(api, keys, { enrollmentId: result.enrollment.enrollment_id, pathname: HEARTBEAT_PATH, body: {} }))
      .toMatchObject({ ok: true, machine: { ownerUserId: owner.user.tokenIdentifier, scope: { revision: 1 } } })
  })

  test("a wrong secret and an unknown id are the same refusal, with no redeemed-by detail", async () => {
    const { api } = setup()
    const created = await invite(api)
    await redeem(api, { token: created.token, hostId: "host_build", keys: hostKeyPair() })
    const wrongSecret = await failure(redeem(api, { token: created.token, hostId: "host_other", keys: hostKeyPair(), secret: "bm90LXRoZS1zZWNyZXQ" }))
    expect(wrongSecret).toMatchObject({ code: "invitation_invalid", status: 403 })
    expect(wrongSecret.details).toBeUndefined()
    const unknown = await failure(redeem(api, { token: `chx_inv_1.nope.${invitationTokenParts(created.token)!.secret}`, hostId: "host_other", keys: hostKeyPair() }))
    expect(unknown).toMatchObject({ code: "invitation_invalid", status: 403 })
    expect(unknown.details).toBeUndefined()
  })

  test("a bad signature is refused before the invitation is touched", async () => {
    const { api } = setup()
    const created = await invite(api)
    const parts = invitationTokenParts(created.token)!
    const keys = hostKeyPair()
    const refused = await failure(api.redeemHostInvitation!({
      invitationId: parts.invitationId,
      secret: parts.secret,
      hostId: "host_build",
      publicKey: keys.publicKey,
      signature: signPayload(hostKeyPair().privateKey, "not the payload"),
    }))
    expect(refused).toMatchObject({ code: "host_attestation_denied", status: 403 })
    expect(await api.listHostInvitations!(owner)).toMatchObject([{ invitation_id: parts.invitationId }])
    expect((await api.listHostInvitations!(owner))[0]?.redeemed_at).toBeUndefined()
  })

  test("redeeming again with the same key and host id resumes the same enrollment", async () => {
    const { api } = setup()
    const created = await invite(api)
    const keys = hostKeyPair()
    const first = await redeem(api, { token: created.token, hostId: "host_build", keys })
    const again = await redeem(api, { token: created.token, hostId: "host_build", keys })
    expect(again).toMatchObject({ resumed: true, enrollment: { enrollment_id: first.enrollment.enrollment_id }, scope: { revision: 1 } })
    expect(await api.listHostEnrollments!(owner)).toHaveLength(1)
  })

  test("redeeming again with a different key, or the right key under another host id, is invitation_redeemed", async () => {
    const { api } = setup()
    const created = await invite(api)
    const keys = hostKeyPair()
    const first = await redeem(api, { token: created.token, hostId: "host_build", keys })
    const differentKey = await failure(redeem(api, { token: created.token, hostId: "host_build", keys: hostKeyPair() }))
    expect(differentKey).toMatchObject({
      code: "invitation_redeemed",
      status: 409,
      details: { redeemed_host_id: "host_build", redeemed_at: expect.any(Number) },
    })
    expect(await failure(redeem(api, { token: created.token, hostId: "host_elsewhere", keys }))).toMatchObject({ code: "invitation_redeemed" })
    expect(await api.listHostEnrollments!(owner)).toMatchObject([{ enrollment_id: first.enrollment.enrollment_id }])
  })

  test("a resumed redeem does not revive a revoked enrollment", async () => {
    const { api } = setup()
    const created = await invite(api)
    const keys = hostKeyPair()
    await redeem(api, { token: created.token, hostId: "host_build", keys })
    await api.revokeHostEnrollment(owner, { hostId: "host_build" })
    expect(await failure(redeem(api, { token: created.token, hostId: "host_build", keys }))).toMatchObject({ code: "invitation_redeemed" })
  })

  test("two concurrent redeems with distinct keys produce exactly one enrollment", async () => {
    const { api } = setup()
    const created = await invite(api)
    const outcomes = await Promise.allSettled([
      redeem(api, { token: created.token, hostId: "host_a", keys: hostKeyPair() }),
      redeem(api, { token: created.token, hostId: "host_b", keys: hostKeyPair() }),
    ])
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toMatchObject([{ reason: { code: "invitation_redeemed" } }])
    expect(await api.listHostEnrollments!(owner)).toHaveLength(1)
  })

  test("revoke and redeem: at most one wins", async () => {
    const { api } = setup()
    const revokedFirst = await invite(api)
    expect(await api.revokeHostInvitation!(owner, { invitationId: revokedFirst.invitationId })).toEqual({ revoked: true })
    expect(await failure(redeem(api, { token: revokedFirst.token, hostId: "host_a", keys: hostKeyPair() }))).toMatchObject({ code: "invitation_revoked", status: 410 })

    const redeemedFirst = await invite(api)
    await redeem(api, { token: redeemedFirst.token, hostId: "host_b", keys: hostKeyPair() })
    expect(await api.revokeHostInvitation!(owner, { invitationId: redeemedFirst.invitationId })).toEqual({ revoked: false })
    expect(await api.listHostEnrollments!(owner)).toMatchObject([{ host_id: "host_b" }])
  })

  test("an expired invitation is refused, and nothing is written", async () => {
    const { api } = setup()
    vi.useFakeTimers()
    vi.setSystemTime(1_726_000_000_000)
    const created = await invite(api, { expiresInMs: 5 * 60_000 })
    vi.setSystemTime(1_726_000_000_000 + 5 * 60_000)
    expect(await failure(redeem(api, { token: created.token, hostId: "host_a", keys: hostKeyPair() }))).toMatchObject({ code: "invitation_expired", status: 410 })
    expect(await api.listHostEnrollments!(owner)).toEqual([])
    expect((await api.listHostInvitations!(owner))[0]?.redeemed_at).toBeUndefined()
  })

  test("an occupied (owner, host_id) pair — live or revoked, any key — is a conflict and writes nothing", async () => {
    const { api } = setup()
    const { keys } = await enrollByAccount(api, { hostId: "host_live" })
    const live = await invite(api)
    expect(await failure(redeem(api, { token: live.token, hostId: "host_live", keys }))).toMatchObject({ code: "invitation_host_conflict", status: 409 })
    expect((await api.listHostInvitations!(owner)).find((row) => row.invitation_id === live.invitationId)!.redeemed_at).toBeUndefined()

    await api.revokeHostEnrollment(owner, { hostId: "host_live" })
    expect(await failure(redeem(api, { token: live.token, hostId: "host_live", keys: hostKeyPair() }))).toMatchObject({ code: "invitation_host_conflict" })
    // A fresh host id on the same invitation still works: the pair, not the machine, is occupied.
    await expect(redeem(api, { token: live.token, hostId: "host_fresh", keys })).resolves.toMatchObject({ resumed: false })
  })

  test("the same key on a different invitation for an occupied pair is a conflict, not a resume", async () => {
    const { api } = setup()
    const keys = hostKeyPair()
    const first = await invite(api)
    await redeem(api, { token: first.token, hostId: "host_build", keys })
    const second = await invite(api)
    expect(await failure(redeem(api, { token: second.token, hostId: "host_build", keys }))).toMatchObject({ code: "invitation_host_conflict" })
    expect(await api.listHostEnrollments!(owner)).toHaveLength(1)
  })
})

describe("scope", () => {
  test("assignment is refused outside the roots and admitted inside them, segment-aware", async () => {
    const { api } = setup()
    const created = await invite(api, { scope: { allowed_roots: ["/srv"], visibility: "owner" } })
    await redeem(api, { token: created.token, hostId: "host_build", keys: hostKeyPair() })
    const assign = (workspaceId: string, remoteDirectory?: string) =>
      api.assignWorkspaceHost(owner, { workspaceId, hostId: "host_build", ...(remoteDirectory !== undefined ? { remoteDirectory } : {}) })

    await expect(assign("ws_in", "/srv/api")).resolves.toMatchObject({ assigned: true })
    await expect(assign("ws_root", "/srv")).resolves.toMatchObject({ assigned: true })
    await expect(assign("ws_dotted", "/srv/./api/../web")).resolves.toMatchObject({ assigned: true })
    for (const outside of ["/srvx", "/etc", "/srv/../etc", "srv/api", undefined]) {
      expect(await failure(assign(`ws_${String(outside)}`, outside))).toMatchObject({ code: "host_assignment_outside_scope", status: 400 })
    }
    expect((await api.listWorkspaces(owner) as Array<{ workspace_id: string }>).map((row) => row.workspace_id).sort())
      .toEqual(["ws_dotted", "ws_in", "ws_root"])

    // An account enrollment carries no scope and admits any directory.
    await enrollByAccount(api, { hostId: "host_account" })
    await expect(api.assignWorkspaceHost(owner, { workspaceId: "ws_free", hostId: "host_account", remoteDirectory: "/anywhere" }))
      .resolves.toMatchObject({ assigned: true })
  })

  test("a re-point of an existing workspace is checked against the roots too", async () => {
    const { api } = setup()
    const created = await invite(api, { scope: { allowed_roots: ["/srv"], visibility: "owner" } })
    await redeem(api, { token: created.token, hostId: "host_build", keys: hostKeyPair() })
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_in", hostId: "host_build", remoteDirectory: "/srv/api" })
    expect(await failure(api.assignWorkspaceHost(owner, { workspaceId: "ws_in", hostId: "host_build", remoteDirectory: "/etc" })))
      .toMatchObject({ code: "host_assignment_outside_scope" })
    expect((await api.openWorkspace(owner, { workspaceId: "ws_in" })).workspace).toMatchObject({ remote_directory: "/srv/api" })
  })

  test("owner visibility withholds only the implicit org-member role; project access is untouched", async () => {
    const { api, db } = setup()
    await api.usersMe(owner)
    await api.usersMe(other)
    const org = await api.createOrg!(owner, { name: "Acme" }) as { org_id: string }
    addOrgMember(db, org.org_id, other.user.tokenIdentifier)
    const orgAuth: SignedControlPlaneAuth = { ...owner, user: { ...owner.user, orgId: org.org_id } }

    const hidden = await invite(api, { auth: orgAuth, scope: { allowed_roots: ["/srv"], visibility: "owner" } })
    await redeem(api, { token: hidden.token, hostId: "host_hidden", keys: hostKeyPair() })
    const shown = await invite(api, { auth: orgAuth, scope: { allowed_roots: ["/srv"], visibility: "org" } })
    await redeem(api, { token: shown.token, hostId: "host_shown", keys: hostKeyPair() })
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_hidden", hostId: "host_hidden", remoteDirectory: "/srv/hidden" })
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_shown", hostId: "host_shown", remoteDirectory: "/srv/shown" })
    expect(db().prepare(`SELECT workspace_id, org_id, org_member_visible FROM workspaces ORDER BY workspace_id`).all()).toEqual([
      { workspace_id: "ws_hidden", org_id: org.org_id, org_member_visible: 0 },
      { workspace_id: "ws_shown", org_id: org.org_id, org_member_visible: 1 },
    ])

    const visible = async (auth: SignedControlPlaneAuth) =>
      (await api.listWorkspaces(auth) as Array<{ workspace_id: string }>).map((row) => row.workspace_id).sort()
    expect(await visible(other)).toEqual(["ws_shown"])
    await expect(api.openWorkspace(other, { workspaceId: "ws_hidden" })).rejects.toThrow()
    await expect(api.openWorkspace(other, { workspaceId: "ws_shown" })).resolves.toMatchObject({ role: "viewer" })
    const project = (await api.openWorkspace(owner, { workspaceId: "ws_hidden" })).workspace as { project_id: string }
    expect(await api.projectRole(other, { projectId: asProjectId(project.project_id) })).toMatchObject({ ok: true, role: "viewer" })

    // A direct member sees it; so does an org admin.
    const target = { kind: "user" as const, userId: other.user.tokenIdentifier }
    await api.grantWorkspaceShare(owner, { workspaceId: "ws_hidden", target, role: "editor" })
    await expect(api.openWorkspace(other, { workspaceId: "ws_hidden" })).resolves.toMatchObject({ role: "editor" })
    await api.revokeWorkspaceShare(owner, { workspaceId: "ws_hidden", target })
    await expect(api.openWorkspace(other, { workspaceId: "ws_hidden" })).rejects.toThrow()
    db().prepare(`UPDATE org_memberships SET role = 'admin' WHERE org_id = ? AND token_identifier = ?`).run(org.org_id, other.user.tokenIdentifier)
    await expect(api.openWorkspace(other, { workspaceId: "ws_hidden" })).resolves.toMatchObject({ role: "admin" })
  })

  test("tightening the roots retires the outside assignment transactionally and re-applies visibility", async () => {
    const { api, db } = setup()
    await api.usersMe(owner)
    await api.usersMe(other)
    const org = await api.createOrg!(owner, { name: "Acme" }) as { org_id: string }
    addOrgMember(db, org.org_id, other.user.tokenIdentifier)
    const orgAuth: SignedControlPlaneAuth = { ...owner, user: { ...owner.user, orgId: org.org_id } }
    const created = await invite(api, { auth: orgAuth, scope: { allowed_roots: ["/srv"], visibility: "org" } })
    const keys = hostKeyPair()
    const { enrollment } = await redeem(api, { token: created.token, hostId: "host_build", keys })
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_kept", hostId: "host_build", remoteDirectory: "/srv/api" })
    await api.assignWorkspaceHost(owner, { workspaceId: "ws_gone", hostId: "host_build", remoteDirectory: "/srv/web" })
    await machineBeat(api, keys, {
      enrollmentId: enrollment.enrollment_id,
      hostId: "host_build",
      generation: 0,
      acks: [{ workspaceId: "ws_kept", revision: 1 }, { workspaceId: "ws_gone", revision: 1 }],
    })
    expect(await online(api)).toEqual({ ws_gone: true, ws_kept: true })

    expect(await failure(api.updateHostEnrollmentScope!(other, { enrollmentId: enrollment.enrollment_id, scope: { allowed_roots: ["/"], visibility: "org" } })))
      .toMatchObject({ code: "host_enrollment_not_found", status: 404 })
    const updated = await api.updateHostEnrollmentScope!(owner, {
      enrollmentId: enrollment.enrollment_id,
      scope: { allowed_roots: ["/srv/api"], visibility: "owner" },
    })
    expect(updated).toEqual({ scope: { allowed_roots: ["/srv/api"], visibility: "owner", revision: 2 }, retired_workspace_ids: ["ws_gone"] })
    expect(await online(api)).toEqual({ ws_kept: true })
    expect(await api.listWorkspaces(other)).toEqual([])
    expect(db().prepare(`SELECT workspace_id FROM host_assignment_readiness ORDER BY workspace_id`).all()).toEqual([{ workspace_id: "ws_kept" }])
    expect(db().prepare(`SELECT workspace_id, deleted_at IS NOT NULL AS retired, org_member_visible FROM workspaces ORDER BY workspace_id`).all()).toEqual([
      { workspace_id: "ws_gone", retired: 1, org_member_visible: 1 },
      { workspace_id: "ws_kept", retired: 0, org_member_visible: 0 },
    ])
    expect(db().prepare(`SELECT metadata FROM audit_events WHERE action = 'host_enrollment.scope_updated'`).get())
      .toEqual({ metadata: JSON.stringify({ enrollment_id: enrollment.enrollment_id, scope_revision: 2, retired_workspace_ids: ["ws_gone"] }) })

    const beat = await machineBeat(api, keys, { enrollmentId: enrollment.enrollment_id, hostId: "host_build", generation: 0, acks: [{ workspaceId: "ws_kept", revision: 1 }] })
    expect(beat.assignments.map((assignment) => assignment.workspace_id)).toEqual(["ws_kept"])
    expect(beat.scope).toEqual({ allowed_roots: ["/srv/api"], visibility: "owner", revision: 2 })
    expect(await failure(api.assignWorkspaceHost(owner, { workspaceId: "ws_gone", hostId: "host_build", remoteDirectory: "/srv/web" })))
      .toMatchObject({ code: "host_assignment_outside_scope" })
  })

  test("an invited machine cannot be assigned a workspace of another org", async () => {
    const { api } = setup()
    await api.usersMe(owner)
    const org = await api.createOrg!(owner, { name: "Acme" }) as { org_id: string }
    const orgAuth: SignedControlPlaneAuth = { ...owner, user: { ...owner.user, orgId: org.org_id } }
    const created = await invite(api, { auth: orgAuth })
    await redeem(api, { token: created.token, hostId: "host_build", keys: hostKeyPair() })
    await api.registerLocalForSharing(owner, { workspaceId: "ws_personal", displayName: "Personal", remoteDirectory: "/srv/p" })
    expect(await failure(api.assignWorkspaceHost(owner, { workspaceId: "ws_personal", hostId: "host_build" })))
      .toMatchObject({ code: "host_assignment_outside_scope" })
    await expect(api.assignWorkspaceHost(owner, { workspaceId: "ws_acme", hostId: "host_build", remoteDirectory: "/srv/a" }))
      .resolves.toMatchObject({ assigned: true })
    expect((await api.openWorkspace(owner, { workspaceId: "ws_acme" })).workspace).toMatchObject({ org_id: org.org_id })
  })

  test("listHostEnrollments omits revoked machines and carries the key fingerprint", async () => {
    const { api } = setup()
    const { keys, enrollment } = await enrollByAccount(api, { hostId: "host_a", displayName: "A" })
    await enrollByAccount(api, { hostId: "host_b" })
    await api.revokeHostEnrollment(owner, { hostId: "host_b" })
    expect(await api.listHostEnrollments!(owner)).toEqual([{
      enrollment_id: enrollment.enrollment_id,
      display_name: "A",
      host_id: "host_a",
      public_key_fingerprint: await publicKeyFingerprint(JSON.parse(keys.publicKey)),
      key_version: 1,
      enrolled_via: "account",
      last_seen_at: enrollment.last_seen_at,
      expires_at: enrollment.expires_at,
      serving_generation: 0,
      acked: [],
      scope: undefined,
    }])
    expect(await api.listHostEnrollments!(other)).toEqual([])
  })
})
