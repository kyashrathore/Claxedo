import { describe, expect, test } from "bun:test"
import {
  createWorkspaceConnectionLeaseCache,
  createWorkspaceScopeCache,
  createWorkspaceScopes,
  distinctWorkspaceIds,
} from "./workspace-scope"

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

  test("retains one connection lease across session mounts in the same workspace", () => {
    const releases: Array<() => void> = []
    const inputs: string[] = []
    const leases = createWorkspaceConnectionLeaseCache((input) => {
      inputs.push(`${input.workspaceId}:${input.kind}:${input.directory}`)
      const release = () => releases.splice(releases.indexOf(release), 1)
      releases.push(release)
      return { release }
    })
    const input = {
      workspaceId: "ws_1",
      kind: "cloud" as const,
      directory: "/workspace",
    }

    // Two different session gates present the same workspace input. The
    // workspace owner acquires once; session identity is not part of the key.
    leases.retain(input)
    leases.retain({ ...input })

    expect(inputs).toEqual(["ws_1:cloud:/workspace"])
    expect(leases.size()).toBe(1)
    expect(releases).toHaveLength(1)

    leases.releaseMissing(["ws_1"])
    expect(releases).toHaveLength(1)
    leases.releaseMissing([])
    expect(releases).toHaveLength(0)
    expect(leases.size()).toBe(0)
  })

  test("refines a workspace lease without dropping the authority between handles", () => {
    const events: string[] = []
    let sequence = 0
    const leases = createWorkspaceConnectionLeaseCache((input) => {
      const handle = ++sequence
      events.push(`acquire:${handle}:${input.kind}`)
      return { release: () => events.push(`release:${handle}`) }
    })

    leases.retain({ workspaceId: "ws_1", kind: "user-hosted" })
    leases.retain({ workspaceId: "ws_1", kind: "cloud", directory: "/workspace" })

    expect(events).toEqual([
      "acquire:1:user-hosted",
      "acquire:2:cloud",
      "release:1",
    ])
    expect(leases.size()).toBe(1)
  })
})
