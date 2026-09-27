/// <reference types="bun" />
import { expect, onTestFinished, test } from "bun:test"
import { hashKey } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import { keyedQueries } from "./keyed-queries"
import { createWorkspaceServer } from "./test-workspace-server"

async function mountListings(open: readonly string[]) {
  const workspace = createWorkspaceServer({ alpha: ["alpha-1"], bravo: ["bravo-1"], charlie: ["charlie-1"] })
  onTestFinished(workspace.dispose)
  const [dirs, setDirs] = createSignal<readonly string[]>(open)
  const resultOf = workspace.mount(() => keyedQueries(dirs, workspace.listing))
  const cache = workspace.server.queryClient.getQueryCache()
  const hashOf = (dir: string) => hashKey(workspace.listing(dir).queryKey)
  const created = (change: () => void) => {
    const before = new Set(cache.getAll())
    change()
    return cache.getAll().flatMap((query) => (before.has(query) ? [] : [query.queryHash]))
  }
  await workspace.loaded(open)
  return {
    setDirs,
    hashOf,
    created,
    loaded: workspace.loaded,
    names: (dir: string) => resultOf(dir)?.data?.map((node) => node.name),
    observers: (dir: string) => cache.get(hashOf(dir))?.getObserversCount() ?? 0,
  }
}

test("keyed queries: reordering the keys leaves each key its own result", async () => {
  const listings = await mountListings(["alpha", "bravo"])
  listings.setDirs(["bravo", "alpha"])
  expect([listings.names("alpha"), listings.names("bravo")]).toEqual([["alpha-1"], ["bravo-1"]])
  await listings.loaded([])
  expect([listings.names("alpha"), listings.names("bravo")]).toEqual([["alpha-1"], ["bravo-1"]])
})

test("keyed queries: a key that joins gets its own result without disturbing the others", async () => {
  const listings = await mountListings(["alpha", "bravo"])
  listings.setDirs(["charlie", "alpha", "bravo"])
  expect([listings.names("alpha"), listings.names("bravo")]).toEqual([["alpha-1"], ["bravo-1"]])
  await listings.loaded(["charlie"])
  expect([listings.names("charlie"), listings.names("alpha"), listings.names("bravo")]).toEqual([["charlie-1"], ["alpha-1"], ["bravo-1"]])
})

test("keyed queries: a key that leaves drops its observer, and a key that joins creates only its own query", async () => {
  const listings = await mountListings(["alpha", "bravo"])
  expect([listings.observers("alpha"), listings.observers("bravo")]).toEqual([1, 1])
  expect(listings.created(() => listings.setDirs(["bravo"]))).toEqual([])
  expect([listings.observers("alpha"), listings.observers("bravo")]).toEqual([0, 1])
  expect(listings.created(() => listings.setDirs(["bravo", "charlie"]))).toEqual([listings.hashOf("charlie")])
  expect([listings.observers("alpha"), listings.observers("bravo"), listings.observers("charlie")]).toEqual([0, 1, 1])
})
