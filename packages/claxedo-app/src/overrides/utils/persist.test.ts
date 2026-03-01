import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"

// persisted() depends on usePlatform(); mock it to a web platform so it uses localStorage.
mock.module("@/context/platform", () => ({
  usePlatform: () => ({ platform: "web" }),
}))

describe("persisted storage", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test("corrupted JSON is treated as missing for structured stores (and removed)", async () => {
    localStorage.setItem("k", "{") // invalid JSON
    const { persisted } = await import(`./persist?test=${Date.now()}`)

    createRoot(() => {
      const store = createStore({ a: 1 })
      const out = persisted("k", store as any)
      expect(out[0].a).toBe(1)
      // Trigger ready accessor so the persisted init path is exercised.
      out[3]()
    })

    // makePersisted may read from storage on a scheduled task; allow it to run.
    await new Promise<void>((r) => setTimeout(r, 0))

    const raw = localStorage.getItem("k")
    // We either remove it or rewrite defaults, but it must not stay corrupted.
    if (raw === null) return
    expect(raw).not.toBe("{")
    const parsed = JSON.parse(raw) as any
    expect(parsed.a).toBe(1)
  })

  test("migrate runs before merge and persisted output keeps default keys", async () => {
    localStorage.setItem("k", JSON.stringify({ legacyCount: 7 }))
    const { persisted } = await import(`./persist?test=${Date.now()}`)

    createRoot(() => {
      const store = createStore({ count: 0, enabled: true })
      const out = persisted(
        {
          key: "k",
          migrate: (value: unknown) => ({
            count: (value as { legacyCount?: number }).legacyCount ?? 0,
          }),
        },
        store as any,
      )
      expect(out[0].count).toBe(7)
      expect(out[0].enabled).toBe(true)
      out[3]()
    })

    await new Promise<void>((r) => setTimeout(r, 0))

    const raw = localStorage.getItem("k")
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { count: number; enabled: boolean }
    expect(parsed).toEqual({ count: 7, enabled: true })
  })

  test("legacy key is migrated into current key and removed", async () => {
    localStorage.setItem("legacy.k", JSON.stringify({ a: 9 }))
    const { persisted } = await import(`./persist?test=${Date.now()}`)

    createRoot(() => {
      const store = createStore({ a: 1, b: 2 })
      const out = persisted({ key: "k", legacy: ["legacy.k"] }, store as any)
      expect(out[0].a).toBe(9)
      expect(out[0].b).toBe(2)
      out[3]()
    })

    await new Promise<void>((r) => setTimeout(r, 0))

    expect(localStorage.getItem("legacy.k")).toBeNull()
    const raw = localStorage.getItem("k")
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { a: number; b: number }
    expect(parsed).toEqual({ a: 9, b: 2 })
  })
})
