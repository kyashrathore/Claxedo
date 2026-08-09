import { beforeEach, describe, expect, test, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/platform/api/api", () => ({
  authFetch,
  getClaxedoServerUrl: () => "http://127.0.0.1:3000",
  normalizeUrl: (value: string) => value,
}))

describe("usage API", () => {
  beforeEach(() => authFetch.mockReset())
  test("encodes range, view, group, filters, pagination, and refresh", async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({ version: 1 }), { status: 200 }))
    const { fetchUnifiedUsage } = await import("./usage-api")
    await fetchUnifiedUsage({
      since: 1,
      until: 2,
      timeZone: "Asia/Kolkata",
      view: "total",
      group: "model",
      filters: { app: "claude", location: "local" },
      after: "anthropic/claude",
      modelAfter: "openai/gpt-5",
      limit: 25,
      refreshNonce: 42,
    })
    const url = new URL(authFetch.mock.calls[0]![0])
    expect(url.pathname).toBe("/api/claxedo/usage")
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      since: "1",
      until: "2",
      timezone: "Asia/Kolkata",
      view: "total",
      group: "model",
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
    expect(new URL(authFetch.mock.calls[0]![0]).pathname).toBe("/api/claxedo/usage/sync")
    expect(authFetch.mock.calls[0]![1]).toMatchObject({ method: "POST" })
  })
})
