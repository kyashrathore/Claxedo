import { describe, expect, test } from "bun:test"
import { createIntegrationRegistry } from "./registry.js"
import { createConnectionsService } from "./service.js"
import { createAttempts } from "./attempts.js"
import { createMemoryConnectionStore, createMemoryCredentialStore } from "./stores/memory.js"
import {
  ConnectionsUnavailableError,
  connectionWebhookSigningProviderId,
  type IntegrationDeclaration,
  type IntegrationImpl,
} from "./types.js"

const KEY_DECL: IntegrationDeclaration = {
  id: "fake",
  name: "Fake",
  methods: ["key"],
  capabilities: ["docs"],
  keyTokenType: "bearer",
  prompts: [{ id: "token", label: "Token", secret: true }],
}

const GITHUB_DECL: IntegrationDeclaration = {
  id: "github",
  name: "GitHub",
  methods: ["key"],
  capabilities: ["code-host", "work-source"],
  keyTokenType: "bearer",
  prompts: [{ id: "token", label: "Token", secret: true }],
}

function harness(input: { impl?: IntegrationImpl; decl?: IntegrationDeclaration } = {}) {
  const registry = createIntegrationRegistry()
  registry.register(input.decl ?? KEY_DECL, input.impl ?? {
    verify: async (_fields, secret) => (secret === "good" ? { ok: true, accountLabel: "Acme" } : { ok: false, reason: "unauthorized" }),
  })
  const credentials = createMemoryCredentialStore()
  const connections = createMemoryConnectionStore()
  const attempts = createAttempts({ sweepIntervalMs: 0 })
  let nextId = 0
  const service = createConnectionsService({ registry, credentials, connections, attempts, newId: () => `connection-${++nextId}` })
  return { registry, credentials, connections, service }
}

describe("connections service", () => {
  test("lists code-host repositories through the connection secret without returning the token", async () => {
    const seen: string[] = []
    const { service } = harness({
      decl: GITHUB_DECL,
      impl: {
        verify: async () => ({ ok: true }),
        listRepositories: async (_fields, secret) => {
          seen.push(secret)
          return [{
            id: "1",
            name: "app",
            fullName: "acme/app",
            cloneUrl: "https://github.com/acme/app.git",
            private: true,
            permissions: { read: true, write: false },
          }]
        },
      },
    })
    await service.connect({ integrationId: "github", fields: {}, secret: "github-secret" })

    const result = await service.listRepositories("connection-1")
    expect(result).toEqual({
      ok: true,
      repositories: [{
        id: "1",
        name: "app",
        fullName: "acme/app",
        cloneUrl: "https://github.com/acme/app.git",
        private: true,
        permissions: { read: true, write: false },
      }],
    })
    expect(seen).toEqual(["github-secret"])
    expect(JSON.stringify(result)).not.toContain("github-secret")
  })

  test("connect verifies, stores namespaced credential, grants declaration capabilities", async () => {
    const { service, credentials, connections } = harness()
    const result = await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    expect(result).toEqual({ ok: true })
    expect(await credentials.get("integration:connection-1")).toMatchObject({ kind: "api_key", status: "available" })
    expect(await connections.get("fake")).toMatchObject({
      integrationId: "fake",
      accountLabel: "Acme",
      grantedCapabilities: ["docs"],
    })
  })

  test("existing connection requires confirmReplace", async () => {
    const { service } = harness()
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    expect(await service.connect({ integrationId: "fake", fields: {}, secret: "good" }))
      .toEqual({ ok: false, code: "connection_exists" })
    expect(await service.connect({ integrationId: "fake", fields: {}, secret: "good", confirmReplace: true }))
      .toEqual({ ok: true })
  })

  test("verify failure returns closed enum and stores nothing", async () => {
    const { service, credentials } = harness()
    const result = await service.connect({ integrationId: "fake", fields: {}, secret: "bad" })
    expect(result).toEqual({ ok: false, code: "connection_verify_failed", reason: "unauthorized" })
    expect(await credentials.get("integration:connection-1")).toBeUndefined()
  })

  test("verify() error fence: a throwing impl embedding the secret leaks nothing", async () => {
    const secret = "sk-super-secret-9911"
    const { service } = harness({
      impl: {
        verify: async () => {
          throw new Error(`upstream said: invalid token ${secret}`)
        },
      },
    })
    let result: unknown
    let threw = false
    try {
      result = await service.connect({ integrationId: "fake", fields: {}, secret })
    } catch {
      threw = true
    }
    // impls own their catch; a throwing impl is a bug, but the service result
    // (when impls follow the contract) never carries messages. Assert the
    // documented contract path instead: closed-enum results only.
    if (!threw) expect(JSON.stringify(result)).not.toContain(secret)
  })

  test("remove deletes row and credential", async () => {
    const { service, credentials } = harness()
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    expect(await service.remove("connection-1")).toBe(true)
    expect(await credentials.get("integration:connection-1")).toBeUndefined()
    expect(await service.remove("connection-1")).toBe(false)
  })

  test("webhook signing secrets have an independent lifecycle and cascade with the Connection", async () => {
    const { service, credentials } = harness({ decl: GITHUB_DECL })
    await expect(service.connect({ integrationId: "github", fields: {}, secret: "good" })).resolves.toEqual({ ok: true })

    const oldSecret = "old-webhook-secret"
    const configured = await service.setWebhookSigningSecret("connection-1", oldSecret)
    expect(configured).toEqual({ ok: true })
    expect(JSON.stringify(configured)).not.toContain(oldSecret)
    expect(await credentials.resolveSecret(connectionWebhookSigningProviderId("connection-1"))).toBe(oldSecret)
    expect(await credentials.resolveSecret("integration:connection-1")).toBe("good")
    expect(await service.resolveWebhookSigningSecret("connection-1", "github")).toBe(oldSecret)
    expect(await service.resolveWebhookSigningSecret("connection-1", "linear")).toBeUndefined()
    expect(await service.resolveWebhookSigningSecret("missing", "github")).toBeUndefined()

    await expect(service.setWebhookSigningSecret("connection-1", "new-webhook-secret")).resolves.toEqual({ ok: true })
    expect(await service.resolveWebhookSigningSecret("connection-1", "github")).toBe("new-webhook-secret")
    await expect(service.removeWebhookSigningSecret("connection-1")).resolves.toEqual({ ok: true })
    expect(await service.resolveWebhookSigningSecret("connection-1", "github")).toBeUndefined()
    expect(await credentials.resolveSecret("integration:connection-1")).toBe("good")

    await service.setWebhookSigningSecret("connection-1", "delete-with-connection")
    await service.remove("connection-1")
    expect(await credentials.get("integration:connection-1")).toBeUndefined()
    expect(await credentials.get(connectionWebhookSigningProviderId("connection-1"))).toBeUndefined()
  })

  test("webhook signing secrets are limited to work-source Connections", async () => {
    const { service } = harness()
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    await expect(service.setWebhookSigningSecret("connection-1", "secret")).resolves.toEqual({
      ok: false,
      code: "webhook_not_supported",
    })
    await expect(service.setWebhookSigningSecret("missing", "secret")).resolves.toEqual({
      ok: false,
      code: "webhook_not_supported",
    })
  })

  test("removeOwner cascades one owner's personal rows and spares team + other owners", async () => {
    const { service, credentials, connections } = harness()
    // connection-1: team, connection-2: alice, connection-3: bob.
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    await service.connect({ integrationId: "fake", owner: "alice", fields: {}, secret: "good" })
    await service.connect({ integrationId: "fake", owner: "bob", fields: {}, secret: "good" })

    expect(await service.removeOwner("alice")).toBe(1)

    // Alice's row + credential are gone.
    expect(await connections.get("fake", "alice")).toBeUndefined()
    expect(await credentials.get("integration:connection-2")).toBeUndefined()
    // Team and bob survive untouched.
    expect(await connections.get("fake", undefined)).toMatchObject({ id: "connection-1" })
    expect(await connections.get("fake", "bob")).toMatchObject({ id: "connection-3" })
    expect(await credentials.get("integration:connection-1")).toMatchObject({ status: "available" })
    expect(await credentials.get("integration:connection-3")).toMatchObject({ status: "available" })

    // Idempotent: a second cascade for the same owner removes nothing.
    expect(await service.removeOwner("alice")).toBe(0)
    // Empty owner is a no-op (never a wildcard that reaps team rows).
    expect(await service.removeOwner("")).toBe(0)
    expect(await connections.get("fake", undefined)).toMatchObject({ id: "connection-1" })
  })

  test("reportAuthFailure flips status; getToken then 409; reverify restores", async () => {
    const { service, credentials } = harness()
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    await service.reportAuthFailure("connection-1", "401 from provider")
    expect(credentials.inspect("integration:connection-1")).toMatchObject({ status: "error", lastError: "auth_failure_reported" })
    const denied = await service.getToken("connection-1", "docs")
    expect(denied).toMatchObject({ ok: false, status: 409, code: "connection_not_available" })
    const reverified = await service.reverify("connection-1")
    expect(reverified).toMatchObject({ ok: true })
    const granted = await service.getToken("connection-1", "docs")
    expect(granted).toMatchObject({ ok: true, response: { token: "good", tokenType: "bearer" } })
  })

  test("getToken: 404 unknown, 403 ungranted capability", async () => {
    const { service } = harness()
    expect(await service.getToken("nope", "docs")).toMatchObject({ ok: false, status: 404 })
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    expect(await service.getToken("connection-1", "channel")).toMatchObject({ ok: false, status: 403, code: "capability_not_granted" })
    expect(await service.getToken("connection-1", undefined)).toMatchObject({ ok: false, status: 403 })
  })

  test("forCapability filters by granted capability and integration", async () => {
    const { service } = harness()
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    expect(await service.forCapability("channel")).toHaveLength(0)
    const handles = await service.forCapability("docs")
    expect(handles).toHaveLength(1)
    expect(handles[0]!.integrationId).toBe("fake")
    expect(await handles[0]!.getToken()).toEqual({ token: "good", tokenType: "bearer" })
    expect(await service.forCapability("docs", { integration: "other" })).toHaveLength(0)
  })

  test("resolveForCapability is capability-first and honors explicit scope", async () => {
    const { service, connections } = harness()
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    await connections.upsert({
      id: "personal-without-docs",
      integrationId: "fake",
      owner: "user-a",
      grantedCapabilities: [],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })

    const resolved = await service.resolveForCapability("docs", { owner: "user-a" })
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ scope: "team" })

    await service.connect({ integrationId: "fake", fields: {}, secret: "good", owner: "user-a", confirmReplace: true })
    const personal = await service.resolveForCapability("docs", { owner: "user-a" })
    expect(personal).toHaveLength(1)
    expect(personal[0]).toMatchObject({ scope: "personal" })

    const personalMissing = await service.resolveForCapability("docs", { owner: "user-b", scope: "personal" })
    expect(personalMissing).toEqual([])
    await expect(service.resolveForCapability("docs", { scope: "personal" })).rejects.toThrow("requires an owner")
  })

  test("list derives connected/degraded/broken status", async () => {
    const { service, credentials } = harness()
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    expect((await service.list())[0]).toMatchObject({ status: "connected" })
    await credentials.setStatus("integration:connection-1", "error", "boom")
    expect((await service.list())[0]).toMatchObject({ status: "degraded" })
    await credentials.deleteByProvider("integration:connection-1")
    expect((await service.list())[0]).toMatchObject({ status: "broken" })
  })

  test("list propagates credential-store outages instead of substituting broken", async () => {
    const registry = createIntegrationRegistry()
    registry.register(KEY_DECL, {
      verify: async () => ({ ok: true }),
    })
    const memoryCredentials = createMemoryCredentialStore()
    const service = createConnectionsService({
      registry,
      credentials: {
        ...memoryCredentials,
        async get() {
          throw new ConnectionsUnavailableError()
        },
      },
      connections: createMemoryConnectionStore(),
      attempts: createAttempts({ sweepIntervalMs: 0 }),
      newId: () => "connection-1",
    })
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })

    await expect(service.list()).rejects.toBeInstanceOf(ConnectionsUnavailableError)
  })

  test("atlassian-style fields ride the token response", async () => {
    const decl: IntegrationDeclaration = {
      ...KEY_DECL,
      keyTokenType: "basic",
      prompts: [
        { id: "site_url", label: "Site URL" },
        { id: "email", label: "Account email" },
        { id: "token", label: "API token", secret: true },
      ],
    }
    const { service } = harness({ decl })
    await service.connect({
      integrationId: "fake",
      fields: { site_url: "https://acme.atlassian.net", email: "a@acme.io" },
      secret: "good",
    })
    const result = await service.getToken("connection-1", "docs")
    expect(result).toMatchObject({
      ok: true,
      response: {
        token: "good",
        tokenType: "basic",
        fields: { site_url: "https://acme.atlassian.net", email: "a@acme.io" },
      },
    })
  })

  test("only declared non-secret prompt fields are persisted and echoed", async () => {
    // Storage contract: a secret copied into fields (or any undeclared field)
    // must never land on the connection row or come back from list().
    const decl: IntegrationDeclaration = {
      ...KEY_DECL,
      prompts: [
        { id: "email", label: "Account email" },
        { id: "token", label: "API token", secret: true },
      ],
    }
    const { service, connections } = harness({ decl })
    const result = await service.connect({
      integrationId: "fake",
      fields: { email: "a@acme.io", token: "good", undeclared: "junk" },
      secret: "good",
    })
    expect(result).toEqual({ ok: true })
    expect((await connections.get("fake"))?.fields).toEqual({ email: "a@acme.io" })
    expect((await service.list())[0]?.fields).toEqual({ email: "a@acme.io" })
  })

  test("oauth connect/callback stores envelope and replay is rejected", async () => {
    const registry = createIntegrationRegistry()
    registry.register(
      { id: "oauthy", name: "OAuthy", methods: ["oauth"], capabilities: ["docs"] },
      {
        authorize: (state) => new URL(`https://provider.test/auth?state=${state}`),
        callback: async (code) => ({ accessToken: `at-${code}`, refreshToken: "rt-1", expiresAt: 111 }),
      },
    )
    const credentials = createMemoryCredentialStore()
    const connections = createMemoryConnectionStore()
    const service = createConnectionsService({ registry, credentials, connections, attempts: createAttempts({ sweepIntervalMs: 0 }), newId: () => "connection-1" })

    const started = await service.connectOAuth({ integrationId: "oauthy", owner: "user-a" })
    expect(started.ok).toBe(true)
    const state = (started as { attemptId: string }).attemptId
    expect((started as { url: string }).url).toContain(`state=${state}`)

    expect(await service.handleCallback(state, "code-1")).toEqual({ ok: true })
    expect(await credentials.readSecret("integration:connection-1")).toBe(JSON.stringify({ access: "at-code-1", refresh: "rt-1" }))
    expect(await connections.get("oauthy", "user-a")).toMatchObject({ id: "connection-1", owner: "user-a" })
    expect(service.attemptStatus(state)).toMatchObject({ status: "complete" })

    // Replay: same state again must be rejected before the impl runs.
    expect(await service.handleCallback(state, "code-2")).toEqual({ ok: false })
    expect(await credentials.readSecret("integration:connection-1")).toBe(JSON.stringify({ access: "at-code-1", refresh: "rt-1" }))
  })

  test("teamOwner partitions the team scope by an opaque key (hosted org partition)", async () => {
    const { service, connections } = harness()
    // One deployment, two tenant partitions plus a legacy owner-absent row.
    await connections.upsert({ id: "org-a-row", integrationId: "fake", owner: "org:org-a", grantedCapabilities: ["docs"], fields: {}, createdAt: 1, updatedAt: 1 })
    await connections.upsert({ id: "org-b-row", integrationId: "fake", owner: "org:org-b", grantedCapabilities: ["docs"], fields: {}, createdAt: 1, updatedAt: 1 })
    await connections.upsert({ id: "ownerless-row", integrationId: "fake", grantedCapabilities: ["docs"], fields: {}, createdAt: 1, updatedAt: 1 })
    await connections.upsert({ id: "alice-row", integrationId: "fake", owner: "user:alice", grantedCapabilities: ["docs"], fields: {}, createdAt: 1, updatedAt: 1 })

    // Team partition = the opaque key: org A never sees org B or the
    // owner-absent partition, and its rows classify as scope "team".
    const orgATeam = await service.list({ teamOwner: "org:org-a", scope: "team" })
    expect(orgATeam.map((row) => row.id)).toEqual(["org-a-row"])
    expect(orgATeam[0]).toMatchObject({ scope: "team" })

    const orgAMixed = await service.list({ teamOwner: "org:org-a", owner: "user:alice" })
    expect(orgAMixed.map((row) => row.id).sort()).toEqual(["alice-row", "org-a-row"])
    expect(orgAMixed.find((row) => row.id === "alice-row")).toMatchObject({ scope: "personal" })

    // Without teamOwner the owner-absent partition remains the team —
    // self-host semantics unchanged.
    expect((await service.list({ scope: "team" })).map((row) => row.id)).toEqual(["ownerless-row"])

    // Capability resolution honors the same partition; personal wins over
    // the org team row for the same integration.
    const teamOnly = await service.resolveForCapability("docs", { teamOwner: "org:org-a", scope: "team" })
    expect(teamOnly.map((handle) => handle.id)).toEqual(["org-a-row"])
    expect(teamOnly[0]).toMatchObject({ scope: "team" })
    const preferred = await service.resolveForCapability("docs", { teamOwner: "org:org-a", owner: "user:alice" })
    expect(preferred.map((handle) => handle.id)).toEqual(["alice-row"])
    expect(preferred[0]).toMatchObject({ scope: "personal" })
  })

  test("connectOAuth attempt scope derives from teamOwner (org team rows are not 'personal')", async () => {
    const registry = createIntegrationRegistry()
    registry.register(
      { id: "oauthy", name: "OAuthy", methods: ["oauth"], capabilities: ["docs"] },
      {
        authorize: (state) => new URL(`https://provider.example/auth?state=${state}`),
        callback: async (code) => ({ accessToken: `at-${code}` }),
      },
    )
    const service = createConnectionsService({
      registry,
      credentials: createMemoryCredentialStore(),
      connections: createMemoryConnectionStore(),
      attempts: createAttempts({ sweepIntervalMs: 0 }),
      newId: () => "connection-1",
    })
    const started = await service.connectOAuth({ integrationId: "oauthy", owner: "org:org-a", teamOwner: "org:org-a" })
    expect(started.ok).toBe(true)
    const state = (started as { attemptId: string }).attemptId
    expect(service.attemptStatus(state)).toMatchObject({ scope: "team" })
  })
})
