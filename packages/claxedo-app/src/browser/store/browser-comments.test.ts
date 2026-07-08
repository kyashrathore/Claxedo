/**
 * Unit tests for the claxedo-owned browser comments store.
 *
 * Strategy (mirrors process-pane.test.ts): mock `createSimpleContext` to
 * capture the init() callback, exercise it inside `createRoot`. The
 * Persist.global hook is replaced with a thin localStorage-backed stub so
 * persistence round-trip can be tested without the full makePersisted
 * machinery.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { BrowserCommentsState } from "./browser-comments"

type TestStore = Record<string, unknown>
type TestSetter = (...args: unknown[]) => unknown

let capturedInit: (() => BrowserCommentsState) | undefined
let storageKey: string | undefined

mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: (config: {
    name: string
    init: () => BrowserCommentsState
    gate?: boolean
  }) => {
    if (config.name === "BrowserComments") capturedInit = config.init
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
  persisted: (target: { key: string }, storeResult: [TestStore, TestSetter]) => {
    const [store, setStore] = storeResult
    // Rehydrate synchronously from localStorage if present.
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
    // Wrap setter so we persist on every write.
    const wrappedSet = new Proxy(setStore, {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target, thisArg, args)
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
  // Force re-evaluation so each test gets a fresh captured init.
  capturedInit = undefined
  await import(`./browser-comments?v=${Date.now()}-${Math.random()}`)
  if (!capturedInit) throw new Error("captured init missing")
  return capturedInit
}

describe("useBrowserComments store", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear()
  })

  test("add() assigns an id and stores the entry under its tabId", async () => {
    const init = await createApi()
    createRoot((dispose) => {
      const api = init()
      const saved = api.add({
        tabId: "tab-A",
        pageUrl: "https://example.com",
        selector: "button.primary",
        comment: "bolder",
        noteText: "note-add",
      })
      expect(saved.id).toMatch(/\S+/)
      expect(api.list("tab-A")).toHaveLength(1)
      expect(api.list("tab-other")).toHaveLength(0)
      dispose()
    })
  })

  test("enqueue() attaches a payload to a sessionId via pending()", async () => {
    const init = await createApi()
    createRoot((dispose) => {
      const api = init()
      api.enqueue("session-A", {
        tabId: "tab-1",
        pageUrl: "u",
        selector: "#a",
        comment: "hi",
        noteText: "note-A",
      })
      api.enqueue("session-B", {
        tabId: "tab-1",
        pageUrl: "u",
        selector: "#b",
        comment: "yo",
        noteText: "note-B",
      })
      expect(api.pending("session-A")).toHaveLength(1)
      expect(api.pending("session-A")[0].noteText).toBe("note-A")
      expect(api.pending("session-B")).toHaveLength(1)
      expect(api.pending("session-other")).toHaveLength(0)
      dispose()
    })
  })

  test("clearPending() only drops entries for the target session", async () => {
    const init = await createApi()
    createRoot((dispose) => {
      const api = init()
      api.enqueue("session-A", {
        tabId: "tab-1", pageUrl: "u", selector: "s1", comment: "c", noteText: "n1",
      })
      api.enqueue("session-A", {
        tabId: "tab-1", pageUrl: "u", selector: "s2", comment: "c", noteText: "n2",
      })
      api.enqueue("session-B", {
        tabId: "tab-1", pageUrl: "u", selector: "s3", comment: "c", noteText: "n3",
      })
      expect(api.pending("session-A")).toHaveLength(2)
      api.clearPending("session-A")
      expect(api.pending("session-A")).toHaveLength(0)
      expect(api.pending("session-B")).toHaveLength(1)
      dispose()
    })
  })

  test("remove() deletes the specified entry", async () => {
    const init = await createApi()
    createRoot((dispose) => {
      const api = init()
      const a = api.add({
        tabId: "tab-Z", pageUrl: "u", selector: "s", comment: "c", noteText: "n",
      })
      api.remove(a.id)
      expect(api.list("tab-Z")).toHaveLength(0)
      dispose()
    })
  })

  test("update() patches an existing entry while preserving id", async () => {
    const init = await createApi()
    createRoot((dispose) => {
      const api = init()
      const a = api.add({
        tabId: "tab-U", pageUrl: "u", selector: "s", comment: "c", noteText: "n",
      })
      api.update(a.id, { comment: "updated", noteText: "note-updated" })
      const entries = api.list("tab-U")
      expect(entries[0].comment).toBe("updated")
      expect(entries[0].noteText).toBe("note-updated")
      expect(entries[0].id).toBe(a.id)
      dispose()
    })
  })

  test("persistence round-trip: entries rehydrate from storage on reload", async () => {
    // First pass: write an entry.
    {
      const init = await createApi()
      createRoot((dispose) => {
        const api = init()
        api.add({
          tabId: "tab-persist",
          sessionId: "session-persist",
          pageUrl: "https://example.com",
          selector: ".btn",
          comment: "persist me",
          noteText: "note-persist",
        })
        dispose()
      })
    }
    // Second pass: reload the module and expect the entry to still be there.
    {
      const init = await createApi()
      createRoot((dispose) => {
        const api = init()
        const entries = api.list("tab-persist")
        expect(entries).toHaveLength(1)
        expect(entries[0].noteText).toBe("note-persist")
        expect(entries[0].sessionId).toBe("session-persist")
        dispose()
      })
    }
  })
})
