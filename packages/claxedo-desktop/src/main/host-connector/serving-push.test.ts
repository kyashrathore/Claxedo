import { describe, expect, test } from "bun:test"

import { setupHostServingPush } from "./serving-push"

const JWKS = "https://relay.test/.well-known/jwks.json"
const AUTHORITY = "https://control-plane.test/api/runtime-authority/session-authorize"
const TUNNEL = { hostTunnelToken: "htt.1", hostId: "host_1", relayUrl: "https://relay.test" }

function harness(options: { respond?: () => Response; serverUrl?: () => Promise<string> } = {}) {
  const requests: Array<{ url: string; method?: string; body: unknown }> = []
  const logged: string[] = []
  const push = setupHostServingPush({
    serverUrl: options.serverUrl ?? (async () => "http://127.0.0.1:4000"),
    request: async (url, init) => {
      requests.push({
        url,
        ...(typeof init?.method === "string" ? { method: init.method } : {}),
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body,
      })
      return options.respond?.() ?? new Response("{}", { status: 200 })
    },
    log: { info: (message) => logged.push(`info ${message}`), warn: (message) => logged.push(`warn ${message}`) },
  })
  return {
    push,
    requests,
    logged,
    body: () => requests.at(-1)?.body,
  }
}

describe("the serving push", () => {
  test("PUTs the credential and both addresses to the daemon", async () => {
    const host = harness()

    await host.push({ tunnel: TUNNEL, endpoints: { relayJwksUrl: JWKS, sessionAuthorityUrl: AUTHORITY } })

    expect(host.requests).toHaveLength(1)
    expect(host.requests[0]?.url).toBe("http://127.0.0.1:4000/api/claxedo/host-serving")
    expect(host.requests[0]?.method).toBe("PUT")
    expect(host.body()).toEqual({
      credential: TUNNEL,
      endpoints: { relayJwksUrl: JWKS, sessionAuthorityUrl: AUTHORITY },
    })
  })

  test("omits the field entirely when the ack named no address", async () => {
    // The serving route's body is strict and its endpoints are optional; an
    // explicit `endpoints: undefined` is not what "the ack named none" means.
    const host = harness()

    await host.push({ tunnel: TUNNEL })

    expect(host.body()).toEqual({ credential: TUNNEL })
  })

  test("withdraws serving with a null credential", async () => {
    const host = harness()

    await host.push({ tunnel: null })

    expect(host.body()).toEqual({ credential: null })
  })

  test("reports which addresses the daemon was given, and what it answered", async () => {
    const host = harness({ respond: () => new Response("invalid_request_body", { status: 400 }) })

    await host.push({ tunnel: TUNNEL, endpoints: { sessionAuthorityUrl: AUTHORITY } })

    expect(host.logged).toEqual([
      "info [host-serving] pushed credential=present endpoints=sessionAuthorityUrl -> 400 invalid_request_body",
    ])
  })

  test("a daemon that never answers is reported, not thrown at the heartbeat", async () => {
    const host = harness({
      serverUrl: async () => {
        throw new Error("claxedo-server failed to start")
      },
    })

    await host.push({ tunnel: TUNNEL })

    expect(host.requests).toEqual([])
    expect(host.logged).toEqual(["warn [host-serving] push failed: Error: claxedo-server failed to start"])
  })
})
