import { describe, expect, test } from "bun:test"
import { createIntegrationRegistry } from "./registry.js"
import { ConnectionTokenError, DefinitiveRefreshError, createTokenService } from "./tokens.js"
import { createMemoryCredentialStore } from "./stores/memory.js"
import type { ConnectionRow, OAuthTokens } from "./types.js"

const ROW: ConnectionRow = {
  id: "connection-1",
  integrationId: "oauthy",
  grantedCapabilities: ["docs"],
  fields: {},
  createdAt: 0,
  updatedAt: 0,
}

const KEY_ROW: ConnectionRow = {
  ...ROW,
  integrationId: "keyed",
}

function oauthHarness(input: {
  refresh?: (refreshToken: string) => Promise<OAuthTokens>
  expiresAt?: number
  now?: () => number
  envelope?: Record<string, unknown>
}) {
  const registry = createIntegrationRegistry()
  registry.register(
    { id: "oauthy", name: "OAuthy", methods: ["oauth"], capabilities: ["docs"] },
    { ...(input.refresh ? { refresh: input.refresh } : {}) },
  )
  const credentials = createMemoryCredentialStore()
  const seed = async () =>
    credentials.put({
      providerId: "integration:connection-1",
      kind: "oauth_token",
      secret: JSON.stringify(input.envelope ?? { access: "old-access", refresh: "old-refresh" }),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    })
  const tokens = createTokenService({ registry, credentials, now: input.now ?? (() => 1_000_000) })
  return { credentials, tokens, seed }
}

describe("token service", () => {
  for (const tokenType of ["bearer", "basic"] as const) {
    test(`key token preserves declared ${tokenType} authorization type`, async () => {
      const registry = createIntegrationRegistry()
      registry.register(
        { id: "keyed", name: "Keyed", methods: ["key"], capabilities: ["docs"], keyTokenType: tokenType },
        {},
      )
      const credentials = createMemoryCredentialStore()
      await credentials.put({ providerId: "integration:connection-1", kind: "api_key", secret: "key-secret" })

      expect(await createTokenService({ registry, credentials }).getLiveToken(KEY_ROW)).toEqual({
        token: "key-secret",
        tokenType,
      })
    })
  }

  test("missing integration declaration requires reconnect without resolving the secret", async () => {
    let reads = 0
    const credentials = createMemoryCredentialStore()
    await credentials.put({ providerId: "integration:connection-1", kind: "api_key", secret: "hidden-secret" })
    const tokens = createTokenService({
      registry: createIntegrationRegistry(),
      credentials: {
        ...credentials,
        async resolveSecret(providerId) {
          reads += 1
          return credentials.resolveSecret(providerId)
        },
      },
    })

    await expect(tokens.getLiveToken(KEY_ROW)).rejects.toMatchObject({
      status: 409,
      code: "connection_not_available",
      credentialStatus: "reconnect_required",
    })
    expect(reads).toBe(0)
  })

  test("missing key token type requires reconnect without resolving the secret", async () => {
    let reads = 0
    const registry = createIntegrationRegistry()
    registry.register({ id: "keyed", name: "Keyed", methods: ["key"], capabilities: ["docs"] }, {})
    const credentials = createMemoryCredentialStore()
    await credentials.put({ providerId: "integration:connection-1", kind: "api_key", secret: "hidden-secret" })
    const tokens = createTokenService({
      registry,
      credentials: {
        ...credentials,
        async resolveSecret(providerId) {
          reads += 1
          return credentials.resolveSecret(providerId)
        },
      },
    })

    await expect(tokens.getLiveToken(KEY_ROW)).rejects.toMatchObject({
      status: 409,
      code: "connection_not_available",
      credentialStatus: "reconnect_required",
    })
    expect(reads).toBe(0)
  })

  test("fresh oauth token passes through without refresh", async () => {
    const { tokens, seed } = oauthHarness({ expiresAt: 1_000_000 + 10 * 60_000 })
    await seed()
    expect(await tokens.getLiveToken(ROW)).toEqual({ token: "old-access", tokenType: "bearer" })
  })

  test("expiring token refreshes once under concurrency (single-flight)", async () => {
    let refreshCalls = 0
    const { tokens, seed, credentials } = oauthHarness({
      expiresAt: 1_000_000 + 1_000,
      refresh: async (rt) => {
        refreshCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(rt).toBe("old-refresh")
        return { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 1_000_000 + 60 * 60_000 }
      },
    })
    await seed()
    const [a, b] = await Promise.all([tokens.getLiveToken(ROW), tokens.getLiveToken(ROW)])
    expect(refreshCalls).toBe(1)
    expect(a).toEqual({ token: "new-access", tokenType: "bearer" })
    expect(b).toEqual({ token: "new-access", tokenType: "bearer" })
    // Rotating refresh token atomically replaced in the envelope.
    expect(await credentials.readSecret("integration:connection-1")).toBe(
      JSON.stringify({ access: "new-access", refresh: "new-refresh" }),
    )
  })

  test("non-rotating provider keeps the old refresh token", async () => {
    const { tokens, seed, credentials } = oauthHarness({
      expiresAt: 1_000_000 + 1_000,
      refresh: async () => ({ accessToken: "new-access" }),
    })
    await seed()
    await tokens.getLiveToken(ROW)
    expect(await credentials.readSecret("integration:connection-1")).toBe(
      JSON.stringify({ access: "new-access", refresh: "old-refresh" }),
    )
  })

  test("definitive refresh rejection persists error and stops serving", async () => {
    const { tokens, seed, credentials } = oauthHarness({
      expiresAt: 1_000_000 + 1_000,
      refresh: async () => {
        throw new DefinitiveRefreshError("invalid_grant")
      },
    })
    await seed()
    await expect(tokens.getLiveToken(ROW)).rejects.toMatchObject({ status: 409, code: "connection_not_available" })
    expect(credentials.inspect("integration:connection-1")).toMatchObject({ status: "error", lastError: "refresh_failed" })
    // Subsequent calls: 409 immediately (status gate), no retry loop.
    await expect(tokens.getLiveToken(ROW)).rejects.toMatchObject({ status: 409 })
  })

  test("transient refresh failure leaves status available and a later call retries", async () => {
    let calls = 0
    const { tokens, seed, credentials } = oauthHarness({
      expiresAt: 1_000_000 + 1_000,
      refresh: async () => {
        calls += 1
        if (calls === 1) throw new Error("ECONNRESET")
        return { accessToken: "recovered", expiresAt: 1_000_000 + 60 * 60_000 }
      },
    })
    await seed()
    await expect(tokens.getLiveToken(ROW)).rejects.toMatchObject({ status: 503, code: "connection_refresh_transient" })
    expect(credentials.inspect("integration:connection-1")).toMatchObject({ status: "available" })
    expect(await tokens.getLiveToken(ROW)).toEqual({ token: "recovered", tokenType: "bearer" })
    expect(calls).toBe(2)
  })

  test("missing refresh token in envelope is definitive", async () => {
    const { tokens, seed, credentials } = oauthHarness({
      expiresAt: 1_000_000 + 1_000,
      envelope: { access: "old-access" },
      refresh: async () => ({ accessToken: "never" }),
    })
    await seed()
    await expect(tokens.getLiveToken(ROW)).rejects.toBeInstanceOf(ConnectionTokenError)
    expect(credentials.inspect("integration:connection-1")).toMatchObject({ status: "error" })
  })

  test("missing credential is 409 connection_not_available", async () => {
    const { tokens } = oauthHarness({})
    await expect(tokens.getLiveToken(ROW)).rejects.toMatchObject({
      status: 409,
      code: "connection_not_available",
      credentialStatus: "missing",
    })
  })
})
