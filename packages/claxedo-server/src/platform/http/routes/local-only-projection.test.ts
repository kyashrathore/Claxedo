import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { describe, expect, test } from "vitest"
import type { ClerkVerifier, ControlPlaneAuthConfig } from "../../auth/auth"
import { localOnlyProjection } from "./local-only-projection"
import { isLoopbackLocalRequest, peerAddressStamp, requestPeerAddress, stampRequestPeerAddress } from "./peer-address"

const signed = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
} as const

const localOnly = {
  enabled: false,
  mode: "local-only",
  reason: "signed/cloud auth is disabled",
} as const

const misconfigured = {
  enabled: false,
  mode: "misconfigured",
  reason: "missing signed auth config",
} as const

const verifier: ClerkVerifier = async (token, config) => ({
  mode: "signed",
  user: {
    subject: token,
    tokenIdentifier: `${config.issuer}|${token}`,
    issuer: config.issuer,
  },
})

function app(input: ControlPlaneAuthConfig = localOnly) {
  return new Hono()
    .use("/api/workgraph", localOnlyProjection({
      authConfig: input,
      verifier,
      label: "WorkGraph",
    }))
    .use("/api/workgraph/*", localOnlyProjection({
      authConfig: input,
      verifier,
      label: "WorkGraph",
    }))
    .get("/api/workgraph", (c) => c.json({ ok: true, root: true }))
    .get("/api/workgraph/runs", (c) => c.json({ ok: true }))
}

describe("local-only projection middleware", () => {
  test("allows unsigned Local Personal Mode", async () => {
    const res = await app().request("http://localhost/api/workgraph/runs")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  test("allows loopback local browser access even with bearer auth attached", async () => {
    const res = await app(signed).request("http://127.0.0.1/api/workgraph/runs", {
      headers: {
        Authorization: "Bearer user_1",
        Origin: "http://localhost:4444",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  test("blocks non-loopback bearer access even when signed auth is disabled", async () => {
    const res = await app().request("https://control.example.test/api/workgraph/runs", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "local_only_projection_route" },
    })
  })

  test("blocks non-loopback unsigned access", async () => {
    const res = await app().request("https://control.example.test/api/workgraph/runs")

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "local_only_projection_route" },
    })
  })

  test("blocks exact projection roots as well as child routes", async () => {
    const res = await app().request("https://control.example.test/api/workgraph", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "local_only_projection_route" },
    })
  })

  test("signed mode still allows unsigned Local Personal Mode", async () => {
    const res = await app(signed).request("http://localhost/api/workgraph/runs")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  test("signed mode rejects verified users instead of returning local rows over non-loopback access", async () => {
    const res = await app(signed).request("https://control.example.test/api/workgraph/runs", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "local_only_projection_route" },
    })
  })

  test("signed auth misconfiguration still allows unsigned Local Personal Mode", async () => {
    const res = await app(misconfigured).request("http://localhost/api/workgraph/runs")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  test("external-bind regression: Host: 127.0.0.1 from a non-loopback peer is not local", async () => {
    // With CLAXEDO_SERVER_HOST=0.0.0.0 a remote client controls the Host
    // header; only the transport peer address is trustworthy.
    const request = new Request("http://127.0.0.1/api/workgraph/runs")
    stampRequestPeerAddress(request, { incoming: { socket: { remoteAddress: "203.0.113.7" } } })
    expect(isLoopbackLocalRequest(request)).toBe(false)
  })

  test("loopback peer with loopback Host stays local", async () => {
    for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const request = new Request("http://localhost/api/workgraph/runs")
      stampRequestPeerAddress(request, { incoming: { socket: { remoteAddress } } })
      expect(isLoopbackLocalRequest(request)).toBe(true)
    }
  })

  test("never treats forwarded traffic as unsigned local", async () => {
    const request = new Request("http://127.0.0.1/api/workgraph/runs", {
      headers: { "x-forwarded-for": "198.51.100.9, 127.0.0.1" },
    })
    stampRequestPeerAddress(request, { incoming: { socket: { remoteAddress: "127.0.0.1" } } })
    expect(isLoopbackLocalRequest(request)).toBe(false)

    const localForward = new Request("http://127.0.0.1/api/workgraph/runs", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    })
    stampRequestPeerAddress(localForward, { incoming: { socket: { remoteAddress: "127.0.0.1" } } })
    expect(isLoopbackLocalRequest(localForward)).toBe(false)

    const spoofedChain = new Request("http://127.0.0.1/api/workgraph/runs", {
      headers: { "x-forwarded-for": "127.0.0.2, 203.0.113.7" },
    })
    stampRequestPeerAddress(spoofedChain, { incoming: { socket: { remoteAddress: "127.0.0.1" } } })
    expect(isLoopbackLocalRequest(spoofedChain)).toBe(false)

    for (const header of [
      "forwarded",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
      "cf-connecting-ip",
      "true-client-ip",
    ]) {
      const forwarded = new Request("http://localhost/api/workgraph/runs", {
        headers: { [header]: "127.0.0.1" },
      })
      stampRequestPeerAddress(forwarded, { incoming: { socket: { remoteAddress: "127.0.0.1" } } })
      expect(isLoopbackLocalRequest(forwarded)).toBe(false)
    }
  })

  test("peerAddressStamp middleware records env.incoming for gates behind it", async () => {
    const app = new Hono()
      .use(peerAddressStamp())
      .use("/api/workgraph/*", localOnlyProjection({ authConfig: localOnly, verifier, label: "WorkGraph" }))
      .get("/api/workgraph/runs", (c) => c.json({ ok: true }))

    const spoofed = await app.request(
      "http://127.0.0.1/api/workgraph/runs",
      {},
      { incoming: { socket: { remoteAddress: "203.0.113.7" } } },
    )
    expect(spoofed.status).toBe(403)

    const local = await app.request(
      "http://127.0.0.1/api/workgraph/runs",
      {},
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    )
    expect(local.status).toBe(200)
  })

  test("pins @hono/node-server socket exposure over a real TCP connection", async () => {
    // Guards the Symbol("incomingKey") fallback in requestPeerAddress: if a
    // node-server upgrade stops exposing the IncomingMessage on the Request,
    // this fails loudly instead of silently degrading to Host-header trust.
    const app = new Hono().get("/peer", (c) =>
      c.json({ peer: requestPeerAddress(c.req.raw) ?? null, local: isLoopbackLocalRequest(c.req.raw) }),
    )
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
    try {
      await new Promise<void>((resolve) => server.on("listening", () => resolve()))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("expected socket address")
      const res = await fetch(`http://127.0.0.1:${address.port}/peer`)
      const body = (await res.json()) as { peer: string | null; local: boolean }
      expect(body.peer).not.toBeNull()
      expect(["127.0.0.1", "::ffff:127.0.0.1", "::1"]).toContain(body.peer)
      expect(body.local).toBe(true)
    } finally {
      server.close()
    }
  })

})
