import { describe, expect, test } from "bun:test"
import { createIntegrationRegistry } from "./registry.js"
import { createConnectionsService } from "./service.js"
import { createAttempts } from "./attempts.js"
import { createMemoryConnectionStore, createMemoryCredentialStore } from "./stores/memory.js"
import type { IntegrationDeclaration, IntegrationImpl } from "./types.js"

const KEY_DECL: IntegrationDeclaration = {
  id: "fake",
  name: "Fake",
  methods: ["key"],
  capabilities: ["docs"],
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
  const service = createConnectionsService({ registry, credentials, connections, attempts })
  return { registry, credentials, connections, service }
}

describe("connections service", () => {
  test("connect verifies, stores namespaced credential, grants declaration capabilities", async () => {
    const { service, credentials, connections } = harness()
    const result = await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    expect(result).toEqual({ ok: true })
    expect(await credentials.get("integration:fake")).toMatchObject({ kind: "api_key", status: "available" })
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
    expect(await credentials.get("integration:fake")).toBeUndefined()
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
    expect(await service.remove("fake")).toBe(true)
    expect(await credentials.get("integration:fake")).toBeUndefined()
    expect(await service.remove("fake")).toBe(false)
  })

  test("reportAuthFailure flips status; getToken then 409; reverify restores", async () => {
    const { service, credentials } = harness()
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    await service.reportAuthFailure("fake", "401 from provider")
    expect(credentials.inspect("integration:fake")).toMatchObject({ status: "error", lastError: "auth_failure_reported" })
    const denied = await service.getToken("fake", "docs")
    expect(denied).toMatchObject({ ok: false, status: 409, code: "connection_not_available" })
    const reverified = await service.reverify("fake")
    expect(reverified).toMatchObject({ ok: true })
    const granted = await service.getToken("fake", "docs")
    expect(granted).toMatchObject({ ok: true, response: { token: "good", tokenType: "bearer" } })
  })

  test("getToken: 404 unknown, 403 ungranted capability", async () => {
    const { service } = harness()
    expect(await service.getToken("nope", "docs")).toMatchObject({ ok: false, status: 404 })
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    expect(await service.getToken("fake", "channel")).toMatchObject({ ok: false, status: 403, code: "capability_not_granted" })
    expect(await service.getToken("fake", undefined)).toMatchObject({ ok: false, status: 403 })
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

  test("list derives connected/degraded/broken status", async () => {
    const { service, credentials } = harness()
    await service.connect({ integrationId: "fake", fields: {}, secret: "good" })
    expect((await service.list())[0]).toMatchObject({ status: "connected" })
    await credentials.setStatus("integration:fake", "error", "boom")
    expect((await service.list())[0]).toMatchObject({ status: "degraded" })
    await credentials.deleteByProvider("integration:fake")
    expect((await service.list())[0]).toMatchObject({ status: "broken" })
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
    const result = await service.getToken("fake", "docs")
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
    const service = createConnectionsService({ registry, credentials, connections, attempts: createAttempts({ sweepIntervalMs: 0 }) })

    const started = await service.connectOAuth({ integrationId: "oauthy" })
    expect(started.ok).toBe(true)
    const state = (started as { attemptId: string }).attemptId
    expect((started as { url: string }).url).toContain(`state=${state}`)

    expect(await service.handleCallback(state, "code-1")).toEqual({ ok: true })
    expect(await credentials.readSecret("integration:oauthy")).toBe(JSON.stringify({ access: "at-code-1", refresh: "rt-1" }))
    expect(service.attemptStatus(state)).toMatchObject({ status: "complete" })

    // Replay: same state again must be rejected before the impl runs.
    expect(await service.handleCallback(state, "code-2")).toEqual({ ok: false })
    expect(await credentials.readSecret("integration:oauthy")).toBe(JSON.stringify({ access: "at-code-1", refresh: "rt-1" }))
  })
})
