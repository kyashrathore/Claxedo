/**
 * Unit tests for the claxedo-owned browser history store.
 *
 * Mirrors the browser-comments.test.ts approach: mock createSimpleContext to
 * capture the init() callback, and mock Persist.global / persisted with a
 * localStorage-backed stub so we can exercise the persistence round-trip.
 *
 * Pure helpers (`applyVisit`, `matchRecentPure`) are tested directly without
 * the SolidJS root for speed and clarity — the store wires them up, so once
 * the pure logic is right the only integration concern is the store's
 * reactivity + persistence, which is covered in its own block.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { BrowserHistoryState } from "./browser-history"
import { applyVisit, matchRecentPure, RECENT_CAP, PER_TAB_CAP } from "./browser-history"

let capturedInit: (() => BrowserHistoryState) | undefined
let storageKey: string | undefined

mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: (config: {
    name: string
    init: () => BrowserHistoryState
    gate?: boolean
  }) => {
    if (config.name === "BrowserHistory") capturedInit = config.init
    return {
      ctx: undefined,
      use: () => {
        throw new Error("not available in tests")
      },
      provider: () => null,
    }
  },
}))

mock.module("@/utils/persist", () => ({
  Persist: {
    global: (key: string) => {
      storageKey = key
      return { storage: "test", key }
    },
    workspace: () => ({}),
  },
  persisted: (target: { key: string }, storeResult: [any, any]) => {
    const [store, setStore] = storeResult
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(target.key) : null
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === "object") {
          setStore(parsed)
        }
      } catch {
        // ignore
      }
    }
    const wrappedSet = new Proxy(setStore, {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target as any, thisArg, args)
        try {
          const snapshot = JSON.parse(JSON.stringify(store))
          if (typeof localStorage !== "undefined") {
            localStorage.setItem(storageKey ?? target.key, JSON.stringify(snapshot))
          }
        } catch {
          // ignore
        }
        return result
      },
    })
    return [store, wrappedSet, null, () => true]
  },
}))

const createApi = async () => {
  capturedInit = undefined
  await import(`./browser-history?v=${Date.now()}-${Math.random()}`)
  if (!capturedInit) throw new Error("captured init missing")
  return capturedInit
}

describe("applyVisit (pure reducer)", () => {
  const empty = { recent: [] as any[], perTab: {} as Record<string, any[]> }

  test("records a fresh URL in both recent + perTab", () => {
    const next = applyVisit(empty, { browserId: "br-1", url: "https://example.com", title: "Example", at: 100 })
    expect(next.recent).toHaveLength(1)
    expect(next.recent[0]).toMatchObject({ url: "https://example.com", title: "Example", visitCount: 1 })
    expect(next.perTab["br-1"]).toHaveLength(1)
    expect(next.perTab["br-1"][0]).toMatchObject({ url: "https://example.com", visitedAt: 100 })
  })

  test("bumps visitCount and moves to head on revisit", () => {
    let s = applyVisit(empty, { browserId: "br-1", url: "https://a.test", title: "A", at: 1 })
    s = applyVisit(s, { browserId: "br-1", url: "https://b.test", title: "B", at: 2 })
    s = applyVisit(s, { browserId: "br-1", url: "https://a.test", title: "A-updated", at: 3 })
    expect(s.recent[0]).toMatchObject({ url: "https://a.test", title: "A-updated", visitCount: 2 })
    expect(s.recent[1]).toMatchObject({ url: "https://b.test" })
  })

  test("recent is capped at RECENT_CAP", () => {
    let s = empty
    for (let i = 0; i < RECENT_CAP + 20; i++) {
      s = applyVisit(s, { browserId: "br-1", url: `https://host-${i}.test`, title: `T${i}`, at: i })
    }
    expect(s.recent).toHaveLength(RECENT_CAP)
    // Most recent URL is the newest one and first in the list.
    expect(s.recent[0].url).toBe(`https://host-${RECENT_CAP + 19}.test`)
  })

  test("perTab is capped at PER_TAB_CAP", () => {
    let s = empty
    for (let i = 0; i < PER_TAB_CAP + 10; i++) {
      s = applyVisit(s, { browserId: "br-cap", url: `https://t-${i}.test`, at: i })
    }
    const list = s.perTab["br-cap"]
    expect(list).toHaveLength(PER_TAB_CAP)
    // Oldest trimmed; newest retained at tail.
    expect(list[0].url).toBe(`https://t-10.test`)
    expect(list[list.length - 1].url).toBe(`https://t-${PER_TAB_CAP + 9}.test`)
  })

  test("consecutive duplicate perTab visits only update the tail", () => {
    let s = applyVisit(empty, { browserId: "br-d", url: "https://x.test", title: "X", at: 10 })
    s = applyVisit(s, { browserId: "br-d", url: "https://x.test", title: "X2", at: 11 })
    expect(s.perTab["br-d"]).toHaveLength(1)
    expect(s.perTab["br-d"][0]).toMatchObject({ title: "X2", visitedAt: 11 })
  })

  test("perTab is isolated per browserId", () => {
    let s = applyVisit(empty, { browserId: "br-1", url: "https://a.test", at: 1 })
    s = applyVisit(s, { browserId: "br-2", url: "https://b.test", at: 2 })
    expect(s.perTab["br-1"]).toHaveLength(1)
    expect(s.perTab["br-2"]).toHaveLength(1)
    expect(s.perTab["br-1"][0].url).toBe("https://a.test")
    expect(s.perTab["br-2"][0].url).toBe("https://b.test")
  })

  test("ignores blank/whitespace URLs", () => {
    const s = applyVisit(empty, { browserId: "br-1", url: "", at: 1 })
    expect(s).toBe(empty)
  })
})

describe("matchRecentPure (autocomplete)", () => {
  const entries = [
    { url: "https://example.com", title: "Example", lastVisitedAt: 3, visitCount: 1 },
    { url: "https://example.com/docs", title: "Docs", lastVisitedAt: 5, visitCount: 1 },
    { url: "https://other.test", title: "Other", lastVisitedAt: 4, visitCount: 1 },
    { url: "https://localhost:3000", title: "Local", lastVisitedAt: 6, visitCount: 1 },
  ]

  test("empty query returns all entries up to limit", () => {
    expect(matchRecentPure(entries, "")).toHaveLength(entries.length)
    expect(matchRecentPure(entries, "", 2)).toHaveLength(2)
  })

  test("exact match wins", () => {
    const r = matchRecentPure(entries, "https://example.com")
    expect(r[0].url).toBe("https://example.com")
  })

  test("prefix match comes before substring match, newest first", () => {
    const r = matchRecentPure(entries, "https://example")
    expect(r[0].url).toBe("https://example.com/docs")
    expect(r[1].url).toBe("https://example.com")
  })

  test("substring match falls back to URL contains", () => {
    const r = matchRecentPure(entries, "other")
    expect(r[0].url).toBe("https://other.test")
  })

  test("title substring match when URL does not match", () => {
    const r = matchRecentPure(entries, "local")
    // "local" is a substring of the URL too so URL-sub beats title-sub.
    expect(r[0].url).toBe("https://localhost:3000")
  })

  test("case-insensitive", () => {
    const r = matchRecentPure(entries, "EXAMPLE")
    expect(r[0].url).toContain("example")
  })
})

describe("useBrowserHistory store", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear()
  })

  test("visit() records and matchRecent() returns in recency order", async () => {
    const init = await createApi()
    createRoot((dispose) => {
      const api = init()
      api.visit({ browserId: "br-1", url: "https://first.test", title: "First", at: 1 })
      api.visit({ browserId: "br-1", url: "https://second.test", title: "Second", at: 2 })
      api.visit({ browserId: "br-2", url: "https://third.test", title: "Third", at: 3 })
      const match = api.matchRecent("test")
      expect(match.map((e) => e.url)).toEqual([
        "https://third.test",
        "https://second.test",
        "https://first.test",
      ])
      dispose()
    })
  })

  test("tabHistory() returns the per-tab list in visit order", async () => {
    const init = await createApi()
    createRoot((dispose) => {
      const api = init()
      api.visit({ browserId: "br-h", url: "https://a.test", at: 1 })
      api.visit({ browserId: "br-h", url: "https://b.test", at: 2 })
      const list = api.tabHistory("br-h")
      expect(list).toHaveLength(2)
      expect(list[0].url).toBe("https://a.test")
      expect(list[1].url).toBe("https://b.test")
      expect(api.tabHistory("br-other")).toHaveLength(0)
      dispose()
    })
  })

  test("forgetTab() clears only one tab's history and leaves recents intact", async () => {
    const init = await createApi()
    createRoot((dispose) => {
      const api = init()
      api.visit({ browserId: "br-keep", url: "https://keep.test", at: 1 })
      api.visit({ browserId: "br-drop", url: "https://drop.test", at: 2 })
      api.forgetTab("br-drop")
      expect(api.tabHistory("br-drop")).toHaveLength(0)
      expect(api.tabHistory("br-keep")).toHaveLength(1)
      expect(api.recent()).toHaveLength(2)
      dispose()
    })
  })

  test("clear() empties both recent + perTab", async () => {
    const init = await createApi()
    createRoot((dispose) => {
      const api = init()
      api.visit({ browserId: "br-c", url: "https://x.test", at: 1 })
      api.clear()
      expect(api.recent()).toHaveLength(0)
      expect(api.tabHistory("br-c")).toHaveLength(0)
      dispose()
    })
  })

  test("persistence round-trip rehydrates recents + perTab across module reloads", async () => {
    {
      const init = await createApi()
      createRoot((dispose) => {
        const api = init()
        api.visit({ browserId: "br-persist", url: "https://persist.test", title: "Persist", at: 42 })
        dispose()
      })
    }
    {
      const init = await createApi()
      createRoot((dispose) => {
        const api = init()
        expect(api.recent()).toHaveLength(1)
        expect(api.recent()[0]).toMatchObject({ url: "https://persist.test", title: "Persist" })
        expect(api.tabHistory("br-persist")).toHaveLength(1)
        dispose()
      })
    }
  })
})
