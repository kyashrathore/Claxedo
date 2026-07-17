import { describe, expect, test, vi } from "vitest"
import { createRemoteAccessService } from "./remote-access-service"

const auth = { user: { subject: "user_1" } } as never

function setup() {
  const localWorkspaces = [
    { id: "ws_1", kind: "local" as const, displayName: "one" },
    { id: "ws_2", kind: "local" as const, displayName: "two" },
  ]
  let workspaceChanged: (() => Promise<void>) | undefined
  const authority = {
    usersMe: vi.fn(async () => ({ id: "user_1" })),
    listWorkspaces: vi.fn(async () => [{ workspace_id: "ws_1" }, { workspace_id: "ws_2" }]),
    createLocalHostLinkChallenge: vi.fn(async (_auth, { workspaceId }: { workspaceId: string }) => ({
      challenge_id: `challenge_${workspaceId}`,
      nonce: `nonce_${workspaceId}`,
      expires_at: Date.now() + 1_000,
    })),
    registerLocalHostLink: vi.fn(async () => ({})),
    registerLocalForSharing: vi.fn(async () => ({})),
    activeLocalHostLink: vi.fn(async (_auth, { workspaceId }: { workspaceId: string }) => ({
      active: true as const,
      host_id: "host_machine",
      workspace_id: workspaceId,
      display_name: "Yash's Mac",
      expires_at: Date.now() + 1_000,
      last_seen_at: 10,
    })),
    pauseLocalHostLink: vi.fn(async () => ({})),
    markSecondDeviceOpen: vi.fn(async () => ({ recorded: true, second_device_open_at: 20 })),
  }
  const startMachineTunnel = vi.fn(async ({ workspaceIds }: {
    workspaceIds: string[]
    hostTunnelTokenProvider: () => Promise<string>
  }) => ({
    reused: false,
    connectionCount: 1,
    workspaceIds,
  }))
  const stopMachineTunnel = vi.fn(() => true)
  const machineTunnelActive = vi.fn(() => true)
  const service = createRemoteAccessService({
    authority: authority as never,
    relayUrl: "https://relay.test",
    hostTunnelTokenSigner: vi.fn(async () => ({ hostTunnelToken: "htt_1", tokenExpiresAt: 1, jti: "jti_1" })),
    listLocalWorkspaces: vi.fn(async () => localWorkspaces),
    subscribeLocalWorkspaces: (listener) => {
      workspaceChanged = listener
      return () => { workspaceChanged = undefined }
    },
    localHostIdentity: vi.fn(async () => ({
      hostId: "host_machine",
      publicKey: "public",
      privateKey: {},
    })),
    signHostPayload: vi.fn(() => "signature"),
    registrationPayload: vi.fn(() => "payload"),
    startMachineTunnel,
    stopMachineTunnel,
    machineTunnelActive,
    capture: vi.fn(),
  })
  return {
    authority,
    service,
    startMachineTunnel,
    stopMachineTunnel,
    machineTunnelActive,
    localWorkspaces,
    workspaceChanged: () => workspaceChanged?.(),
  }
}

describe("remote access service", () => {
  test("enrolls all local projects under one host and starts exactly one machine tunnel", async () => {
    const { authority, service, startMachineTunnel } = setup()

    await expect(service.enable(auth, { displayName: "Yash's Mac", startAtLogin: true })).resolves.toEqual({
      hostId: "host_machine",
      workspaceIds: ["ws_1", "ws_2"],
      connectionCount: 1,
    })
    expect(authority.createLocalHostLinkChallenge).toHaveBeenCalledTimes(2)
    expect(authority.registerLocalHostLink).toHaveBeenCalledTimes(2)
    expect(authority.registerLocalForSharing).toHaveBeenCalledTimes(2)
    expect(startMachineTunnel).toHaveBeenCalledTimes(1)
    expect(startMachineTunnel).toHaveBeenCalledWith({
      workspaceIds: ["ws_1", "ws_2"],
      hostId: "host_machine",
      relayUrl: "https://relay.test",
      hostTunnelTokenProvider: expect.any(Function),
    })
    await expect(startMachineTunnel.mock.calls[0]![0].hostTunnelTokenProvider()).resolves.toBe("htt_1")
  })

  test("adds a newly opened project through a registration update path", async () => {
    const { service, startMachineTunnel, localWorkspaces, workspaceChanged } = setup()
    await service.enable(auth, { displayName: "Mac", startAtLogin: true })
    localWorkspaces.push({ id: "ws_3", kind: "local", displayName: "three" })
    await workspaceChanged()

    expect(startMachineTunnel).toHaveBeenCalledTimes(2)
    expect(startMachineTunnel.mock.calls[1]![0]).toMatchObject({
      hostId: "host_machine",
      workspaceIds: ["ws_1", "ws_2", "ws_3"],
    })
  })

  test("groups workspace links into one device and revokes every link for the host", async () => {
    const { authority, service, stopMachineTunnel } = setup()
    await expect(service.devices(auth)).resolves.toEqual([{
      hostId: "host_machine",
      displayName: "Yash's Mac",
      lastSeenAt: 10,
      workspaceIds: ["ws_1", "ws_2"],
    }])
    await expect(service.revoke(auth, "host_machine")).resolves.toEqual({ revoked: true })
    expect(authority.pauseLocalHostLink).toHaveBeenCalledTimes(2)
    expect(stopMachineTunnel).toHaveBeenCalledWith("host_machine")
    await expect(service.revoke(auth, "host_other")).resolves.toEqual({ revoked: false })
    expect(stopMachineTunnel).toHaveBeenCalledTimes(1)
  })

  test("distinguishes durable enrollment from an active process-local tunnel", async () => {
    const { service, machineTunnelActive } = setup()
    machineTunnelActive.mockReturnValue(false)
    await expect(service.status(auth)).resolves.toEqual({
      enrolled: true,
      enabled: false,
      secondDeviceOpen: false,
    })
  })

  test("persists second-device proof through the workspace authority", async () => {
    const { authority, service } = setup()
    await expect(service.markSecondDeviceOpen(auth, "ws_1")).resolves.toEqual({ recorded: true })
    expect(authority.markSecondDeviceOpen).toHaveBeenCalledWith(auth, { workspaceId: "ws_1" })
  })
})
