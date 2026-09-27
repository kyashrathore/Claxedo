import { createServer } from "node:http"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createSafeEndpointFetch } from "./discovery"

const received: string[] = []
const redirected: string[] = []
const destination = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  redirected.push(body)
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify({ access_token: "unexpected-token" }))
})
const endpoint = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  received.push(body)
  const url = new URL(request.url!, origin(endpoint))
  response.writeHead(Number(url.searchParams.get("status") ?? 200), {
    location: `${origin(destination)}/token`,
    "content-type": "application/json",
  })
  response.end(JSON.stringify({ access_token: "accepted-token" }))
})

function origin(server: typeof endpoint) {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeAll(async () => {
  endpoint.listen(0, "127.0.0.1")
  destination.listen(0, "127.0.0.1")
  await Promise.all([once(endpoint, "listening"), once(destination, "listening")])
})

afterAll(async () => {
  await Promise.all([endpoint, destination].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

describe("authenticated MCP endpoint fetch", () => {
  const checked = createSafeEndpointFetch(fetch, async () => { throw new Error("literal address must not resolve") })
  const grants: Record<string, string>[] = [
    { grant_type: "authorization_code", code: "test-code", code_verifier: "test-verifier" },
    { grant_type: "refresh_token", refresh_token: "test-refresh" },
    { grant_type: "client_credentials" },
  ]

  for (const grant of grants) {
    it.each([301, 302, 303, 307, 308])(`refuses %s redirects without disclosing ${grant.grant_type} credentials`, async (status) => {
      received.length = 0
      redirected.length = 0
      const body = new URLSearchParams({ ...grant, client_id: "test-client", client_secret: "test-secret" })
      const result = await checked(`${origin(endpoint)}/token?status=${status}`, {
        method: "POST", body, redirect: "follow",
      }).then((response) => response, (error: unknown) => error)
      expect(received).toEqual([body.toString()])
      expect(redirected).toEqual([])
      expect(result).toBeInstanceOf(Error)
    })
  }

  it("returns a successful token response from the approved endpoint", async () => {
    const response = await checked(`${origin(endpoint)}/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_secret: "test-secret" }),
    })
    expect(await response.json()).toEqual({ access_token: "accepted-token" })
  })

  it("refuses same-origin redirects too", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 307, headers: { location: "/other-token" } }))
    await expect(createSafeEndpointFetch(fetcher, async () => ["93.184.216.34"])(
      "https://login.example/token", { method: "POST", body: "client_secret=test-secret" },
    )).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
