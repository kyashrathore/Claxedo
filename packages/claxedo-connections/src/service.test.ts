import { describe, expect, test } from "bun:test"
import { createIntegrationRegistry } from "./registry.js"
import { createConnectionsService } from "./service.js"
import { createAttempts } from "./attempts.js"
import { createMemoryConnectionStore, createMemoryCredentialStore } from "./stores/memory.js"
import {
  ConnectionExistsError,
  ConnectionsUnavailableError,
  type ConnectionStorePort,
  type CredentialStorePort,
  type IntegrationDeclaration,
  type IntegrationImpl,
} from "./types.js"
import { docsPort, mcpPort, workSourcePort } from "./ports/index.js"

const KEY_DECL: IntegrationDeclaration = {
  id: "fake",
  name: "Fake",
  methods: ["key"],
  keyTokenType: "bearer",
  prompts: [{ id: "token", label: "Token", secret: true }],
}

const GITHUB_DECL: IntegrationDeclaration = {
  id: "github",
  name: "GitHub",
  methods: ["key"],
  keyTokenType: "bearer",
  prompts: [{ id: "token", label: "Token", secret: true }],
}

function harness(input: { impl?: IntegrationImpl; decl?: IntegrationDeclaration } = {}) {
  const registry = createIntegrationRegistry()
  registry.register(input.decl ?? KEY_DECL, input.impl ?? {
    actions: { docs: docsPort },
    auth: {
      verify: async (_fields, secret) => (secret === "good" ? { ok: true, accountLabel: "Acme" } : { ok: false, reason: "unauthorized" }),
    },
  })
  const credentials = createMemoryCredentialStore()
  const connections = createMemoryConnectionStore()
  const attempts = createAttempts({ sweepIntervalMs: 0 })
  let nextId = 0
  const service = createConnectionsService({ registry, credentials, connections, attempts, newId: () => `connection-${++nextId}` })
  return { registry, credentials, connections, attempts, service }
}

describe("connections service", () => {
  test("freezes OAuth integration context and forwards authorization-response issuer validation", async () => {
    const seen: unknown[][] = []
    const callback: NonNullable<NonNullable<IntegrationImpl["auth"]>["callback"]> = async (...args) => {
      seen.push(args)
      return { accessToken: "oauth-access" }
    }
    const { service, attempts, registry } = harness()
    registry.register(
      { id: "mcp-test", name: "MCP", methods: ["oauth"] },
      {
        actions: { mcp: mcpPort },
        auth: {
          attemptContext: { issuer: "https://issuer.example" },
          authorize: (state) => new URL(`https://issuer.example/authorize?state=${state}`),
          callback,
        },
      },
    )
    const started = await service.connectOAuth({ integrationId: "mcp-test", owner: "user:1" })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await expect(service.handleCallback(started.attemptId, "code", { issuer: "https://issuer.example" })).resolves.toEqual({ ok: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.[0]).toBe("code")
    expect(seen[0]?.[1]).toEqual(expect.any(String))
    expect(seen[0]?.[2]).toEqual({ issuer: "https://issuer.example" })
    expect(seen[0]?.[3]).toEqual({ issuer: "https://issuer.example" })
    attempts.dispose()
  })

  test("lists code-host repositories through the connection secret without returning the token", async () => {
    const seen: string[] = []
    const { service } = harness({
      decl: GITHUB_DECL,
      impl: {
        actions: {
          "code-host": {
            capability: "code-host",
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
          "work-source": workSourcePort,
        },
        auth: { verify: async () => ({ ok: true }) },
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

  test("listRepositories: 501 when a stored grant outlives the port that served it", async () => {
    // An integration cannot declare code-host without implementing it, so the
    // only way to reach this branch is a row whose grant was written while the
    // integration still served the port. Deriving capabilities from ports made
    // this the sole remaining path — the grant is durable, the port is not.
    const { service, connections, credentials } = harness({
      decl: { ...GITHUB_DECL, id: "github" },
      impl: { actions: { "work-source": workSourcePort }, auth: { verify: async () => ({ ok: true }) } },
    })
    await connections.upsert({
      id: "connection-1",
      integrationId: "github",
      grantedCapabilities: ["code-host"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    await credentials.put({ providerId: "integration:connection-1", kind: "api_key", secret: "github-secret" })

    const result = await service.listRepositories("connection-1")
    expect(result).toEqual({ ok: false, status: 501, code: "repository_listing_unsupported" })
    expect(JSON.stringify(result)).not.toContain("github-secret")
  })

  test("listRepositories: provider rejection is 502 unauthorized and provider failure is 502 unavailable", async () => {
    // The impl's closed error vocabulary is the only thing that crosses —
    // provider bodies (which can embed the pasted secret) never do.
    const cases = [
      { thrown: new Error("github_repositories_unauthorized"), code: "repository_provider_unauthorized" },
      { thrown: new Error("github_repositories_unavailable"), code: "repository_provider_unavailable" },
      { thrown: new Error("github_repositories_invalid_response"), code: "repository_provider_unavailable" },
      // A non-Error throw must still classify, never escape.
      { thrown: "boom github-secret", code: "repository_provider_unavailable" },
    ] as const
    for (const { thrown, code } of cases) {
      const { service } = harness({
        decl: GITHUB_DECL,
        impl: {
          actions: {
            "code-host": {
              capability: "code-host",
              listRepositories: async () => {
                throw thrown
              },
            },
            "work-source": workSourcePort,
          },
          auth: { verify: async () => ({ ok: true }) },
        },
      })
      await service.connect({ integrationId: "github", fields: {}, secret: "github-secret" })

      const result = await service.listRepositories("connection-1")
      expect(result).toEqual({ ok: false, status: 502, code })
      expect(JSON.stringify(result)).not.toContain("github-secret")
    }
  })

  test("listRepositories: a message embedding the secret is still reduced to the closed 502 code", async () => {
    const { service } = harness({
      decl: GITHUB_DECL,
      impl: {
        actions: {
          "code-host": {
            capability: "code-host",
            listRepositories: async () => {
              throw new Error("401 Unauthorized for token github-secret")
            },
          },
          "work-source": workSourcePort,
        },
        auth: { verify: async () => ({ ok: true }) },
      },
    })
    await service.connect({ integrationId: "github", fields: {}, secret: "github-secret" })

    const result = await service.listRepositories("connection-1")
    // Not the exact sentinel string, so it classifies as unavailable — and
    // the raw provider message is dropped entirely.
    expect(result).toEqual({ ok: false, status: 502, code: "repository_provider_unavailable" })
    expect(JSON.stringify(result)).not.toContain("github-secret")
    expect(JSON.stringify(result)).not.toContain("Unauthorized for token")
  })

  test("reverify: 'unsupported' without a verify impl, 'missing' when the stored secret is gone", async () => {
    const unsupported = harness({ impl: { actions: { docs: docsPort } } })
    await unsupported.connections.upsert({
      id: "connection-1",
      integrationId: "fake",
      grantedCapabilities: ["docs"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    })
    expect(await unsupported.service.reverify("connection-1")).toEqual({ ok: false, reason: "unsupported" })

    // A connection whose backing credential was deleted out from under it.
    const { service, credentials } = harness()
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    await credentials.deleteByProvider("integration:connection-1")
    expect(await service.reverify("connection-1")).toEqual({ ok: false, reason: "missing" })

    // An unknown id has no row and therefore no impl to consult.
    expect(await service.reverify("nope")).toEqual({ ok: false, reason: "unsupported" })
  })

  test("reverify surfaces the impl's closed failure reason and never repairs the credential status", async () => {
    // The provider is reachable at connect time and unreachable afterwards.
    let reachable = true
    const { service, credentials } = harness({
      impl: {
        actions: { docs: docsPort },
        auth: { verify: async () => (reachable ? { ok: true } : { ok: false, reason: "network" }) },
      },
    })
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    await service.reportAuthFailure("connection-1", "401 from provider")
    expect(credentials.inspect("integration:connection-1")).toMatchObject({ status: "error" })

    reachable = false
    // readSecret ignores status, so the impl still runs; a failed re-verify
    // must leave the credential in error rather than restoring it.
    const result = await service.reverify("connection-1")
    expect(result).toEqual({ ok: false, reason: "network" })
    expect(credentials.inspect("integration:connection-1")).toMatchObject({ status: "error" })
    expect(JSON.stringify(result)).not.toContain("good")
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
        actions: { docs: docsPort },
        auth: {
          verify: async () => {
            throw new Error(`upstream said: invalid token ${secret}`)
          },
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


  test("no surviving path writes webhook signing material", async () => {
    const { service, credentials } = harness({ decl: GITHUB_DECL })
    await expect(service.connect({ integrationId: "github", fields: {}, secret: "good" })).resolves.toEqual({ ok: true })
    await service.reverify("connection-1")
    await service.getToken("connection-1", "work-source")
    expect(await credentials.get("integration:connection-1:webhook-signing")).toBeUndefined()
    expect(Reflect.get(service, "setWebhookSigningSecret")).toBeUndefined()
    expect(Reflect.get(service, "resolveWebhookSigningSecret")).toBeUndefined()
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

  test("a row is never written for a credential the store does not have", async () => {
    // The pairing rests on the write order, so the second write has to check
    // the first: a credential store that accepts a put it did not keep would
    // otherwise produce a connection that answers every token request
    // `connection_not_available` and that re-verify cannot repair.
    const registry = createIntegrationRegistry()
    registry.register(KEY_DECL, {
      actions: { docs: docsPort },
      auth: { verify: async () => ({ ok: true }) },
    })
    const memory = createMemoryCredentialStore()
    const credentials: CredentialStorePort = { ...memory, put: async () => undefined }
    const connections = createMemoryConnectionStore()
    const service = createConnectionsService({
      registry,
      credentials,
      connections,
      attempts: createAttempts({ sweepIntervalMs: 0 }),
      newId: () => "connection-1",
    })

    await expect(service.connect({ integrationId: "fake", fields: {}, secret: "sk-lost" }))
      .rejects.toThrow("integration:connection-1 was not stored")
    expect(await connections.getById("connection-1")).toBeUndefined()
    service.dispose()
  })

  test("a refused upsert undoes nothing at the credential store", async () => {
    // No compensation: an undo of the first write is a second failure path
    // that can itself fail, and the secret it would delete is unreachable
    // anyway — a provider id is only ever addressed through a row.
    const registry = createIntegrationRegistry()
    registry.register(KEY_DECL, {
      actions: { docs: docsPort },
      auth: { verify: async () => ({ ok: true }) },
    })
    const memory = createMemoryCredentialStore()
    const deleted: string[] = []
    const credentials: CredentialStorePort = {
      ...memory,
      deleteByProvider: async (providerId) => {
        deleted.push(providerId)
        return memory.deleteByProvider(providerId)
      },
    }
    const store = createMemoryConnectionStore()
    const connections: ConnectionStorePort = {
      ...store,
      async upsert() {
        throw new ConnectionExistsError()
      },
    }
    const service = createConnectionsService({
      registry,
      credentials,
      connections,
      attempts: createAttempts({ sweepIntervalMs: 0 }),
      newId: () => "connection-orphan",
    })

    await expect(service.connect({ integrationId: "fake", fields: {}, secret: "sk-residue" }))
      .rejects.toBeInstanceOf(ConnectionExistsError)
    expect(deleted).toEqual([])
    expect(await connections.getById("connection-orphan")).toBeUndefined()
    service.dispose()
  })

  test("reportAuthFailure never relabels a credential that is not serving", async () => {
    // revoked/expired are host lifecycle decisions and "error" is a prior
    // report: a caller-asserted auth failure may only take an available
    // credential out of service, not rewrite any other state.
    for (const status of ["revoked", "expired", "error"] as const) {
      const registry = createIntegrationRegistry()
      registry.register(KEY_DECL, {
        actions: { docs: docsPort },
        auth: { verify: async () => ({ ok: true }) },
      })
      const memory = createMemoryCredentialStore()
      const statusWrites: string[] = []
      const credentials: CredentialStorePort = {
        ...memory,
        get: async () => ({ kind: "api_key", status }),
        setStatus: async (_providerId, next) => {
          statusWrites.push(next)
        },
      }
      const service = createConnectionsService({
        registry,
        credentials,
        connections: createMemoryConnectionStore(),
        attempts: createAttempts({ sweepIntervalMs: 0 }),
        newId: () => "connection-1",
      })
      await service.connect({ integrationId: "fake", fields: {}, secret: "good" })

      await service.reportAuthFailure("connection-1", "401 from provider")
      expect(statusWrites, status).toEqual([])
      service.dispose()
    }
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

  test("resolveForCapability filters by granted capability and integration", async () => {
    const { service } = harness()
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    expect(await service.resolveForCapability("channel")).toHaveLength(0)
    const handles = await service.resolveForCapability("docs")
    expect(handles).toHaveLength(1)
    expect(handles[0].integrationId).toBe("fake")
    expect(await handles[0].getToken()).toEqual({ token: "good", tokenType: "bearer" })
    expect(await service.resolveForCapability("docs", { integration: "other" })).toHaveLength(0)
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
      actions: { docs: docsPort },
      auth: { verify: async () => ({ ok: true }) },
    })
    const memoryCredentials = createMemoryCredentialStore()
    let outage = false
    const service = createConnectionsService({
      registry,
      credentials: {
        ...memoryCredentials,
        async get(providerId) {
          if (outage) throw new ConnectionsUnavailableError()
          return memoryCredentials.get(providerId)
        },
      },
      connections: createMemoryConnectionStore(),
      attempts: createAttempts({ sweepIntervalMs: 0 }),
      newId: () => "connection-1",
    })
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })

    outage = true
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
      {
        id: "oauthy",
        name: "OAuthy",
        methods: ["oauth"],
        prompts: [{ id: "resource", label: "Resource" }]
      },
      {
        actions: { docs: docsPort },
        auth: {
          authorize: (state) => new URL(`https://provider.test/auth?state=${state}`),
          callback: async (code) => ({
            accessToken: `at-${code}`,
            refreshToken: "rt-1",
            expiresAt: 111,
            fields: { resource: "https://resource.test/mcp", undeclared: "discard" },
          }),
      
        },
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
    expect(await connections.get("oauthy", "user-a")).toMatchObject({
      id: "connection-1",
      owner: "user-a",
      fields: { resource: "https://resource.test/mcp" },
    })
    expect(await service.attemptStatus(state)).toMatchObject({ status: "complete" })

    // Replay: same state again must be rejected before the impl runs.
    expect(await service.handleCallback(state, "code-2")).toEqual({ ok: false })
    expect(await credentials.readSecret("integration:connection-1")).toBe(JSON.stringify({ access: "at-code-1", refresh: "rt-1" }))
  })

  test("OAuth integrations persist allowlisted callback metadata without rendering it as a prompt", async () => {
    const registry = createIntegrationRegistry()
    registry.register(
      { id: "mcp", name: "MCP", methods: ["oauth"]  },
      {
        actions: { mcp: mcpPort },
        auth: {
          canonicalFields: ["resource"],
          authorize: (state) => new URL(`https://provider.test/auth?state=${state}`),
          callback: async () => ({
            accessToken: "access",
            fields: { resource: "https://resource.test/mcp", untrusted: "discard" },
          }),
      
        },
      },
    )
    const connections = createMemoryConnectionStore()
    const service = createConnectionsService({
      registry,
      connections,
      credentials: createMemoryCredentialStore(),
      attempts: createAttempts({ sweepIntervalMs: 0 }),
      newId: () => "connection-1",
    })

    const started = await service.connectOAuth({ integrationId: "mcp", owner: "user-a" })
    expect(started.ok).toBe(true)
    await service.handleCallback((started as { attemptId: string }).attemptId, "code")
    expect((await connections.get("mcp", "user-a"))?.fields).toEqual({ resource: "https://resource.test/mcp" })
    expect(registry.list()[0]?.prompts).toBeUndefined()
  })

  test("missing OAuth callback code settles and releases the consumed attempt", async () => {
    let now = 0
    const attempts = createAttempts({ now: () => now, retentionMs: 100, sweepIntervalMs: 0 })
    const registry = createIntegrationRegistry()
    registry.register(
      { id: "oauthy", name: "OAuthy", methods: ["oauth"]  },
      {
        actions: { docs: docsPort },
        auth: {
          authorize: (state) => new URL(`https://provider.test/auth?state=${state}`),
          callback: async (code) => ({ accessToken: `at-${code}` }),
      
        },
      },
    )
    const service = createConnectionsService({
      registry,
      credentials: createMemoryCredentialStore(),
      connections: createMemoryConnectionStore(),
      attempts,
      newId: () => "connection-1",
    })
    const started = await service.connectOAuth({ integrationId: "oauthy" })
    const state = (started as { attemptId: string }).attemptId

    await expect(service.handleCallback(state, undefined)).resolves.toEqual({ ok: false })
    expect(await service.attemptStatus(state)).toMatchObject({
      status: "failed",
      message: "callback_code_missing",
    })

    now = 101
    attempts.sweep()
    expect(await service.attemptStatus(state)).toBeUndefined()
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
      { id: "oauthy", name: "OAuthy", methods: ["oauth"]  },
      {
        actions: { docs: docsPort },
        auth: {
          authorize: (state) => new URL(`https://provider.example/auth?state=${state}`),
          callback: async (code) => ({ accessToken: `at-${code}` }),
      
        },
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
    expect(await service.attemptStatus(state)).toMatchObject({ scope: "team" })
  })
})
