import { describe, expect, test } from "vitest"
import { authorityRowReachable } from "./placement-reachability"

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
