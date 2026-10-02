/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId } from "../ids"
import { bootstrapCatalog } from "./placements"

const signedBody = {
  healthy: true,
  events: { hostAggregate: false },
  deployment: { serverKind: "daemon", issuesSessions: true, documents: false, connections: true },
  project: [
    {
      id: "proj_one",
      name: "acme/api",
      worktree: "ws_running",
      sandboxes: ["ws_running", "ws_stopped"],
      workspaces: {
        ws_running: { id: "ws_running", backing: "cloud-vm", workspace_name: "main", reachable: true, directory: "workspace:ws_running", remote_directory: "/workspace" },
        ws_stopped: { id: "ws_stopped", backing: "cloud-vm", workspace_name: "fix", reachable: false, directory: "workspace:ws_stopped" },
      },
    },
  ],
}

test("placements: a signed bootstrap places each control-plane workspace by its id, reachable as the server states", () => {
  const catalog = bootstrapCatalog(signedBody)

  expect(catalog.declaration).toEqual({ serverKind: "daemon", hostAggregate: false, issuesSessions: true, documents: false, connections: true })
  expect(catalog.placements.map(({ placement, route }) => ({ id: placement.id, kind: placement.kind, reachable: placement.reachable, route }))).toEqual([
    { id: placementId("ws_running"), kind: "cloud", reachable: true, route: { directory: "workspace:ws_running", workspaceId: "ws_running", remote: true } },
    { id: placementId("ws_stopped"), kind: "cloud", reachable: false, route: { directory: "workspace:ws_stopped", workspaceId: "ws_stopped", remote: true } },
  ])
})

test("placements: a hosted bootstrap declares the posture and places nothing", () => {
  expect(bootstrapCatalog({ events: { hostAggregate: false }, deployment: { serverKind: "hosted", issuesSessions: true } }).placements).toEqual([])
})

test("bootstrap refuses an absent or unsupported server kind instead of guessing from the origin", () => {
  for (const deployment of [{}, { serverKind: "self-hosted" }]) {
    expect(() => bootstrapCatalog({ deployment })).toThrow(expect.objectContaining({ class: "internal" }))
  }
})
