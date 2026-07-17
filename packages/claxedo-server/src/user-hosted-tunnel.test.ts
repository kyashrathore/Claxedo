import { afterEach, describe, expect, test, vi } from "vitest"

const mocks = {
  sandboxManagerEnsure: vi.fn(async () => ({
    status: "ready",
    workspaceId: "ws_cloud",
    sandboxId: "sandbox_cloud",
    hostId: "host_cloud",
    url: "http://127.0.0.1:5123",
    epoch: 1,
    homeRegion: "us-east",
  })),
  ensureSupervisorSandbox: vi.fn(async () => ({ url: "http://127.0.0.1:5123" })),
  syncWorkspaceRuntimeAgentExtensions: vi.fn(async () => {}),
  broadcastRuntimeConfig: vi.fn(async () => {}),
  discardSupervisorSandbox: vi.fn(async () => {}),
  getSupervisorSandboxStatus: vi.fn(() => undefined),
  getSandbox: vi.fn(() => undefined),
  markSupervisorSandboxUse: vi.fn(),
  touchSupervisorSandbox: vi.fn(),
  getSupervisorSandboxTarget: vi.fn(() => undefined),
  holdSupervisorSandbox: vi.fn(),
  releaseSupervisorSandbox: vi.fn(),
  workspaceSupervisorServerUrl: vi.fn(() => "http://127.0.0.1:3001"),
  configureWorkspaceSupervisor: vi.fn(),
  shutdownWorkspaceSupervisor: vi.fn(async () => {}),
  listSupervisorSandboxs: vi.fn(() => []),
  close: vi.fn(),
  updateRegistration: vi.fn(async () => {}),
  startWorkspaceRelayHostTunnel: vi.fn((_options: unknown) => ({
    close: mocks.close,
    updateRegistration: mocks.updateRegistration,
  })),
  getWorkspace: vi.fn(async (id: string) => ({
    id,
    directory: `/tmp/${id}`,
    kind: "local",
    created_at: Date.now(),
    updated_at: Date.now(),
  })),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}

vi.mock("./workspace-supervisor", () => ({
  createWorkspaceSupervisorSandboxManager: vi.fn(() => ({
    ensure: mocks.sandboxManagerEnsure,
  })),
  ensureSupervisorSandbox: mocks.ensureSupervisorSandbox,
  syncWorkspaceRuntimeAgentExtensions: mocks.syncWorkspaceRuntimeAgentExtensions,
  broadcastRuntimeConfig: mocks.broadcastRuntimeConfig,
  discardSupervisorSandbox: mocks.discardSupervisorSandbox,
  getSupervisorSandboxStatus: mocks.getSupervisorSandboxStatus,
  getSandbox: mocks.getSandbox,
  markSupervisorSandboxUse: mocks.markSupervisorSandboxUse,
  touchSupervisorSandbox: mocks.touchSupervisorSandbox,
  getSupervisorSandboxTarget: mocks.getSupervisorSandboxTarget,
  holdSupervisorSandbox: mocks.holdSupervisorSandbox,
  releaseSupervisorSandbox: mocks.releaseSupervisorSandbox,
  workspaceSupervisorServerUrl: mocks.workspaceSupervisorServerUrl,
  configureWorkspaceSupervisor: mocks.configureWorkspaceSupervisor,
  shutdownWorkspaceSupervisor: mocks.shutdownWorkspaceSupervisor,
  listSupervisorSandboxs: mocks.listSupervisorSandboxs,
}))

vi.mock("@claxedo/workspace-runtime/relay", () => ({
  startWorkspaceRelayHostTunnel: mocks.startWorkspaceRelayHostTunnel,
}))

vi.mock("./workspace-store", () => ({
  getWorkspace: mocks.getWorkspace,
}))

vi.mock("./log", () => ({
  Log: {
    create: () => mocks.log,
  },
}))

const {
  startUserHostedMachineTunnel,
  startUserHostedWorkspaceTunnel,
  stopAllUserHostedWorkspaceTunnels,
} = await import("./user-hosted-tunnel")

afterEach(() => {
  stopAllUserHostedWorkspaceTunnels()
  vi.clearAllMocks()
})

describe("user-hosted Workspace Relay tunnel manager", () => {
  test("keeps one machine tunnel while registrations add local workspaces", async () => {
    await expect(startUserHostedMachineTunnel({
      workspaceIds: ["ws_b", "ws_a"],
      hostId: "host_machine",
      relayUrl: "http://relay.test/",
      hostTunnelToken: "htt_1",
    })).resolves.toEqual({ reused: false, connectionCount: 1, workspaceIds: ["ws_a", "ws_b"] })

    const options = mocks.startWorkspaceRelayHostTunnel.mock.calls[0]![0] as {
      workspaceIds: string[]
      localBaseUrl: string
      resolveLocalUrl: (input: { workspaceId: string; path: string }) => URL | undefined
      tokenProvider: () => Promise<string>
    }
    expect(options.workspaceIds).toEqual(["ws_a", "ws_b"])
    expect(options.localBaseUrl).toBe("http://127.0.0.1:3001")
    expect(options.resolveLocalUrl({ workspaceId: "ws_b", path: "/api/wr/health?probe=1" })?.toString())
      .toBe("http://127.0.0.1:3001/workspaces/ws_b/api/wr/health?probe=1")
    expect(options.resolveLocalUrl({ workspaceId: "ws_b", path: "/api/claxedo/credentials" })).toBeUndefined()
    expect(options.resolveLocalUrl({ workspaceId: "ws_unknown", path: "/api/wr/health" })).toBeUndefined()
    await expect(options.tokenProvider()).resolves.toBe("htt_1")

    await expect(startUserHostedMachineTunnel({
      workspaceIds: ["ws_a", "ws_b", "ws_c"],
      hostId: "host_machine",
      relayUrl: "http://relay.test",
      hostTunnelToken: "htt_2",
    })).resolves.toEqual({ reused: true, connectionCount: 1, workspaceIds: ["ws_a", "ws_b", "ws_c"] })

    expect(mocks.startWorkspaceRelayHostTunnel).toHaveBeenCalledTimes(1)
    expect(mocks.updateRegistration).toHaveBeenCalledWith({
      workspaceIds: ["ws_a", "ws_b", "ws_c"],
      token: "htt_2",
    })
    await expect(options.tokenProvider()).resolves.toBe("htt_2")
    expect(mocks.close).not.toHaveBeenCalled()
  })

  test("starts a local embedded workspace tunnel through the control-plane relay path", async () => {
    await expect(startUserHostedWorkspaceTunnel({
      workspaceId: "ws_local",
      hostId: "host_local",
      relayUrl: "http://relay.test/",
      hostTunnelToken: "htt_1",
    })).resolves.toEqual({
      url: "http://127.0.0.1:3001/workspaces/ws_local",
      reused: false,
    })

    expect(mocks.sandboxManagerEnsure).not.toHaveBeenCalled()
    expect(mocks.holdSupervisorSandbox).not.toHaveBeenCalled()
    expect(mocks.startWorkspaceRelayHostTunnel).toHaveBeenCalledWith({
      relayUrl: "http://relay.test",
      hostId: "host_local",
      workspaceIds: ["ws_local"],
      localBaseUrl: "http://127.0.0.1:3001/workspaces/ws_local",
      tokenProvider: expect.any(Function),
      onEvent: expect.any(Function),
      pingIntervalMs: 15_000,
      reconnectIntervalMs: 1_000,
    })
    await expect((mocks.startWorkspaceRelayHostTunnel.mock.calls[0]![0] as {
      tokenProvider: () => Promise<string>
    }).tokenProvider()).resolves.toBe("htt_1")
  })

  test("starts a cloud runtime tunnel with Host Tunnel Token auth", async () => {
    mocks.getWorkspace.mockResolvedValueOnce({
      id: "ws_cloud",
      directory: "/workspace",
      kind: "cloud",
      created_at: Date.now(),
      updated_at: Date.now(),
    })

    await expect(startUserHostedWorkspaceTunnel({
      workspaceId: "ws_cloud",
      hostId: "host_cloud",
      relayUrl: "http://relay.test/",
      hostTunnelToken: "htt_1",
    })).resolves.toEqual({
      url: "http://127.0.0.1:5123",
      reused: false,
    })

    expect(mocks.sandboxManagerEnsure).toHaveBeenCalledWith("ws_cloud", {
      homeRegion: "us-east",
      hostId: "host_cloud",
    })
    expect(mocks.holdSupervisorSandbox).toHaveBeenCalledWith("ws_cloud")
    expect(mocks.startWorkspaceRelayHostTunnel).toHaveBeenCalledWith(expect.objectContaining({
      localBaseUrl: "http://127.0.0.1:5123",
    }))
  })

  test("reuses existing tunnels when credentials rotate", async () => {
    await startUserHostedWorkspaceTunnel({
      workspaceId: "ws_local",
      hostId: "host_local",
      relayUrl: "http://relay.test",
      hostTunnelToken: "htt_1",
    })
    await startUserHostedWorkspaceTunnel({
      workspaceId: "ws_local",
      hostId: "host_local",
      relayUrl: "http://relay.test",
      hostTunnelToken: "htt_2",
    })

    expect(mocks.startWorkspaceRelayHostTunnel).toHaveBeenCalledTimes(1)
    await expect((mocks.startWorkspaceRelayHostTunnel.mock.calls[0]![0] as {
      tokenProvider: () => Promise<string>
    }).tokenProvider()).resolves.toBe("htt_2")
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.releaseSupervisorSandbox).not.toHaveBeenCalled()
    expect(stopAllUserHostedWorkspaceTunnels()).toBe(1)
    expect(mocks.close).toHaveBeenCalledTimes(1)
    expect(mocks.releaseSupervisorSandbox).not.toHaveBeenCalled()
  })

  test("logs auth-failed, reconnecting, and closed tunnel events", async () => {
    await startUserHostedWorkspaceTunnel({
      workspaceId: "ws_local",
      hostId: "host_local",
      relayUrl: "http://relay.test",
      hostTunnelToken: "htt_1",
    })

    const { onEvent } = mocks.startWorkspaceRelayHostTunnel.mock.calls[0]![0] as {
      onEvent: (event: Record<string, unknown>) => void
    }
    mocks.log.info.mockClear()

    onEvent({ type: "connecting", attempt: 1 })
    onEvent({ type: "open" })
    onEvent({ type: "auth-failed", attempt: 1, error: "Runtime Access Token expired" })
    onEvent({ type: "reconnecting", attempt: 2, delayMs: 1_000, reason: "auth-failed" })
    onEvent({ type: "closed", reason: "max-attempts" })

    const context = {
      workspaceId: "ws_local",
      hostId: "host_local",
      relayUrl: "http://relay.test",
    }
    expect(mocks.log.error).toHaveBeenCalledWith("user-hosted workspace tunnel auth failed", {
      ...context,
      attempt: 1,
      error: "Runtime Access Token expired",
    })
    expect(mocks.log.warn).toHaveBeenCalledWith("user-hosted workspace tunnel reconnecting", {
      ...context,
      attempt: 2,
      delayMs: 1_000,
      reason: "auth-failed",
    })
    expect(mocks.log.info).toHaveBeenCalledWith("user-hosted workspace tunnel closed", {
      ...context,
      reason: "max-attempts",
    })
    // connecting/open are routine and stay quiet.
    expect(mocks.log.info).toHaveBeenCalledTimes(1)
  })

  test("closes existing tunnels when the relay endpoint changes or the host link stops", async () => {
    await startUserHostedWorkspaceTunnel({
      workspaceId: "ws_local",
      hostId: "host_local",
      relayUrl: "http://relay.one.test",
      hostTunnelToken: "htt_1",
    })
    await startUserHostedWorkspaceTunnel({
      workspaceId: "ws_local",
      hostId: "host_local",
      relayUrl: "http://relay.two.test",
      hostTunnelToken: "htt_2",
    })

    expect(mocks.close).toHaveBeenCalledTimes(1)
    expect(mocks.releaseSupervisorSandbox).not.toHaveBeenCalled()
    expect(stopAllUserHostedWorkspaceTunnels()).toBe(1)
    expect(mocks.close).toHaveBeenCalledTimes(2)
    expect(mocks.releaseSupervisorSandbox).not.toHaveBeenCalled()
  })
})
