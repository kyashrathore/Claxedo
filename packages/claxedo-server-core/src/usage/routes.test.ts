import { describe, expect, test, vi } from "vitest"
import { LocalUsageRoutes } from "./routes"

const outbox = {
  flush: async () => ({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
  clearIdentity: async () => ({ attempted: 0, delivered: 0, conflicts: 0, pending: 0 }),
}

const snapshot = {
  accounts: [{ harness: "codex", credentialId: "cred_1", label: "a@b.c", inUse: true, windows: [], usageAt: 5 }],
}

function routes(quota: Parameters<typeof LocalUsageRoutes>[0]["quota"]) {
  return LocalUsageRoutes({
    local: { current: async () => [], pendingOutbox: async () => [] } as never,
    identity: async () => undefined,
    outbox,
    quota,
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

describe("local usage routes, total view", () => {
  const empty = { rows: [], totalRows: [], coverage: [], classifiedClaxedo: 0, unclassified: 0, scannedAt: 1_234 }
  function withHistory(history: NonNullable<Parameters<typeof LocalUsageRoutes>[0]["history"]>) {
    return LocalUsageRoutes({
      local: { current: async () => [], pendingOutbox: async () => [] } as never,
      identity: async () => undefined,
      outbox,
      history,
    })
  }
  const RANGE = "since=0&until=20&timezone=UTC"

  test("a plain read asks for the stored history, and only the refresh nonce asks for a walk", async () => {
    const history = vi.fn(async () => empty)
    const app = withHistory(history)
    expect((await app.request(`/?${RANGE}&view=total`)).status).toBe(200)
    expect(history).toHaveBeenLastCalledWith({ since: 0, until: 20, refresh: false })
    expect((await app.request(`/?${RANGE}&view=total&refresh_nonce=3`)).status).toBe(200)
    expect(history).toHaveBeenLastCalledWith({ since: 0, until: 20, refresh: true })
    expect((await app.request(`/?${RANGE}&view=total&refresh_nonce=3`)).status).toBe(200)
    expect(history).toHaveBeenLastCalledWith({ since: 0, until: 20, refresh: false })
    expect(history).toHaveBeenCalledTimes(3)
  })

  test("the views that do not draw local history never touch it", async () => {
    const history = vi.fn(async () => empty)
    const app = withHistory(history)
    for (const view of ["quota", "claxedo"]) {
      expect((await app.request(`/?${RANGE}&view=${view}`)).status).toBe(200)
      expect((await app.request(`/?${RANGE}&view=${view}&refresh_nonce=${view.length}`)).status).toBe(200)
    }
    expect(history).not.toHaveBeenCalled()
  })

  test("the response says when the rows it draws were scanned", async () => {
    const app = withHistory(async () => empty)
    const body = await (await app.request(`/?${RANGE}&view=total`)).json()
    expect(body.externalLocal).toMatchObject({ status: "available", scannedAt: 1_234 })
  })
})
