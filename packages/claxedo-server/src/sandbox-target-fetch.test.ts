import { afterEach, describe, expect, test, vi } from "vitest"
import type { Workspace } from "./workspace-store"

import { sandboxFetch } from "./sandbox-target-fetch"

describe("sandboxFetch", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.clearAllMocks()
  })

  test("uses SandboxManager target identity through Relay for cloud workspace requests when composed", async () => {
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "ready" as const,
        workspaceId: "ws_1",
        sandboxId: "sb_1",
        hostId: "host_1",
        url: "https://runtime-manager.test/base/",
        epoch: 1,
        homeRegion: "eu-west" as const,
      })),
    }
    const relayProvider = {
      mintRuntimeAccessToken: vi.fn(async () => ({ token: "relay-runtime-token", expiresAt: 123, jti: "jti_1" })),
      getRelayEndpoint: vi.fn(async () => "https://relay.example.test"),
    }
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as never

    const res = await sandboxFetch(
      {
        id: "ws_1",
        org_id: "org_1",
        kind: "cloud",
        directory: "/workspace",
        created_at: 1,
        updated_at: 1,
      } as Workspace,
      "/api/wr/health?probe=1",
      { headers: { accept: "application/json" } },
      {
        sandboxManager: sandboxManager as never,
        relayProvider: relayProvider as never,
        defaultHomeRegion: "eu-west",
      },
    )

    expect(res.status).toBe(200)
    expect(sandboxManager.ensure).toHaveBeenCalledWith("ws_1", { homeRegion: "eu-west" })
    expect(relayProvider.mintRuntimeAccessToken).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      hostId: "host_1",
      subject: "control-plane",
      orgId: "org_1",
      role: "owner",
      ttlMs: 10 * 60_000,
    })
    expect(relayProvider.getRelayEndpoint).toHaveBeenCalledWith("ws_1", "eu-west")
    const call = (globalThis.fetch as never as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call[0])).toBe("https://relay.example.test/workspaces/ws_1/api/wr/health?probe=1")
    const headers = new Headers((call[1] as RequestInit).headers)
    expect(headers.get("authorization")).toBe("Bearer relay-runtime-token")
    expect(headers.get("x-opencode-directory")).toBe("workspace:ws_1")
    expect(headers.get("accept-encoding")).toBe("identity")
  })

  test("fails closed for cloud workspace requests without a SandboxManager", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as never

    await expect(sandboxFetch(
      {
        id: "ws_legacy",
        kind: "cloud",
        directory: "/workspace",
        created_at: 1,
        updated_at: 1,
      } as Workspace,
      "/api/wr/health",
    )).rejects.toThrow("sandbox manager unavailable: ws_legacy")

    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test("fails closed for cloud workspace requests without a Relay provider", async () => {
    const sandboxManager = {
      ensure: vi.fn(async () => ({
        status: "ready" as const,
        workspaceId: "ws_legacy",
        sandboxId: "sb_1",
        hostId: "host_1",
        url: "https://runtime-manager.test/base/",
        epoch: 1,
        homeRegion: "us-east" as const,
      })),
    }
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as never

    await expect(sandboxFetch(
      {
        id: "ws_legacy",
        org_id: "org_1",
        kind: "cloud",
        directory: "/workspace",
        created_at: 1,
        updated_at: 1,
      } as Workspace,
      "/api/wr/health",
      undefined,
      { sandboxManager: sandboxManager as never },
    )).rejects.toThrow("workspace relay provider unavailable: ws_legacy")

    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
