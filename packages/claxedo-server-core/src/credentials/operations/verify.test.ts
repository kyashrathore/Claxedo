import { describe, expect, test, vi } from "vitest"
import { CredentialVerificationError, verifyCredential } from "./verify"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"

const NOW = 1_700_000_000_000

test("unsupported providers return a typed verification error", async () => {
  await expect(verifyCredential(credential({ provider_id: "unsupported-provider", expires_at: null }), "secret"))
    .rejects.toMatchObject({ code: "credential_verification_unsupported", status: 400, retryable: false })
})

test("unreadable secrets return a typed validation error", async () => {
  await expect(verifyCredential(credential({ provider_id: "openai", kind: "api_key", expires_at: null }), "{}"))
    .rejects.toMatchObject({ code: "credential_shape_invalid", status: 400, retryable: false })
})
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
const CATALOG_URL = "https://api.anthropic.com/v1/models"

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

type Answer = { ok?: boolean; status?: number; body?: string; json?: unknown; headers?: Record<string, string> }

/**
 * One stub for all four hops: the token endpoint, the model catalog, the
 * provider probe and Anthropic's profile read, each a real `Response` so
 * status, headers and body are read the way a vendor's are. Recording every
 * one is the point — the bug this covers was a probe that never happened, and
 * the auxiliary reads must stay off the verdict while visible to an assertion.
 */
function transport(input: {
  token?: { ok?: boolean; body?: unknown; status?: number; text?: string; headers?: Record<string, string> }
  probe?: Answer
  profile?: { ok?: boolean; status?: number; json?: unknown }
  /** The model catalog an Anthropic subscription token's verdict comes from. */
  catalog?: Answer
}) {
  const calls: Array<{
    url: string
    authorization?: string
    headers: Record<string, string>
    body?: Record<string, unknown>
  }> = []
  const answer = (item: Answer, refusedStatus: number) => {
    const status = item.status ?? (item.ok === false ? refusedStatus : 200)
    const body = item.body ?? (item.json === undefined ? (status === 200 ? "{}" : "") : JSON.stringify(item.json))
    const type = item.body === undefined && item.json !== undefined ? "application/json" : item.headers?.["content-type"]
    return new Response(body, { status, headers: { ...(type ? { "content-type": type } : {}), ...item.headers } })
  }
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
      const status = token.status ?? (token.ok === false ? 400 : 200)
      const body = token.text
        ?? JSON.stringify(status === 200 ? token.body ?? { access_token: "access_new", refresh_token: "refresh_new" } : { error: "invalid_grant" })
      return new Response(body, { status, headers: { "content-type": "application/json", ...token.headers } })
    }
    if (target === CATALOG_URL) return answer(input.catalog ?? {}, 401)
    if (target === PROFILE_URL) {
      const profile = input.profile ?? {}
      return Response.json(profile.json ?? {}, { status: profile.status ?? (profile.ok === false ? 403 : 200) })
    }
    return answer(input.probe ?? {}, 400)
  }) as unknown as typeof fetch
  return {
    stub,
    calls,
    tokenCalls: () => calls.filter((call) => call.url === TOKEN_URL),
    probeCalls: () => calls.filter((call) => call.url !== TOKEN_URL && call.url !== PROFILE_URL && call.url !== CATALOG_URL),
    profileCalls: () => calls.filter((call) => call.url === PROFILE_URL),
    catalogCalls: () => calls.filter((call) => call.url === CATALOG_URL),
  }
}

const ANTHROPIC_AUTH_ERROR = { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }
const ANTHROPIC_SCOPE_ERROR = {
  type: "error",
  error: { type: "permission_error", message: "OAuth token does not meet scope requirement", details: { error_code: "oauth_scope_insufficient" } },
}
const ANTHROPIC_RATE_LIMIT = { type: "error", error: { type: "rate_limit_error", message: "Rate limited. Please try again later." } }
/** What Cloudflare answers a request it challenges: the edge's page, not the API's error. */
const CHALLENGE_PAGE: Answer = {
  status: 403,
  body: "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>",
  headers: { "content-type": "text/html; charset=UTF-8" },
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
    expect(transports.probeCalls()[0].authorization).toBe("Bearer access_new")
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
    const transports = transport({ probe: { status: 402, json: { error: { type: "insufficient_quota" } } } })

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

    expect(outcome).toEqual({ health: "expired", evidence: { status: 400, type: "invalid_grant" } })
    expect(transports.tokenCalls()).toHaveLength(1)
    expect(transports.probeCalls()).toHaveLength(0)
  })

  /**
   * The token endpoint answering with no OAuth error — a gateway page, a 5xx —
   * says nothing about the refresh token. Only `invalid_grant` and its kin end
   * a login; everything else leaves the stored verdict alone.
   */
  test("a refresh the token endpoint cannot conclude is not an expiry", async () => {
    const transports = transport({ token: { status: 502, text: "<html>bad gateway</html>", headers: { "content-type": "text/html" } } })

    await expect(verifyCredential(credential({ expires_at: NOW - 1 }), codexSecret(), { fetch: transports.stub, now: () => NOW }))
      .rejects.toMatchObject({ code: "credential_provider_unavailable" })
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
      credential({ provider_id: "claude-sdk", expires_at: NOW - 1 }),
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

    expect(outcome).toEqual({ health: "ok", usage: [] })
    expect(transports.tokenCalls()).toHaveLength(0)
    expect(transports.probeCalls()[0].authorization).toBe("Bearer access_old")
  })

  test("maps the vendor's own refusals without a refresh attempt, and keeps the status and error type behind each", async () => {
    const cases: Array<{ probe: Answer; outcome: Record<string, unknown> }> = [
      {
        probe: { status: 429, json: { error: { type: "usage_limit_reached" } }, headers: { "retry-after": "3124" } },
        outcome: { health: "rate_capped", evidence: { status: 429, type: "usage_limit_reached", retryAfterSeconds: 3124 } },
      },
      { probe: { status: 401, json: { detail: "Could not parse your authentication token" } }, outcome: { health: "auth_failed", evidence: { status: 401 } } },
      { probe: { status: 400, json: { error: { code: "token_expired" } } }, outcome: { health: "expired", evidence: { status: 400, type: "token_expired" } } },
    ]
    for (const item of cases) {
      const transports = transport({ probe: item.probe })
      const outcome = await verifyCredential(credential({ expires_at: NOW + 60_000 }), codexSecret(), {
        fetch: transports.stub,
        now: () => NOW,
      })
      expect(outcome).toEqual(item.outcome)
      expect(transports.tokenCalls()).toHaveLength(0)
    }
  })

  /**
   * chatgpt.com answers a Worker's request with Cloudflare's challenge page: a
   * 403 with an HTML body and no API error. That is the edge refusing the
   * client, not the vendor refusing the login, so it is no verdict at all —
   * the Check fails and the stored row is left as it was.
   */
  test("a probe answered with the edge's challenge page is inconclusive, never a refusal of the key", async () => {
    const transports = transport({ probe: CHALLENGE_PAGE })

    await expect(verifyCredential(credential({ provider_id: "openai", kind: "api_key" }), "sk-openai", { fetch: transports.stub, now: () => NOW }))
      .rejects.toMatchObject({ code: "credential_verification_failed", message: expect.stringMatching(/403.*text\/html/) })
    expect(transports.tokenCalls()).toHaveLength(0)
  })

  /**
   * chatgpt.com answers a Worker with Cloudflare's challenge page, so from
   * there the usage read judges nothing. auth.openai.com answers the same
   * Worker with its own JSON, so the login's refresh grant is the one
   * conclusive signal a Worker can get: taken, the login is live; refused,
   * it is over. Without it, a hosted ChatGPT plan once marked refused by the
   * old reading could never have been written `ok` again.
   */
  describe("a ChatGPT login the edge will not let the usage read judge", () => {
    /** A row the old reading marked refused, which only a verdict can bring back. */
    const refused = () => credential({ expires_at: NOW + 60_000, health: "auth_failed", status: "error" })

    test("is proven live by its refresh grant when it is refused, through the caller's refresh path, and its windows stay unread", async () => {
      const transports = transport({ probe: CHALLENGE_PAGE })
      const refresh = vi.fn(async () => ({ secret: codexSecret("access_renewed"), expiresAt: NOW + 3_600_000 }))

      const outcome = await verifyCredential(refused(), codexSecret(), { fetch: transports.stub, now: () => NOW, refresh })

      expect(outcome).toEqual({ health: "ok", refreshed: { secret: codexSecret("access_renewed"), expiresAt: NOW + 3_600_000 }, usageRefused: { status: 403 } })
      expect(refresh).toHaveBeenCalledOnce()
      expect(transports.probeCalls()).toHaveLength(1)
    })

    /**
     * The exchange rotates a single-use refresh token: spent on every Usage
     * view load it would race the runtime's own renewal and a second tab, and
     * OpenAI's reuse detection ends the whole login. A deliverable row has
     * nothing to recover, so it is left exactly as it is and nothing is spent.
     */
    test("an ok row whose usage read is a challenge page is left unchanged with no refresh", async () => {
      for (const row of [credential({ expires_at: NOW + 60_000 }), credential({ expires_at: NOW + 60_000, health: "ok" }), credential({ expires_at: NOW + 60_000, health: "rate_capped" })]) {
        const transports = transport({ probe: CHALLENGE_PAGE })
        const refresh = vi.fn(async () => ({ secret: codexSecret("access_renewed"), expiresAt: NOW + 3_600_000 }))

        await expect(verifyCredential(row, codexSecret(), { fetch: transports.stub, now: () => NOW, refresh }))
          .rejects.toMatchObject({ code: "credential_verification_failed", message: expect.stringMatching(/403.*text\/html/) })
        expect(refresh).not.toHaveBeenCalled()
        expect(transports.tokenCalls()).toHaveLength(0)
      }
    })

    test("a row kept out by its status alone is recovered too", async () => {
      const transports = transport({ probe: CHALLENGE_PAGE })

      const outcome = await verifyCredential(credential({ expires_at: NOW + 60_000, status: "error" }), codexSecret(), { fetch: transports.stub, now: () => NOW })

      expect(outcome.health).toBe("ok")
      expect(JSON.parse(outcome.refreshed!.secret).access).toBe("access_new")
      expect(transports.tokenCalls()).toHaveLength(1)
    })

    test("is over when the token endpoint refuses the grant", async () => {
      const transports = transport({ probe: CHALLENGE_PAGE, token: { ok: false } })

      const outcome = await verifyCredential(refused(), codexSecret(), { fetch: transports.stub, now: () => NOW })

      expect(outcome).toEqual({ health: "expired", evidence: { status: 400, type: "invalid_grant" } })
    })

    test("stays unjudged when the token endpoint's answer is not its own", async () => {
      const transports = transport({ probe: CHALLENGE_PAGE, token: { status: 502, text: "<html>bad gateway</html>", headers: { "content-type": "text/html" } } })

      await expect(verifyCredential(refused(), codexSecret(), { fetch: transports.stub, now: () => NOW }))
        .rejects.toMatchObject({ code: "credential_provider_unavailable" })
    })

    test("stays unjudged when the login carries no refresh token", async () => {
      const transports = transport({ probe: CHALLENGE_PAGE })
      const secret = JSON.stringify({ type: "codex_auth", tokens: { access_token: "access_old", account_id: "acct_1" } })

      await expect(verifyCredential(refused(), secret, { fetch: transports.stub, now: () => NOW }))
        .rejects.toMatchObject({ code: "credential_verification_failed" })
      expect(transports.tokenCalls()).toHaveLength(0)
    })

    test("a login just renewed for being stale is not renewed twice", async () => {
      const transports = transport({ probe: CHALLENGE_PAGE })

      const outcome = await verifyCredential(credential({ expires_at: NOW - 1 }), codexSecret(), { fetch: transports.stub, now: () => NOW })

      expect(outcome.health).toBe("ok")
      expect(outcome.refreshed).toBeDefined()
      expect(transports.tokenCalls()).toHaveLength(1)
    })
  })

  test("OpenAI's 429 for a key out of quota is no billing, not a rate cap", async () => {
    const transports = transport({ probe: { status: 429, json: { error: { type: "insufficient_quota", code: "insufficient_quota" } } } })

    const outcome = await verifyCredential(credential({ provider_id: "openai", kind: "api_key" }), "sk-openai", { fetch: transports.stub, now: () => NOW })

    expect(outcome).toEqual({ health: "no_billing", evidence: { status: 429, type: "insufficient_quota" } })
  })

  test("a vendor outage is inconclusive for a key, never a refusal of it", async () => {
    const transports = transport({ probe: { status: 503, json: { error: { type: "server_error" } } } })

    await expect(verifyCredential(credential({ provider_id: "openai", kind: "api_key" }), "sk-openai", { fetch: transports.stub, now: () => NOW }))
      .rejects.toMatchObject({ code: "credential_verification_failed", message: expect.stringMatching(/503 server_error/) })
  })

  test("a vendor outage on the usage read of a refused ChatGPT login leaves it to its refresh grant, which still proves it", async () => {
    const transports = transport({ probe: { status: 503, json: { error: { type: "server_error" } } } })

    const outcome = await verifyCredential(credential({ expires_at: NOW + 60_000, health: "auth_failed", status: "error" }), codexSecret(), {
      fetch: transports.stub,
      now: () => NOW,
    })

    expect(outcome).toMatchObject({ health: "ok", usageRefused: { status: 503, type: "server_error" } })
    expect(transports.tokenCalls()).toHaveLength(1)
  })

  test("an api_key credential verifies with the raw secret", async () => {
    const transports = transport({})

    const outcome = await verifyCredential(
      credential({ provider_id: "anthropic", kind: "api_key" }),
      "sk-ant-key",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "ok" })
    expect(transports.probeCalls()[0].url).toBe("https://api.anthropic.com/v1/messages")
    expect(transports.probeCalls()[0].headers["x-api-key"]).toBe("sk-ant-key")
    expect(transports.probeCalls()[0].headers.Authorization).toBeUndefined()
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

    const probe = transports.probeCalls()[0]
    expect(outcome).toEqual({ health: "ok", usage: [] })
    expect(probe.url).toBe("https://api.anthropic.com/api/oauth/usage")
    expect(probe.headers.Authorization).toBe("Bearer sk-ant-oat01-setup-token-value")
    expect(probe.headers["anthropic-beta"]).toBe("oauth-2025-04-20")
    expect(probe.headers["x-api-key"]).toBeUndefined()
  })

  test("a subscription token's check is the usage read, and it reports the plan's windows", async () => {
    const transports = transport({
      probe: {
        json: {
          five_hour: { utilization: 12.4, resets_at: "2026-09-12T18:00:00Z" },
          seven_day: { utilization: 40, resets_at: "2026-09-15T00:00:00Z" },
          seven_day_opus: null,
        },
      },
    })

    const outcome = await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "api_key" }),
      "sk-ant-oat01-setup-token-value",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({
      health: "ok",
      usage: [
        { window: "session", usedPercent: 12, resetsAt: Date.parse("2026-09-12T18:00:00Z") },
        { window: "weekly", usedPercent: 40, resetsAt: Date.parse("2026-09-15T00:00:00Z") },
      ],
    })
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

    const probe = transports.probeCalls()[0]
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

    expect(transports.probeCalls()[0].headers["x-api-key"]).toBe("sk-ant-api03-console-key")
  })

  test("a console API key is still sent as x-api-key, never as a bearer token", async () => {
    const transports = transport({})

    await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "api_key" }),
      "sk-ant-api03-console-key",
      { fetch: transports.stub, now: () => NOW },
    )

    const probe = transports.probeCalls()[0]
    expect(probe.headers["x-api-key"]).toBe("sk-ant-api03-console-key")
    expect(probe.headers.Authorization).toBeUndefined()
    expect(probe.headers["anthropic-beta"]).toBeUndefined()
  })

  test("a discovered Keychain login still verifies as OAuth", async () => {
    const transports = transport({})

    await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "oauth_token" }),
      JSON.stringify({ type: "claude_code_oauth", claudeAiOauth: { accessToken: "sk-ant-oat01-keychain" } }),
      { fetch: transports.stub, now: () => NOW },
    )

    const probe = transports.probeCalls()[0]
    expect(probe.headers.Authorization).toBe("Bearer sk-ant-oat01-keychain")
    expect(probe.headers["anthropic-beta"]).toBe("oauth-2025-04-20")
  })

  test("a ChatGPT login is checked with the usage read Codex's own status screen makes", async () => {
    const transports = transport({
      probe: {
        json: {
          rate_limit: {
            // Free plans get only the weekly window, in the primary slot.
            primary_window: { used_percent: 63.5, limit_window_seconds: 604_800, reset_at: 1_757_700_000 },
            secondary_window: null,
          },
        },
      },
    })

    const outcome = await verifyCredential(credential({ expires_at: NOW + 60_000 }), codexSecret(), {
      fetch: transports.stub,
      now: () => NOW,
    })

    const probe = transports.probeCalls()[0]
    expect(probe.url).toBe("https://chatgpt.com/backend-api/wham/usage")
    expect(probe.headers.Authorization).toBe("Bearer access_old")
    expect(probe.headers["ChatGPT-Account-Id"]).toBe("acct_1")
    expect(probe.body).toBeUndefined()
    expect(outcome).toEqual({
      health: "ok",
      usage: [{ window: "weekly", usedPercent: 64, resetsAt: 1_757_700_000_000 }],
    })
  })

  test("both ChatGPT windows are named by their length, whichever slot carries them", async () => {
    const transports = transport({
      probe: {
        json: {
          rate_limit: {
            primary_window: { used_percent: 5, limit_window_seconds: 18_000, reset_at: 1_757_600_000 },
            secondary_window: { used_percent: 41, limit_window_seconds: 604_800, reset_at: 1_757_700_000 },
          },
        },
      },
    })

    const outcome = await verifyCredential(credential({ expires_at: NOW + 60_000 }), codexSecret(), {
      fetch: transports.stub,
      now: () => NOW,
    })

    expect(outcome.usage).toEqual([
      { window: "session", usedPercent: 5, resetsAt: 1_757_600_000_000 },
      { window: "weekly", usedPercent: 41, resetsAt: 1_757_700_000_000 },
    ])
  })

  test("a usage read the vendor's API rejects is a verdict on the login, not on the read", async () => {
    const transports = transport({ probe: { status: 401, json: { detail: "Could not parse your authentication token" } } })

    const outcome = await verifyCredential(credential({ expires_at: NOW + 60_000 }), codexSecret(), {
      fetch: transports.stub,
      now: () => NOW,
    })

    expect(outcome).toEqual({ health: "auth_failed", evidence: { status: 401 } })
  })

  test("keeps the public Responses shape for plain OpenAI API keys", async () => {
    const transports = transport({})

    await verifyCredential(credential({ provider_id: "openai", kind: "api_key" }), "sk-openai", {
      fetch: transports.stub,
      now: () => NOW,
    })

    const probe = transports.probeCalls()[0]
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
      credential({ provider_id: "cursor-sdk", kind: "api_key" }),
      "cursor-dashboard-key",
      { fetch: transports.stub, now: () => NOW },
    )

    const probe = transports.probeCalls()[0]
    expect(outcome).toEqual({ health: "ok" })
    expect(probe.url).toBe("https://api.cursor.com/v1/me")
    expect(probe.headers.Authorization).toBe("Bearer cursor-dashboard-key")
    // A key check must never be a billable model call.
    expect(probe.body).toBeUndefined()
  })

  test("a rejected Cursor key is auth_failed, not an error", async () => {
    const transports = transport({ probe: { status: 401, json: { error: "unauthorized" } } })

    const outcome = await verifyCredential(
      credential({ provider_id: "cursor-sdk", kind: "api_key" }),
      "cursor-revoked-key",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "auth_failed", evidence: { status: 401, type: "unauthorized" } })
  })

  test("a rate-capped Cursor key still authenticated", async () => {
    const transports = transport({ probe: { status: 429, body: "too many requests" } })

    const outcome = await verifyCredential(
      credential({ provider_id: "cursor-sdk", kind: "api_key" }),
      "cursor-dashboard-key",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "rate_capped", evidence: { status: 429 } })
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
        credential({ provider_id: "cursor-sdk", kind: "api_key" }),
        "cursor-dashboard-key",
        { fetch: offline, now: () => NOW },
      ),
    ).rejects.toBeInstanceOf(CredentialVerificationError)
  })

  test("a Cursor key pasted with surrounding whitespace is sent bare", async () => {
    const transports = transport({})

    await verifyCredential(
      credential({ provider_id: "cursor-sdk", kind: "api_key" }),
      "  cursor-dashboard-key\n",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(transports.probeCalls()[0].headers.Authorization).toBe("Bearer cursor-dashboard-key")
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

describe("verifyCredential — naming the account", () => {
  function jwt(claims: Record<string, unknown>) {
    return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
  }

  test("a ChatGPT subscription is named from its own claims, with no extra request", async () => {
    const transports = transport({})
    const secret = JSON.stringify({
      type: "codex_auth",
      tokens: {
        id_token: jwt({ email: "chatgpt@example.com", chatgpt_account_id: "acct_1" }),
        access_token: "access_old",
        refresh_token: "refresh_old",
        account_id: "acct_1",
      },
    })

    const outcome = await verifyCredential(credential({ expires_at: NOW + 60_000 }), secret, {
      fetch: transports.stub,
      now: () => NOW,
    })

    expect(outcome).toEqual({ health: "ok", usage: [], accountEmail: "chatgpt@example.com" })
    expect(transports.probeCalls()).toHaveLength(1)
  })

  test("an Anthropic subscription is named from the profile read", async () => {
    const transports = transport({ profile: { json: { account: { email_address: "claude@example.com" } } } })

    const outcome = await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "oauth_token" }),
      JSON.stringify({ type: "claude_code_oauth", claudeAiOauth: { accessToken: "sk-ant-oat01-keychain" } }),
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "ok", usage: [], accountEmail: "claude@example.com" })
    expect(transports.profileCalls()[0].headers.Authorization).toBe("Bearer sk-ant-oat01-keychain")
    expect(transports.profileCalls()[0].headers["anthropic-beta"]).toBe("oauth-2025-04-20")
  })

  /**
   * `/api/oauth/profile` is not granted to every subscription. A token the
   * usage read has just accepted is a working token, so a refusal there may
   * only cost the account its name — never turn a working credential into
   * `auth_failed`, which is what makes the user reconnect a good login.
   */
  test("a refused profile read leaves the usage read's verdict alone", async () => {
    const transports = transport({
      profile: { ok: false, status: 403, json: { account: { email_address: "refused@example.com" } } },
    })

    const outcome = await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "oauth_token" }),
      JSON.stringify({ type: "claude_code_oauth", claudeAiOauth: { accessToken: "sk-ant-oat01-keychain" } }),
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "ok", usage: [] })
    expect(transports.profileCalls()).toHaveLength(1)
  })

  test("a rejected token is asked nothing else: neither its windows nor who it belongs to", async () => {
    const transports = transport({ catalog: { status: 401, json: ANTHROPIC_AUTH_ERROR } })

    const outcome = await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "oauth_token" }),
      JSON.stringify({ type: "claude_code_oauth", claudeAiOauth: { accessToken: "sk-ant-oat01-revoked" } }),
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "auth_failed", evidence: { status: 401, type: "authentication_error" } })
    expect(transports.calls.map((call) => call.url)).toEqual([CATALOG_URL])
  })

  /**
   * `claude setup-token` mints `user:inference` only, so the usage read turns
   * the token away while every turn on it runs. The model catalog is the
   * inference scope's own route, and the only answer that judges the token;
   * the usage read's refusal costs the account its windows and nothing more.
   */
  test("a setup-token the usage read turns away is live when the model catalog answers it", async () => {
    const transports = transport({ probe: { status: 403, json: ANTHROPIC_SCOPE_ERROR } })

    const outcome = await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "oauth_token" }),
      "sk-ant-oat01-inference-only-setup-token",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "ok", usageRefused: { status: 403, type: "permission_error" } })
    const catalog = transports.calls.find((call) => call.url === CATALOG_URL)!
    expect(catalog.headers.Authorization).toBe("Bearer sk-ant-oat01-inference-only-setup-token")
    expect(catalog.headers["anthropic-beta"]).toBe("oauth-2025-04-20")
    expect(catalog.headers["x-api-key"]).toBeUndefined()
    expect(transports.profileCalls()).toHaveLength(0)
  })

  /**
   * Anthropic throttles `/api/oauth/usage` per token with a retry-after of
   * nearly an hour, while `/v1/models` and every turn keep answering. A
   * throttled plan read was marking a working account rate-capped and, through
   * the status that verdict set, undeliverable to every harness.
   */
  test("a throttled usage read leaves a working token ok and says when the windows can be read again", async () => {
    const transports = transport({ probe: { status: 429, json: ANTHROPIC_RATE_LIMIT, headers: { "retry-after": "3124" } } })

    const outcome = await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "oauth_token" }),
      "sk-ant-oat01-keychain",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "ok", usageRefused: { status: 429, type: "rate_limit_error", retryAfterSeconds: 3124 } })
    expect(transports.calls.map((call) => call.url)).toEqual([CATALOG_URL, "https://api.anthropic.com/api/oauth/usage"])
  })

  test("a usage read answered with the edge's page costs the windows, not the verdict", async () => {
    const transports = transport({ probe: CHALLENGE_PAGE })

    const outcome = await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "oauth_token" }),
      "sk-ant-oat01-keychain",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "ok", usageRefused: { status: 403 } })
  })

  test("a catalog answered with the edge's page leaves the token unjudged", async () => {
    const transports = transport({ catalog: CHALLENGE_PAGE })

    await expect(verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "oauth_token" }),
      "sk-ant-oat01-keychain",
      { fetch: transports.stub, now: () => NOW },
    )).rejects.toMatchObject({ code: "credential_verification_failed" })
    expect(transports.probeCalls()).toHaveLength(0)
  })

  test("a catalog the vendor throttles is rate-capped, with the vendor's word for it", async () => {
    const transports = transport({ catalog: { status: 429, json: ANTHROPIC_RATE_LIMIT, headers: { "retry-after": "60" } } })

    const outcome = await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "oauth_token" }),
      "sk-ant-oat01-keychain",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "rate_capped", evidence: { status: 429, type: "rate_limit_error", retryAfterSeconds: 60 } })
  })

  test("a token the catalog refuses is refused, and a console key never reaches the catalog", async () => {
    const refused = transport({ catalog: { status: 403, json: { type: "error", error: { type: "permission_error" } } } })
    expect(await verifyCredential(
      credential({ provider_id: "claude-sdk", kind: "oauth_token" }),
      "sk-ant-oat01-revoked",
      { fetch: refused.stub, now: () => NOW },
    )).toEqual({ health: "auth_failed", evidence: { status: 403, type: "permission_error" } })

    const key = transport({ probe: { status: 401, json: ANTHROPIC_AUTH_ERROR } })
    expect(await verifyCredential(
      credential({ provider_id: "anthropic", kind: "api_key" }),
      "sk-ant-api03-bad-key",
      { fetch: key.stub, now: () => NOW },
    )).toEqual({ health: "auth_failed", evidence: { status: 401, type: "authentication_error" } })
    expect(key.calls.map((call) => call.url)).toEqual(["https://api.anthropic.com/v1/messages"])
  })

  test("an API key names no account", async () => {
    const transports = transport({ profile: { json: { email: "leaked@example.com" } } })

    const outcome = await verifyCredential(
      credential({ provider_id: "anthropic", kind: "api_key" }),
      "sk-ant-api03-console-key",
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "ok" })
    expect(transports.profileCalls()).toHaveLength(0)
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
      credential({ provider_id: "boat", kind: "sandbox_driver" }),
      JSON.stringify({ api_key: "boat_key" }),
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "ok" })
    expect(transports.probeCalls()[0].url).toBe("https://boat.dev/api/v1/me")
    expect(transports.probeCalls()[0].headers.Authorization).toBe("Bearer boat_key")
  })

  test("a rejected sandbox provider key is auth_failed, not an error, with the provider's word behind it", async () => {
    const transports = transport({ probe: { status: 401, json: { ok: false, code: "unauthorized" } } })

    const outcome = await verifyCredential(
      credential({ provider_id: "boat", kind: "sandbox_driver" }),
      JSON.stringify({ api_key: "boat_revoked" }),
      { fetch: transports.stub, now: () => NOW },
    )

    expect(outcome).toEqual({ health: "auth_failed", evidence: { status: 401, type: "unauthorized" } })
  })

  test("a bare or non-object sandbox secret is refused without a provider request", async () => {
    const transports = transport({})
    for (const secret of ["boat_key", '"boat_key"', "[]", "null"]) {
      await expect(verifyCredential(
        credential({ provider_id: "boat", kind: "sandbox_driver" }),
        secret,
        { fetch: transports.stub, now: () => NOW },
      )).rejects.toThrow("Sandbox provider credential has an unsupported shape")
    }
    expect(transports.probeCalls()).toEqual([])
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
