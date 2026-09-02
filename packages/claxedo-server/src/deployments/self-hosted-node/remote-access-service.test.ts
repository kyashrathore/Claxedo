import { generateKeyPairSync } from "node:crypto"
import { describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { signHostPayload, type LocalHostIdentity } from "../../workspace/local-host"
import { createRemoteAccessService } from "./remote-access-service"

/**
 * Machine-wide remote access against the REAL SQLite authority.
 *
 * Every route to "routable" here crosses the production contract: the service
 * signs the real enroll-v1 and heartbeat-v2 payload literals with a real P-256
 * key, and the authority verifies those exact bytes before anything becomes
 * assigned, acked, or leased. A service that signed the wrong literal, the
 * wrong served set, or skipped the beat fails these tests — there is no mock
 * of the assign→beat→routable sequence to hide behind.
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

function setup(input: {
  localWorkspaces?: Array<{ id: string; kind: "local" | "cloud"; displayName: string }>
  sessionAuthority?: "local" | "managed-private"
} = {}) {
  const authority = createSqliteWorkspaceAuthority({ path: ":memory:" })
  const identity = machineIdentity()
  const localWorkspaces = input.localWorkspaces ?? [
    { id: "ws_1", kind: "local" as const, displayName: "one" },
    { id: "ws_2", kind: "local" as const, displayName: "two" },
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
    // Beats in these tests are driven explicitly through enable/assign; a
    // large interval keeps the background loop from interleaving signatures.
    heartbeatIntervalMs: 3_600_000,
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

    await expect(service.enable(auth, { displayName: "Yash's Mac", startAtLogin: true })).resolves.toEqual({
      hostId: "host_machine",
      workspaceIds: ["ws_1", "ws_2"],
      connectionCount: 1,
    })

    // The machine is enrolled once, machine-wide — not per workspace.
    await expect(authority.activeHostEnrollment!(auth)).resolves.toMatchObject({
      active: true,
      host_id: "host_machine",
      display_name: "Yash's Mac",
    })
    // Routable = owner-assigned AND machine-acked AND live lease, verified by
    // the real authority from the signatures the service produced.
    await expect(authority.activeWorkspaceHost!(auth, { workspaceId: "ws_1" })).resolves.toMatchObject({
      active: true,
      host_id: "host_machine",
    })
    await expect(authority.activeWorkspaceHost!(auth, { workspaceId: "ws_2" })).resolves.toMatchObject({
      active: true,
      host_id: "host_machine",
    })
    // The v2 heartbeat literal covered the whole served set in ONE signature.
    expect(signSpy.mock.calls.map(([, payload]) => payload)).toContain(
      [
        "claxedo.host-enrollment.heartbeat.v2",
        "host_id=host_machine",
        "ttl_ms=60000",
        "workspaces=ws_1,ws_2",
      ].join("\n"),
    )
    expect(signSpy.mock.calls.some(([, payload]) => payload.startsWith("claxedo.host-enrollment.enroll.v1\nhost_id=host_machine\n"))).toBe(true)
    // Exactly one machine tunnel fed from the beat's serveable set.
    expect(startMachineTunnel).toHaveBeenCalledTimes(1)
    expect(startMachineTunnel).toHaveBeenCalledWith({
      workspaceIds: ["ws_1", "ws_2"],
      hostId: "host_machine",
      relayUrl: "https://relay.test",
      hostTunnelTokenProvider: expect.any(Function),
    })
    await expect(startMachineTunnel.mock.calls[0]![0].hostTunnelTokenProvider()).resolves.toBe("htt_1")
  })

  test("every beat declares the composition of the runtimes this host serves", async () => {
    // The control plane mints each client's event-stream scope from what the
    // HOST declared and infers nothing, so this service has to carry the
    // composition of the embedded runtimes it shares out. Read back through
    // the real authority's routing answer — the same value the connection mint
    // reads — for both compositions, because a beat that hard-coded one of
    // them would still satisfy a single-value test.
    for (const declared of ["local", "managed-private"] as const) {
      const { authority, service } = setup({ sessionAuthority: declared })
      await service.enable(auth, { displayName: "Mac", startAtLogin: false })

      await expect(authority.activeWorkspaceHost!(auth, { workspaceId: "ws_1" })).resolves.toMatchObject({
        active: true,
        session_authority: declared,
      })
    }
  })

  test("a newly opened project is assigned and becomes routable through the workspace-change path", async () => {
    const { authority, service, startMachineTunnel, localWorkspaces, workspaceChanged } = setup()
    await service.enable(auth, { displayName: "Mac", startAtLogin: true })

    localWorkspaces.push({ id: "ws_3", kind: "local", displayName: "three" })
    await workspaceChanged()

    expect(startMachineTunnel).toHaveBeenCalledTimes(2)
    expect(startMachineTunnel.mock.calls[1]![0]).toMatchObject({
      hostId: "host_machine",
      workspaceIds: ["ws_1", "ws_2", "ws_3"],
    })
    await expect(authority.activeWorkspaceHost!(auth, { workspaceId: "ws_3" })).resolves.toMatchObject({
      active: true,
      host_id: "host_machine",
    })
  })

  test("assignWorkspace self-enrolls, assigns, and answers only after the beat acked the workspace", async () => {
    const { authority, service } = setup({
      localWorkspaces: [{ id: "ws_share", kind: "local", displayName: "shared" }],
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
    await expect(authority.activeWorkspaceHost!(auth, { workspaceId: "ws_share" })).resolves.toMatchObject({
      active: true,
      host_id: "host_machine",
    })
    // The devices surface names the MACHINE. A share-path enrollment carries
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
    await service.enable(auth, { displayName: "Mac", startAtLogin: false })

    await expect(service.unassignWorkspace(auth, "ws_1")).resolves.toEqual({ unassigned: true })

    // A user-hosted workspace lives exactly as long as its host assignment
    // (commit 9b88098572): unassigning ws_1 retires the workspace row itself,
    // not just its routing, so it 404s rather than reporting `active: false`.
    await expect(authority.activeWorkspaceHost!(auth, { workspaceId: "ws_1" })).rejects.toThrow("Workspace not found")
    await expect(authority.listWorkspaces(auth)).resolves.not.toContainEqual(
      expect.objectContaining({ workspace_id: "ws_1" }),
    )
    await expect(authority.activeWorkspaceHost!(auth, { workspaceId: "ws_2" })).resolves.toMatchObject({ active: true })
    await expect(authority.listWorkspaces(auth)).resolves.toContainEqual(
      expect.objectContaining({ workspace_id: "ws_2" }),
    )
    expect(startMachineTunnel.mock.calls.at(-1)![0]).toMatchObject({ workspaceIds: ["ws_2"] })

    await expect(service.unassignWorkspace(auth, "ws_2")).resolves.toEqual({ unassigned: true })
    expect(stopMachineTunnel).toHaveBeenCalledWith("host_machine")
  })

  test("status reports enrollment, tunnel liveness, and second-device proof from the authority", async () => {
    const { authority, service, machineTunnelActive } = setup()
    await expect(service.status(undefined)).resolves.toEqual({ enrolled: false, enabled: false, secondDeviceOpen: false })
    await expect(service.status(auth)).resolves.toEqual({ enrolled: false, enabled: false, secondDeviceOpen: false })

    await service.enable(auth, { displayName: "Mac", startAtLogin: false })
    await expect(service.status(auth)).resolves.toEqual({ enrolled: true, enabled: true, secondDeviceOpen: false })

    machineTunnelActive.mockReturnValue(false)
    await expect(service.status(auth)).resolves.toEqual({ enrolled: true, enabled: false, secondDeviceOpen: false })
    machineTunnelActive.mockReturnValue(true)

    await expect(service.markSecondDeviceOpen(auth, "ws_1")).resolves.toEqual({ recorded: true })
    await expect(service.status(auth)).resolves.toEqual({ enrolled: true, enabled: true, secondDeviceOpen: true })
  })

  test("revoke pauses the machine enrollment, stops the tunnel, and empties the devices surface", async () => {
    const { authority, service, stopMachineTunnel } = setup()
    await service.enable(auth, { displayName: "Mac", startAtLogin: false })

    await expect(service.revoke(auth, "host_other")).resolves.toEqual({ revoked: false })
    expect(stopMachineTunnel).not.toHaveBeenCalled()

    await expect(service.revoke(auth, "host_machine")).resolves.toEqual({ revoked: true })
    expect(stopMachineTunnel).toHaveBeenCalledWith("host_machine")
    await expect(authority.activeHostEnrollment!(auth)).resolves.toEqual({ active: false, reason: "paused" })
    await expect(service.devices(auth)).resolves.toEqual([])
    await expect(authority.activeWorkspaceHost!(auth, { workspaceId: "ws_1" })).resolves.toEqual({ active: false })
  })

  test("a signature over the wrong served set is refused by the authority, not papered over", async () => {
    const { authority, identity } = setup()
    const service = createRemoteAccessService({
      authority: authority as never,
      relayUrl: "https://relay.test",
      hostTunnelTokenSigner: vi.fn(async () => ({ hostTunnelToken: "htt_1", tokenExpiresAt: 1, jti: "jti_1" })),
      listLocalWorkspaces: async () => [{ id: "ws_1", kind: "local", displayName: "one" }],
      localHostIdentity: async () => identity,
      sessionAuthority: () => "local",
      // A tampering signer: heartbeat signatures cover an EMPTY set no matter
      // what the service claims to serve. The real verifier must refuse it.
      signHostPayload: (who, payload) =>
        signHostPayload(
          who,
          payload.startsWith("claxedo.host-enrollment.heartbeat.v2")
            ? payload.replace(/workspaces=.*$/, "workspaces=")
            : payload,
        ),
      startMachineTunnel: vi.fn(async () => ({ connectionCount: 1, workspaceIds: [] })),
      stopMachineTunnel: vi.fn(() => true),
      heartbeatIntervalMs: 3_600_000,
      capture: vi.fn(),
    })

    await expect(service.enable(auth, { displayName: "Mac", startAtLogin: false })).rejects.toThrow(/Invalid host attestation/)
    await expect(authority.activeWorkspaceHost!(auth, { workspaceId: "ws_1" })).resolves.toEqual({ active: false })
  })
})
