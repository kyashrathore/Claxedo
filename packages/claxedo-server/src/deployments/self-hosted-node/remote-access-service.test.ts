import { machineDisplayName } from "@claxedo/helpers/machine-name"
import { generateKeyPairSync } from "node:crypto"
import { describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import {
  createSqliteWorkspaceAuthority,
  SqliteHostConnectError,
} from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import {
  invitationRedeemPayload,
  invitationTokenParts,
  publicKeyFingerprint,
} from "@claxedo/server-core/platform/auth/host-connect-contract"
import { hostEnrollmentPayload, signHostPayload, type LocalHostIdentity } from "../../workspace/local-host"
import { createRemoteAccessService } from "./remote-access-service"

/**
 * Machine-wide remote access against the real SQLite authority.
 *
 * Every route to "routable" here crosses the production contract: the service
 * signs the real enroll-v1 literal with a real P-256 key, then beats as the
 * machine, and the authority decides from its own rows what is assigned,
 * acked at the current revision, and leased. A service that skipped the beat,
 * acked a revision the owner has moved past, or kept beating from a
 * superseded instance fails these tests — there is no mock of the
 * assign→beat→routable sequence to hide behind.
 */

const auth: SignedControlPlaneAuth = {
  mode: "signed",
  token: "tok_user_1",
  user: {
    subject: "user_1",
    tokenIdentifier: "https://idp.example.test|user_1",
    issuer: "https://idp.example.test",
  },
} as SignedControlPlaneAuth

function machineIdentity(hostId = "host_machine"): LocalHostIdentity {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  return {
    hostId,
    publicKey: JSON.stringify(pair.publicKey.export({ format: "jwk" })),
    privateKey: pair.privateKey.export({ format: "jwk" }),
  }
}

type Local = { id: string; kind: "local" | "cloud"; directory: string; displayName: string }

type Authority = ReturnType<typeof createSqliteWorkspaceAuthority>

/**
 * The real authority with its machine beat counted, and refusable on demand.
 * Counting is how a loop that is still running is told from one that stopped
 * while both are failing; the refusal covers the two decisive codes that
 * arise in this process only as a race between the principal lookup and the
 * guarded write, which no test can schedule against the adapter.
 */
function observedBeats(authority: Authority) {
  const refuse: { error?: unknown } = {}
  const heartbeatHostEnrollmentByMachine = vi.fn(
    async (...args: Parameters<NonNullable<Authority["heartbeatHostEnrollmentByMachine"]>>) => {
      if (refuse.error) throw refuse.error
      return await authority.heartbeatHostEnrollmentByMachine!(...args)
    },
  )
  return {
    observed: { ...authority, heartbeatHostEnrollmentByMachine } as Authority,
    beats: heartbeatHostEnrollmentByMachine,
    refuse,
  }
}

async function enrollKeyUnderHostId(authority: Authority, identity: LocalHostIdentity) {
  const request = await authority.createHostEnrollmentRequest(auth, { hostId: identity.hostId })
  await authority.enrollHost(auth, {
    hostId: identity.hostId,
    publicKey: identity.publicKey,
    requestId: request.request_id,
    signature: signHostPayload(identity, hostEnrollmentPayload({
      hostId: identity.hostId,
      requestId: request.request_id,
      nonce: request.nonce,
    })),
  })
}

function setup(input: {
  localWorkspaces?: Local[]
  sessionAuthority?: "local" | "managed-private"
  /** Shared so a second service can contend for one machine's enrollment. */
  authority?: ReturnType<typeof createSqliteWorkspaceAuthority>
  identity?: LocalHostIdentity
  heartbeatIntervalMs?: number
} = {}) {
  const authority = input.authority ?? createSqliteWorkspaceAuthority({ path: ":memory:" })
  const identity = input.identity ?? machineIdentity()
  const localWorkspaces: Local[] = input.localWorkspaces ?? [
    { id: "ws_1", kind: "local", directory: "/repo/one", displayName: "one" },
    { id: "ws_2", kind: "local", directory: "/repo/two", displayName: "two" },
  ]
  let workspaceChanged: (() => Promise<void>) | undefined
  const startMachineTunnel = vi.fn(async ({ workspaceIds }: {
    workspaceIds: string[]
    hostTunnelTokenProvider: () => Promise<string>
  }) => ({
    connectionCount: 1,
    workspaceIds,
  }))
  const stopMachineTunnel = vi.fn(() => true)
  const machineTunnelActive = vi.fn(() => true)
  const signSpy = vi.fn(signHostPayload)
  const service = createRemoteAccessService({
    authority: authority as never,
    relayUrl: "https://relay.test",
    hostTunnelTokenSigner: vi.fn(async () => ({ hostTunnelToken: "htt_1", tokenExpiresAt: 456_000, jti: "jti_1" })),
    listLocalWorkspaces: async () => localWorkspaces,
    subscribeLocalWorkspaces: (listener) => {
      workspaceChanged = listener
      return () => { workspaceChanged = undefined }
    },
    localHostIdentity: async () => identity,
    signHostPayload: signSpy,
    // The composition this host serves. In production it is read from the
    // embedded runtimes the same process configured; here the test names it so
    // both flavours can be driven.
    sessionAuthority: () => input.sessionAuthority ?? "local",
    startMachineTunnel,
    stopMachineTunnel,
    machineTunnelActive,
    // Beats are driven explicitly through enable/assign unless a test asks
    // for the loop; a large interval keeps the background one out of the way.
    heartbeatIntervalMs: input.heartbeatIntervalMs ?? 3_600_000,
    capture: vi.fn(),
  })
  return {
    authority,
    identity,
    service,
    localWorkspaces,
    startMachineTunnel,
    stopMachineTunnel,
    machineTunnelActive,
    signSpy,
    workspaceChanged: () => workspaceChanged?.(),
  }
}

describe("remote access service", () => {
  test("enable enrolls the machine, assigns every local project, and one signed beat makes them routable", async () => {
    const { authority, service, startMachineTunnel, signSpy } = setup()

    await expect(service.enable(auth, { startAtLogin: true })).resolves.toEqual({
      hostId: "host_machine",
      workspaceIds: ["ws_1", "ws_2"],
      connectionCount: 1,
    })

    // The machine is enrolled once, machine-wide — not per workspace, and it
    // names itself through the same derivation the desktop uses: nothing in the
    // request carried a name to enroll under, and the raw hostname (mDNS tail
    // and all) is not what reaches the control plane.
    const enrolled = await authority.activeHostEnrollment(auth)
    expect(enrolled).toMatchObject({
      active: true,
      host_id: "host_machine",
      display_name: machineDisplayName(process.platform),
    })
    // Independent of the derivation: whatever this host is called, the mDNS
    // tail is not part of the name the account sees.
    expect(enrolled.active ? enrolled.display_name : "").not.toMatch(/\.local$/)
    // Routable = owner-assigned and machine-acked and live lease, verified by
    // the real authority from the signatures the service produced.
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_1" })).resolves.toMatchObject({
      active: true,
      host_id: "host_machine",
    })
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_2" })).resolves.toMatchObject({
      active: true,
      host_id: "host_machine",
    })
    // The machine key signs the enrollment and nothing else: the beat is the
    // machine principal this process already holds.
    expect(signSpy.mock.calls.map(([, payload]) => payload.split("\n")[0])).toEqual(["claxedo.host-enrollment.enroll.v1"])
    await expect(authority.listHostEnrollments!(auth)).resolves.toMatchObject([{
      assignments: [
        { workspace_id: "ws_1", remote_directory: "/repo/one", revision: 1 },
        { workspace_id: "ws_2", remote_directory: "/repo/two", revision: 1 },
      ],
      acked: [{ workspaceId: "ws_1", revision: 1 }, { workspaceId: "ws_2", revision: 1 }],
    }])
    // Exactly one machine tunnel fed from the beat's serveable set.
    expect(startMachineTunnel).toHaveBeenCalledTimes(1)
    expect(startMachineTunnel).toHaveBeenCalledWith({
      workspaceIds: ["ws_1", "ws_2"],
      hostId: "host_machine",
      relayUrl: "https://relay.test",
      hostTunnelTokenProvider: expect.any(Function),
    })
    await expect(startMachineTunnel.mock.calls[0][0].hostTunnelTokenProvider()).resolves.toBe("htt_1")
  })

  test("every beat declares the composition of the runtimes this host serves", async () => {
    // The control plane mints each client's event-stream scope from what the
    // host declared and infers nothing, so this service has to carry the
    // composition of the embedded runtimes it shares out. Read back through
    // the real authority's routing answer — the same value the connection mint
    // reads — for both compositions, because a beat that hard-coded one of
    // them would still satisfy a single-value test.
    for (const declared of ["local", "managed-private"] as const) {
      const { authority, service } = setup({ sessionAuthority: declared })
      await service.enable(auth, { startAtLogin: false })

      await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_1" })).resolves.toMatchObject({
        active: true,
        session_authority: declared,
      })
    }
  })

  test("a newly opened project is assigned and becomes routable through the workspace-change path", async () => {
    const { authority, service, startMachineTunnel, localWorkspaces, workspaceChanged } = setup()
    await service.enable(auth, { startAtLogin: true })

    localWorkspaces.push({ id: "ws_3", kind: "local", directory: "/repo/three", displayName: "three" })
    await workspaceChanged()

    expect(startMachineTunnel).toHaveBeenCalledTimes(2)
    expect(startMachineTunnel.mock.calls[1][0]).toMatchObject({
      hostId: "host_machine",
      workspaceIds: ["ws_1", "ws_2", "ws_3"],
    })
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_3" })).resolves.toMatchObject({
      active: true,
      host_id: "host_machine",
    })
  })

  test("assignWorkspace self-enrolls, assigns, and answers only after the beat acked the workspace", async () => {
    const { authority, service } = setup({
      localWorkspaces: [{ id: "ws_share", kind: "local", directory: "/repo/share", displayName: "shared" }],
    })
    await authority.usersMe(auth)

    // No enable() first: sharing one workspace is enough to enroll the machine.
    const result = await service.assignWorkspace(auth, { workspaceId: "ws_share", displayName: "shared" })

    expect(result.assignment).toEqual({ assigned: true, workspace_id: "ws_share", host_id: "host_machine" })
    expect(result.hostTunnel).toEqual({
      hostTunnelToken: "htt_1",
      tokenExpiresAt: 456_000,
      jti: "jti_1",
      relayUrl: "https://relay.test",
    })
    // Share success = routable, not merely recorded.
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_share" })).resolves.toMatchObject({
      active: true,
      host_id: "host_machine",
    })
    // The devices surface names the machine. A share-path enrollment carries
    // no machine display name yet, so it falls back to the host id.
    await expect(service.devices(auth)).resolves.toEqual([{
      hostId: "host_machine",
      displayName: "host_machine",
      lastSeenAt: expect.any(Number),
      workspaceIds: ["ws_share"],
    }])
  })

  test("unassignWorkspace removes routing and shrinks the machine's signed consent set", async () => {
    const { authority, service, startMachineTunnel, stopMachineTunnel } = setup()
    await service.enable(auth, { startAtLogin: false })

    await expect(service.unassignWorkspace(auth, "ws_1")).resolves.toEqual({ unassigned: true })

    // A machine-placed workspace lives exactly as long as its host assignment
    // (commit 9b88098572): unassigning ws_1 retires the workspace row itself,
    // not just its routing, so it 404s rather than reporting `active: false`.
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_1" })).rejects.toThrow("Workspace not found")
    await expect(authority.listWorkspaces(auth)).resolves.not.toContainEqual(
      expect.objectContaining({ workspace_id: "ws_1" }),
    )
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_2" })).resolves.toMatchObject({ active: true })
    await expect(authority.listWorkspaces(auth)).resolves.toContainEqual(
      expect.objectContaining({ workspace_id: "ws_2" }),
    )
    expect(startMachineTunnel.mock.calls.at(-1)![0]).toMatchObject({ workspaceIds: ["ws_2"] })

    await expect(service.unassignWorkspace(auth, "ws_2")).resolves.toEqual({ unassigned: true })
    expect(stopMachineTunnel).toHaveBeenCalledWith("host_machine")
  })

  test("status reports enrollment, tunnel liveness, and second-device proof from the authority", async () => {
    const { service, machineTunnelActive } = setup()
    await expect(service.status(undefined)).resolves.toEqual({ enrolled: false, enabled: false, secondDeviceOpen: false })
    await expect(service.status(auth)).resolves.toEqual({ enrolled: false, enabled: false, secondDeviceOpen: false })

    await service.enable(auth, { startAtLogin: false })
    await expect(service.status(auth)).resolves.toEqual({ enrolled: true, enabled: true, secondDeviceOpen: false })

    machineTunnelActive.mockReturnValue(false)
    await expect(service.status(auth)).resolves.toEqual({ enrolled: true, enabled: false, secondDeviceOpen: false })
    machineTunnelActive.mockReturnValue(true)

    await expect(service.markSecondDeviceOpen(auth, "ws_1")).resolves.toEqual({ recorded: true })
    await expect(service.status(auth)).resolves.toEqual({ enrolled: true, enabled: true, secondDeviceOpen: true })
  })

  // The bootstrap declares this, and a client compares it against the host a
  // workspace row names to decide whether to reach this node directly or to
  // relay to another machine.
  test("names the enrollment it serves under, and names none before enabling or after revoking", async () => {
    const { authority, service } = setup()
    expect(service.servingEnrollmentId()).toBeUndefined()

    await service.enable(auth, { startAtLogin: false })
    const active = await authority.activeHostEnrollment(auth)
    expect(active).toMatchObject({ active: true })
    expect(service.servingEnrollmentId()).toBe(active.active ? active.enrollment_id : undefined)
    expect(service.servingEnrollmentId()).toBeTruthy()

    await service.revoke(auth, "host_machine")
    expect(service.servingEnrollmentId()).toBeUndefined()
  })

  test("revoke revokes the machine enrollment, stops the tunnel, and empties the devices surface", async () => {
    const { authority, service, stopMachineTunnel } = setup()
    await service.enable(auth, { startAtLogin: false })

    await expect(service.revoke(auth, "host_other")).resolves.toEqual({ revoked: false })
    expect(stopMachineTunnel).not.toHaveBeenCalled()

    await expect(service.revoke(auth, "host_machine")).resolves.toEqual({ revoked: true })
    expect(stopMachineTunnel).toHaveBeenCalledWith("host_machine")
    await expect(authority.activeHostEnrollment(auth)).resolves.toEqual({ active: false, reason: "revoked" })
    await expect(service.devices(auth)).resolves.toEqual([])
    // Revoke retires the shared workspaces with the machine: nothing routable,
    // and nothing left to read.
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_1" })).rejects.toThrow("Workspace not found")
    await expect(service.status(auth)).resolves.toEqual({ enrolled: false, enabled: false, secondDeviceOpen: false })

    // Enabling again re-proves the key and shares this machine's projects
    // afresh, reviving the retired rows.
    const again = await service.enable(auth, { startAtLogin: false })
    expect(again.workspaceIds).toEqual(["ws_1", "ws_2"])
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_1" })).resolves.toMatchObject({ active: true, host_id: "host_machine" })
  })

  test("revoke reaches a machine enrolled through an invitation the same way, without touching this machine", async () => {
    const { authority, service, stopMachineTunnel } = setup()
    await service.enable(auth, { startAtLogin: false })
    const box = machineIdentity("host_box")
    const invitation = await authority.createHostInvitation!(auth, { scope: { allowed_roots: ["/srv"], visibility: "owner" } })
    const parts = invitationTokenParts(invitation.token)!
    await authority.redeemHostInvitation!({
      invitationId: parts.invitationId,
      secret: parts.secret,
      hostId: box.hostId,
      publicKey: box.publicKey,
      signature: signHostPayload(box, invitationRedeemPayload({
        invitationId: parts.invitationId,
        hostId: box.hostId,
        publicKeySha256: await publicKeyFingerprint(JSON.parse(box.publicKey)),
      })),
    })
    await authority.assignWorkspaceHost(auth, { workspaceId: "ws_box", hostId: box.hostId, remoteDirectory: "/srv/api" })

    await expect(service.revoke(auth, box.hostId)).resolves.toEqual({ revoked: true })
    expect(stopMachineTunnel).toHaveBeenCalledWith(box.hostId)
    await expect(authority.listHostEnrollments!(auth)).resolves.toEqual([
      expect.objectContaining({ host_id: "host_machine", enrolled_via: "account" }),
    ])
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_1" })).resolves.toMatchObject({ active: true, host_id: "host_machine" })
    await expect(service.status(auth)).resolves.toEqual({ enrolled: true, enabled: true, secondDeviceOpen: false })
    await expect(service.hostId()).resolves.toBe("host_machine")
  })

  test("re-pointing a workspace withdraws routing until this machine acks the new directory", async () => {
    // The revision is the whole point of acking descriptions: a machine still
    // serving the old directory keeps saying so with the old revision, and
    // must not route until it has consented to the new one.
    const { authority, service, workspaceChanged } = setup()
    await service.enable(auth, { startAtLogin: false })
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_1" })).resolves.toMatchObject({ active: true })

    await authority.assignWorkspaceHost(auth, {
      workspaceId: "ws_1",
      hostId: "host_machine",
      remoteDirectory: "/repo/one-moved",
    })
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_1" })).resolves.toEqual({ active: false })

    await workspaceChanged()

    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_1" })).resolves.toMatchObject({ active: true })
    await expect(authority.listHostEnrollments!(auth)).resolves.toMatchObject([{
      acked: [{ workspaceId: "ws_1", revision: 2 }, { workspaceId: "ws_2", revision: 1 }],
    }])
  })

  test("a share the owner recorded without a directory is re-declared with this machine's path", async () => {
    // An assignment with no directory is reconcilable but not describable, and
    // a machine acks descriptions — so a workspace that reaches the served set
    // undescribed would be assigned, locally present, and permanently offline.
    const { authority, service, localWorkspaces, workspaceChanged } = setup({
      localWorkspaces: [{ id: "ws_1", kind: "local", directory: "/repo/one", displayName: "one" }],
    })
    await service.enable(auth, { startAtLogin: false })
    await authority.assignWorkspaceHost(auth, { workspaceId: "ws_3", hostId: "host_machine" })
    localWorkspaces.push({ id: "ws_3", kind: "local", directory: "/repo/three", displayName: "three" })

    // One beat with no sync puts ws_3 into the served set with no description
    // to ack, which is the state the re-declaration exists for.
    await service.assignWorkspace(auth, { workspaceId: "ws_1", displayName: "one" })
    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_3" })).resolves.toEqual({ active: false })

    await workspaceChanged()

    await expect(authority.activeWorkspaceHost(auth, { workspaceId: "ws_3" })).resolves.toMatchObject({
      active: true,
      host_id: "host_machine",
    })
    await expect(authority.listHostEnrollments!(auth)).resolves.toMatchObject([{
      assignments: expect.arrayContaining([
        expect.objectContaining({ workspace_id: "ws_3", remote_directory: "/repo/three" }),
      ]),
    }])
  })

  test("a second instance of this machine takes over serving, and the first stops beating", async () => {
    // Two processes on one enrollment would each rewrite the other's
    // readiness. The generation fences them, and the instance that lost it has
    // nothing left to retry.
    const first = setup({ heartbeatIntervalMs: 5 })
    await first.service.enable(auth, { startAtLogin: false })
    expect(first.stopMachineTunnel).not.toHaveBeenCalled()

    const second = setup({ authority: first.authority, identity: first.identity })
    await second.service.enable(auth, { startAtLogin: false })

    await vi.waitFor(() => {
      expect(first.stopMachineTunnel).toHaveBeenCalledWith("host_machine")
    })
    // The takeover cost no routing: the instance holding the generation acked
    // the same workspaces.
    await expect(first.authority.activeWorkspaceHost(auth, { workspaceId: "ws_1" }))
      .resolves.toMatchObject({ active: true, host_id: "host_machine" })
  })

  test("a revoked enrollment ends the beat loop and drops the tunnel", async () => {
    // Revoking took the readiness rows with it, so the relay socket is open
    // for workspaces nothing can reach and every later beat earns the same
    // refusal.
    const { authority, service, stopMachineTunnel } = setup({ heartbeatIntervalMs: 5 })
    await service.enable(auth, { startAtLogin: false })
    expect(stopMachineTunnel).not.toHaveBeenCalled()

    await authority.revokeHostEnrollment(auth, { hostId: "host_machine" })

    await vi.waitFor(() => {
      expect(stopMachineTunnel).toHaveBeenCalledWith("host_machine")
    })
  })

  test("an enrollment that holds another machine's key ends the beat loop and drops the tunnel", async () => {
    // Nothing signs a beat in this process, so the stored key is the only
    // evidence that the enrollment is still this machine's. Without the
    // comparison the principal's key version is read from the very row it is
    // checked against, and this box would go on serving under a key it does
    // not hold.
    const { authority, service, identity, stopMachineTunnel } = setup({ heartbeatIntervalMs: 5 })
    await service.enable(auth, { startAtLogin: false })
    expect(stopMachineTunnel).not.toHaveBeenCalled()

    await enrollKeyUnderHostId(authority, machineIdentity(identity.hostId))

    await vi.waitFor(() => {
      expect(stopMachineTunnel).toHaveBeenCalledWith("host_machine")
    })
  })

  test.each(["enrollment_owner_ineligible", "enrollment_key_version_mismatch"] as const)(
    "a beat refused as %s ends the beat loop and drops the tunnel",
    async (code) => {
      const base = createSqliteWorkspaceAuthority({ path: ":memory:" })
      const { observed, refuse } = observedBeats(base)
      const { service, stopMachineTunnel } = setup({ authority: observed, heartbeatIntervalMs: 5 })
      await service.enable(auth, { startAtLogin: false })
      expect(stopMachineTunnel).not.toHaveBeenCalled()

      refuse.error = new SqliteHostConnectError(code, "refused")

      await vi.waitFor(() => {
        expect(stopMachineTunnel).toHaveBeenCalledWith("host_machine")
      })
    },
  )

  test("a paused enrollment keeps beating, and resuming it serves again without re-enabling", async () => {
    // The owner sets and lifts a pause from one route, so retrying is what
    // brings a headless box back. A loop that stopped here would leave it dark
    // until someone logged in.
    const base = createSqliteWorkspaceAuthority({ path: ":memory:" })
    const { observed, beats } = observedBeats(base)
    const { service, startMachineTunnel, stopMachineTunnel } = setup({
      authority: observed,
      heartbeatIntervalMs: 5,
    })
    await service.enable(auth, { startAtLogin: false })

    await base.pauseHostEnrollment(auth, { hostId: "host_machine", paused: true })
    const refused = beats.mock.calls.length
    await vi.waitFor(() => {
      expect(beats.mock.calls.length).toBeGreaterThan(refused + 2)
    })
    expect(stopMachineTunnel).not.toHaveBeenCalled()

    const served = startMachineTunnel.mock.calls.length
    await base.pauseHostEnrollment(auth, { hostId: "host_machine", paused: false })

    await vi.waitFor(() => {
      expect(startMachineTunnel.mock.calls.length).toBeGreaterThan(served)
    })
    await expect(base.activeWorkspaceHost(auth, { workspaceId: "ws_1" }))
      .resolves.toMatchObject({ active: true, host_id: "host_machine" })
  })

  test("enabling twice leaves one beat loop, not two", async () => {
    // A second enable that left the first interval alive would beat twice per
    // interval for the life of the process, each loop undoing the other's
    // acks against a generation only one of them holds.
    vi.useFakeTimers()
    try {
      const { service, startMachineTunnel } = setup({ heartbeatIntervalMs: 1_000 })
      await service.enable(auth, { startAtLogin: false })
      await service.enable(auth, { startAtLogin: false })

      const enabled = startMachineTunnel.mock.calls.length
      await vi.advanceTimersByTimeAsync(3_000)

      expect(startMachineTunnel.mock.calls.length - enabled).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
