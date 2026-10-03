import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneServices } from "../authority/services"
import { sessionCleanupRuntimeClient } from "./cleanup-runtime-client"

const identity = { userId: "user-a", actorId: "actor-a", orgId: "org-a" }

function fixture(backing: "cloud-vm" | "local-worktree" = "local-worktree") {
  const target = vi.fn(async () => ({ status: "stopped" }))
  const ensure = vi.fn(async () => { throw new Error("Cleanup must not wake a runtime") })
  const hostTunnelResolver = vi.fn(async () => ({ active: true, hostId: "host-a", backing: "local-worktree" }))
  const openRuntimeWorkspace = vi.fn(async () => ({ allowed: true, role: "owner", workspace: { workspace_id: "workspace-a", org_id: "org-a", backing, home_region: "us-east" } }))
  const services = { authority: { openRuntimeWorkspace }, relay: { provider: { getRelayEndpoint: vi.fn(), mintRuntimeAccessToken: vi.fn() }, hostTunnelResolver }, sandbox: { sandboxManager: { target, ensure } } } as unknown as ControlPlaneServices
  return { services, target, ensure, hostTunnelResolver, openRuntimeWorkspace }
}

describe("cleanup runtime resolution", () => {
  test("opens a machine as the verified owner actor without creating signed auth", async () => {
    const f = fixture()
    await sessionCleanupRuntimeClient(f.services, identity, "workspace-a")
    expect(f.openRuntimeWorkspace).toHaveBeenCalledWith({ principalKind: "user", actorKind: "human", actorId: identity.actorId }, { workspaceId: "workspace-a" })
    expect(f.hostTunnelResolver).toHaveBeenCalledWith("workspace-a")
    expect(f.ensure).not.toHaveBeenCalled()
  })

  test("reports stopped cloud runtimes without waking them", async () => {
    const f = fixture("cloud-vm")
    await expect(sessionCleanupRuntimeClient(f.services, identity, "workspace-a")).rejects.toMatchObject({ code: "workspace_runtime_unavailable", status: 503 })
    expect(f.target).toHaveBeenCalledWith("workspace-a")
    expect(f.ensure).not.toHaveBeenCalled()
  })

  test("refuses an owner identity pointing at another organization", async () => {
    const f = fixture()
    await expect(sessionCleanupRuntimeClient(f.services, { ...identity, orgId: "org-b" }, "workspace-a")).rejects.toMatchObject({ code: "session_cleanup_access_denied", status: 403 })
    expect(f.hostTunnelResolver).not.toHaveBeenCalled()
  })
})
