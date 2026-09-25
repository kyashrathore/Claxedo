import { describe, expect, test } from "vitest"
import type { SandboxTargetResult } from "../sandbox/manager-port"
import { readyCloudWorkspaces } from "./cloud-runtime-readiness"

function manager(leases: Record<string, SandboxTargetResult["status"]>) {
  const asked: string[] = []
  return {
    asked,
    target: async (id: string): Promise<SandboxTargetResult> => {
      asked.push(id)
      return leases[id] === "ready"
        ? { status: "ready",
      routingId: "routing_test", sandboxId: id, url: "http://sandbox.test", hostId: id, epoch: 1, homeRegion: "us-east" }
        : { status: "unavailable", reason: "runtime_lease_missing" }
    },
  }
}

describe("readyCloudWorkspaces", () => {
  test("names the cloud rows whose lease is ready, and asks nothing of a machine's row", async () => {
    const leases = manager({ ws_running: "ready", ws_machine: "ready" })
    const ready = await readyCloudWorkspaces(leases, [
      { workspace_id: "ws_running", backing: "cloud-vm" },
      { workspace_id: "ws_stopped", backing: "cloud-vm" },
      { workspaceId: "ws_unplaced" },
      { workspace_id: "ws_machine", backing: "local-worktree" },
    ])

    expect([...ready]).toEqual(["ws_running"])
    expect(leases.asked.sort()).toEqual(["ws_running", "ws_stopped", "ws_unplaced"])
  })

  test("a deployment with no sandbox manager runs no cloud workspace", async () => {
    expect(await readyCloudWorkspaces(undefined, [{ workspace_id: "ws_cloud", backing: "cloud-vm" }])).toEqual(new Set())
  })
})
