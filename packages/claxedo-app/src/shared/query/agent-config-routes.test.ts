import { describe, expect, test } from "bun:test"
import { workspaceScopedResourceList } from "./agent-config-routes"

// workspaceScopedResourceList is the single implementation of the 3-way
// transport branch shared by agentListQuery (directory.ts) and
// commandListQuery (shell.ts). These tests pin its behavior directly so a
// future change to the branch can't silently diverge between the two
// call sites without touching (and re-verifying) this one spec.

function jsonArrayParse(data: unknown) {
  return Array.isArray(data) ? data : []
}

describe("workspaceScopedResourceList", () => {
  test("non-cloud/non-user-hosted workspaces route through the central agent-config API scoped by directory and harness type when scopeCentralUrl is true", async () => {
    const calls: string[] = []
    const result = await workspaceScopedResourceList({
      baseUrl: "http://claxedo.test/",
      directory: "/tmp/ws",
      harnessType: "opencode",
      request: (async (input: string | URL | Request) => {
        calls.push(String(input))
        return new Response(JSON.stringify([{ name: "build" }]), { status: 200 })
      }) as typeof fetch,
      workspace: { workspaceId: "ws_local", directory: "/tmp/ws", kind: "local" },
      resource: { plural: "agents", singular: "agent", scopeCentralUrl: true },
      parse: jsonArrayParse,
    })

    expect(calls).toEqual(["http://claxedo.test/api/claxedo/agent-config/agents?directory=%2Ftmp%2Fws&type=opencode"])
    expect(result).toEqual([{ name: "build" }])
  })

  test("central agent-config URL omits directory and harness type when scopeCentralUrl is false", async () => {
    const calls: string[] = []
    await workspaceScopedResourceList({
      baseUrl: "http://claxedo.test/",
      directory: "/tmp/ws",
      harnessType: "opencode",
      request: (async (input: string | URL | Request) => {
        calls.push(String(input))
        return new Response(JSON.stringify([{ name: "lint" }]), { status: 200 })
      }) as typeof fetch,
      workspace: { workspaceId: "ws_local", directory: "/tmp/ws", kind: "local" },
      resource: { plural: "commands", singular: "command", scopeCentralUrl: false },
      parse: jsonArrayParse,
    })

    expect(calls).toEqual(["http://claxedo.test/api/claxedo/agent-config/commands"])
  })

  test("cloud workspaces route through the workspace-runtime transport using the resource's singular path", async () => {
    const calls: string[] = []
    const result = await workspaceScopedResourceList({
      baseUrl: "http://127.0.0.1:3001",
      directory: "/tmp/ws",
      harnessType: "opencode",
      request: (async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init)
        calls.push(req.url)
        return new Response(JSON.stringify([{ name: "plan" }]), { status: 200 })
      }) as typeof fetch,
      workspace: { workspaceId: "ws_1", directory: "/tmp/ws", kind: "cloud" },
      resource: { plural: "agents", singular: "agent", scopeCentralUrl: true },
      parse: jsonArrayParse,
    })

    expect(calls).toEqual(["http://127.0.0.1:3001/workspaces/ws_1/agent?harness=opencode"])
    expect(result).toEqual([{ name: "plan" }])
  })

  test("returns an empty list without issuing a request when a cloud workspace resolves without a workspaceId", async () => {
    let called = false
    const result = await workspaceScopedResourceList({
      baseUrl: "http://127.0.0.1:3001",
      directory: "/tmp/ws",
      request: (async () => {
        called = true
        return new Response("[]", { status: 200 })
      }) as typeof fetch,
      workspace: { workspaceId: "", directory: "/tmp/ws", kind: "cloud" },
      resource: { plural: "commands", singular: "command", scopeCentralUrl: false },
      parse: jsonArrayParse,
    })

    expect(called).toBe(false)
    expect(result).toEqual([])
  })

  test("returns an empty list when the central agent-config response is not ok", async () => {
    const result = await workspaceScopedResourceList({
      baseUrl: "http://claxedo.test",
      directory: "/tmp/ws",
      request: (async () => new Response("", { status: 404 })) as typeof fetch,
      workspace: { workspaceId: "ws_local", directory: "/tmp/ws", kind: "local" },
      resource: { plural: "agents", singular: "agent", scopeCentralUrl: true },
      parse: jsonArrayParse,
    })

    expect(result).toEqual([])
  })

  test("returns an empty list when the workspace-runtime fetch rejects", async () => {
    const result = await workspaceScopedResourceList({
      baseUrl: "http://127.0.0.1:3001",
      directory: "/tmp/ws",
      request: (async () => {
        throw new Error("network down")
      }) as typeof fetch,
      workspace: { workspaceId: "ws_1", directory: "/tmp/ws", kind: "cloud" },
      resource: { plural: "commands", singular: "command", scopeCentralUrl: false },
      parse: jsonArrayParse,
    })

    expect(result).toEqual([])
  })
})
