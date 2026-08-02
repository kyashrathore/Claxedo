import { describe, expect, test } from "vitest"
import { CredentialVerificationError, verifyCredential } from "./verify"
import type { CredentialMetadata } from "./types"

const NOW = 1_700_000_000_000
const TOKEN_URL = "https://auth.openai.com/oauth/token"

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

function codexSecret(access = "access_old") {
  return JSON.stringify({
    type: "codex_auth",
    tokens: { access_token: access, refresh_token: "refresh_old", account_id: "acct_1" },
    refresh: "refresh_old",
    access,
    expires: NOW - 1,
    account_id: "acct_1",
    oauth: { refresh: "refresh_old", access, expires: NOW - 1, account_id: "acct_1" },
  })
}

/**
 * One stub for both hops: the token endpoint and the provider probe. Recording
 * both is the point — the bug this covers was a probe that never happened.
 */
function transport(input: {
  token?: { ok?: boolean; body?: unknown }
  probe?: { ok?: boolean; status?: number; body?: string }
}) {
  const calls: Array<{
    url: string
    authorization?: string
    headers: Record<string, string>
    body?: Record<string, unknown>
  }> = []
  const stub = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: target,
      headers,
      ...(headers.Authorization ? { authorization: headers.Authorization } : {}),
      ...(typeof init?.body === "string" && init.body.startsWith("{")
        ? { body: JSON.parse(init.body) as Record<string, unknown> }
        : {}),
    })
    if (target === TOKEN_URL) {
      const token = input.token ?? {}
      return {
        ok: token.ok ?? true,
        status: token.ok === false ? 400 : 200,
        json: async () => token.body ?? { access_token: "access_new", refresh_token: "refresh_new" },
        text: async () => "",
      } as unknown as Response
    }
    const probe = input.probe ?? {}
    return {
      ok: probe.ok ?? true,
      status: probe.status ?? (probe.ok === false ? 400 : 200),
      text: async () => probe.body ?? "",
    } as unknown as Response
  }) as unknown as typeof fetch
  return {
    stub,
    calls,
    tokenCalls: () => calls.filter((call) => call.url === TOKEN_URL),
    probeCalls: () => calls.filter((call) => call.url !== TOKEN_URL),
  }
}

describe("verifyCredential — stale but refreshable", () => {
  test("refreshes a stale Codex login, probes with the new token, and returns ok", async () => {
    const transports = transport({})

    const outcome = await verifyCredential(credential({ expires_at: NOW - 1 }), codexSecret(), {
      fetch: transports.stub,
      now: () => NOW,
    })

    expect(outcome.health).toBe("ok")
    expect(transports.tokenCalls()).toHaveLength(1)
    // The regression: before the fix the local expiry short-circuited and the
    // provider was never contacted at all.
    expect(transports.probeCalls()).toHaveLength(1)
    expect(transports.probeCalls()[0]!.authorization).toBe("Bearer access_new")
    expect(outcome.refreshed?.secret).toBeDefined()
    expect(JSON.parse(outcome.refreshed!.secret).access).toBe("access_new")
  })

  test("hands the caller the renewed secret and its new expiry to persist", async () => {
    const transports = transport({})

    const outcome = await verifyCredential(credential({ expires_at: NOW - 1 }), codexSecret(), {
      fetch: transports.stub,
      now: () => NOW,
    })

    expect(outcome.refreshed?.expiresAt).toBe(NOW + 55 * 60 * 1000)
    expect(JSON.parse(outcome.refreshed!.secret).tokens.refresh_token).toBe("refresh_new")
  })

  test("still reports a provider verdict after a successful refresh", async () => {
    const transports = transport({ probe: { ok: false, status: 402, body: "insufficient_quota" } })

    const outcome = await verifyCredential(credential({ expires_at: NOW - 1 }), codexSecret(), {
      fetch: transports.stub,
      now: () => NOW,
    })

    expect(outcome.health).toBe("no_billing")
    expect(outcome.refreshed).toBeDefined()
  })
})

describe("verifyCredential — stale and not refreshable", () => {
  test("a rejected refresh token is expired, and the provider is not probed", async () => {
    const transports = transport({ token: { ok: false } })

    const outcome = await verifyCredential(credential({ expires_at: NOW - 1 }), codexSecret(), {
      fetch: transports.stub,
      now: () => NOW,
    })

    expect(outcome).toEqual({ health: "expired" })
    expect(transports.tokenCalls()).toHaveLength(1)
    expect(transports.probeCalls()).toHaveLength(0)
  })

  test("a secret with no refresh token is expired without any network call", async () => {
    const transports = transport({})
    const secret = JSON.stringify({ type: "codex_auth", access: "access_old", expires: NOW - 1 })

    const outcome = await verifyCredential(credential({ expires_at: NOW - 1 }), secret, {
      fetch: transports.stub,
      now: () => NOW,
    })

    expect(outcome).toEqual({ health: "expired" })
    expect(transports.calls).toHaveLength(0)
  })

  test("a provider with no refresh grant keeps the old short-circuit", async () => {
    const transports = transport({})

    const outcome = await verifyCredential(
      credential({ provider_id: "claude-acp", expires_at: NOW - 1 }),
      JSON.stringify({ claudeAiOauth: { accessToken: "access_old" } }),
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "expired" })
    expect(transports.calls).toHaveLength(0)
  })
})

describe("verifyCredential — unexpired credentials are untouched", () => {
  test("never calls the token endpoint when the credential is still fresh", async () => {
    const transports = transport({})

    const outcome = await verifyCredential(credential({ expires_at: NOW + 60_000 }), codexSecret(), {
      fetch: transports.stub,
      now: () => NOW,
    })

    expect(outcome).toEqual({ health: "ok" })
    expect(transports.tokenCalls()).toHaveLength(0)
    expect(transports.probeCalls()[0]!.authorization).toBe("Bearer access_old")
  })

  test("maps provider failures without a refresh attempt", async () => {
    const cases: Array<{ probe: { ok: false; status: number; body?: string }; health: string }> = [
      { probe: { ok: false, status: 429 }, health: "rate_capped" },
      { probe: { ok: false, status: 401 }, health: "auth_failed" },
      { probe: { ok: false, status: 400, body: "token_expired" }, health: "expired" },
    ]
    for (const item of cases) {
      const transports = transport({ probe: item.probe })
      const outcome = await verifyCredential(credential({ expires_at: NOW + 60_000 }), codexSecret(), {
        fetch: transports.stub,
        now: () => NOW,
      })
      expect(outcome).toEqual({ health: item.health })
      expect(transports.tokenCalls()).toHaveLength(0)
    }
  })

  test("an api_key credential verifies with the raw secret", async () => {
    const transports = transport({})

    const outcome = await verifyCredential(
      credential({ provider_id: "anthropic", kind: "api_key" }),
      "sk-ant-key",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "ok" })
    expect(transports.probeCalls()[0]!.url).toBe("https://api.anthropic.com/v1/messages")
    expect(transports.probeCalls()[0]!.headers["x-api-key"]).toBe("sk-ant-key")
    expect(transports.probeCalls()[0]!.headers.Authorization).toBeUndefined()
  })

  /**
   * A `claude setup-token` value is OAuth material that arrives through the
   * API-key paste path, so it is stored as `api_key` — the asymmetry the
   * cloud-sharing rule uses to tell a mintable token from an unshareable
   * Keychain login. Branching the auth header on `kind` therefore sent a
   * subscription token as `x-api-key`, which Anthropic rejects: the user pasted
   * a valid token and onboarding told them it was refused. The header must
   * follow the secret's shape, matching what `claudeAuthEnv` does at spawn.
   */
  test("a pasted setup-token verifies as OAuth even though it is stored as an api_key", async () => {
    const transports = transport({})

    const outcome = await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "api_key" }),
      "sk-ant-oat01-setup-token-value",
      { fetch: transports.stub, now: () => NOW },
    )

    const probe = transports.probeCalls()[0]!
    expect(outcome).toEqual({ health: "ok" })
    expect(probe.headers.Authorization).toBe("Bearer sk-ant-oat01-setup-token-value")
    expect(probe.headers["anthropic-beta"]).toBe("oauth-2025-04-20")
    expect(probe.headers["x-api-key"]).toBeUndefined()
  })

  /**
   * A token pasted out of a terminal usually carries a trailing newline. The
   * desktop form trims before saving, but nothing on the wire enforces that —
   * `secret` is stored verbatim — so the server cannot depend on a client
   * having done it. Untrimmed, the prefix match misses and the token takes the
   * API-key branch: the exact failure the predicate exists to prevent.
   */
  test("a setup-token pasted with surrounding whitespace is still recognised as OAuth", async () => {
    const transports = transport({})

    await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "api_key" }),
      "  sk-ant-oat01-setup-token-value\n",
      { fetch: transports.stub, now: () => NOW },
    )

    const probe = transports.probeCalls()[0]!
    expect(probe.headers.Authorization).toBe("Bearer sk-ant-oat01-setup-token-value")
    expect(probe.headers["anthropic-beta"]).toBe("oauth-2025-04-20")
    expect(probe.headers["x-api-key"]).toBeUndefined()
  })

  /**
   * A leading space is not dropped by the Headers API — it survives into the
   * value, so the provider is handed a token that is not the user's and returns
   * auth_failed on a good key.
   */
  test("a console API key with surrounding whitespace is sent as the bare key", async () => {
    const transports = transport({})

    await verifyCredential(
      credential({ provider_id: "anthropic", kind: "api_key" }),
      "  sk-ant-api03-console-key\n",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(transports.probeCalls()[0]!.headers["x-api-key"]).toBe("sk-ant-api03-console-key")
  })

  test("a console API key is still sent as x-api-key, never as a bearer token", async () => {
    const transports = transport({})

    await verifyCredential(
      credential({ provider_id: "claude-acp", kind: "api_key" }),
      "sk-ant-api03-console-key",
      { fetch: transports.stub, now: () => NOW },
    )

    const probe = transports.probeCalls()[0]!
    expect(probe.headers["x-api-key"]).toBe("sk-ant-api03-console-key")
    expect(probe.headers.Authorization).toBeUndefined()
    expect(probe.headers["anthropic-beta"]).toBeUndefined()
  })

  test("a discovered Keychain login still verifies as OAuth", async () => {
    const transports = transport({})

    await verifyCredential(
      credential({ provider_id: "claude-acp", kind: "oauth_token" }),
      JSON.stringify({ type: "claude_code_oauth", claudeAiOauth: { accessToken: "sk-ant-oat01-keychain" } }),
      { fetch: transports.stub, now: () => NOW },
    )

    const probe = transports.probeCalls()[0]!
    expect(probe.headers.Authorization).toBe("Bearer sk-ant-oat01-keychain")
    expect(probe.headers["anthropic-beta"]).toBe("oauth-2025-04-20")
  })

  // Pinned against what chatgpt.com/backend-api/codex/responses actually
  // enforces (observed 2026-07-25): a string `input` is "Input must be a list",
  // store true is "Store must be set to false", stream false is "Stream must be
  // set to true", and max_output_tokens is "Unsupported parameter". Each of
  // those is a 400 that maps to a hard error, so a valid ChatGPT subscription
  // could never verify.
  test("sends the Codex endpoint the request shape it accepts", async () => {
    const transports = transport({})

    await verifyCredential(credential({ expires_at: NOW + 60_000 }), codexSecret(), {
      fetch: transports.stub,
      now: () => NOW,
    })

    const probe = transports.probeCalls()[0]!
    expect(probe.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(Array.isArray(probe.body!.input)).toBe(true)
    expect(probe.body!.stream).toBe(true)
    expect(probe.body!.store).toBe(false)
    expect(probe.body).not.toHaveProperty("max_output_tokens")
  })

  test("keeps the public Responses shape for plain OpenAI API keys", async () => {
    const transports = transport({})

    await verifyCredential(credential({ provider_id: "openai", kind: "api_key" }), "sk-openai", {
      fetch: transports.stub,
      now: () => NOW,
    })

    const probe = transports.probeCalls()[0]!
    expect(probe.url).toBe("https://api.openai.com/v1/responses")
    expect(probe.body!.input).toBe("Reply with OK.")
    expect(probe.body!.max_output_tokens).toBe(1)
  })

  /**
   * `GET /v1/me` is Cursor's documented key-introspection route — "retrieve
   * information about the API key being used for authentication" — so it answers
   * exactly the question a probe asks, spends no model quota, and mutates
   * nothing. Bearer auth, per the same docs.
   */
  test("a Cursor key verifies against the documented key-introspection route", async () => {
    const transports = transport({})

    const outcome = await verifyCredential(
      credential({ provider_id: "cursor-acp", kind: "api_key" }),
      "cursor-dashboard-key",
      { fetch: transports.stub, now: () => NOW },
    )

    const probe = transports.probeCalls()[0]!
    expect(outcome).toEqual({ health: "ok" })
    expect(probe.url).toBe("https://api.cursor.com/v1/me")
    expect(probe.headers.Authorization).toBe("Bearer cursor-dashboard-key")
    // A key check must never be a billable model call.
    expect(probe.body).toBeUndefined()
  })

  test("a rejected Cursor key is auth_failed, not an error", async () => {
    const transports = transport({ probe: { ok: false, status: 401, body: "unauthorized" } })

    const outcome = await verifyCredential(
      credential({ provider_id: "cursor-acp", kind: "api_key" }),
      "cursor-revoked-key",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "auth_failed" })
  })

  test("a rate-capped Cursor key still authenticated", async () => {
    const transports = transport({ probe: { ok: false, status: 429, body: "too many requests" } })

    const outcome = await verifyCredential(
      credential({ provider_id: "cursor-acp", kind: "api_key" }),
      "cursor-dashboard-key",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "rate_capped" })
  })

  /**
   * An unreachable provider says nothing about the key. It must surface as
   * `CredentialVerificationError`, which `probeDiscoveredCredential` maps to the
   * `unknown` verdict — an offline laptop must never render a red cross against
   * a credential that is fine.
   */
  test("a network failure is inconclusive, never a verdict against the key", async () => {
    const offline = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.cursor.com")
    }) as unknown as typeof fetch

    await expect(
      verifyCredential(
        credential({ provider_id: "cursor-acp", kind: "api_key" }),
        "cursor-dashboard-key",
        { fetch: offline, now: () => NOW },
      ),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })

  test("a Cursor key pasted with surrounding whitespace is sent bare", async () => {
    const transports = transport({})

    await verifyCredential(
      credential({ provider_id: "cursor-acp", kind: "api_key" }),
      "  cursor-dashboard-key\n",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(transports.probeCalls()[0]!.headers.Authorization).toBe("Bearer cursor-dashboard-key")
  })

  test("an unsupported provider is an error, not a health verdict", async () => {
    const transports = transport({})

    await expect(
      verifyCredential(credential({ provider_id: "not-a-provider", kind: "api_key" }), "token", {
        fetch: transports.stub,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })
})

/**
 * Sandbox provider keys were the one credential kind nothing could check: a bad
 * key was first discovered at workspace creation, long after the user believed
 * setup had succeeded. Routing the kind through the same entry point gives
 * their rows the live verdicts AI credentials already get.
 */
describe("verifyCredential — sandbox providers", () => {
  test("a sandbox driver credential is probed against its provider", async () => {
    const transports = transport({})

    const outcome = await verifyCredential(
      credential({ provider_id: "daytona", kind: "sandbox_driver" }),
      JSON.stringify({ api_key: "dtn_key" }),
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "ok" })
    expect(transports.probeCalls()[0]!.url).toBe("https://app.daytona.io/api/api-keys/current")
    expect(transports.probeCalls()[0]!.headers.Authorization).toBe("Bearer dtn_key")
  })

  test("a rejected sandbox provider key is auth_failed, not an error", async () => {
    const transports = transport({ probe: { ok: false, status: 401, body: "unauthorized" } })

    const outcome = await verifyCredential(
      credential({ provider_id: "box", kind: "sandbox_driver" }),
      JSON.stringify({ api_key: "box_revoked" }),
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "auth_failed" })
  })

  /**
   * The legacy encoder stored single-field drivers bare, and
   * `credentials/migrate.ts` still writes daytona that way — a stored
   * credential that predates the JSON codec must still verify rather than read
   * as an unsupported shape.
   */
  test("a legacy bare secret still verifies", async () => {
    const transports = transport({})

    const outcome = await verifyCredential(
      credential({ provider_id: "daytona", kind: "sandbox_driver" }),
      "dtn_legacy_key",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "ok" })
    expect(transports.probeCalls()[0]!.headers.Authorization).toBe("Bearer dtn_legacy_key")
  })

  test("a sandbox provider with no documented probe is an error, not a verdict", async () => {
    const transports = transport({})

    await expect(
      verifyCredential(
        credential({ provider_id: "modal", kind: "sandbox_driver" }),
        JSON.stringify({ token_id: "ak-1", token_secret: "as-1" }),
        { fetch: transports.stub, now: () => NOW },
      ),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
    expect(transports.probeCalls()).toHaveLength(0)
  })

  test("an unknown sandbox provider id is an error, not a verdict", async () => {
    const transports = transport({})

    await expect(
      verifyCredential(
        credential({ provider_id: "not-a-driver", kind: "sandbox_driver" }),
        JSON.stringify({ api_key: "x" }),
        { fetch: transports.stub, now: () => NOW },
      ),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
    expect(transports.probeCalls()).toHaveLength(0)
  })
})
