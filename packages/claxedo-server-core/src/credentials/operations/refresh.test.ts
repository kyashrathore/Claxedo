import { describe, expect, test } from "vitest"
import {
  CredentialRefreshError,
  credentialRefreshToken,
  isRefreshableCredential,
  refreshCredentialSecret,
  renewedCredential,
} from "./refresh"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"

const NOW = 1_700_000_000_000

function credential(input: Partial<CredentialMetadata> = {}): CredentialMetadata {
  return {
    id: "cred_1",
    provider_id: "codex-app-server",
    kind: "oauth_token",
    source: "local_only",
    status: "available",
    created_at: NOW,
    updated_at: NOW,
    revision: 1,
    incarnation: "cred_1",
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
    expect(isRefreshableCredential(credential({ provider_id: "codex-app-server" }))).toBe(true)
    expect(isRefreshableCredential(credential({ provider_id: "openai" }))).toBe(true)
  })

  test("rejects API keys and providers with no refresh grant", () => {
    expect(isRefreshableCredential(credential({ kind: "api_key" }))).toBe(false)
    expect(isRefreshableCredential(credential({ provider_id: "claude-sdk" }))).toBe(false)
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
    expect(calls[0].url).toBe("https://auth.openai.com/oauth/token")
    expect(calls[0].init.method).toBe("POST")
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    )
    // The grant must go out already form-encoded: a non-string body would be
    // serialized by fetch under a content type this request pins by hand.
    const rawBody = calls[0].init.body
    expect(typeof rawBody).toBe("string")
    const body = new URLSearchParams(typeof rawBody === "string" ? rawBody : "")
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
      refreshCredentialSecret(credential({ provider_id: "claude-sdk" }), codexSecret(), { fetch: stub }),
    ).rejects.toBeInstanceOf(CredentialRefreshError)
    expect(calls).toHaveLength(0)
  })
})

describe("renewedCredential", () => {
  function stored(row: CredentialMetadata) {
    let secret = codexSecret()
    let current = row
    const writes: number[] = []
    return {
      writes,
      store: {
        read: async () => secret,
        write: async (next: { secret: string; expiresAt: number }) => {
          secret = next.secret
          writes.push(next.expiresAt)
          current = { ...current, expires_at: next.expiresAt, revision: current.revision + 1 }
        },
        reread: async () => current,
        fresh: (expiresAt: number) => { current = { ...current, expires_at: expiresAt } },
      },
    }
  }

  test("hands over a login with time to spare unchanged, and renews one inside the window", async () => {
    const { stub, calls } = tokenResponse({ access_token: jwt(NOW / 1000 + 3600), refresh_token: "refresh_new" })
    const spare = credential({ id: "spare", expires_at: NOW + 60 * 60 * 1000 })
    const target = stored(spare)
    expect(await renewedCredential(spare, target.store, { fetch: stub, now: () => NOW })).toBe(spare)
    expect(calls).toHaveLength(0)

    const due = credential({ id: "due", expires_at: NOW + 60_000 })
    const renewing = stored(due)
    expect((await renewedCredential(due, renewing.store, { fetch: stub, now: () => NOW })).expires_at).toBe(NOW + 3_600_000)
    expect(renewing.writes).toEqual([NOW + 3_600_000])
  })

  test("renews a login its holder reports refused unless the store already holds a newer one", async () => {
    const { stub, calls } = tokenResponse({ access_token: jwt(NOW / 1000 + 7200), refresh_token: "refresh_new" })
    const row = credential({ id: "refused", expires_at: NOW + 60 * 60 * 1000 })
    const target = stored(row)
    expect((await renewedCredential(row, target.store, { fetch: stub, now: () => NOW, rejectedExpiresAt: NOW + 60 * 60 * 1000 })).expires_at)
      .toBe(NOW + 7_200_000)
    expect(await renewedCredential(row, target.store, { fetch: stub, now: () => NOW, rejectedExpiresAt: NOW + 30 * 60 * 1000 })).toBe(row)
    expect(calls).toHaveLength(1)
  })

  test("takes the renewal another process won instead of failing on the spent refresh token", async () => {
    const { stub } = tokenResponse({ error: "invalid_grant" }, { ok: false, status: 400 })
    const row = credential({ id: "raced", expires_at: NOW + 60_000 })
    const target = stored(row)
    target.store.fresh(NOW + 3_600_000)
    expect((await renewedCredential(row, target.store, { fetch: stub, now: () => NOW })).expires_at).toBe(NOW + 3_600_000)

    const lost = credential({ id: "lost", expires_at: NOW + 60_000 })
    await expect(renewedCredential(lost, stored(lost).store, { fetch: stub, now: () => NOW })).rejects.toBeInstanceOf(CredentialRefreshError)
  })
})
