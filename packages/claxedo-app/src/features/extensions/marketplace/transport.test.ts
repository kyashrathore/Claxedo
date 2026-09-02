import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { createMarketplaceExtensionsRequest } from "./transport"

afterEach(() => {
  queryClient.clear()
})

const SERVER = "https://control.test"

/**
 * One stub control plane + relay. Every leg the real placement branch takes is
 * answered here and recorded, so a test asserts the WHOLE route a marketplace
 * request travels rather than an injected seam.
 */
function stubMachine(input: { kind: "local" | "cloud" | "user-hosted"; workspaceId?: string }) {
  const calls: string[] = []
  const request = (async (resource: string | URL | Request, init?: RequestInit) => {
    const req = resource instanceof Request ? resource : new Request(String(resource), init)
    calls.push(`${req.method} ${req.url}`)
    const url = new URL(req.url)
    if (url.pathname === "/api/workspace/resolve") {
      return Response.json(input.workspaceId
        ? { workspaceId: input.workspaceId, kind: input.kind, directory: "/repo/main" }
        : null, { status: input.workspaceId ? 200 : 404 })
    }
    if (url.pathname === `/api/workspace/${input.workspaceId}/connection`) {
      return Response.json({
        access: input.kind === "cloud" ? "cloud" : "user-hosted",
        backing: input.kind === "cloud" ? "cloud-vm" : "local-worktree",
        workspaceId: input.workspaceId,
        role: "owner",
        relayUrl: "https://relay.test",
        runtimeAccessToken: "rat_relay",
        tokenExpiresAt: Date.now() + 120_000,
      })
    }
    return Response.json({ desired: { installs: [] } })
  }) as typeof fetch
  return { calls, request }
}

describe("marketplace extensions transport", () => {
  test("a machine-scope list for a user-hosted workspace reaches that workspace's runtime", async () => {
    const machine = stubMachine({ kind: "user-hosted", workspaceId: "ws_host" })
    const extensions = createMarketplaceExtensionsRequest({
      directory: "/repo/main",
      serverUrl: SERVER,
      request: machine.request,
    })

    const response = await extensions({ scope: "machine", init: { headers: { Accept: "application/json" } } })

    expect(response.ok).toBe(true)
    expect(machine.calls).toContain(
      "GET https://relay.test/workspaces/ws_host/api/wr/extensions?scope=machine",
    )
    expect(machine.calls.some((call) => call.includes("/api/claxedo/agent-config/extensions"))).toBe(false)
  })

  test("a machine scan for a cloud workspace asks the sandbox, never the desktop", async () => {
    const machine = stubMachine({ kind: "cloud", workspaceId: "ws_cloud" })
    const extensions = createMarketplaceExtensionsRequest({
      directory: "/repo/main",
      serverUrl: SERVER,
      request: machine.request,
    })

    await extensions({ path: "/machine-scan", scope: "machine" })

    expect(machine.calls).toContain(
      "GET https://relay.test/workspaces/ws_cloud/api/wr/extensions/machine-scan?scope=machine",
    )
  })

  test("a local workspace keeps machine scope on the Claxedo server that serves it", async () => {
    const machine = stubMachine({ kind: "local", workspaceId: "ws_local" })
    const extensions = createMarketplaceExtensionsRequest({
      directory: "/repo/main",
      serverUrl: SERVER,
      request: machine.request,
    })

    await extensions({ scope: "machine" })

    expect(machine.calls).toContain(
      "GET https://control.test/api/claxedo/agent-config/extensions?scope=machine&workspaceId=ws_local",
    )
    expect(machine.calls.some((call) => call.startsWith("GET https://relay.test/"))).toBe(false)
  })

  test("the catalog is machine-independent and stays on the Claxedo server", async () => {
    const machine = stubMachine({ kind: "user-hosted", workspaceId: "ws_host" })
    const extensions = createMarketplaceExtensionsRequest({
      directory: "/repo/main",
      serverUrl: SERVER,
      request: machine.request,
    })

    await extensions({ path: "/catalog" })

    expect(machine.calls).toContain("GET https://relay.test/workspaces/ws_host/api/wr/extensions/catalog")
  })

  test("a directory with no workspace record stays central", async () => {
    const machine = stubMachine({ kind: "local" })
    const extensions = createMarketplaceExtensionsRequest({
      directory: "/repo/unowned",
      serverUrl: SERVER,
      request: machine.request,
    })

    await extensions({ scope: "project", directory: "/repo/unowned" })

    expect(machine.calls).toContain(
      "GET https://control.test/api/claxedo/agent-config/extensions?scope=project&directory=%2Frepo%2Funowned",
    )
  })
})
