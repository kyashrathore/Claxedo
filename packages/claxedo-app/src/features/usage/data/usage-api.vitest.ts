import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/platform/api/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/platform/api/api")>(),
  authFetch,
  getClaxedoServerUrl: () => "http://127.0.0.1:3000",
}))

// The route answers a whole `UnifiedUsageResponse`, and `fetchUnifiedUsage`
// parses it, so a `{ version: 1 }` stub would exercise the failure path instead
// of the request encoding this test is about. Zeroed but complete.
function usageTotals() {
  return {
    turnCount: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    unknownCategories: 0,
  }
}

function usageCost() {
  return {
    estimatedUsd: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    catalog: { adapter: "none", version: "0", source: "test" },
  }
}

function usageSeries() {
  return { totals: usageTotals(), daily: [] }
}

function unifiedUsageResponse() {
  return {
    version: 1,
    range: { since: 1, until: 2, timeZone: "Asia/Kolkata" },
    quota: { status: "available" },
    claxedo: {
      ...usageSeries(),
      cost: usageCost(),
      locationShare: { localTokens: 0, cloudTokens: 0 },
      status: "available",
      scope: "local",
    },
    externalLocal: {
      ...usageSeries(),
      cost: usageCost(),
      status: "available",
      coverage: [],
      unclassified: 0,
    },
    total: usageSeries(),
    totalCost: usageCost(),
    filterOptions: { claxedo: {}, total: {} },
  }
}

/** Electron preload's account bridge, as `signedAccountRun` reads it. */
function installAccountBridge(
  run: (operation: string, input?: Record<string, unknown>) => Promise<unknown>,
  status: "signed" | "unsigned" = "signed",
) {
  ;(globalThis as { api?: unknown }).api = {
    account: {
      run,
      state: async () => (status === "signed" ? { status, identity: { userId: "user_1" } } : { status }),
      onState: () => () => undefined,
      signIn: async () => ({ status: "signed" }),
      signOut: async () => ({ status: "unsigned" }),
    },
  }
}

function sentRequest(call: unknown[]) {
  const url = new URL(String(call[0]))
  const init = call[1] as RequestInit | undefined
  return {
    endpoint: `${url.origin}${url.pathname}`,
    query: Object.fromEntries(url.searchParams),
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  }
}

describe("usage API", () => {
  beforeEach(() => authFetch.mockReset())
  afterEach(() => {
    delete (globalThis as { api?: unknown }).api
  })

  test("a signed desktop reads the Usage view from its own server and brings the account's cloud turns along", async () => {
    const facts = [{ messageId: "msg_cloud" }]
    const run = vi.fn(async () => ({ facts }))
    installAccountBridge(run)
    authFetch.mockResolvedValue(Response.json(unifiedUsageResponse()))
    const { fetchUnifiedUsage } = await import("./usage-api")

    await fetchUnifiedUsage({ since: 1, until: 2, timeZone: "UTC", view: "total", group: "provider" })

    expect(run.mock.calls).toEqual([["usage.cloudFacts", { since: 1, until: 2 }]])
    expect(authFetch).toHaveBeenCalledTimes(1)
    expect(sentRequest(authFetch.mock.calls[0])).toEqual({
      endpoint: "http://127.0.0.1:3000/api/claxedo/usage",
      query: { since: "1", until: "2", timezone: "UTC", view: "total", group: "provider" },
      method: "POST",
      body: { cloud: { status: "available", facts } },
    })
  })

  test("a failed cloud read still reads this machine's usage and tells its server why the cloud part is missing", async () => {
    const run = vi.fn(async () => {
      throw new Error(`HOSTED_HTTP 503 ${JSON.stringify({ detail: 'operation "usage.cloudFacts" failed: 503', body: null })}`)
    })
    installAccountBridge(run)
    const degraded = unifiedUsageResponse()
    authFetch.mockImplementation(async () => Response.json({
      ...degraded,
      claxedo: { ...degraded.claxedo, status: "degraded", error: "Cloud usage is unavailable" },
    }))
    const { fetchUnifiedUsage } = await import("./usage-api")

    const answer = await fetchUnifiedUsage({ since: 1, until: 2, timeZone: "UTC", view: "claxedo" })

    expect(sentRequest(authFetch.mock.calls[0]).body).toEqual({
      cloud: { status: "unavailable", error: 'operation "usage.cloudFacts" failed: 503' },
    })
    expect(answer.claxedo).toMatchObject({ status: "degraded", error: "Cloud usage is unavailable" })

    run.mockResolvedValueOnce({ turns: [] } as never)
    await fetchUnifiedUsage({ since: 1, until: 2, timeZone: "UTC", view: "claxedo" })
    expect(sentRequest(authFetch.mock.calls[1]).body).toEqual({
      cloud: { status: "unavailable", error: expect.stringContaining('hosted operation "usage.cloudFacts" returned an unexpected shape') },
    })
  })

  test("an unsigned desktop, and the plans view, read with a plain GET and never ask the hosted plane", async () => {
    const run = vi.fn(async () => ({ facts: [] }))
    authFetch.mockImplementation(async () => Response.json(unifiedUsageResponse()))
    const { fetchUnifiedUsage } = await import("./usage-api")

    installAccountBridge(run, "unsigned")
    await fetchUnifiedUsage({ since: 1, until: 2, timeZone: "UTC", view: "claxedo" })
    installAccountBridge(run)
    await fetchUnifiedUsage({ since: 1, until: 2, timeZone: "UTC", view: "quota" })

    expect(run).not.toHaveBeenCalled()
    expect(authFetch.mock.calls.map((call) => sentRequest(call))).toEqual([
      expect.objectContaining({ endpoint: "http://127.0.0.1:3000/api/claxedo/usage", method: "GET", body: undefined }),
      expect.objectContaining({ endpoint: "http://127.0.0.1:3000/api/claxedo/usage", method: "GET", body: undefined }),
    ])
  })

  test("encodes range, view, group, metric, filters, pagination, and refresh", async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify(unifiedUsageResponse()), { status: 200 }))
    const { fetchUnifiedUsage } = await import("./usage-api")
    await fetchUnifiedUsage({
      since: 1,
      until: 2,
      timeZone: "Asia/Kolkata",
      view: "total",
      group: "model",
      metric: "cost",
      filters: { app: "claude", location: "local" },
      after: "anthropic/claude",
      modelAfter: "openai/gpt-5",
      limit: 25,
      refreshNonce: 42,
    })
    const url = new URL(authFetch.mock.calls[0][0])
    expect(url.pathname).toBe("/api/claxedo/usage")
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      since: "1",
      until: "2",
      timezone: "Asia/Kolkata",
      view: "total",
      group: "model",
      metric: "cost",
      filter_app: "claude",
      filter_location: "local",
      after: "anthropic/claude",
      model_after: "openai/gpt-5",
      limit: "25",
      refresh_nonce: "42",
    })
  })

  test.each([
    ["too many cloud turns", 413, { error: { code: "cloud_usage_too_large", message: "At most 10000 cloud revisions are accepted" } }, "At most 10000 cloud revisions are accepted"],
    ["a body too large to read", 413, "Payload Too Large", "the server refused them (413)"],
    ["a cloud part it cannot read", 400, { error: { code: "invalid_cloud_usage", message: "cloud must be an object" } }, "cloud must be an object"],
  ])("a server that refuses %s still draws this machine's usage and says the cloud part is missing", async (_name, status, body, reason) => {
    installAccountBridge(vi.fn(async () => ({ facts: [{ messageId: "msg_cloud" }] })))
    authFetch
      .mockResolvedValueOnce(typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status }))
      .mockResolvedValueOnce(Response.json(unifiedUsageResponse()))
    const { fetchUnifiedUsage } = await import("./usage-api")

    const answer = await fetchUnifiedUsage({ since: 1, until: 2, timeZone: "UTC", view: "claxedo" })

    expect(authFetch.mock.calls.map((call) => sentRequest(call).method)).toEqual(["POST", "GET"])
    expect(answer.claxedo).toMatchObject({ status: "degraded", scope: "local", error: `Cloud usage is unavailable: ${reason}` })
  })

  test("a refusal about the read itself fails the read rather than dropping the cloud part", async () => {
    installAccountBridge(vi.fn(async () => ({ facts: [] })))
    authFetch.mockResolvedValue(Response.json({ error: "invalid_usage_range" }, { status: 400 }))
    const { fetchUnifiedUsage } = await import("./usage-api")

    await expect(fetchUnifiedUsage({ since: 1, until: 2, timeZone: "UTC", view: "claxedo" })).rejects.toThrow("invalid_usage_range")
    expect(authFetch).toHaveBeenCalledTimes(1)
  })
})
