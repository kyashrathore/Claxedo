import { describe, expect, test } from "vitest"
import {
  CredentialRefreshError,
  credentialRefreshToken,
  isRefreshableCredential,
  refreshCredentialSecret,
} from "./refresh"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"

const NOW = 1_700_000_000_000

function credential(input: Partial<CredentialMetadata> = {}): CredentialMetadata {
  return {
    id: "cred_1",
    provider_id: "codex-acp",
    kind: "oauth_token",
    source: "local_only",
    status: "available",
    created_at: NOW,
    updated_at: NOW,
    ...input,
  }
}

/** Mirrors what `sync.ts` writes for a `~/.codex/accounts/*.auth.json` login. */
function codexSecret(access = "access_old", refresh = "refresh_old") {
  return JSON.stringify({
    source: "codex",
    type: "codex_auth",
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: "id_old", access_token: access, refresh_token: refresh, account_id: "acct_1" },
    last_refresh: "2026-04-09T18:54:40.649142Z",
    refresh,
    access,
    expires: NOW - 1,
    account_id: "acct_1",
    oauth: { refresh, access, expires: NOW - 1, account_id: "acct_1" },
  })
}

function jwt(expSeconds: number) {
  const claims = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")
  return `header.${claims}.signature`
}

function tokenResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const stub = (async (url: string | URL, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} })
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { stub, calls }
}

describe("isRefreshableCredential", () => {
  test("accepts OAuth logins for providers that mint renewable tokens", () => {
    expect(isRefreshableCredential(credential({ provider_id: "codex-acp" }))).toBe(true)
    expect(isRefreshableCredential(credential({ provider_id: "codex-app-server" }))).toBe(true)
    expect(isRefreshableCredential(credential({ provider_id: "openai" }))).toBe(true)
  })

  test("rejects API keys and providers with no refresh grant", () => {
    expect(isRefreshableCredential(credential({ kind: "api_key" }))).toBe(false)
    expect(isRefreshableCredential(credential({ provider_id: "claude-acp" }))).toBe(false)
  })
})

describe("credentialRefreshToken", () => {
  test("reads the codex secret shape", () => {
    expect(credentialRefreshToken(codexSecret())).toBe("refresh_old")
  })

  test("reads the OpenCode-shaped nested oauth secret", () => {
    const secret = JSON.stringify({ type: "oauth", oauth: { refresh: "nested_refresh", access: "a" } })
    expect(credentialRefreshToken(secret)).toBe("nested_refresh")
  })

  test("returns undefined for an API key or a secret with no refresh token", () => {
    expect(credentialRefreshToken("sk-plain-api-key")).toBeUndefined()
    expect(credentialRefreshToken(JSON.stringify({ access: "only" }))).toBeUndefined()
  })
})

describe("refreshCredentialSecret", () => {
  test("posts the form-encoded refresh grant the provider expects", async () => {
    const { stub, calls } = tokenResponse({ access_token: jwt(1_700_003_600), refresh_token: "refresh_new" })

    await refreshCredentialSecret(credential(), codexSecret(), { fetch: stub, now: () => NOW })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://auth.openai.com/oauth/token")
    expect(calls[0]!.init.method).toBe("POST")
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    )
    const body = new URLSearchParams(String(calls[0]!.init.body))
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("refresh_token")).toBe("refresh_old")
    expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
  })

  test("rewrites every mirrored token position and takes expiry from the new access token", async () => {
    const access = jwt(1_700_003_600)
    const { stub } = tokenResponse({ access_token: access, refresh_token: "refresh_new", id_token: "id_new" })

    const result = await refreshCredentialSecret(credential(), codexSecret(), { fetch: stub, now: () => NOW })
    const secret = JSON.parse(result.secret) as Record<string, any>

    expect(result.expiresAt).toBe(1_700_003_600_000)
    expect(secret.access).toBe(access)
    expect(secret.refresh).toBe("refresh_new")
    expect(secret.expires).toBe(1_700_003_600_000)
    expect(secret.tokens.access_token).toBe(access)
    expect(secret.tokens.refresh_token).toBe("refresh_new")
    expect(secret.tokens.id_token).toBe("id_new")
    expect(secret.oauth.access).toBe(access)
    expect(secret.oauth.refresh).toBe("refresh_new")
    expect(secret.oauth.expires).toBe(1_700_003_600_000)
    expect(secret.last_refresh).toBe(new Date(NOW).toISOString())
    // Identity and provider config survive untouched.
    expect(secret.account_id).toBe("acct_1")
    expect(secret.tokens.account_id).toBe("acct_1")
    expect(secret.auth_mode).toBe("chatgpt")
    expect(secret.type).toBe("codex_auth")
  })

  test("keeps the current refresh token when the provider does not rotate it", async () => {
    const { stub } = tokenResponse({ access_token: jwt(1_700_003_600) })

    const result = await refreshCredentialSecret(credential(), codexSecret(), { fetch: stub, now: () => NOW })

    expect((JSON.parse(result.secret) as { refresh: string }).refresh).toBe("refresh_old")
  })

  test("falls back to a 55 minute lifetime when the access token carries no exp", async () => {
    const { stub } = tokenResponse({ access_token: "opaque-token" })

    const result = await refreshCredentialSecret(credential(), codexSecret(), { fetch: stub, now: () => NOW })

    expect(result.expiresAt).toBe(NOW + 55 * 60 * 1000)
  })

  test("does not invent keys the stored secret never had", async () => {
    const { stub } = tokenResponse({ access_token: "opaque-token", refresh_token: "refresh_new" })
    const lean = JSON.stringify({ type: "oauth", refresh: "refresh_old", access: "access_old" })

    const result = await refreshCredentialSecret(credential({ provider_id: "openai" }), lean, {
      fetch: stub,
      now: () => NOW,
    })

    expect(JSON.parse(result.secret)).toEqual({ type: "oauth", refresh: "refresh_new", access: "opaque-token" })
  })

  test("rejects when the refresh token is refused", async () => {
    const { stub } = tokenResponse({ error: "invalid_grant" }, { ok: false, status: 400 })

    await expect(refreshCredentialSecret(credential(), codexSecret(), { fetch: stub, now: () => NOW })).rejects
      .toBeInstanceOf(CredentialRefreshError)
  })

  test("rejects when the response carries no access token", async () => {
    const { stub } = tokenResponse({ refresh_token: "refresh_new" })

    await expect(refreshCredentialSecret(credential(), codexSecret(), { fetch: stub, now: () => NOW })).rejects
      .toBeInstanceOf(CredentialRefreshError)
  })

  test("rejects providers that have no refresh grant", async () => {
    const { stub, calls } = tokenResponse({ access_token: "a" })

    await expect(
      refreshCredentialSecret(credential({ provider_id: "claude-acp" }), codexSecret(), { fetch: stub }),
    ).rejects.toBeInstanceOf(CredentialRefreshError)
    expect(calls).toHaveLength(0)
  })
})
