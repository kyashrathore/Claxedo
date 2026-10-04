import { describe, expect, test, vi } from "vitest"
import { LocalUsageRoutes } from "./routes"
import { tokenTrackerPricing } from "./adapters/token-tracker-pricing"

const pricing = tokenTrackerPricing("bundled")

const snapshot = {
  accounts: [{ harness: "codex", credentialId: "cred_1", label: "a@b.c", inUse: true, windows: [], usageAt: 5 }],
}

function routes(quota: Parameters<typeof LocalUsageRoutes>[0]["quota"]) {
  return LocalUsageRoutes({
    local: { current: async () => [], ownedBy: async () => [] },
    identity: async () => undefined,
    quota,
    pricing,
  })
}

const QUOTA = "/?since=0&until=20&timezone=UTC&view=quota"

describe("local usage routes, quota view", () => {
  test("a throttled refresh reaches the wire with when the next one will run", async () => {
    const app = routes(async () => ({ status: "available", snapshot, throttledUntil: 61_000 }))
    const body = await (await app.request(`${QUOTA}&refresh_nonce=7`)).json()
    expect(body.quota).toEqual({ status: "available", snapshot, throttledUntil: 61_000 })
  })

  test("a held snapshot standing in for a failed read does not carry the spacing of the refresh that produced it", async () => {
    const quota = vi
      .fn()
      .mockResolvedValueOnce({ status: "available", snapshot, throttledUntil: 61_000 })
      .mockRejectedValueOnce(new Error("registry offline"))
    const app = routes(quota)
    expect((await (await app.request(`${QUOTA}&refresh_nonce=1`)).json()).quota).toMatchObject({ throttledUntil: 61_000 })
    expect((await (await app.request(`${QUOTA}&refresh_nonce=2`)).json()).quota).toEqual({
      status: "available",
      snapshot,
      error: "registry offline",
    })
  })
})

describe("local usage routes, views", () => {
  test("a view other than quota or claxedo is refused", async () => {
    const response = await routes(undefined).request("/?since=0&until=20&timezone=UTC&view=total")
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_usage_view" })
  })
})
