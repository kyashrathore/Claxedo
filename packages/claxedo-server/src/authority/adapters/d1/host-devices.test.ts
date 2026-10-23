import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity, ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import type { MachinePrincipal } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { MINIMUM_CONNECT_CLI_VERSION, pairingRedeemPayload, publicKeyFingerprint } from "@claxedo/account-contract/machine"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { D1ApplicationIdentityAuthority } from "./application-identity"
import { recordD1HostMachineReport } from "./host-devices"
import { D1HostAccessAuthority } from "./host-access-authority"
import { D1HostPairingAuthority } from "./host-pairing-authority"
import { D1WorkspaceAuthority } from "./workspace-authority"
import { hostedRemoteAccessService } from "../../../deployments/hosted-shared/hosted-remote-access-service"
import { applyControlPlaneBaseline } from "../../../test-support/control-plane-migrations"
import { WORKERS_COMPATIBILITY_DATE } from "../../../../scripts/deploy/hosted-worker-bundle"

const active: Miniflare[] = []
afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

const ORIGIN = "https://app.claxedo.test"
const FOLDER = "/home/ubuntu/code/app"

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

async function setup() {
  const instance = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", compatibilityDate: WORKERS_COMPATIBILITY_DATE, d1Databases: ["CONTROL_PLANE_DB"] })
  active.push(instance)
  const database = await instance.getD1Database("CONTROL_PLANE_DB")
  await applyControlPlaneBaseline(database)
  let clock = 1_800_000_000_000
  let sequence = 0
  const now = () => clock
  const randomId = (prefix: string) => `${prefix}_${String(++sequence).padStart(4, "0")}`
  const workspace = new D1WorkspaceAuthority(database, { deploymentId: "deployment-a", product: { kind: "claxedo-hosted" }, now, randomId })
  const shared = { deploymentId: "deployment-a", now, randomId }
  const hostAccess = new D1HostAccessAuthority(database, {
    ...shared,
    localWorkspaceRegistration: (auth, input) => workspace.localWorkspaceRegistration(auth, input),
    authorizeLocalWorkspaceRegistration: (auth, args) => workspace.authorizeLocalWorkspaceRegistration(auth, args),
  })
  const pairings = new D1HostPairingAuthority(database, { ...shared, newCode: () => "K7QM4PXD9R2TWB6HJ3NF", resolveOrgId: (auth) => workspace.resolveOrgId(auth) })
  const alice = await signed(workspace, "alice", "org_acme")
  await workspace.createHostedOrganization(alice, { name: "Acme", orgId: "org_acme" })
  const machine = async (enrollmentId: string): Promise<MachinePrincipal> => {
    const row = await hostAccess.machineAuth.lookupEnrollment(enrollmentId)
    if (!row) throw new Error(`no enrollment ${enrollmentId}`)
    return { enrollmentId, hostId: row.host_id, ownerUserId: row.owner_user_id, ownerActorId: row.owner_actor_id, scope: row.scope, keyVersion: row.key_version, generation: row.serving_generation }
  }
  const report = async (enrollmentId: string, input: Parameters<typeof recordD1HostMachineReport>[2]) =>
    await recordD1HostMachineReport(database, await machine(enrollmentId), input, clock)
  return { database, workspace, hostAccess, pairings, alice, machine, report, now, advance: (ms: number) => { clock += ms } }
}

type Input = Awaited<ReturnType<typeof setup>>

async function pairedMachine(input: Input, hostId: string) {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey)
  const fingerprint = await publicKeyFingerprint(jwk)
  const minted = await input.pairings.createHostPairing(input.alice)
  const payload = pairingRedeemPayload({ codeSha256: await sha256Hex(minted.code), hostId, publicKeySha256: fingerprint })
  const signature = Buffer.from(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(payload)))).toString("base64url")
  const redeemed = await input.pairings.redeemHostPairing({
    code: minted.code, hostId, publicKey: JSON.stringify(jwk), signature,
    machine: { hostname: "build-box", os: "Ubuntu 24.04", arch: "x64", cli_version: "0.2.1", folder: FOLDER, home: "/home/ubuntu" },
  })
  return { enrollmentId: redeemed.enrollment.enrollment_id, pairingId: minted.pairingId }
}

async function approved(input: Input, hostId: string) {
  const paired = await pairedMachine(input, hostId)
  const answer = await input.pairings.approveHostPairing(input.alice, { pairingId: paired.pairingId, displayName: "Build box" })
  await input.hostAccess.assignWorkspaceHost(input.alice, { workspaceId: "ws_app", hostId, displayName: "app", repoName: "app", remoteDirectory: answer.folder })
  await input.pairings.recordHostPairingWorkspace(input.alice, { pairingId: paired.pairingId, workspaceId: "ws_app" })
  return paired.enrollmentId
}

const listed = async (input: Input) => (await input.hostAccess.listHostDevices(input.alice))[0]

describe("what a machine reports about itself", () => {
  test("a held machine reports why its service did not start, and its owner sees it offline with that cause once approved", async () => {
    const input = await setup()
    const { enrollmentId, pairingId } = await pairedMachine(input, "host_held")
    const fix = "sudo loginctl enable-linger ubuntu && claxedo connect --install-service"
    expect(await input.report(enrollmentId, { cliVersion: "0.2.1", os: "Ubuntu 24.04", arch: "x64", blocked: { reason: "linger_off", fix } })).toEqual({ recorded: true })
    await input.pairings.approveHostPairing(input.alice, { pairingId })
    expect(await listed(input)).toMatchObject({
      state: "offline", cli_version: "0.2.1", os: "Ubuntu 24.04", arch: "x64",
      blocked: { reason: "linger_off", fix, reported_at: input.now() },
      roots: [{ path: FOLDER, retires: [] }],
    })
  })

  test("acquiring a serving generation clears the reason, and the serving instance's report records its version under that generation only", async () => {
    const input = await setup()
    const enrollmentId = await approved(input, "host_serving")
    await input.report(enrollmentId, { cliVersion: "0.2.1", blocked: { reason: "desktop_daemon", fix: "claxedo connect --install-service --alongside-desktop" } })
    expect((await listed(input))?.blocked?.reason).toBe("desktop_daemon")
    const { generation } = await input.hostAccess.acquireHostServingGeneration(await input.machine(enrollmentId))
    expect((await listed(input))?.blocked, "the next acquisition clears it").toBeUndefined()
    await input.hostAccess.heartbeatHostEnrollmentByMachine(await input.machine(enrollmentId), { enrollmentId, hostId: "host_serving", generation, acks: [] })

    expect(await input.report(enrollmentId, { cliVersion: "0.2.3", os: "Ubuntu 24.04", arch: "arm64", generation })).toEqual({ recorded: true })
    expect(await listed(input)).toMatchObject({ cli_version: "0.2.3", arch: "arm64" })
    expect(await input.report(enrollmentId, { cliVersion: "0.1.0", generation: generation - 1 }), "a superseded instance").toEqual({ recorded: false })
    expect(await input.report(enrollmentId, { cliVersion: "0.1.0", blocked: { reason: "desktop_daemon", fix: "claxedo connect --alongside-desktop" } }), "a second process beside a live one").toEqual({ recorded: false })
    expect(await listed(input)).toMatchObject({ cli_version: "0.2.3" })
    expect((await listed(input))?.blocked).toBeUndefined()
  })

  test("a reported stop ends the lease, so the machine reads offline at once with the stop as its cause", async () => {
    const input = await setup()
    const enrollmentId = await approved(input, "host_stopped")
    const { generation } = await input.hostAccess.acquireHostServingGeneration(await input.machine(enrollmentId))
    await input.hostAccess.heartbeatHostEnrollmentByMachine(await input.machine(enrollmentId), { enrollmentId, hostId: "host_stopped", generation, acks: [] })
    expect((await listed(input))?.state).toBe("online")
    input.advance(1_000)
    await input.report(enrollmentId, { cliVersion: "0.2.2", generation, blocked: { reason: "stopped", fix: "claxedo connect --install-service" } })
    expect(await listed(input)).toMatchObject({ state: "offline", blocked: { reason: "stopped", fix: "claxedo connect --install-service" } })
    input.advance(1_000)
    await input.report(enrollmentId, { cliVersion: "0.2.2", blocked: { reason: "desktop_daemon", fix: "claxedo connect --install-service --alongside-desktop" } })
    expect((await listed(input))?.blocked?.reason, "the instance that starts next is heard once the lease ended").toBe("desktop_daemon")
  })

  test("a removed machine reports nothing", async () => {
    const input = await setup()
    const enrollmentId = await approved(input, "host_removed")
    const principal = await input.machine(enrollmentId)
    await input.hostAccess.revokeHostEnrollment(input.alice, { hostId: "host_removed" })
    expect(await recordD1HostMachineReport(input.database, principal, { cliVersion: "0.2.2", blocked: { reason: "stopped", fix: "claxedo connect" } }, input.now())).toEqual({ recorded: false })
  })
})

describe("the owner's devices list", () => {
  test("each root names the assignments that removing it alone would retire", async () => {
    const input = await setup()
    const enrollmentId = await approved(input, "host_roots")
    await input.hostAccess.updateHostEnrollmentScope(input.alice, { enrollmentId, scope: { allowed_roots: [FOLDER, "/home/ubuntu/code", "/srv"] } })
    await input.hostAccess.assignWorkspaceHost(input.alice, { workspaceId: "ws_data", hostId: "host_roots", displayName: "data", repoName: "data", remoteDirectory: "/srv/data" })
    const device = await listed(input)
    expect(device?.roots).toEqual([
      { path: FOLDER, retires: [] },
      { path: "/home/ubuntu/code", retires: [] },
      { path: "/srv", retires: [{ workspace_id: "ws_data", display_name: "data", directory: "/srv/data" }] },
    ])
    const narrowed = await input.hostAccess.updateHostEnrollmentScope(input.alice, { enrollmentId, scope: { allowed_roots: [FOLDER, "/home/ubuntu/code"] } })
    expect(narrowed.retired_workspace_ids, "the update retires what the list said it would").toEqual(["ws_data"])
    await input.hostAccess.updateHostEnrollmentScope(input.alice, { enrollmentId, scope: { allowed_roots: [FOLDER] } })
    expect((await listed(input))?.roots).toEqual([{ path: FOLDER, retires: [{ workspace_id: "ws_app", display_name: "app", directory: FOLDER }] }])
  })

  test("the plane offers the update command for the machine's system while its CLI is below the accepted version, and nothing once it is not", async () => {
    const input = await setup()
    const enrollmentId = await approved(input, "host_update")
    const service = hostedRemoteAccessService(input.hostAccess as never, { controlPlaneOrigin: ORIGIN })
    const [device] = await service.devices(input.alice)
    expect(device).toMatchObject({
      displayName: "Build box", cliVersion: "0.2.1", os: "Ubuntu 24.04",
      update: { version: MINIMUM_CONNECT_CLI_VERSION, command: `curl -fsSL ${ORIGIN}/api/claxedo/connect | sh && claxedo connect --install-service` },
    })
    await input.report(enrollmentId, { cliVersion: "0.2.1", os: "Windows Server 2025 Datacenter" })
    expect((await service.devices(input.alice))[0]?.update?.command).toBe(`& ([scriptblock]::Create((irm ${ORIGIN}/api/claxedo/connect.ps1))); claxedo connect --install-service`)
    await input.report(enrollmentId, { cliVersion: MINIMUM_CONNECT_CLI_VERSION })
    expect((await service.devices(input.alice))[0]?.update).toBeUndefined()
  })
})
