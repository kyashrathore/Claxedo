import { beforeEach, describe, expect, test, vi } from "vitest"

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
    sync: { attempted: 0, delivered: 0, conflicts: 0, pending: 0 },
  }
}

describe("usage API", () => {
  beforeEach(() => authFetch.mockReset())
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

  test("wakes durable usage sync through the authenticated local endpoint", async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({ attempted: 1, pending: 0 }), { status: 200 }))
    const { syncUsageOutbox } = await import("./usage-api")
    await expect(syncUsageOutbox()).resolves.toMatchObject({ attempted: 1, pending: 0 })
    expect(new URL(authFetch.mock.calls[0][0]).pathname).toBe("/api/claxedo/usage/sync")
    expect(authFetch.mock.calls[0][1]).toMatchObject({ method: "POST" })
  })

  test("wakes on installation and online events, then detaches on disposal", async () => {
    authFetch.mockImplementation(async () => Response.json({ attempted: 1, pending: 0 }))
    const { installUsageOutboxWakeups } = await import("./usage-api")
    const dispose = installUsageOutboxWakeups()
    try {
      await vi.waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1))
      window.dispatchEvent(new Event("online"))
      await vi.waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2))
      dispose()
      window.dispatchEvent(new Event("online"))
      expect(authFetch).toHaveBeenCalledTimes(2)
    } finally {
      dispose()
    }
  })

})
