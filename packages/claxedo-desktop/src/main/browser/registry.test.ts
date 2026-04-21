import { describe, expect, test } from "bun:test"

import { BrowserRegistry, type WebContentsFromId } from "./registry"

/**
 * Minimal `WebContents` stand-in — only the bits the registry touches. Tests
 * must not require launching Electron.
 */
type FakeWc = {
  id: number
  destroyed: boolean
}

function makeFake(id: number): FakeWc {
  return { id, destroyed: false }
}

function makeResolver(map: Map<number, FakeWc>): WebContentsFromId {
  return ((id: number) => {
    const wc = map.get(id)
    if (!wc) return undefined
    // Cast through unknown to satisfy the Electron WebContents type in the
    // registry — the registry only reads .id and .isDestroyed().
    return {
      id: wc.id,
      isDestroyed: () => wc.destroyed,
    } as unknown as ReturnType<WebContentsFromId>
  }) as WebContentsFromId
}

describe("BrowserRegistry", () => {
  test("register creates a handle keyed by paneId", () => {
    const wc = makeFake(42)
    const registry = new BrowserRegistry(makeResolver(new Map([[42, wc]])))

    const handle = registry.register("pane-a", 42)

    expect(handle.webContentsId).toBe(42)
    expect(registry.get("pane-a")).toBe(handle)
    expect(registry.paneIds()).toEqual(["pane-a"])
  })

  test("re-register with same paneId+wc returns the existing handle", () => {
    const wc = makeFake(42)
    const registry = new BrowserRegistry(makeResolver(new Map([[42, wc]])))

    const first = registry.register("pane-a", 42)
    const second = registry.register("pane-a", 42)

    expect(second).toBe(first)
  })

  test("register throws when paneId is empty", () => {
    const registry = new BrowserRegistry(makeResolver(new Map()))
    expect(() => registry.register("", 1)).toThrow(/paneId is required/)
  })

  test("register throws when webContents id does not resolve", () => {
    const registry = new BrowserRegistry(makeResolver(new Map()))
    expect(() => registry.register("pane-a", 99)).toThrow(/not found/)
  })

  test("register throws when resolved webContents is destroyed", () => {
    const wc: FakeWc = { id: 7, destroyed: true }
    const registry = new BrowserRegistry(makeResolver(new Map([[7, wc]])))
    expect(() => registry.register("pane-a", 7)).toThrow(/destroyed/)
  })

  test("registering same paneId to a different webContents is rejected", () => {
    const a = makeFake(1)
    const b = makeFake(2)
    const registry = new BrowserRegistry(
      makeResolver(
        new Map([
          [1, a],
          [2, b],
        ]),
      ),
    )

    registry.register("pane-a", 1)
    expect(() => registry.register("pane-a", 2)).toThrow(/already bound/)
  })

  test("unregister removes the entry and is idempotent", () => {
    const wc = makeFake(42)
    const registry = new BrowserRegistry(makeResolver(new Map([[42, wc]])))

    registry.register("pane-a", 42)
    expect(registry.get("pane-a")).toBeDefined()

    registry.unregister("pane-a")
    expect(registry.get("pane-a")).toBeUndefined()
    // Idempotent.
    registry.unregister("pane-a")
    registry.unregister("never-registered")
  })

  test("get returns undefined for unknown paneId", () => {
    const registry = new BrowserRegistry(makeResolver(new Map()))
    expect(registry.get("missing")).toBeUndefined()
  })

  test("clear drops every handle", () => {
    const a = makeFake(1)
    const b = makeFake(2)
    const registry = new BrowserRegistry(
      makeResolver(
        new Map([
          [1, a],
          [2, b],
        ]),
      ),
    )
    registry.register("pane-a", 1)
    registry.register("pane-b", 2)
    expect(registry.paneIds().length).toBe(2)

    registry.clear()
    expect(registry.paneIds()).toEqual([])
  })

  test("independent paneIds map to independent handles", () => {
    const a = makeFake(1)
    const b = makeFake(2)
    const registry = new BrowserRegistry(
      makeResolver(
        new Map([
          [1, a],
          [2, b],
        ]),
      ),
    )

    const handleA = registry.register("pane-a", 1)
    const handleB = registry.register("pane-b", 2)
    expect(handleA).not.toBe(handleB)
    expect(handleA.webContentsId).toBe(1)
    expect(handleB.webContentsId).toBe(2)
  })
})
