import { describe, expect, mock, test } from "bun:test"
import { holdClaxedoDaemonLease } from "./server-daemon-lease"
import type { ClaxedoDaemonDiscovery } from "./server-daemon-discovery"

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
    const calls: Array<{ url: string; method: string; authorization: string | null }> = []
    const request = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      })
      return Response.json(
        init?.method === "DELETE" ? { released: true } : { id: "lease-1", expiresAt: Date.now() + 15_000 },
        { status: init?.method === "POST" ? 201 : 200 },
      )
    })

    const held = await holdClaxedoDaemonLease(discovery, { request, renewIntervalMs: 60_000 })
    await held.renewNow()
    await held.stop()

    expect(held).not.toHaveProperty("token")
    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ["POST", "/api/claxedo/daemon/leases"],
      ["PUT", "/api/claxedo/daemon/leases/lease-1"],
      ["DELETE", "/api/claxedo/daemon/leases/lease-1"],
    ])
    expect(calls.every((call) => call.authorization === "Bearer secret-token")).toBe(true)
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

    const held = await holdClaxedoDaemonLease(discovery, { request, renewIntervalMs: 60_000 })
    await held.renewNow()
    expect(held.id).toBe("lease-2")
    await held.stop()
  })
})
