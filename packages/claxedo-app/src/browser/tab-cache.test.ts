/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { PlacementId } from "@/server"
import { createTabCache } from "./tab-cache"

const id = (value: string) => value as PlacementId

function cache(initial: readonly string[]) {
  return createRoot((dispose) => {
    const [placements, setPlacements] = createSignal<readonly PlacementId[]>(initial.map(id))
    return { tabs: createTabCache(2, undefined, placements), setPlacements, dispose }
  })
}

const open = (tabs: ReturnType<typeof createTabCache>) => tabs.tabs().map((tab): string => tab.placementId)

test("a deleted placement's page is disposed, and one that was never listed is kept", () => {
  const { tabs, setPlacements, dispose } = cache(["a", "b"])
  tabs.tabFor(id("a"))
  tabs.tabFor(id("shared"))

  setPlacements([id("b")])

  expect(open(tabs)).toEqual(["shared"])
  dispose()
})

test("a page opened before the catalog loads survives the catalog arriving", () => {
  const { tabs, setPlacements, dispose } = cache([])
  const first = tabs.tabFor(id("a"))

  setPlacements([id("a"), id("b")])

  expect(tabs.tabFor(id("a"))).toBe(first)
  dispose()
})

test("opening past the cap evicts the least recently used page", () => {
  const { tabs, dispose } = cache(["a", "b", "c"])
  tabs.tabFor(id("a"))
  tabs.tabFor(id("b"))
  tabs.tabFor(id("a"))
  tabs.tabFor(id("c"))

  expect(open(tabs)).toEqual(["a", "c"])
  dispose()
})
