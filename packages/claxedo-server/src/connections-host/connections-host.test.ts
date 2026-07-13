import { describe, expect, test, beforeEach, afterAll, vi } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `connections-host-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("../credentials/store")
const registry = await import("../credentials/registry")
const { ClaxedoDB } = await import("../storage/db")
ClaxedoDB.Drizzle()

const { createConnectionsHost, CONNECTIONS_TOKEN_HEADER } = await import("./connections-host")
const { createConnectionStoreAdapter, createCredentialStoreAdapter } = await import("./store-adapter")
const { CONNECTION_TURN_HEADER, createConnectionTurnCredentials } = await import("./turn-credentials")
import type { ControlPlaneCredentials } from "../control-plane/services"

function credentialsPort(): ControlPlaneCredentials {
  return {
    listCredentials: async () => registry.listCredentials(),
    getCredentialByProvider: async (providerId) => registry.getCredentialByProvider(providerId),
    resolveCredentialSecret: (providerId) => registry.resolveSecret(providerId),
    putCredential: (input) => registry.putCredential(input),
    deleteCredential: async (id) => registry.deleteCredential(id),
    deleteCredentialsByProvider: async (providerId) => registry.deleteCredentialsByProvider(providerId),
    updateCredentialStatus: async (id, status, error) => registry.updateCredentialStatus(id, status, error),
    syncLocalCredentials: async () => ({ synced: [], removed: [] }) as never,
  }
}

describe("connections host", () => {
  beforeEach(() => {
    setBackendOverride(createTestBackend())
    ClaxedoDB.use((db) => db.run(`DELETE FROM claxedo_connection`))
  })

  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("store adapters round-trip: connection rows + namespaced credential", async () => {
    const connections = createConnectionStoreAdapter()
    await connections.upsert({
      id: "connection-notion",
      integrationId: "notion",
      accountLabel: "Acme Bot",
      grantedCapabilities: ["docs"],
      fields: { workspace: "acme" },
      createdAt: 1,
      updatedAt: 2,
    })
    expect(await connections.get("notion")).toMatchObject({
      integrationId: "notion",
      accountLabel: "Acme Bot",
      grantedCapabilities: ["docs"],
      fields: { workspace: "acme" },
    })
    expect(await connections.list()).toHaveLength(1)

    const credentials = createCredentialStoreAdapter(credentialsPort())
    await credentials.put({ providerId: "integration:connection-notion", kind: "api_key", secret: "ntn-123" })
    expect(await credentials.get("integration:connection-notion")).toMatchObject({ kind: "api_key", status: "available" })
    expect(await credentials.resolveSecret("integration:connection-notion")).toBe("ntn-123")

    // readSecret works across a non-available status (re-verify path).
    await credentials.setStatus("integration:connection-notion", "error", "auth_failure_reported")
    expect(await credentials.resolveSecret("integration:connection-notion")).toBeNull()
    expect(await credentials.readSecret("integration:connection-notion")).toBe("ntn-123")

    await credentials.deleteByProvider("integration:connection-notion")
    expect(await credentials.get("integration:connection-notion")).toBeUndefined()
    expect(await connections.delete("connection-notion")).toBe(true)
    expect(await connections.delete("connection-notion")).toBe(false)
  })

  test("connection credentials stay out of the shared fanout", async () => {
    const credentials = createCredentialStoreAdapter(credentialsPort())
    await credentials.put({ providerId: "integration:github", kind: "api_key", secret: "ghp-secret" })
    await registry.putCredential({ provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-1" })
    expect(await registry.resolveSecretsForScope("shared")).toEqual({ openai: "sk-1" })
  })

  test("gates: loopback required in unsigned-local; token routes need the header", async () => {
    const host = createConnectionsHost({ credentials: credentialsPort(), env: {} })

    // Non-loopback origin → gated (unsigned-local auth resolves only for loopback).
    const remote = await host.routes.request("http://relay.example/")
    expect(remote.status).toBeGreaterThanOrEqual(401)

    // Loopback list passes the gate.
    const local = await host.routes.request("http://127.0.0.1/")
    expect(local.status).toBe(200)
    const body = (await local.json()) as { integrations: Array<{ id: string }> }
    expect(body.integrations.map((integration) => integration.id).sort()).toEqual(["atlassian", "github", "linear", "notion"])

    // Token endpooint: loopback without header → 403; with header → 404 (no connection).
    const noHeader = await host.routes.request("http://127.0.0.1/connections/notion/token?capability=docs")
    expect(noHeader.status).toBe(403)
    expect(await noHeader.json()).toEqual({ code: "connections_header_required" })

    const withHeader = await host.routes.request("http://127.0.0.1/connections/notion/token?capability=docs", {
      headers: { [CONNECTIONS_TOKEN_HEADER]: "1" },
    })
    expect(withHeader.status).toBe(404)

    // Token endpoint from non-loopback → 403 loopback_required even with header.
    const remoteToken = await host.routes.request("http://relay.example/connections/notion/token?capability=docs", {
      headers: { [CONNECTIONS_TOKEN_HEADER]: "1" },
    })
    expect(remoteToken.status).toBe(403)
    host.dispose()
  })

  test("gates: spoofed Host: 127.0.0.1 from a non-loopback peer never reaches credential routes", async () => {
    // External-bind regression (CLAXEDO_SERVER_HOST=0.0.0.0): the Host header
    // is client-controlled, so the gate must also verify the socket peer.
    const host = createConnectionsHost({ credentials: credentialsPort(), env: {} })
    const remoteEnv = { incoming: { socket: { remoteAddress: "203.0.113.7" } } }

    const list = await host.routes.request("http://127.0.0.1/", {}, remoteEnv)
    expect(list.status).toBeGreaterThanOrEqual(401)

    const token = await host.routes.request(
      "http://127.0.0.1/connections/notion/token?capability=docs",
      { headers: { [CONNECTIONS_TOKEN_HEADER]: "1" } },
      remoteEnv,
    )
    expect(token.status).toBe(403)
    expect(await token.json()).toEqual({ code: "connections_loopback_required" })

    // Same request from a genuine loopback peer still passes the gates.
    const localToken = await host.routes.request(
      "http://127.0.0.1/connections/notion/token?capability=docs",
      { headers: { [CONNECTIONS_TOKEN_HEADER]: "1" } },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    )
    expect(localToken.status).toBe(404)
    host.dispose()
  })

  test("signed subjects see and manage only their own personal connections", async () => {
    const host = createConnectionsHost({
      credentials: credentialsPort(),
      env: {},
      authConfig: { enabled: true, issuer: "https://issuer.example", jwksUrl: "https://issuer.example/jwks" },
      verifier: async (token) => ({
        mode: "signed",
        user: { subject: token, tokenIdentifier: token, issuer: "https://issuer.example" },
      }),
    })
    const connections = createConnectionStoreAdapter()
    await connections.upsert({
      id: "team-notion",
      integrationId: "notion",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await connections.upsert({
      id: "user-a-notion",
      integrationId: "notion",
      owner: "user-a",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })

    const listFor = async (subject: string) =>
      await (await host.routes.request("http://relay.example/", { headers: { authorization: `Bearer ${subject}` } })).json() as {
        connections: Array<{ id: string; scope: string }>
      }

    expect((await listFor("user-a")).connections.map((connection) => connection.id).sort()).toEqual(["team-notion", "user-a-notion"])
    expect((await listFor("user-b")).connections.map((connection) => connection.id)).toEqual(["team-notion"])
    expect((await (await host.routes.request("http://127.0.0.1/")).json() as { connections: Array<{ id: string }> }).connections)
      .toEqual([expect.objectContaining({ id: "team-notion" })])

    const forbiddenDelete = await host.routes.request("http://relay.example/connections/user-a-notion", {
      method: "DELETE",
      headers: { authorization: "Bearer user-b" },
    })
    expect(forbiddenDelete.status).toBe(404)
    const forbiddenReverify = await host.routes.request("http://relay.example/connections/user-a-notion/reverify", {
      method: "POST",
      headers: { authorization: "Bearer user-b" },
    })
    expect(forbiddenReverify.status).toBe(404)
    host.dispose()
  })

  test("token resolution requires a valid subject-bearing turn credential for personal rows", async () => {
    const turns = createConnectionTurnCredentials()
    const host = createConnectionsHost({ credentials: credentialsPort(), env: {}, turnCredentials: turns })
    const connections = createConnectionStoreAdapter()
    const credentials = createCredentialStoreAdapter(credentialsPort())
    await connections.upsert({
      id: "team-notion",
      integrationId: "notion",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await connections.upsert({
      id: "user-a-notion",
      integrationId: "notion",
      owner: "user-a",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await credentials.put({ providerId: "integration:team-notion", kind: "api_key", secret: "team-token" })
    await credentials.put({ providerId: "integration:user-a-notion", kind: "api_key", secret: "personal-token" })

    const token = async (id: string, turn?: string) =>
      await host.routes.request(`http://127.0.0.1/connections/${id}/token?capability=docs`, {
        headers: {
          [CONNECTIONS_TOKEN_HEADER]: "1",
          ...(turn ? { [CONNECTION_TURN_HEADER]: turn } : {}),
        },
      })

    expect((await token("user-a-notion")).status).toBe(404)
    const interactive = turns.mint({ sessionId: "session-1", subject: "user-a" })
    expect(await (await token("user-a-notion", interactive)).json()).toMatchObject({ token: "personal-token" })
    expect(await (await token("team-notion", interactive)).json()).toMatchObject({ token: "team-token" })
    const unattended = turns.mint({ sessionId: "session-1" })
    expect((await token("user-a-notion", unattended)).status).toBe(404)
    expect((await token("user-a-notion", "unknown")).status).toBe(404)
    host.dispose()
    turns.dispose()
  })

  test("integrations routes are never proxied into workspace runtimes", async () => {
    const { routeOwnership, RouteHandler } = await import("../route-ownership")
    for (const pathname of [
      "/api/claxedo/integrations",
      "/api/claxedo/integrations/callback",
      "/api/claxedo/integrations/connections/notion/token",
    ]) {
      expect(routeOwnership(pathname).handler).not.toBe(RouteHandler.SandboxRuntime)
    }
  })

  // ── D7: hosted org partition (launch plan 012; design 015 §2 Decision 1) ──
  // Bearer convention for the fake verifier: "subject@org" carries an org
  // claim; a bare subject is an org-less signed principal.
  const HOSTED_ENV = {
    CLAXEDO_DEPLOYMENT_MODE: "hosted",
    CLAXEDO_HOSTED_CREDENTIALS_ENABLED: "1",
  }
  const hostedHost = (extra: Parameters<typeof createConnectionsHost>[0] extends infer T ? Partial<T> : never = {}) =>
    createConnectionsHost({
      credentials: credentialsPort(),
      env: { ...HOSTED_ENV },
      authConfig: { enabled: true, issuer: "https://issuer.example", jwksUrl: "https://issuer.example/jwks" },
      verifier: async (token) => {
        const [subject, orgId] = token.split("@")
        return {
          mode: "signed",
          user: {
            subject: subject!,
            tokenIdentifier: token,
            issuer: "https://issuer.example",
            ...(orgId ? { orgId } : {}),
          },
        }
      },
      ...extra,
    })

  const seedRow = async (row: { id: string; owner?: string }) => {
    const connections = createConnectionStoreAdapter()
    await connections.upsert({
      id: row.id,
      integrationId: "notion",
      ...(row.owner !== undefined ? { owner: row.owner } : {}),
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
  }

  test("hosted D7: org A team rows are invisible and inaccessible to org B on every route surface", async () => {
    const host = hostedHost()
    await seedRow({ id: "team-org-a", owner: "org:org-a" })
    await seedRow({ id: "team-org-b", owner: "org:org-b" })
    await seedRow({ id: "personal-alice", owner: "user:alice" })
    await seedRow({ id: "personal-bob", owner: "user:bob" })

    const as = (bearer: string, path = "/", init: RequestInit = {}) =>
      host.routes.request(`http://cp.example${path}`, {
        ...init,
        headers: { authorization: `Bearer ${bearer}`, ...(init.headers ?? {}) },
      })

    // List: each org member sees exactly their org team partition + own personal rows.
    const aliceList = (await (await as("alice@org-a")).json()) as { connections: Array<{ id: string; scope: string }> }
    expect(aliceList.connections.map((c) => c.id).sort()).toEqual(["personal-alice", "team-org-a"])
    expect(aliceList.connections.find((c) => c.id === "team-org-a")).toMatchObject({ scope: "team" })
    expect(aliceList.connections.find((c) => c.id === "personal-alice")).toMatchObject({ scope: "personal" })

    const bobList = (await (await as("bob@org-b")).json()) as { connections: Array<{ id: string }> }
    expect(bobList.connections.map((c) => c.id).sort()).toEqual(["personal-bob", "team-org-b"])

    // Delete / reverify / token / auth-failure: org B against org A's team row → 404 everywhere.
    expect((await as("bob@org-b", "/connections/team-org-a", { method: "DELETE" })).status).toBe(404)
    expect((await as("bob@org-b", "/connections/team-org-a/reverify", { method: "POST" })).status).toBe(404)
    // Personal rows stay invisible across subjects, org membership notwithstanding.
    expect((await as("bob@org-a", "/connections/personal-alice", { method: "DELETE" })).status).toBe(404)
    expect((await as("bob@org-a", "/connections/personal-alice/reverify", { method: "POST" })).status).toBe(404)

    // Org A retains full management of its own partition.
    expect((await as("alice@org-a", "/connections/team-org-a", { method: "DELETE" })).status).toBe(200)
    host.dispose()
  })

  test("hosted D7: team connect writes the org partition key, never owner-absent", async () => {
    // Notion's verify hits the network; stub it to succeed so the write path runs.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ name: "Org A Bot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    try {
      const host = hostedHost()
      const res = await host.routes.request("http://cp.example/notion/connect", {
        method: "POST",
        headers: { authorization: "Bearer alice@org-a" },
        body: JSON.stringify({ fields: {}, secret: "ntn-team-secret" }),
      })
      expect(res.status).toBe(200)
      const connections = createConnectionStoreAdapter()
      const rows = await connections.list()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.owner).toBe("org:org-a")
      // The self-host (owner-absent) partition stays empty on hosted.
      expect(await connections.list({ owner: null })).toEqual([])
      host.dispose()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("hosted D7: owner-absent rows are refused — invisible, undeletable, untokenable", async () => {
    const host = hostedHost()
    await seedRow({ id: "legacy-ownerless" })
    const as = (bearer: string, path = "/", init: RequestInit = {}) =>
      host.routes.request(`http://cp.example${path}`, {
        ...init,
        headers: { authorization: `Bearer ${bearer}`, ...(init.headers ?? {}) },
      })
    const listing = (await (await as("alice@org-a")).json()) as { connections: unknown[] }
    expect(listing.connections).toEqual([])
    expect((await as("alice@org-a", "/connections/legacy-ownerless", { method: "DELETE" })).status).toBe(404)
    expect((await as("alice@org-a", "/connections/legacy-ownerless/reverify", { method: "POST" })).status).toBe(404)
    // Loopback token path (header + no turn credential) cannot reach it either.
    const token = await host.routes.request("http://127.0.0.1/connections/legacy-ownerless/token?capability=docs", {
      headers: { [CONNECTIONS_TOKEN_HEADER]: "1" },
    })
    expect(token.status).toBe(404)
    host.dispose()
  })

  test("hosted D7: signed principal without an org gets 403 connections_org_required", async () => {
    const host = hostedHost()
    const res = await host.routes.request("http://cp.example/", {
      headers: { authorization: "Bearer alice" },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ code: "connections_org_required" })
    host.dispose()
  })

  test("hosted D7: loopback gets no partition keys — nothing to read, nothing to write", async () => {
    const host = hostedHost()
    await seedRow({ id: "team-org-a", owner: "org:org-a" })
    await seedRow({ id: "legacy-ownerless" })
    const listing = await host.routes.request("http://127.0.0.1/")
    expect(listing.status).toBe(200)
    expect(((await listing.json()) as { connections: unknown[] }).connections).toEqual([])
    const connect = await host.routes.request("http://127.0.0.1/notion/connect", {
      method: "POST",
      body: JSON.stringify({ fields: {}, secret: "ntn-x" }),
    })
    expect(connect.status).toBe(422)
    expect(await connect.json()).toEqual({ ok: false, code: "team_scope_requires_team_partition" })
    host.dispose()
  })

  test("hosted D7: token resolution derives the team partition from the turn's org only", async () => {
    const turns = createConnectionTurnCredentials()
    const host = hostedHost({ turnCredentials: turns })
    const connections = createConnectionStoreAdapter()
    const credentials = createCredentialStoreAdapter(credentialsPort())
    await connections.upsert({
      id: "team-org-a",
      integrationId: "notion",
      owner: "org:org-a",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await connections.upsert({
      id: "personal-alice",
      integrationId: "notion",
      owner: "user:alice",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await credentials.put({ providerId: "integration:team-org-a", kind: "api_key", secret: "org-a-team-token" })
    await credentials.put({ providerId: "integration:personal-alice", kind: "api_key", secret: "alice-token" })

    const token = async (id: string, turn?: string) =>
      host.routes.request(`http://127.0.0.1/connections/${id}/token?capability=docs`, {
        headers: {
          [CONNECTIONS_TOKEN_HEADER]: "1",
          ...(turn ? { [CONNECTION_TURN_HEADER]: turn } : {}),
        },
      })

    const orgATurn = turns.mint({ sessionId: "s1", subject: "alice", orgId: "org-a" })
    const orgBTurn = turns.mint({ sessionId: "s2", subject: "mallory", orgId: "org-b" })
    const orglessTurn = turns.mint({ sessionId: "s3", subject: "alice" })

    expect(await (await token("team-org-a", orgATurn)).json()).toMatchObject({ token: "org-a-team-token" })
    expect(await (await token("personal-alice", orgATurn)).json()).toMatchObject({ token: "alice-token" })
    // Org B's turn cannot resolve org A's team row; an org-less turn cannot either.
    expect((await token("team-org-a", orgBTurn)).status).toBe(404)
    expect((await token("team-org-a", orglessTurn)).status).toBe(404)
    // No turn credential at all resolves nothing on hosted.
    expect((await token("team-org-a")).status).toBe(404)
    expect((await token("personal-alice")).status).toBe(404)
    host.dispose()
    turns.dispose()
  })

  test("hosted D7 hard gate: flag off → 503 on every surface, loopback included", async () => {
    const host = createConnectionsHost({
      credentials: credentialsPort(),
      env: { CLAXEDO_DEPLOYMENT_MODE: "hosted" },
      authConfig: { enabled: true, issuer: "https://issuer.example", jwksUrl: "https://issuer.example/jwks" },
      verifier: async (token: string) => ({
        mode: "signed",
        user: { subject: token, tokenIdentifier: token, issuer: "https://issuer.example", orgId: "org-a" },
      }),
    })
    for (const [path, init] of [
      ["/", {}],
      ["/notion/connect", { method: "POST", body: "{}" }],
      ["/attempts/x", {}],
      ["/connections/x", { method: "DELETE" }],
      ["/connections/x/reverify", { method: "POST" }],
      ["/connections/x/token?capability=docs", { headers: { [CONNECTIONS_TOKEN_HEADER]: "1" } }],
      ["/connections/x/auth-failure", { method: "POST", body: "{}", headers: { [CONNECTIONS_TOKEN_HEADER]: "1" } }],
    ] as const) {
      const signed = await host.routes.request(`http://cp.example${path}`, {
        ...init,
        headers: { authorization: "Bearer alice", ...("headers" in init ? init.headers : {}) },
      })
      expect(signed.status).toBe(503)
      expect(await signed.json()).toEqual({ code: "connections_unavailable" })
      const loopback = await host.routes.request(`http://127.0.0.1${path}`, { ...init })
      expect(loopback.status).toBe(503)
    }
    host.dispose()
  })

  // ── D6/B4: hosted-connections entitlement (choke point #2; launch plan 012,
  // ADR 014 §5). Composed hook, consulted after D7 org resolution — free orgs
  // get the typed 402, entitled orgs pass through to the partition logic.
  test("hosted D6: unentitled org gets 402 on the signed surface; entitled org passes", async () => {
    const denials: string[] = []
    const host = hostedHost({
      requireHostedConnectionsEntitlement: async (clerkOrgId: string) => {
        denials.push(clerkOrgId)
        if (clerkOrgId === "org-paid") return undefined
        return {
          status: 402 as const,
          body: { error: { code: "billing_entitlement_required", message: "subscription required" } },
        }
      },
    } as never)
    await seedRow({ id: "team-org-paid", owner: "org:org-paid" })

    const denied = await host.routes.request("http://cp.example/", {
      headers: { authorization: "Bearer alice@org-free" },
    })
    expect(denied.status).toBe(402)
    expect(await denied.json()).toMatchObject({ error: { code: "billing_entitlement_required" } })

    const allowed = await host.routes.request("http://cp.example/", {
      headers: { authorization: "Bearer bob@org-paid" },
    })
    expect(allowed.status).toBe(200)
    expect(((await allowed.json()) as { connections: Array<{ id: string }> }).connections)
      .toEqual([expect.objectContaining({ id: "team-org-paid" })])
    expect(denials).toEqual(["org-free", "org-paid"])
    host.dispose()
  })

  test("hosted D6: billing mirror unreadable fails closed (503), never open", async () => {
    const host = hostedHost({
      requireHostedConnectionsEntitlement: async () => ({
        status: 503 as const,
        body: { error: { code: "billing_state_unavailable", message: "fail closed" } },
      }),
    } as never)
    const res = await host.routes.request("http://cp.example/", {
      headers: { authorization: "Bearer alice@org-a" },
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "billing_state_unavailable" } })
    host.dispose()
  })

  test("self-host: the entitlement hook is never consulted (I-1 — no billing on the self-host path)", async () => {
    const gate = { calls: 0 }
    const host = createConnectionsHost({
      credentials: credentialsPort(),
      env: {},
      authConfig: { enabled: true, issuer: "https://issuer.example", jwksUrl: "https://issuer.example/jwks" },
      verifier: async (token: string) => ({
        mode: "signed",
        user: { subject: token, tokenIdentifier: token, issuer: "https://issuer.example", orgId: "org-a" },
      }),
      requireHostedConnectionsEntitlement: async () => {
        gate.calls += 1
        return { status: 402 as const, body: { error: { code: "billing_entitlement_required", message: "x" } } }
      },
    })
    const res = await host.routes.request("http://relay.example/", {
      headers: { authorization: "Bearer alice" },
    })
    expect(res.status).toBe(200)
    expect(gate.calls).toBe(0)
    host.dispose()
  })

  // ── F5 (adversarial-review): the PRODUCTION composition wires the hook ──
  // `connections-entitlement.ts` (imported by server.ts) is the missing wiring
  // the review flagged as dead code. Prove the real builder gates a free org
  // and admits an entitled one through the full connections-host surface, and
  // that self-host produces no hook at all (byte-identical, never gated).
  test("F5 wiring: hosted + flag-on + free org → 402; entitled org → allowed (real builder)", async () => {
    const { hostedConnectionsEntitlement } = await import("./connections-entitlement")
    const entitlementState = async ({ clerkOrgId }: { orgId?: string; clerkOrgId?: string }) =>
      clerkOrgId === "org-paid"
        ? {
            found: true as const,
            org_id: "org_doc_paid",
            plan: "pro" as const,
            subscription_status: "active",
          }
        : { found: false as const }
    const store = {
      entitlementState: vi.fn(entitlementState),
      applyPolarState: vi.fn(),
      checkoutContext: vi.fn(),
      listReconcileFlagged: vi.fn(),
      listDeletedWithSubscription: vi.fn(),
    } as unknown as import("../billing/billing-store").BillingStore

    const requireHostedConnectionsEntitlement = hostedConnectionsEntitlement({ ...HOSTED_ENV }, { store })
    expect(requireHostedConnectionsEntitlement).toBeTypeOf("function")
    const host = hostedHost({ requireHostedConnectionsEntitlement } as never)
    await seedRow({ id: "team-org-paid", owner: "org:org-paid" })

    const denied = await host.routes.request("http://cp.example/", {
      headers: { authorization: "Bearer alice@org-free" },
    })
    expect(denied.status).toBe(402)
    expect(await denied.json()).toMatchObject({ error: { code: "billing_entitlement_required" } })

    const allowed = await host.routes.request("http://cp.example/", {
      headers: { authorization: "Bearer bob@org-paid" },
    })
    expect(allowed.status).toBe(200)
    expect(((await allowed.json()) as { connections: Array<{ id: string }> }).connections)
      .toEqual([expect.objectContaining({ id: "team-org-paid" })])
    host.dispose()
  })

  test("F5 wiring: self-host builds NO hook (undefined) — never gated (I-1)", async () => {
    const { hostedConnectionsEntitlement } = await import("./connections-entitlement")
    expect(hostedConnectionsEntitlement({})).toBeUndefined()
    expect(hostedConnectionsEntitlement({ CLAXEDO_DEPLOYMENT_MODE: "self-host" })).toBeUndefined()
  })

  // ── F12 (adversarial review; D2 vs D7): re-check org membership in Convex ──
  // The team partition is keyed on the verified Clerk org_id claim, but a claim
  // alone is not authorization — the host re-checks the subject is a real
  // member of that org before granting the team partition.
  test("F12 hosted: a verified member passes; a stale org claim with no membership gets 403", async () => {
    const checked: Array<{ subject: string; orgId: string }> = []
    const host = hostedHost({
      verifyOrgMembership: async (input: { subject: string; orgId: string }) => {
        checked.push(input)
        return input.subject === "alice" && input.orgId === "org-a"
      },
    } as never)
    await seedRow({ id: "team-org-a", owner: "org:org-a" })

    const ok = await host.routes.request("http://cp.example/", { headers: { authorization: "Bearer alice@org-a" } })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { connections: Array<{ id: string }> }).connections)
      .toEqual([expect.objectContaining({ id: "team-org-a" })])

    // mallory presents an org-a claim but is not a member per Convex → 403, no partition.
    const denied = await host.routes.request("http://cp.example/", { headers: { authorization: "Bearer mallory@org-a" } })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ code: "connections_org_membership_required" })
    expect(checked).toContainEqual({ subject: "alice", orgId: "org-a" })
    host.dispose()
  })

  test("F12 self-host: builds NO membership verifier and the gate never checks (byte-identical)", async () => {
    const { hostedOrgMembershipVerifier } = await import("./org-membership")
    expect(hostedOrgMembershipVerifier({})).toBeUndefined()
    expect(hostedOrgMembershipVerifier({ CLAXEDO_DEPLOYMENT_MODE: "self-host" })).toBeUndefined()

    // Even if a verifier is injected, the self-host signed path never consults it.
    const calls = { n: 0 }
    const host = createConnectionsHost({
      credentials: credentialsPort(),
      env: {},
      authConfig: { enabled: true, issuer: "https://issuer.example", jwksUrl: "https://issuer.example/jwks" },
      verifier: async (token: string) => ({
        mode: "signed",
        user: { subject: token, tokenIdentifier: token, issuer: "https://issuer.example", orgId: "org-a" },
      }),
      verifyOrgMembership: async () => {
        calls.n += 1
        return false
      },
    } as never)
    const res = await host.routes.request("http://relay.example/", { headers: { authorization: "Bearer alice" } })
    expect(res.status).toBe(200)
    expect(calls.n).toBe(0)
    host.dispose()
  })

  test("F12 hosted builder: fails closed (false) when Convex config is absent — no unconfirmed grant", async () => {
    const { hostedOrgMembershipVerifier } = await import("./org-membership")
    const verify = hostedOrgMembershipVerifier({ CLAXEDO_DEPLOYMENT_MODE: "hosted" })
    expect(verify).toBeTypeOf("function")
    expect(await verify!({ subject: "alice", orgId: "org-a" })).toBe(false)
  })

  test("google integration registers only when host env provides client credentials", () => {
    const without = createConnectionsHost({ credentials: credentialsPort(), env: {} })
    expect(without.service.listIntegrations().map((i) => i.id)).not.toContain("google")
    without.dispose()

    const withGoogle = createConnectionsHost({
      credentials: credentialsPort(),
      env: {
        CLAXEDO_INTEGRATION_GOOGLE_CLIENT_ID: "cid",
        CLAXEDO_INTEGRATION_GOOGLE_CLIENT_SECRET: "cs",
      },
      publicUrl: "https://host.example",
    })
    expect(withGoogle.service.listIntegrations().map((i) => i.id)).toContain("google")
    withGoogle.dispose()
  })
})
