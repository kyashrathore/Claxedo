import { beforeEach, describe, expect, test, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/platform/api/api", () => ({ authFetch, getClaxedoServerUrl: () => "http://127.0.0.1:3000", normalizeUrl: (value: string) => value }))

describe("usage API", () => {
  beforeEach(() => authFetch.mockReset())
  test("encodes range, timezone, group, and refresh", async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({ version: 1 }), { status: 200 }))
    const { fetchUnifiedUsage } = await import("./usage-api")
    await fetchUnifiedUsage({ since: 1, until: 2, timeZone: "Asia/Kolkata", group: "model", refresh: true })
    const url = new URL(authFetch.mock.calls[0]![0])
    expect(url.pathname).toBe("/api/claxedo/usage")
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ since: "1", until: "2", timezone: "Asia/Kolkata", group: "model", refresh: "1" })
  })
})
