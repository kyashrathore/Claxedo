import { describe, expect, test, vi } from "vitest"
import { createHostedQuotaReader } from "./hosted-quota"
import type { ControlPlaneCredentials } from "../authority/control-plane-contract"
import type { CredentialMetadata, CredentialUsageWindow } from "../credentials/types"

const ORG = "org_acme"
const ANTHROPIC_USAGE = "https://api.anthropic.com/api/oauth/usage"
const CHATGPT_USAGE = "https://chatgpt.com/backend-api/wham/usage"

function credential(input: Partial<CredentialMetadata> & { id: string; provider_id: string }): CredentialMetadata {
  return {
    kind: "oauth_token",
    source: "managed",
    status: "available",
    owner: "alice",
    created_at: 0,
    updated_at: 0,
    revision: 1,
    incarnation: input.id,
    ...input,
  }
}

/** A store whose rows take the verdict and the windows a Check writes, as the hosted D1 store does. */
function store(rows: CredentialMetadata[], secrets: Record<string, string | null>) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const credentials = {
    listCredentials: vi.fn(async () => [...byId.values()]),
    effectiveCredentials: vi.fn(async () => [...byId.values()].filter((row) => row.activated_at != null)),
    resolveCredentialSecretById: vi.fn(async (id: string) => secrets[id] ?? null),
    updateCredentialHealth: vi.fn(async (id: string, health: CredentialMetadata["health"], at: number) => {
      byId.set(id, { ...byId.get(id)!, health, last_validated_at: at })
    }),
    updateCredentialUsage: vi.fn(async (id: string, windows: CredentialUsageWindow[], at: number) => {
      byId.set(id, { ...byId.get(id)!, usage_windows: windows, usage_at: at })
    }),
    updateCredentialLabel: vi.fn(async (id: string, label: string) => {
      byId.set(id, { ...byId.get(id)!, label })
    }),
    updateCredentialSecret: vi.fn(async () => true),
  } as unknown as ControlPlaneCredentials
  return credentials as ControlPlaneCredentials & { resolveCredentialSecretById: ReturnType<typeof vi.fn> }
}

const vendors = (answers: Record<string, () => Response | Promise<Response>>) =>
  vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const answer = answers[url]
    if (!answer) return new Response("not found", { status: 404 })
    return await answer()
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>

const ANTHROPIC_MODELS = "https://api.anthropic.com/v1/models"
const anthropicModels = () => Response.json({ data: [] })
const anthropicUsage = () => Response.json({ five_hour: { utilization: 30, resets_at: 400 }, seven_day: { utilization: 61, resets_at: 900 } })
const chatgptUsage = () => Response.json({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 500 } } })

const claude = credential({ id: "claude", provider_id: "claude-sdk", account_id: "acct_claude", label: "claude-sdk", activated_at: 5 })
const codex = credential({ id: "codex", provider_id: "codex-app-server", account_id: "acct_codex", label: "contactyash@example.com", activated_at: 6 })
const secrets = { claude: "sk-ant-oat01-alice", codex: JSON.stringify({ tokens: { access_token: "codex-access", account_id: "acct_codex" } }) }

describe("hosted usage quota reader", () => {
  test("the first read of unchecked logins asks each vendor before answering, and the cards carry their windows", async () => {
    const credentials = store([claude, codex], secrets)
    const fetchImpl = vendors({
      [ANTHROPIC_MODELS]: anthropicModels,
      [ANTHROPIC_USAGE]: anthropicUsage,
      "https://api.anthropic.com/api/oauth/profile": () => Response.json({ account: { email_address: "ada@example.com" } }),
      [CHATGPT_USAGE]: chatgptUsage,
    })
    const read = createHostedQuotaReader({ credentials, now: () => 1_000, fetch: fetchImpl })

    const answer = await read({ org: ORG, person: "alice", refresh: false })

    expect(answer).not.toHaveProperty("refreshing")
    expect(answer.status).toBe("available")
    expect(answer.snapshot?.accounts.map((account) => [account.harness, account.label, account.inUse, account.usageAt, account.windows])).toEqual([
      ["claude", "ada@example.com", true, 1_000, [
        { window: "session", usedPercent: 30, resetsAt: 400_000 },
        { window: "weekly", usedPercent: 61, resetsAt: 900_000 },
      ]],
      ["codex", "contactyash@example.com", true, 1_000, [{ window: "session", usedPercent: 12, resetsAt: 500_000 }]],
    ])
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([ANTHROPIC_USAGE, CHATGPT_USAGE]))
    expect(credentials.updateCredentialUsage).toHaveBeenCalledWith("claude", expect.any(Array), 1_000, ORG)
  })

  test("figures read recently are answered from the store; a refresh reads again at once and the next one inside a minute is answered from it", async () => {
    const credentials = store([codex], secrets)
    const fetchImpl = vendors({ [CHATGPT_USAGE]: chatgptUsage })
    let clock = 1_000
    const read = createHostedQuotaReader({ credentials, now: () => clock, fetch: fetchImpl, staleAfterMs: 300_000, refreshIntervalMs: 60_000 })

    await read({ org: ORG, person: "alice", refresh: false })
    clock = 200_000
    await read({ org: ORG, person: "alice", refresh: false })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock = 301_000
    await read({ org: ORG, person: "alice", refresh: false })
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    clock = 310_000
    expect(await read({ org: ORG, person: "alice", refresh: true })).not.toHaveProperty("throttledUntil")
    expect(fetchImpl).toHaveBeenCalledTimes(3)

    clock = 340_000
    expect(await read({ org: ORG, person: "alice", refresh: true })).toMatchObject({ throttledUntil: 370_000 })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  test("a vendor that fails leaves its reason on that card and the other account's windows still land", async () => {
    const credentials = store([claude, codex], secrets)
    const fetchImpl = vendors({
      [ANTHROPIC_MODELS]: () => { throw new Error("offline") },
      [CHATGPT_USAGE]: chatgptUsage,
    })
    const read = createHostedQuotaReader({ credentials, now: () => 1_000, fetch: fetchImpl })

    const { status, snapshot } = await read({ org: ORG, person: "alice", refresh: false })

    expect(status).toBe("available")
    expect(snapshot?.accounts.map((account) => [account.harness, account.windows.length, account.usageError])).toEqual([
      ["claude", 0, "This account's limits could not be read: Credential provider request failed"],
      ["codex", 1, undefined],
    ])
  })

  test("a vendor that does not answer in time costs its own card, not the view", async () => {
    const credentials = store([claude, codex], secrets)
    const fetchImpl = vendors({
      [ANTHROPIC_MODELS]: () => new Promise<Response>(() => {}),
      [CHATGPT_USAGE]: chatgptUsage,
    })
    const read = createHostedQuotaReader({ credentials, now: () => 1_000, fetch: fetchImpl, checkTimeoutMs: 20 })

    const { snapshot } = await read({ org: ORG, person: "alice", refresh: false })

    expect(snapshot?.accounts.map((account) => [account.harness, account.windows.length, account.usageError])).toEqual([
      ["claude", 0, "The provider did not answer in time, so this account's limits could not be read. Refresh to try again."],
      ["codex", 1, undefined],
    ])
  })

  test("a login the vendor refuses and one whose secret is gone each say so on their card", async () => {
    const credentials = store([claude, codex], { claude: secrets.claude, codex: null })
    const fetchImpl = vendors({
      [ANTHROPIC_MODELS]: () => Response.json({ type: "error", error: { type: "authentication_error" } }, { status: 401 }),
    })
    const read = createHostedQuotaReader({ credentials, now: () => 1_000, fetch: fetchImpl })

    const { status, snapshot } = await read({ org: ORG, person: "alice", refresh: false })

    expect(status).toBe("unavailable")
    expect(snapshot?.accounts.map((account) => [account.harness, account.health, account.usageAt, account.usageError])).toEqual([
      ["claude", "auth_failed", 1_000, "The provider refused this login, so its limits cannot be read. Sign in to this account again."],
      ["codex", undefined, undefined, "This account's stored login is missing, so its limits cannot be read. Sign in to this account again."],
    ])
    expect(credentials.updateCredentialHealth).toHaveBeenCalledWith("claude", "auth_failed", 1_000, ORG, { status: 401, type: "authentication_error" })
  })

  /**
   * chatgpt.com answers a Worker's request with Cloudflare's challenge page.
   * Before, that 403 was read as the vendor refusing the login, and every
   * Usage view load re-marked a working ChatGPT plan `auth_failed`.
   */
  test("an answer that is not the vendor API's writes no verdict and says what came back", async () => {
    const credentials = store([codex], secrets)
    const fetchImpl = vendors({
      [CHATGPT_USAGE]: () => new Response("<!DOCTYPE html><html><title>Just a moment...</title></html>", { status: 403, headers: { "content-type": "text/html; charset=UTF-8" } }),
    })
    const read = createHostedQuotaReader({ credentials, now: () => 1_000, fetch: fetchImpl })

    const { snapshot } = await read({ org: ORG, person: "alice", refresh: false })

    expect(snapshot?.accounts.map((account) => [account.harness, account.health, account.usageError])).toEqual([
      ["codex", undefined, "This account's limits could not be read: Credential provider answered 403 with text/html; charset=UTF-8 rather than an API error"],
    ])
    expect(credentials.updateCredentialHealth).not.toHaveBeenCalled()
  })

  test("a throttled plan read leaves the login ok and says when its limits can be read again", async () => {
    const credentials = store([claude], secrets)
    const fetchImpl = vendors({
      [ANTHROPIC_MODELS]: anthropicModels,
      [ANTHROPIC_USAGE]: () => Response.json({ type: "error", error: { type: "rate_limit_error" } }, { status: 429, headers: { "retry-after": "3124" } }),
    })
    const read = createHostedQuotaReader({ credentials, now: () => 1_000, fetch: fetchImpl })

    const { snapshot } = await read({ org: ORG, person: "alice", refresh: false })

    expect(snapshot?.accounts[0]).toMatchObject({
      harness: "claude",
      health: "ok",
      windows: [],
      usageError: "The provider is throttling this account's plan read; this account runs turns, and its limits can be read again in 53 min.",
    })
    expect(credentials.updateCredentialHealth).toHaveBeenCalledWith("claude", "ok", 1_000, ORG, undefined)
  })

  test("a setup-token the vendor accepts without windows is explained and not asked again until its figures are stale", async () => {
    const credentials = store([claude], secrets)
    const fetchImpl = vendors({
      [ANTHROPIC_MODELS]: anthropicModels,
      [ANTHROPIC_USAGE]: () => Response.json({ type: "error", error: { type: "permission_error", details: { error_code: "oauth_scope_insufficient" } } }, { status: 403 }),
    })
    let clock = 1_000
    const read = createHostedQuotaReader({ credentials, now: () => clock, fetch: fetchImpl, staleAfterMs: 300_000 })

    const first = await read({ org: ORG, person: "alice", refresh: false })
    clock = 100_000
    await read({ org: ORG, person: "alice", refresh: false })

    expect(first.snapshot?.accounts[0]).toMatchObject({ harness: "claude", health: "ok", usageAt: 1_000, windows: [] })
    expect(first.snapshot?.accounts[0]?.usageError).toMatch(/inference-only/)
    expect(fetchImpl.mock.calls.filter(([url]) => url === ANTHROPIC_USAGE)).toHaveLength(1)
  })

  test("another member's login is neither listed nor asked", async () => {
    const bob = credential({ id: "bob", provider_id: "codex-app-server", account_id: "acct_bob", owner: "bob" })
    const credentials = store([codex, bob], { ...secrets, bob: secrets.codex })
    const fetchImpl = vendors({ [CHATGPT_USAGE]: chatgptUsage })
    const read = createHostedQuotaReader({ credentials, now: () => 1_000, fetch: fetchImpl })

    const { snapshot } = await read({ org: ORG, person: "alice", refresh: false })

    expect(snapshot?.accounts.map((account) => account.credentialId)).toEqual(["codex"])
    expect(credentials.resolveCredentialSecretById.mock.calls.map(([id]) => id)).toEqual(["codex"])
  })
})
