/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId } from "../ids"
import { bootstrapCatalog } from "./placements"

const signedBody = {
  healthy: true,
  events: { hostAggregate: false },
  deployment: { serverKind: "daemon", issuesSessions: true, documents: false, connections: true },
  host: { enrollment: "enr_self", name: "Ada's MacBook" },
  project: [
    {
      id: "proj_one",
      name: "acme/api",
      worktree: "ws_running",
      sandboxes: ["ws_running", "ws_stopped"],
      workspaces: {
        ws_running: { id: "ws_running", backing: "cloud-vm", workspace_name: "main", status: "ready", reachable: true, directory: "workspace:ws_running", remote_directory: "/workspace" },
        ws_stopped: { id: "ws_stopped", backing: "cloud-vm", workspace_name: "fix", status: "stopped", reachable: false, directory: "workspace:ws_stopped" },
        ws_booting: { id: "ws_booting", backing: "cloud-vm", workspace_name: "boot", status: "provisioning", reachable: false, directory: "workspace:ws_booting" },
        ws_failed: { id: "ws_failed", backing: "cloud-vm", workspace_name: "bad", status: "failed", error: "The cloud workspace could not start: no such branch", reachable: false, directory: "workspace:ws_failed" },
        ws_unsaid: { id: "ws_unsaid", backing: "cloud-vm", workspace_name: "quiet", reachable: false, directory: "workspace:ws_unsaid" },
      },
    },
  ],
}

test("placements: a signed bootstrap places each control-plane workspace by its id, reachable and in the lifecycle the server states", () => {
  const catalog = bootstrapCatalog(signedBody)

  expect(catalog.declaration).toEqual({ serverKind: "daemon", hostAggregate: false, issuesSessions: true, documents: false, connections: true, enrollmentId: "enr_self", machineName: "Ada's MacBook" })
  expect(catalog.placements.map(({ placement, route }) => ({ id: placement.id, kind: placement.kind, reachable: placement.reachable, lifecycle: placement.kind === "cloud" ? placement.lifecycle : undefined, route }))).toEqual([
    { id: placementId("ws_running"), kind: "cloud", reachable: true, lifecycle: "live", route: { directory: "workspace:ws_running", workspaceId: "ws_running", remote: true } },
    { id: placementId("ws_stopped"), kind: "cloud", reachable: false, lifecycle: "asleep", route: { directory: "workspace:ws_stopped", workspaceId: "ws_stopped", remote: true } },
    { id: placementId("ws_booting"), kind: "cloud", reachable: false, lifecycle: "starting", route: { directory: "workspace:ws_booting", workspaceId: "ws_booting", remote: true } },
    { id: placementId("ws_failed"), kind: "cloud", reachable: false, lifecycle: "failed", route: { directory: "workspace:ws_failed", workspaceId: "ws_failed", remote: true } },
    { id: placementId("ws_unsaid"), kind: "cloud", reachable: false, lifecycle: "asleep", route: { directory: "workspace:ws_unsaid", workspaceId: "ws_unsaid", remote: true } },
  ])
  for (const { placement } of catalog.placements) {
    expect(placement.onThisMachine).toBe(false)
    expect(placement.machineId).toBeUndefined()
  }
})

test("placements: a hosted bootstrap declares the posture and places nothing", () => {
  expect(bootstrapCatalog({ events: { hostAggregate: false }, deployment: { serverKind: "hosted", issuesSessions: true } }).placements).toEqual([])
})

test("bootstrap refuses an absent or unsupported server kind instead of guessing from the origin", () => {
  for (const deployment of [{}, { serverKind: "self-hosted" }]) {
    expect(() => bootstrapCatalog({ deployment })).toThrow(expect.objectContaining({ class: "internal" }))
  }
})
