import { describe, expect, test } from "bun:test"
import { createIntegrationRegistry } from "./registry.js"
import { createConnectionsService } from "./service.js"
import { createIntegrationsRoutes } from "./routes.js"
import { createAttempts } from "./attempts.js"
import { createMemoryConnectionStore, createMemoryCredentialStore } from "./stores/memory.js"

function harness(gates: { gateDenies?: boolean; tokenGateDenies?: boolean; owner?: string; tokenOwner?: string } = {}) {
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
  let nextId = 0
  const service = createConnectionsService({
    registry,
    credentials,
    connections: createMemoryConnectionStore(),
    attempts: createAttempts({ sweepIntervalMs: 0 }),
    newId: () => `connection-${++nextId}`,
  })
  const app = createIntegrationsRoutes(service, {
    gate: () => (gates.gateDenies ? new Response("denied", { status: 403 }) : null),
    tokenGate: () => (gates.tokenGateDenies ? new Response("token denied", { status: 403 }) : null),
    owner: () => gates.owner,
    tokenOwner: () => gates.tokenOwner,
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

    const listing = (await (await app.request("/")).json()) as { integrations: unknown[]; connections: Array<{ id: string; status: string }> }
    expect(listing.integrations).toHaveLength(1)
    expect(listing.connections[0]).toMatchObject({ integrationId: "fake", status: "connected", accountLabel: "Acme" })

    const token = await app.request(`/connections/${listing.connections[0]!.id}/token?capability=docs`)
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
    expect((await app.request("/connections/connection-1/token?capability=channel")).status).toBe(403)
    expect((await app.request("/connections/connection-1/token")).status).toBe(403)

    await service.reportAuthFailure("connection-1", "x")
    const res = await app.request("/connections/connection-1/token?capability=docs")
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

  test("scopes connections by opaque owner and hides foreign personal rows", async () => {
    const unsigned = harness()
    const personalUnsigned = await unsigned.app.request("/fake/connect", {
      method: "POST",
      body: JSON.stringify({ ...connectBody, scope: "personal" }),
    })
    expect(personalUnsigned.status).toBe(422)
    expect((await unsigned.app.request("/fake/connect", { method: "POST", body: JSON.stringify(connectBody) })).status).toBe(200)
    const unsignedListing = await (await unsigned.app.request("/")).json() as {
      connections: Array<{ scope: string }>
      personalScopeEnabled: boolean
    }
    expect(unsignedListing.connections).toEqual([expect.objectContaining({ scope: "team" })])
    expect(unsignedListing.personalScopeEnabled).toBe(false)

    const { app, service } = harness({ owner: "user-a", tokenOwner: "user-a" })
    await app.request("/fake/connect", { method: "POST", body: JSON.stringify(connectBody) })
    await app.request("/fake/connect", { method: "POST", body: JSON.stringify({ ...connectBody, scope: "personal" }) })
    const ownerListing = await (await app.request("/")).json() as {
      connections: Array<{ id: string; scope: string }>
      personalScopeEnabled: boolean
    }
    expect(ownerListing.connections.map((connection) => connection.scope).sort()).toEqual(["personal", "team"])
    expect(ownerListing.personalScopeEnabled).toBe(true)
    const personal = ownerListing.connections.find((connection) => connection.scope === "personal")!
    expect((await app.request(`/connections/${personal.id}/token?capability=docs`)).status).toBe(200)

    const otherUser = createIntegrationsRoutes(service, { owner: () => "user-b", tokenOwner: () => "user-b" })
    const otherListing = await (await otherUser.request("/")).json() as { connections: Array<{ scope: string }> }
    expect(otherListing.connections).toEqual([expect.objectContaining({ scope: "team" })])
    expect((await otherUser.request(`/connections/${personal.id}`, { method: "DELETE" })).status).toBe(404)
    expect((await otherUser.request(`/connections/${personal.id}/reverify`, { method: "POST" })).status).toBe(404)
    expect((await otherUser.request(`/connections/${personal.id}/token?capability=docs`)).status).toBe(404)
  })

  test("reverify + auth-failure + delete flow", async () => {
    const { app } = harness()
    await app.request("/fake/connect", { method: "POST", body: JSON.stringify(connectBody) })
    expect((await app.request("/connections/connection-1/auth-failure", { method: "POST", body: JSON.stringify({ reason: "401" }) })).status).toBe(204)
    expect((await app.request("/connections/connection-1/token?capability=docs")).status).toBe(409)
    expect((await app.request("/connections/connection-1/reverify", { method: "POST" })).status).toBe(200)
    expect((await app.request("/connections/connection-1/token?capability=docs")).status).toBe(200)
    expect((await app.request("/connections/connection-1", { method: "DELETE" })).status).toBe(200)
    expect((await app.request("/connections/nope", { method: "DELETE" })).status).toBe(404)
  })

  test("token endpoint never reflects the request Origin (no CORS headers from the kit)", async () => {
    // The kit sets no CORS policy; reflecting arbitrary Origins on the token
    // route would let any allowed-by-host origin read tokens. Pin that the
    // published package emits no Access-Control-* headers itself — hosts own
    // (and are responsible for scoping) any CORS middleware.
    const { app } = harness()
    await app.request("/fake/connect", { method: "POST", body: JSON.stringify(connectBody) })
    const res = await app.request("/connections/connection-1/token?capability=docs", {
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

  test("org-partitioned team scope: team writes carry the team key and stay invisible across partitions", async () => {
    // One service/store shared by two partitioned apps — the hosted shape:
    // same deployment, two orgs.
    const { service } = harness()
    const partitioned = (org: string, subject: string) =>
      createIntegrationsRoutes(service, {
        owner: () => `user:${subject}`,
        tokenOwner: () => `user:${subject}`,
        teamOwner: () => `org:${org}`,
        tokenTeamOwner: () => `org:${org}`,
        ownerlessRows: "refuse",
      })
    const orgA = partitioned("org-a", "alice")
    const orgB = partitioned("org-b", "bob")

    // Team connect through org A's app writes the org A partition key.
    expect((await orgA.request("/fake/connect", { method: "POST", body: JSON.stringify(connectBody) })).status).toBe(200)
    const aListing = (await (await orgA.request("/")).json()) as { connections: Array<{ id: string; scope: string }> }
    expect(aListing.connections).toEqual([expect.objectContaining({ scope: "team" })])
    const teamRow = aListing.connections[0]!
    expect((await service.getById(teamRow.id))?.owner).toBe("org:org-a")

    // Every org B surface: list, delete, reverify, token, auth-failure.
    const bListing = (await (await orgB.request("/")).json()) as { connections: unknown[] }
    expect(bListing.connections).toEqual([])
    expect((await orgB.request(`/connections/${teamRow.id}`, { method: "DELETE" })).status).toBe(404)
    expect((await orgB.request(`/connections/${teamRow.id}/reverify`, { method: "POST" })).status).toBe(404)
    expect((await orgB.request(`/connections/${teamRow.id}/token?capability=docs`)).status).toBe(404)
    expect((await orgB.request(`/connections/${teamRow.id}/auth-failure`, { method: "POST", body: "{}" })).status).toBe(404)

    // Org A keeps full access to its own partition.
    expect((await orgA.request(`/connections/${teamRow.id}/token?capability=docs`)).status).toBe(200)
    expect((await orgA.request(`/connections/${teamRow.id}`, { method: "DELETE" })).status).toBe(200)
  })

  test("ownerlessRows: 'refuse' makes owner-absent rows unreachable on every surface", async () => {
    const { app: selfHost, service } = harness()
    // Seed an owner-absent (self-host team) row through the default app.
    expect((await selfHost.request("/fake/connect", { method: "POST", body: JSON.stringify(connectBody) })).status).toBe(200)
    const seeded = (await (await selfHost.request("/")).json()) as { connections: Array<{ id: string }> }
    const ownerless = seeded.connections[0]!.id

    const refusing = createIntegrationsRoutes(service, {
      owner: () => "user:alice",
      tokenOwner: () => "user:alice",
      teamOwner: () => "org:org-a",
      tokenTeamOwner: () => "org:org-a",
      ownerlessRows: "refuse",
    })
    const listing = (await (await refusing.request("/")).json()) as { connections: unknown[] }
    expect(listing.connections).toEqual([])
    expect((await refusing.request(`/connections/${ownerless}`, { method: "DELETE" })).status).toBe(404)
    expect((await refusing.request(`/connections/${ownerless}/reverify`, { method: "POST" })).status).toBe(404)
    expect((await refusing.request(`/connections/${ownerless}/token?capability=docs`)).status).toBe(404)
    expect((await refusing.request(`/connections/${ownerless}/auth-failure`, { method: "POST", body: "{}" })).status).toBe(404)

    // A refusing app without a resolved team key cannot write team rows and
    // never falls back to the owner-absent partition.
    const noTeamKey = createIntegrationsRoutes(service, {
      owner: () => "user:alice",
      ownerlessRows: "refuse",
    })
    const denied = await noTeamKey.request("/fake/connect", { method: "POST", body: JSON.stringify(connectBody) })
    expect(denied.status).toBe(422)
    expect(await denied.json()).toEqual({ ok: false, code: "team_scope_requires_team_partition" })
    // Listing without a team key surfaces personal rows only.
    const personalOnly = (await (await noTeamKey.request("/")).json()) as { connections: unknown[] }
    expect(personalOnly.connections).toEqual([])

    // The self-host app still sees its team row — untouched semantics.
    const still = (await (await selfHost.request("/")).json()) as { connections: Array<{ id: string; scope: string }> }
    expect(still.connections).toEqual([expect.objectContaining({ id: ownerless, scope: "team" })])
  })
})
