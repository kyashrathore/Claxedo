import { describe, expect, test, vi } from "vitest"
import { createControlPlaneRelayProvider } from "."

describe("control-plane relay provider", () => {
  const actor = { actorId: "actor_1", actorKind: "human" as const }
  test("resolves the configured relay endpoint for a workspace home region", () => {
    const provider = createControlPlaneRelayProvider({
      relay: {
        relayUrl: "https://relay.default.test",
        relayUrls: {
          "eu-west": "https://relay.eu.test",
        },
      },
      runtimeAccessTokenSigner: vi.fn(),
      hostTunnelTokenSigner: vi.fn(),
      targetLookup: vi.fn(),
      recordRuntimeAccessToken: vi.fn(),
    })

    expect(provider.getRelayEndpoint("ws_1", "eu-west")).toBe("https://relay.eu.test")
    expect(provider.getRelayEndpoint("ws_1", "apac-south")).toBe("https://relay.default.test")
  })

  test("fails closed when no relay endpoint is configured for a region", () => {
    const provider = createControlPlaneRelayProvider({
      relay: {},
      runtimeAccessTokenSigner: vi.fn(),
      hostTunnelTokenSigner: vi.fn(),
      targetLookup: vi.fn(),
      recordRuntimeAccessToken: vi.fn(),
    })

    expect(() => provider.getRelayEndpoint("ws_1", "us-east")).toThrow("Workspace relay endpoint is not configured")
  })

  test("mints host tunnel and runtime access tokens through the injected signers", async () => {
    const hostTunnelTokenSigner = vi.fn(async () => ({
      hostTunnelToken: "htt_1",
      tokenExpiresAt: 1_000,
      jti: "htt_jti",
    }))
    const runtimeAccessTokenSigner = vi.fn(async () => ({
      runtimeAccessToken: "rat_1",
      tokenExpiresAt: 2_000,
      jti: "rat_jti",
    }))
    const recordRuntimeAccessToken = vi.fn(async () => {})
    const provider = createControlPlaneRelayProvider({
      relay: { relayUrl: "https://relay.test" },
      runtimeAccessTokenSigner,
      hostTunnelTokenSigner,
      targetLookup: vi.fn(),
      recordRuntimeAccessToken,
    })

    await expect(provider.mintHostTunnelToken({
      workspaceId: "ws_1",
      hostId: "host_1",
      subject: "user_1",
      ttlMs: 60_000,
    })).resolves.toEqual({
      token: "htt_1",
      expiresAt: 1_000,
      jti: "htt_jti",
    })
    expect(hostTunnelTokenSigner).toHaveBeenCalledWith({
      subject: "user_1",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      ttlSeconds: 60, // 60_000ms requested, in host-tunnel bounds → honored
    })

    await expect(provider.mintRuntimeAccessToken({
      ...actor,
      principalKind: "user",
      workspaceId: "ws_1",
      hostId: "host_1",
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      orgId: "org_1",
      role: "editor",
      ttlMs: 60_000,
    })).resolves.toEqual({
      token: "rat_1",
      expiresAt: 2_000,
      jti: "rat_jti",
    })
    expect(runtimeAccessTokenSigner).toHaveBeenCalledWith({
      ...actor,
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
      ttlSeconds: 15 * 60, // 60s requested, below RAT minimum → clamped up
    })
    expect(recordRuntimeAccessToken).toHaveBeenCalledWith({
      ...actor,
      principalKind: "user",
      workspaceId: "ws_1",
      hostId: "host_1",
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      orgId: "org_1",
      role: "editor",
      ttlMs: 60_000,
      token: "rat_1",
      expiresAt: 2_000,
      jti: "rat_jti",
    })
  })

  test("honors in-bounds ttlMs and clamps out-of-bounds ttlMs to the signer bounds", async () => {
    const hostTunnelTokenSigner = vi.fn(async () => ({
      hostTunnelToken: "htt_1",
      tokenExpiresAt: 1_000,
      jti: "htt_jti",
    }))
    const runtimeAccessTokenSigner = vi.fn(async () => ({
      runtimeAccessToken: "rat_1",
      tokenExpiresAt: 2_000,
      jti: "rat_jti",
    }))
    const provider = createControlPlaneRelayProvider({
      relay: { relayUrl: "https://relay.test" },
      runtimeAccessTokenSigner,
      hostTunnelTokenSigner,
      targetLookup: vi.fn(),
      recordRuntimeAccessToken: vi.fn(),
    })
    const base = {
      ...actor,
      principalKind: "user" as const,
      workspaceId: "ws_1",
      hostId: "host_1",
      subject: "user_1",
      orgId: "org_1",
      role: "viewer" as const,
    }

    // In-bounds requests are honored exactly.
    await provider.mintRuntimeAccessToken({ ...runtimeBase, ttlMs: 20 * 60_000 })
    expect(runtimeAccessTokenSigner).toHaveBeenLastCalledWith(expect.objectContaining({ ttlSeconds: 20 * 60 }))
    await provider.mintHostTunnelToken({ ...hostBase, ttlMs: 5 * 60_000 })
    expect(hostTunnelTokenSigner).toHaveBeenLastCalledWith(expect.objectContaining({ ttlSeconds: 5 * 60 }))

    // Out-of-bounds requests are clamped to the signer bounds.
    await provider.mintRuntimeAccessToken({ ...runtimeBase, ttlMs: 7 * 24 * 60 * 60_000 })
    expect(runtimeAccessTokenSigner).toHaveBeenLastCalledWith(expect.objectContaining({ ttlSeconds: 60 * 60 }))
    await provider.mintHostTunnelToken({ ...hostBase, ttlMs: 1 })
    expect(hostTunnelTokenSigner).toHaveBeenLastCalledWith(expect.objectContaining({ ttlSeconds: 60 }))

    // Invalid requests fall back to the signer's own default (no ttlSeconds).
    await provider.mintRuntimeAccessToken({ ...runtimeBase, ttlMs: Number.NaN })
    expect(runtimeAccessTokenSigner).toHaveBeenLastCalledWith(expect.not.objectContaining({ ttlSeconds: expect.anything() }))
  })

  test("fails closed without org and preserves the explicit runtime role", async () => {
    const runtimeAccessTokenSigner = vi.fn(async () => ({
      runtimeAccessToken: "rat_1",
      tokenExpiresAt: 2_000,
      jti: "rat_jti",
    }))
    const provider = createControlPlaneRelayProvider({
      relay: { relayUrl: "https://relay.test" },
      runtimeAccessTokenSigner,
      hostTunnelTokenSigner: vi.fn(),
      targetLookup: vi.fn(),
      recordRuntimeAccessToken: vi.fn(),
    })

    await expect(provider.mintRuntimeAccessToken({
      ...actor,
      principalKind: "user",
      workspaceId: "ws_1",
      hostId: "host_1",
      subject: "user_1",
      role: "viewer",
      ttlMs: 60_000,
    })).rejects.toThrow("org id required")

    await provider.mintRuntimeAccessToken({
      ...actor,
      principalKind: "user",
      workspaceId: "ws_1",
      hostId: "host_1",
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      orgId: "org_1",
      role: "viewer",
      ttlMs: 60_000,
    })

    expect(runtimeAccessTokenSigner).toHaveBeenCalledTimes(1)
    expect(runtimeAccessTokenSigner).toHaveBeenLastCalledWith({
      ...actor,
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "viewer",
      ttlSeconds: 15 * 60,
    })
  })

  test("does not return an unregistered runtime token", async () => {
    const provider = createControlPlaneRelayProvider({
      relay: { relayUrl: "https://relay.test" },
      runtimeAccessTokenSigner: vi.fn(async () => ({
        runtimeAccessToken: "rat_1",
        tokenExpiresAt: 2_000,
        jti: "rat_jti",
      })),
      hostTunnelTokenSigner: vi.fn(),
      targetLookup: vi.fn(),
      recordRuntimeAccessToken: vi.fn(async () => {
        throw new Error("authority unavailable")
      }),
    })

    await expect(provider.mintRuntimeAccessToken({
      ...actor,
      principalKind: "user",
      workspaceId: "ws_1",
      hostId: "host_1",
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      orgId: "org_1",
      role: "viewer",
      ttlMs: 60_000,
    })).rejects.toThrow("authority unavailable")
  })

  test("resolves relay targets without exposing resolver failure details", async () => {
    const targetLookup = vi.fn(async (input: { workspaceId: string; hostId: string }) =>
      input.hostId === "host_ready"
        ? {
            found: true as const,
            baseUrl: "https://runtime.test/ws_1",
            access: "cloud" as const,
            backing: "cloud-vm" as const,
          }
        : {
            found: false as const,
            code: "relay_resolver_workspace_target_unavailable" as const,
          })
    const provider = createControlPlaneRelayProvider({
      relay: { relayUrl: "https://relay.test" },
      runtimeAccessTokenSigner: vi.fn(),
      hostTunnelTokenSigner: vi.fn(),
      targetLookup,
      recordRuntimeAccessToken: vi.fn(),
    })

    await expect(provider.resolveTarget("ws_1", "host_ready")).resolves.toEqual({
      workspaceId: "ws_1",
      hostId: "host_ready",
      baseUrl: "https://runtime.test/ws_1",
      access: "cloud",
      backing: "cloud-vm",
    })
    await expect(provider.resolveTarget("ws_1", "host_missing")).resolves.toBeUndefined()
  })

  test("drains workspaces through the injected transport hook and emits telemetry", async () => {
    const drainWorkspace = vi.fn(async () => {})
    const capture = vi.fn()
    const provider = createControlPlaneRelayProvider({
      relay: { relayUrl: "https://relay.test" },
      runtimeAccessTokenSigner: vi.fn(),
      hostTunnelTokenSigner: vi.fn(),
      targetLookup: vi.fn(),
      recordRuntimeAccessToken: vi.fn(),
      drainWorkspace,
      telemetry: { capture },
    })

    await provider.drainWorkspace("ws_1")

    expect(drainWorkspace).toHaveBeenCalledWith("ws_1")
    expect(capture).toHaveBeenCalledWith("system", "relay_provider.drain_workspace", { workspaceId: "ws_1" })
  })
})
