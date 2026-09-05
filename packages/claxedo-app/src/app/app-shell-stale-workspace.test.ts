import { describe, expect, test } from "bun:test"
import type { ContentMeta } from "./workbench/state"
import { applyStaleWorkspaceSweep } from "./app-shell-route-sync"

function surface(input: Partial<ContentMeta> & Pick<ContentMeta, "id" | "type">): ContentMeta {
  return input as ContentMeta
}

const inventory = [{ worktree: "/repo/kept", sandboxes: ["/repo/kept-sandbox"], workspaces: {} }]

describe("applyStaleWorkspaceSweep", () => {
  test("closes session surfaces the inventory does not know and sends an active one to the root", () => {
    const closed: Array<[string, string]> = []
    const navigated: Array<[string, { replace: boolean }]> = []
    const swept = applyStaleWorkspaceSweep({
      inventoryReady: true,
      inventory,
      activeSurfaceId: () => "gone-draft",
      surfaces: () => [
        surface({ id: "gone-draft", type: "session", sessionId: "new", directory: "/repo/wiped" }),
        surface({ id: "kept", type: "session", sessionId: "ses_1", directory: "/repo/kept" }),
        surface({ id: "kept-sandbox", type: "session", sessionId: "new", directory: "/repo/kept-sandbox" }),
        surface({ id: "global", type: "process", directory: "__process__" }),
      ],
      closeContent: (id, reason) => closed.push([id, reason]),
      navigate: (to, options) => navigated.push([to, options]),
    })
    expect(swept).toEqual(["gone-draft"])
    expect(closed).toEqual([["gone-draft", "panic"]])
    expect(navigated).toEqual([["/", { replace: true }]])
  })

  test("a stale background surface closes without touching the route", () => {
    const navigated: string[] = []
    const swept = applyStaleWorkspaceSweep({
      inventoryReady: true,
      inventory,
      activeSurfaceId: () => "kept",
      surfaces: () => [
        surface({ id: "kept", type: "session", sessionId: "ses_1", directory: "/repo/kept" }),
        surface({ id: "gone", type: "session", sessionId: "ses_2", directory: "/repo/wiped" }),
      ],
      closeContent: () => {},
      navigate: (to) => navigated.push(to),
    })
    expect(swept).toEqual(["gone"])
    expect(navigated).toEqual([])
  })

  // An empty inventory that is still loading would otherwise sweep every pane.
  test("does nothing until the inventory has loaded", () => {
    const closed: string[] = []
    const swept = applyStaleWorkspaceSweep({
      inventoryReady: false,
      inventory: [],
      activeSurfaceId: () => "draft",
      surfaces: () => [surface({ id: "draft", type: "session", sessionId: "new", directory: "/repo/anything" })],
      closeContent: (id) => closed.push(id),
      navigate: () => {},
    })
    expect(swept).toEqual([])
    expect(closed).toEqual([])
  })
})
