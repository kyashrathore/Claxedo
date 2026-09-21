import { describe, expect, mock, test } from "bun:test"
import { holdClaxedoDaemonLease } from "./server-daemon-lease"
import type { ClaxedoDaemonDiscovery } from "./server-daemon-discovery"

/** The URL of a `fetch` double's argument, whichever of the three forms it takes. */
function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input)
}

/** A `fetch` double's body. Everything under test sends a string. */
function requestBody(body: BodyInit | null | undefined): string {
  return typeof body === "string" ? body : ""
}

const discovery: ClaxedoDaemonDiscovery = {
  service: "claxedo-local-daemon",
  protocol: 1,
  generation: "generation-1",
  token: "secret-token",
  pid: 42,
  port: 2593,
  startedAt: "2026-08-27T00:00:00.000Z",
}

describe("Claxedo daemon client lease", () => {
  test("acquires, renews, and explicitly releases without exposing the token", async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null; capability: string | null }> = []
    const request = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: requestUrl(input),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
        capability: new Headers(init?.headers).get("x-claxedo-daemon-capability"),
      })
      return Response.json(
        init?.method === "DELETE" ? { released: true } : { id: "lease-1", expiresAt: Date.now() + 15_000 },
        { status: init?.method === "POST" ? 201 : 200 },
      )
    })

    const held = await holdClaxedoDaemonLease(discovery, { fetch: request, renewIntervalMs: 60_000 })
    await held.renewNow()
    await held.stop()

    expect(held).not.toHaveProperty("token")
    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ["POST", "/api/claxedo/daemon/leases"],
      ["PUT", "/api/claxedo/daemon/leases/lease-1"],
      ["DELETE", "/api/claxedo/daemon/leases/lease-1"],
    ])
    expect(calls.every((call) => call.authorization === "Bearer secret-token")).toBe(true)
    // Two presentations of one published secret: the lifecycle route reads the
    // bearer, the admission gate ahead of it reads the capability.
    expect(calls.every((call) => call.capability === "secret-token")).toBe(true)
  })

  test("reacquires instead of reviving an expired lease", async () => {
    let post = 0
    const request = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        post++
        return Response.json({ id: `lease-${String(post)}`, expiresAt: Date.now() + 15_000 }, { status: 201 })
      }
      if (init?.method === "PUT") return Response.json({}, { status: 404 })
      return Response.json({ released: true })
    })

    const held = await holdClaxedoDaemonLease(discovery, { fetch: request, renewIntervalMs: 60_000 })
    await held.renewNow()
    expect(held.id).toBe("lease-2")
    await held.stop()
  })

  test("a clean app quit releases the lease and drains the machine it was holding", async () => {
    const calls: Array<{ pathname: string; method: string; body: unknown }> = []
    const request = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const { pathname } = new URL(requestUrl(input))
      calls.push({
        pathname,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(requestBody(init.body)) : undefined,
      })
      if (init?.method === "POST" && pathname.endsWith("/leases")) {
        return Response.json({ id: "lease-1", expiresAt: Date.now() + 15_000 }, { status: 201 })
      }
      if (init?.method === undefined && pathname === "/api/claxedo/daemon/recovery") {
        return Response.json({
          scopeRevision: "rev-1",
          target: { scope: "machine", machineId: "local", ownerGeneration: "generation-1" },
        })
      }
      return Response.json({ kind: "operation" })
    })

    const held = await holdClaxedoDaemonLease(discovery, { fetch: request, renewIntervalMs: 60_000 })
    await held.drain()

    // The lease goes first: a drain submitted while this process still holds
    // one would be waiting on itself.
    expect(calls.map((call) => `${call.method} ${call.pathname}`)).toEqual([
      "POST /api/claxedo/daemon/leases",
      "DELETE /api/claxedo/daemon/leases/lease-1",
      "GET /api/claxedo/daemon/recovery",
      "POST /api/claxedo/daemon/recovery",
    ])
    expect(calls.at(-1)?.body).toMatchObject({
      action: "drain_daemon",
      scopeRevision: "rev-1",
      target: { scope: "machine", machineId: "local", ownerGeneration: "generation-1" },
      attempt: 1,
    })
  })

  test("reports a refused drain while leaving lease expiry as the crash fallback", async () => {
    const onError = mock(() => {})
    const request = mock(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST" && new URL(requestUrl(input)).pathname.endsWith("/leases")) {
        return Response.json({ id: "lease-1", expiresAt: Date.now() + 15_000 }, { status: 201 })
      }
      return Response.json({}, { status: 503 })
    })

    const held = await holdClaxedoDaemonLease(discovery, { fetch: request, onError, renewIntervalMs: 60_000 })
    await held.drain()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toContain("daemon lease release failed (503)")
  })
})
