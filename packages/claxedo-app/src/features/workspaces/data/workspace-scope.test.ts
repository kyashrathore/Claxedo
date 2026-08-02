import { describe, expect, test } from "bun:test"
import { createWorkspaceScopeCache, createWorkspaceScopes, distinctWorkspaceIds } from "./workspace-scope"

describe("workspace scope registry", () => {
  test("deduplicates open workspace ids", () => {
    expect(distinctWorkspaceIds(["ws_1", undefined, "ws_1", "", "ws_2"])).toEqual(["ws_1", "ws_2"])
  })

  test("mounts one scope per distinct open workspace id", () => {
    const scopes = createWorkspaceScopes(["ws_1", "ws_2", "ws_1"])

    expect(scopes.get("ws_1")?.workspaceId).toBe("ws_1")
    expect(scopes.get("ws_2")?.workspaceId).toBe("ws_2")
  })

  test("keeps one scope per workspace id across host updates", () => {
    const scopesFor = createWorkspaceScopeCache()

    const first = scopesFor(["ws_1", "ws_2", "ws_1"])
    const second = scopesFor(["ws_2", "ws_1"])
    const third = scopesFor(["ws_2"])
    const fourth = scopesFor(["ws_1", "ws_2"])

    expect(second.get("ws_1")).toBe(first.get("ws_1"))
    expect(second.get("ws_2")).toBe(first.get("ws_2"))
    expect(third.has("ws_1")).toBe(false)
    expect(fourth.get("ws_1")).toBe(first.get("ws_1"))
  })
})
