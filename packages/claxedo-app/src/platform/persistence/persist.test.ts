import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { configurePersistencePlatform, Persist, persisted, removePersisted } from "./persist"

const disposers: Array<() => void> = []
const ownedKeys = ["k", "legacy.k", "claxedo.global.dat:server"]
let previous: Array<[string, string | null]> = []
let previousUrl = window.location.href

describe("persisted storage", () => {
  beforeEach(async () => {
    previous = ownedKeys.map((key) => [key, localStorage.getItem(key)])
    previousUrl = window.location.href
    configurePersistencePlatform({ platform: "web" })
    window.location.href = "http://localhost/"
    for (const key of ownedKeys) await removePersisted({ key })
    window.location.href = "http://localhost/"
  })

  afterEach(async () => {
    disposers.splice(0).reverse().forEach((dispose) => dispose())
    window.location.href = "http://localhost/"
    for (const key of ownedKeys) await removePersisted({ key })
    for (const [key, value] of previous) if (value !== null) localStorage.setItem(key, value)
    window.location.href = previousUrl
  })

  test("corrupted JSON is treated as missing for structured stores (and removed)", async () => {
    localStorage.setItem("k", "{") // invalid JSON

    const initialized = createRoot((dispose) => {
      disposers.push(dispose)
      const store = createStore({ a: 1 })
      const out = persisted("k", store)
      expect(out[0].a).toBe(1)
      return out[2]
    })

    await initialized

    const raw = localStorage.getItem("k")
    // We either remove it or rewrite defaults, but it must not stay corrupted.
    if (raw === null) return
    expect(raw).not.toBe("{")
    const parsed = JSON.parse(raw) as { a: number }
    expect(parsed.a).toBe(1)
  })

  test("migrate runs before merge and persisted output keeps default keys", async () => {
    localStorage.setItem("k", JSON.stringify({ legacyCount: 7 }))

    const initialized = createRoot((dispose) => {
      disposers.push(dispose)
      const store = createStore({ count: 0, enabled: true })
      const out = persisted(
        {
          key: "k",
          migrate: (value: unknown) => ({
            count: (value as { legacyCount?: number }).legacyCount ?? 0,
          }),
        },
        store,
      )
      expect(out[0].count).toBe(7)
      expect(out[0].enabled).toBe(true)
      return out[2]
    })

    await initialized

    const raw = localStorage.getItem("k")
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { count: number; enabled: boolean }
    expect(parsed).toEqual({ count: 7, enabled: true })
  })

  test("legacy key is migrated into current key and removed", async () => {
    localStorage.setItem("legacy.k", JSON.stringify({ a: 9 }))

    const initialized = createRoot((dispose) => {
      disposers.push(dispose)
      const store = createStore({ a: 1, b: 2 })
      const out = persisted({ key: "k", legacy: ["legacy.k"] }, store)
      expect(out[0].a).toBe(9)
      expect(out[0].b).toBe(2)
      return out[2]
    })

    await initialized

    expect(localStorage.getItem("legacy.k")).toBeNull()
    const raw = localStorage.getItem("k")
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { a: number; b: number }
    expect(parsed).toEqual({ a: 9, b: 2 })
  })

  test("server-scoped persistence treats localhost and 127.0.0.1 as the same server", async () => {

    const a = Persist.serverWorkspace("http://localhost:3001", "/workspace", "terminal.v2")
    const b = Persist.serverWorkspace("http://127.0.0.1:3001", "/workspace", "terminal.v2")
    const c = Persist.serverGlobal("http://localhost:3001", "server")
    const d = Persist.serverGlobal("http://127.0.0.1:3001", "server")

    expect(a).toEqual(b)
    expect(c).toEqual(d)
  })
})
