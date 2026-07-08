import { describe, expect, test } from "bun:test"
import { createIntegrationRegistry } from "./registry.js"
import { createConnectionsService } from "./service.js"
import { createIntegrationsRoutes } from "./routes.js"
import { createAttempts } from "./attempts.js"
import { createMemoryConnectionStore, createMemoryCredentialStore } from "./stores/memory.js"

function harness(gates: { gateDenies?: boolean; tokenGateDenies?: boolean } = {}) {
  const registry = createIntegrationRegistry()
  registry.register(
    {
      id: "fake",
      name: "Fake",
      methods: ["key"],
      capabilities: ["docs"],
      keyTokenType: "basic",
      prompts: [
        { id: "site_url", label: "Site" },
        { id: "token", label: "Token", secret: true },
      ],
    },
    { verify: async (_f, secret) => (secret === "good" ? { ok: true, accountLabel: "Acme" } : { ok: false, reason: "unauthorized" }) },
  )
  const credentials = createMemoryCredentialStore()
  const service = createConnectionsService({
    registry,
    credentials,
    connections: createMemoryConnectionStore(),
    attempts: createAttempts({ sweepIntervalMs: 0 }),
  })
  const app = createIntegrationsRoutes(service, {
    gate: () => (gates.gateDenies ? new Response("denied", { status: 403 }) : null),
    tokenGate: () => (gates.tokenGateDenies ? new Response("token denied", { status: 403 }) : null),
  })
  return { app, service, credentials }
}

const connectBody = { fields: { site_url: "https://acme.example" }, secret: "good" }

describe("integrations routes", () => {
  test("gate runs on every gated route", async () => {
    const { app } = harness({ gateDenies: true })
    for (const [method, path] of [
      ["GET", "/"],
      ["POST", "/fake/connect"],
      ["GET", "/attempts/x"],
      ["DELETE", "/connections/fake"],
      ["POST", "/connections/fake/reverify"],
      ["POST", "/connections/fake/auth-failure"],
      ["GET", "/connections/fake/token?capability=docs"],
    ] as const) {
      const res = await app.request(path, { method, ...(method === "POST" ? { body: "{}" } : {}) })
      expect(res.status).toBe(403)
    }
  })

  test("tokenGate additionally guards token and auth-failure routes only", async () => {
    const { app } = harness({ tokenGateDenies: true })
    expect((await app.request("/", { method: "GET" })).status).toBe(200)
    expect((await app.request("/connections/fake/token?capability=docs")).status).toBe(403)
    expect((await app.request("/connections/fake/auth-failure", { method: "POST", body: "{}" })).status).toBe(403)
  })

  test("connect + list + token happy path with frozen response shape", async () => {
    const { app } = harness()
    const connect = await app.request("/fake/connect", {
      method: "POST",
      body: JSON.stringify(connectBody),
    })
    expect(connect.status).toBe(200)

    const listing = (await (await app.request("/")).json()) as { integrations: unknown[]; connections: Array<{ status: string }> }
    expect(listing.integrations).toHaveLength(1)
    expect(listing.connections[0]).toMatchObject({ integrationId: "fake", status: "connected", accountLabel: "Acme" })

    const token = await app.request("/connections/fake/token?capability=docs")
    expect(token.status).toBe(200)
    expect(await token.json()).toEqual({
      token: "good",
      tokenType: "basic",
      fields: { site_url: "https://acme.example" },
    })
  })

  test("token endpoint error contract: 404 unknown, 403 ungranted, 409 non-available", async () => {
    const { app, service } = harness()
    expect((await app.request("/connections/nope/token?capability=docs")).status).toBe(404)

    await app.request("/fake/connect", { method: "POST", body: JSON.stringify(connectBody) })
    expect((await app.request("/connections/fake/token?capability=channel")).status).toBe(403)
    expect((await app.request("/connections/fake/token")).status).toBe(403)

    await service.reportAuthFailure("fake", "x")
    const res = await app.request("/connections/fake/token?capability=docs")
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ code: "connection_not_available", status: "error" })
  })

  test("connect conflicts and verify failures never echo the secret", async () => {
    const { app } = harness()
    const bad = await app.request("/fake/connect", {
      method: "POST",
      body: JSON.stringify({ fields: {}, secret: "sk-hidden-1234" }),
    })
    expect(bad.status).toBe(422)
    expect(await bad.text()).not.toContain("sk-hidden-1234")

    await app.request("/fake/connect", { method: "POST", body: JSON.stringify(connectBody) })
    const conflict = await app.request("/fake/connect", { method: "POST", body: JSON.stringify(connectBody) })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ ok: false, code: "connection_exists" })
  })

  test("reverify + auth-failure + delete flow", async () => {
    const { app } = harness()
    await app.request("/fake/connect", { method: "POST", body: JSON.stringify(connectBody) })
    expect((await app.request("/connections/fake/auth-failure", { method: "POST", body: JSON.stringify({ reason: "401" }) })).status).toBe(204)
    expect((await app.request("/connections/fake/token?capability=docs")).status).toBe(409)
    expect((await app.request("/connections/fake/reverify", { method: "POST" })).status).toBe(200)
    expect((await app.request("/connections/fake/token?capability=docs")).status).toBe(200)
    expect((await app.request("/connections/fake", { method: "DELETE" })).status).toBe(200)
    expect((await app.request("/connections/nope", { method: "DELETE" })).status).toBe(404)
  })

  test("token endpoint never reflects the request Origin (no CORS headers from the kit)", async () => {
    // The kit sets no CORS policy; reflecting arbitrary Origins on the token
    // route would let any allowed-by-host origin read tokens. Pin that the
    // published package emits no Access-Control-* headers itself — hosts own
    // (and are responsible for scoping) any CORS middleware.
    const { app } = harness()
    await app.request("/fake/connect", { method: "POST", body: JSON.stringify(connectBody) })
    const res = await app.request("/connections/fake/token?capability=docs", {
      headers: { Origin: "http://localhost:6666" },
    })
    expect(res.status).toBe(200)
    for (const [name, value] of res.headers) {
      expect(name.toLowerCase().startsWith("access-control-")).toBe(false)
      expect(value).not.toContain("http://localhost:6666")
    }
  })

  test("callback renders static pages and rejects unknown state", async () => {
    const { app } = harness()
    const res = await app.request("/callback?state=unknown&code=x")
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain("Connection failed")
    expect(html).not.toContain("unknown") // never echoes request params
  })
})
