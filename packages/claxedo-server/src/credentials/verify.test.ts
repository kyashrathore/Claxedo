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
  const calls: Array<{ url: string; authorization?: string; body?: Record<string, unknown> }> = []
  const stub = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: target,
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

  test("an unsupported provider is an error, not a health verdict", async () => {
    const transports = transport({})

    await expect(
      verifyCredential(credential({ provider_id: "vercel", kind: "sandbox_driver" }), "token", {
        fetch: transports.stub,
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })
})
