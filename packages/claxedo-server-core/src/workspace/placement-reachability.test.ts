import { describe, expect, test } from "vitest"
import { authorityRowReachable, withAuthorityRowReachability } from "./placement-reachability"
import type { SandboxTargetResult } from "../sandbox/manager-port"

test("cloud inventory reports the authoritative lease lifecycle without starting compute", async () => {
  const targets: Record<string, SandboxTargetResult> = {
    cold: { status: "unavailable", reason: "runtime_lease_missing" },
    starting: { status: "unavailable", reason: "runtime_acquiring", leaseStatus: "acquiring" },
    stopped: { status: "unavailable", reason: "runtime_stopped", leaseStatus: "stopped" },
    failed: { status: "unavailable", reason: "provider_rejected", leaseStatus: "unavailable" },
    ready: { status: "ready", sandboxId: "box", url: "https://runtime.test", hostId: "host", epoch: 1, homeRegion: "eu" },
  }
  const calls: string[] = []
  const rows = await withAuthorityRowReachability({ target: async (id) => { calls.push(id); return targets[id] } }, [
    ...Object.keys(targets).map((workspace_id) => ({ workspace_id, backing: "cloud-vm" })),
    { workspace_id: "machine", backing: "local-worktree", host_online: true },
  ])
  expect(calls).toEqual(Object.keys(targets))
  expect(rows).toMatchObject([
    { status: "stopped", reachable: false }, { status: "provisioning", reachable: false },
    { status: "stopped", reachable: false }, { status: "failed", error: "provider_rejected", reachable: false },
    { status: "ready", reachable: true }, { reachable: true },
  ])
  expect(rows[5]).not.toHaveProperty("status")
})

describe("authorityRowReachable", () => {
  test("a cloud row answers with its sandbox lease, a machine row with its serving enrollment or this server", () => {
    const ready = new Set(["ws_cloud_up"])
    const served = new Set(["ws_mine"])
    const reach = (row: Record<string, unknown>) => authorityRowReachable(row, ready, served)

    expect(reach({ workspace_id: "ws_cloud_up", backing: "cloud-vm" })).toBe(true)
    expect(reach({ workspace_id: "ws_cloud_down", backing: "cloud-vm" })).toBe(false)
    expect(reach({ workspace_id: "ws_bare" })).toBe(false)
    expect(reach({ workspace_id: "ws_laptop", backing: "local-worktree", host_online: true })).toBe(true)
    expect(reach({ workspace_id: "ws_laptop", backing: "local-worktree", host_online: false })).toBe(false)
    expect(reach({ workspace_id: "ws_mine", backing: "local-worktree" })).toBe(true)
    expect(reach({ backing: "local-worktree", host_online: true })).toBe(false)
  })
})
