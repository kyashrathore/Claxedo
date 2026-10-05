import { describe, expect, test } from "vitest"
import type { SandboxTargetResult } from "../sandbox/manager-port"
import { cloudWorkspaceLifecycles, readyCloudWorkspaces } from "./cloud-runtime-readiness"

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

  test("a lease waiting out a scheduled retry is still provisioning, and one that stopped retrying fails with its reason in words", async () => {
    const unavailable = (failure?: Extract<SandboxTargetResult, { status: "unavailable" }>["failure"]): SandboxTargetResult =>
      ({ status: "unavailable", reason: "runtime_lease_not_ready", leaseStatus: "unavailable", ...(failure ? { failure } : {}) })
    const targets: Record<string, SandboxTargetResult> = {
      ws_backoff: unavailable({ kind: "provider", message: "quota exceeded", retrying: true }),
      ws_gave_up: unavailable({ kind: "provider", message: "quota exceeded", retrying: false }),
      ws_boot: unavailable({ kind: "boot", message: "fatal: couldn't find remote ref refs/heads/missing", retrying: false }),
      ws_silent: unavailable({ kind: "unhealthy", message: "runtime_unhealthy", retrying: false }),
      ws_unknown: unavailable(),
    }
    const lifecycles = await cloudWorkspaceLifecycles(
      { target: async (id) => targets[id] },
      Object.keys(targets).map((workspace_id) => ({ workspace_id, backing: "cloud-vm" })),
    )

    expect(Object.fromEntries(lifecycles)).toEqual({
      ws_backoff: { status: "provisioning" },
      ws_gave_up: { status: "failed", error: "The cloud workspace could not start: quota exceeded" },
      ws_boot: { status: "failed", error: "The cloud workspace could not start: fatal: couldn't find remote ref refs/heads/missing" },
      ws_silent: { status: "failed", error: "The cloud workspace stopped answering" },
      ws_unknown: { status: "failed", error: "The cloud workspace is not running" },
    })
  })
})
