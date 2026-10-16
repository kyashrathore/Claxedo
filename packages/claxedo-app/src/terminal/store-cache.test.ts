/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId } from "@/server"
import { createTerminalStoreCache } from "./store-cache"
import type { TerminalStore } from "./store"

test("a placement's terminal stream runs only while something on screen retains its list, not while its store sits in the cache", () => {
  const watching = new Map<string, number>()
  const watch = (id: string) => {
    watching.set(id, (watching.get(id) ?? 0) + 1)
    return () => watching.set(id, (watching.get(id) ?? 0) - 1)
  }
  const cache = createTerminalStoreCache(8, (id) => ({ placementId: id }) as unknown as TerminalStore, watch)
  const workspace = placementId("ws_left_open")

  cache.storeFor(workspace)
  expect(watching.get(workspace) ?? 0).toBe(0)
  const releasePane = cache.retain(workspace)
  const releaseRail = cache.retain(workspace)
  expect(watching.get(workspace)).toBe(2)
  releasePane()
  releaseRail()
  expect(watching.get(workspace)).toBe(0)
  cache.dispose()
})
