import { beforeEach, describe, expect, test, vi } from "vitest"

import { localRelayTargetExists, localRelayTargetLookup } from "./internal-relay-local"

describe("local relay target lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("uses SandboxManager sandbox target before stale workspace row sandbox url", async () => {
    const touch = vi.fn(async () => ({ touched: true, status: "ready" as const }))
    const lookup = localRelayTargetLookup({
      sandboxManager: {
        target: vi.fn(async () => ({
          status: "ready",
          workspaceId: "ws_1",
          sandboxId: "sandbox_1",
          url: "https://runtime.example.test/ws_1/",
          hostId: "host_1",
          epoch: 1,
          homeRegion: "us-east",
        })),
        touch,
      } as never,
    })

    await expect(lookup({ workspaceId: "ws_1", hostId: "host_1" })).resolves.toEqual({
      found: true,
      baseUrl: "https://runtime.example.test/ws_1/",
      access: "cloud",
      backing: "cloud-vm",
    })
    await Promise.resolve()
    expect(touch).toHaveBeenCalledWith("ws_1")
  })

  test("fails closed instead of using workspace row when manager target is unavailable", async () => {
    const lookup = localRelayTargetLookup({
      sandboxManager: {
        target: vi.fn(async () => ({ status: "unavailable", reason: "runtime_lease_not_ready" })),
      } as never,
    })

    await expect(lookup({ workspaceId: "ws_1", hostId: "host_1" })).resolves.toEqual({
      found: false,
      code: "relay_resolver_workspace_target_unavailable",
    })
  })

  test("fails closed when no SandboxManager is composed", async () => {
    await expect(localRelayTargetLookup()({ workspaceId: "ws_1", hostId: "host_1" })).resolves.toEqual({
      found: false,
      code: "relay_resolver_workspace_target_unavailable",
    })
    await expect(localRelayTargetExists()({ workspaceId: "ws_1", hostId: "host_1" })).resolves.toBe(false)
  })

  test("local target existence uses SandboxManager host id when available", async () => {
    const exists = localRelayTargetExists({
      sandboxManager: {
        target: vi.fn(async () => ({
          status: "ready",
          workspaceId: "ws_1",
          sandboxId: "sandbox_1",
          url: "https://runtime.example.test/ws_1/",
          hostId: "host_1",
          epoch: 1,
          homeRegion: "us-east",
        })),
      } as never,
    })

    await expect(exists({ workspaceId: "ws_1", hostId: "host_1" })).resolves.toBe(true)
    await expect(exists({ workspaceId: "ws_1", hostId: "stale-host" })).resolves.toBe(false)
  })
})
