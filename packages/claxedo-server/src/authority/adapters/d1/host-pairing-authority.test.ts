import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import type { MachinePrincipal } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { PAIRING_TTL_MS, invitationRedeemPayload, pairingRedeemPayload, publicKeyFingerprint } from "@claxedo/account-contract/machine"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { D1ApplicationIdentityAuthority } from "./application-identity"
import { D1HostAccessAuthority } from "./host-access-authority"
import { D1HostInvitationAuthority } from "./host-invitation-authority"
import { D1HostPairingAuthority } from "./host-pairing-authority"
import { D1WorkspaceAuthority } from "./workspace-authority"
import { applyControlPlaneBaseline } from "../../../test-support/control-plane-migrations"
import { WORKERS_COMPATIBILITY_DATE } from "../../../../scripts/deploy/hosted-worker-bundle"

const active: Miniflare[] = []
afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

const CODES = ["K7QM4PXD9R2TWB6HJ3NF", "A1B2C3D4E5F6G7H8J9K0", "Z9Y8X7W6V5T4S3R2Q1P0"]

async function setup() {
  const instance = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", compatibilityDate: WORKERS_COMPATIBILITY_DATE, d1Databases: ["CONTROL_PLANE_DB"] })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  await applyControlPlaneBaseline(database)
  let clock = 1_800_000_000_000
  let sequence = 0
  const codes = [...CODES]
  const now = () => clock
  const randomId = (prefix: string) => `${prefix}_${String(++sequence).padStart(4, "0")}`
  const workspace = new D1WorkspaceAuthority(database, { deploymentId: "deployment-a", product: { kind: "claxedo-hosted" }, now, randomId })
  const shared = { deploymentId: "deployment-a", now, randomId }
  const hostAccess = new D1HostAccessAuthority(database, {
    ...shared,
    localWorkspaceRegistration: (auth, input) => workspace.localWorkspaceRegistration(auth, input),
    authorizeLocalWorkspaceRegistration: (auth, args) => workspace.authorizeLocalWorkspaceRegistration(auth, args),
  })
  const pairings = new D1HostPairingAuthority(database, { ...shared, newCode: () => codes.shift() ?? "", resolveOrgId: (auth) => workspace.resolveOrgId(auth) })
  const invitations = new D1HostInvitationAuthority(database, { ...shared, resolveOrgId: (auth) => workspace.resolveOrgId(auth) })
  const alice = await signed(workspace, "alice", "org_acme")
  const bob = await signed(workspace, "bob", "org_bob")
  await workspace.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
  await workspace.createHostedOrganization(bob, { name: "Bobco", orgId: "org_bob" })
  return { database, workspace, hostAccess, pairings, invitations, alice, bob, advance: (ms: number) => { clock += ms } }
}

type Input = Awaited<ReturnType<typeof setup>>

async function signed(authority: D1WorkspaceAuthority, subject: string, orgId: string): Promise<SignedControlPlaneAuth> {
  const identity: AuthIdentity = { adapter: "better-auth", issuer: "https://auth.example.test", subject }
  const result = await new D1ApplicationIdentityAuthority(authority.accessContext(), { kind: "claxedo-hosted" }).ensureApplicationIdentity(identity)
  if (result.state !== "active") throw new Error(`identity did not become active: ${result.state}`)
  const principal: ControlPlanePrincipal = {
    userId: result.userId, actorId: result.actorId, actorKind: "human", deploymentId: "deployment-a", sessionId: `auth:${subject}`,
    authenticatedAt: 1_800_000_000_000, methods: ["oauth:github"], assurance: "single-factor",
    client: { kind: "browser", tokenKind: "browser-session", id: "browser", resource: "https://api.example.test", scopes: ["openid"], origin: "https://app.example.test" },
    identity,
  }
  return { mode: "signed", principal, user: { subject, tokenIdentifier: `${identity.issuer}|${subject}`, issuer: identity.issuer, orgId } }
}

async function hostKey() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey)
  return {
    publicKey: JSON.stringify(jwk),
    fingerprint: await publicKeyFingerprint(jwk),
    async sign(payload: string) {
      const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(payload))
      return Buffer.from(new Uint8Array(signature)).toString("base64url")
    },
  }
}

async function redeem(input: Input, code: string, hostId: string, folder = "/home/ubuntu/code/app") {
  const key = await hostKey()
  const codeSha256 = await sha256Hex(code)
  const result = await input.pairings.redeemHostPairing({
    code, hostId, publicKey: key.publicKey,
    signature: await key.sign(pairingRedeemPayload({ codeSha256, hostId, publicKeySha256: key.fingerprint })),
    machine: { hostname: "build-box", os: "Ubuntu 24.04", arch: "x64", cli_version: "0.2.2", folder, home: "/home/ubuntu" },
    country: "IN",
  })
  return { key, result }
}

async function machineOf(input: Input, enrollmentId: string): Promise<MachinePrincipal> {
  const row = await input.hostAccess.machineAuth.lookupEnrollment(enrollmentId)
  if (!row) throw new Error(`no enrollment ${enrollmentId}`)
  return { enrollmentId, hostId: row.host_id, ownerUserId: row.owner_user_id, ownerActorId: row.owner_actor_id, scope: row.scope, keyVersion: row.key_version, generation: row.serving_generation }
}

async function approve(input: Input, pairingId: string, displayName?: string) {
  const approved = await input.pairings.approveHostPairing(input.alice, { pairingId, ...(displayName ? { displayName } : {}) })
  const workspaceId = approved.workspaceId ?? `ws_${pairingId}`
  await input.hostAccess.assignWorkspaceHost(input.alice, { workspaceId, hostId: approved.hostId, displayName: "app", repoName: "app", remoteDirectory: approved.folder })
  return await input.pairings.recordHostPairingWorkspace(input.alice, { pairingId, workspaceId })
}

describe("machine pairing", () => {
  test("a code moves from waiting through installing to a machine held for approval, and approval names it, shares its folder and assigns it", async () => {
    const input = await setup()
    const minted = await input.pairings.createHostPairing(input.alice)
    expect(minted).toMatchObject({ code: CODES[0], expiresAt: 1_800_000_000_000 + PAIRING_TTL_MS })
    expect((await input.pairings.hostPairing(input.alice, minted)).stage).toBe("waiting")

    await input.pairings.recordHostPairingProgress({ code: minted.code.toLowerCase(), hostname: "build-box", os: "Linux" })
    expect(await input.pairings.hostPairing(input.alice, minted)).toMatchObject({ stage: "installing", progress: { stage: "installing", hostname: "build-box", os: "Linux" } })

    const { result } = await redeem(input, minted.code, "host_build")
    expect(result).toMatchObject({ resumed: false, pairing_id: minted.pairingId, org_id: "org_acme", scope: { allowed_roots: [] } })
    const enrollmentId = result.enrollment.enrollment_id
    expect(await input.hostAccess.machineAuth.lookupEnrollment(enrollmentId)).toMatchObject({ approval_requested_at: expect.any(Number), revoked_reason: null })
    const waiting = await input.pairings.hostPairing(input.alice, minted)
    expect(waiting).toMatchObject({
      stage: "awaiting_approval", request: "machine", enrollment_id: enrollmentId, host_id: "host_build",
      machine: { hostname: "build-box", os: "Ubuntu 24.04", arch: "x64", cli_version: "0.2.2", folder: "/home/ubuntu/code/app", folder_kind: "folder", country: "IN" },
    })
    expect((await input.pairings.listHostPairingRequests(input.alice)).map((request) => request.pairing_id)).toEqual([minted.pairingId])
    expect(await input.hostAccess.listHostDevices(input.alice), "a waiting machine is a request, not a machine").toEqual([])
    expect(await input.pairings.hostPairingSelf(await machineOf(input, enrollmentId))).toMatchObject({ stage: "awaiting_approval", folder: "/home/ubuntu/code/app" })

    const approved = await approve(input, minted.pairingId, "Build box")
    expect(approved).toMatchObject({ stage: "approved", display_name: "Build box", workspace_id: `ws_${minted.pairingId}` })
    expect(await input.hostAccess.machineAuth.lookupEnrollment(enrollmentId)).toMatchObject({ approval_requested_at: null, scope: { allowed_roots: ["/home/ubuntu/code/app"], revision: 2 } })
    expect((await input.hostAccess.listHostDevices(input.alice)).map((device) => device.host_id)).toEqual(["host_build"])
    expect(await input.pairings.listHostPairingRequests(input.alice)).toEqual([])
    await expect(input.pairings.approveHostPairing(input.alice, { pairingId: minted.pairingId }), "answered once").rejects.toMatchObject({ code: "pairing_decided" })
  })

  test("a denied machine is revoked with its reason, and the code is spent", async () => {
    const input = await setup()
    const minted = await input.pairings.createHostPairing(input.alice)
    const { result } = await redeem(input, minted.code, "host_denied")
    await input.pairings.denyHostPairing(input.alice, minted)
    expect(await input.hostAccess.machineAuth.lookupEnrollment(result.enrollment.enrollment_id)).toMatchObject({ revoked_at: expect.any(Number), revoked_reason: "denied" })
    expect((await input.pairings.hostPairing(input.alice, minted)).stage).toBe("denied")
    await expect(redeem(input, minted.code, "host_other")).rejects.toMatchObject({ code: "pairing_used" })
  })

  test("each code a machine cannot redeem is refused with its own reason", async () => {
    const input = await setup()
    await expect(input.pairings.recordHostPairingProgress({ code: "not-a-code", hostname: "h", os: "Linux" })).rejects.toMatchObject({ code: "pairing_invalid" })
    await expect(redeem(input, "ZZZZZZZZZZZZZZZZZZZZ", "host_a")).rejects.toMatchObject({ code: "pairing_invalid" })

    const used = await input.pairings.createHostPairing(input.alice)
    const first = await redeem(input, used.code, "host_a")
    await expect(redeem(input, used.code, "host_b"), "another machine").rejects.toMatchObject({ code: "pairing_used" })
    await expect(input.pairings.recordHostPairingProgress({ code: used.code, hostname: "h", os: "Linux" })).rejects.toMatchObject({ code: "pairing_used" })
    const again = await input.pairings.redeemHostPairing({
      code: used.code, hostId: "host_a", publicKey: first.key.publicKey,
      signature: await first.key.sign(pairingRedeemPayload({ codeSha256: await sha256Hex(used.code), hostId: "host_a", publicKeySha256: first.key.fingerprint })),
      machine: { hostname: "build-box", os: "Ubuntu 24.04", arch: "x64", cli_version: "0.2.2", folder: "/srv" },
    })
    expect(again, "the same machine retrying its redeem").toMatchObject({ resumed: true, enrollment: { enrollment_id: first.result.enrollment.enrollment_id } })

    const cancelled = await input.pairings.createHostPairing(input.alice)
    expect(await input.pairings.cancelHostPairings(input.alice)).toEqual({ cancelled: 1 })
    await expect(redeem(input, cancelled.code, "host_c")).rejects.toMatchObject({ code: "pairing_owner_signed_out" })

    const expired = await input.pairings.createHostPairing(input.alice)
    input.advance(PAIRING_TTL_MS)
    await expect(redeem(input, expired.code, "host_d")).rejects.toMatchObject({ code: "pairing_expired" })
    expect((await input.pairings.hostPairing(input.alice, expired)).stage).toBe("expired")
  })

  test("a machine no one answers within the wait expires, and its approval is refused", async () => {
    const input = await setup()
    const minted = await input.pairings.createHostPairing(input.alice)
    const { result } = await redeem(input, minted.code, "host_late")
    input.advance(PAIRING_TTL_MS)
    expect((await input.pairings.hostPairing(input.alice, minted)).stage).toBe("expired")
    expect(await input.pairings.listHostPairingRequests(input.alice)).toEqual([])
    await expect(input.pairings.approveHostPairing(input.alice, minted)).rejects.toMatchObject({ code: "pairing_expired" })
    expect(await input.hostAccess.machineAuth.lookupEnrollment(result.enrollment.enrollment_id)).toMatchObject({ approval_requested_at: expect.any(Number) })
  })

  test("only the person who minted a code sees or answers it", async () => {
    const input = await setup()
    const minted = await input.pairings.createHostPairing(input.alice)
    await redeem(input, minted.code, "host_private")
    await expect(input.pairings.hostPairing(input.bob, minted)).rejects.toMatchObject({ code: "pairing_invalid" })
    await expect(input.pairings.approveHostPairing(input.bob, minted)).rejects.toMatchObject({ code: "pairing_invalid" })
    await expect(input.pairings.denyHostPairing(input.bob, minted)).rejects.toMatchObject({ code: "pairing_invalid" })
    expect(await input.pairings.listHostPairingRequests(input.bob)).toEqual([])
  })

  test("a connected machine's code asks to share another folder, and approving it adds a root without enrolling again", async () => {
    const input = await setup()
    const first = await input.pairings.createHostPairing(input.alice)
    const { result } = await redeem(input, first.code, "host_two")
    await approve(input, first.pairingId)
    const machine = await machineOf(input, result.enrollment.enrollment_id)

    const second = await input.pairings.createHostPairing(input.alice)
    const asked = await input.pairings.requestHostPairingFolder(machine, { code: second.code, folder: "/home/ubuntu", home: "/home/ubuntu" })
    expect(asked).toMatchObject({ pairing_id: second.pairingId, stage: "awaiting_approval", folder: "/home/ubuntu" })
    expect(await input.pairings.hostPairing(input.alice, second)).toMatchObject({ request: "folder", machine: { folder_kind: "home" }, enrollment_id: machine.enrollmentId })
    await approve(input, second.pairingId)
    expect(await input.hostAccess.machineAuth.lookupEnrollment(machine.enrollmentId)).toMatchObject({ scope: { allowed_roots: ["/home/ubuntu/code/app", "/home/ubuntu"] } })

    const third = await input.pairings.createHostPairing(input.alice)
    await input.pairings.requestHostPairingFolder(machine, { code: third.code, folder: "/srv/data" })
    await input.pairings.denyHostPairing(input.alice, third)
    expect(await input.hostAccess.machineAuth.lookupEnrollment(machine.enrollmentId), "a denied folder leaves the machine as it was").toMatchObject({ revoked_at: null, scope: { allowed_roots: ["/home/ubuntu/code/app", "/home/ubuntu"] } })

    const strangers = await input.pairings.createHostPairing(input.bob)
    await expect(input.pairings.requestHostPairingFolder(machine, { code: strangers.code, folder: "/srv" }), "another person's code").rejects.toMatchObject({ code: "pairing_invalid" })
  })

  test("the invitation redeem never spends a pairing code, so approval cannot be skipped", async () => {
    const input = await setup()
    const minted = await input.pairings.createHostPairing(input.alice)
    const key = await hostKey()
    await expect(input.invitations.redeemHostInvitation({
      invitationId: minted.pairingId, secret: minted.code, hostId: "host_skip", publicKey: key.publicKey,
      signature: await key.sign(invitationRedeemPayload({ invitationId: minted.pairingId, hostId: "host_skip", publicKeySha256: key.fingerprint })),
    })).rejects.toMatchObject({ code: "invitation_invalid" })
  })

  test("a machine's owner is told of it in each organization they belong to, and in none they left", async () => {
    const input = await setup()
    const alice = input.alice.principal?.userId ?? ""
    const personal = await input.database.prepare(`select org_id from orgs where owner_user_id = ? and kind = 'personal'`).bind(alice).first<{ org_id: string }>()
    expect(await input.workspace.machineOwnerOrgIds(alice), "her personal organization and Acme").toEqual([personal?.org_id ?? "", "org_acme"].toSorted((a, b) => a.localeCompare(b)))
    await input.database.prepare(`update org_memberships set revoked_at = 1 where user_id = ?`).bind(alice).run()
    expect(await input.workspace.machineOwnerOrgIds(alice)).toEqual([])
  })
})
