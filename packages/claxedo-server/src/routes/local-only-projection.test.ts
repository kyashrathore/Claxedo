import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import type { ClerkVerifier, ControlPlaneAuthConfig } from "../control-plane/auth"
import { localOnlyProjection } from "./local-only-projection"
import { mountLazyLocalOnlyWorkGraph, mountLocalOnlyWorkGraph } from "../server"

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

function mountedWorkGraph(input: ControlPlaneAuthConfig = localOnly) {
  const app = new Hono()
  const workgraph = new Hono()
    .get("/", (c) => c.json({ ok: true, root: true }))
    .get("/runs", (c) => c.json({ ok: true }))

  mountLocalOnlyWorkGraph(app, workgraph, {
    authConfig: input,
    verifier,
  })

  return app
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

  test("WorkGraph server mount applies the same local-only projection", async () => {
    const blocked = await mountedWorkGraph(signed).request("https://control.example.test/api/workgraph/runs", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(blocked.status).toBe(403)
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "local_only_projection_route" },
    })

    const unsigned = await mountedWorkGraph(signed).request("https://control.example.test/api/workgraph/runs")
    expect(unsigned.status).toBe(403)
    await expect(unsigned.json()).resolves.toMatchObject({
      error: { code: "local_only_projection_route" },
    })

    const loopback = await mountedWorkGraph(signed).request("http://127.0.0.1/api/workgraph/runs", {
      headers: {
        Authorization: "Bearer user_1",
        Origin: "http://localhost:4444",
      },
    })

    expect(loopback.status).toBe(200)
    await expect(loopback.json()).resolves.toEqual({ ok: true })
  })

  test("lazy WorkGraph mount rejects non-loopback requests before loading the optional app", async () => {
    const app = new Hono()
    let loads = 0
    mountLazyLocalOnlyWorkGraph(app, {
      authConfig: signed,
      verifier,
    }, async () => {
      loads++
      return new Hono().get("/runs", (c) => c.json({ ok: true }))
    })

    const blocked = await app.request("https://control.example.test/api/workgraph/runs")
    expect(blocked.status).toBe(403)
    expect(loads).toBe(0)

    const loopback = await app.request("http://localhost/api/workgraph/runs")
    expect(loopback.status).toBe(200)
    await expect(loopback.json()).resolves.toEqual({ ok: true })
    expect(loads).toBe(1)
  })
})
