import { describe, expect, test } from "bun:test"
import { createEffect, createRoot, createSignal, flush } from "solid-js"
import { collectRouteResolutionDirectories, directSessionResolutionDependencies } from "./route-bridge-reactivity"

/**
 * Owns the resolver observer for one test. The root only CONSTRUCTS it: Solid 2
 * rejects a signal write from inside an owned scope, and the router drives these
 * signals from outside the graph anyway. `createComputed` is gone in Solid 2, so
 * the observer is a two-phase `createEffect` whose tracked compute counts the
 * resolver runs; that compute runs synchronously at creation exactly as the
 * computed did, which is why `resolverRuns` is already 1 before the first write.
 */
function mountResolverObserver() {
  return createRoot((dispose) => {
    const [directSessionId, setDirectSessionId] = createSignal<string>()
    const [activeSessionId, setActiveSessionId] = createSignal("ses_a")
    const counts = { resolverRuns: 0, activeDependencyReads: 0 }

    createEffect(
      () => {
        directSessionResolutionDependencies(directSessionId(), () => {
          counts.activeDependencyReads += 1
          return [activeSessionId()] as const
        })
        counts.resolverRuns += 1
      },
      () => {},
    )

    return { dispose, setDirectSessionId, setActiveSessionId, counts }
  })
}

describe("route bridge reactive dependencies", () => {
  test("ordinary session switches do not wake the direct-session resolver", () => {
    const { dispose, setDirectSessionId, setActiveSessionId, counts } = mountResolverObserver()
    try {
      expect(counts.resolverRuns).toBe(1)
      expect(counts.activeDependencyReads).toBe(0)

      // Solid 2 stages every write until `flush()`, and each write is flushed on
      // its own so a coalesced flush can never hide a wake this asserts against.
      setActiveSessionId("ses_b")
      flush()
      expect(counts.resolverRuns).toBe(1)
      expect(counts.activeDependencyReads).toBe(0)

      setDirectSessionId("ses_direct")
      flush()
      expect(counts.resolverRuns).toBe(2)
      expect(counts.activeDependencyReads).toBe(1)

      setActiveSessionId("ses_c")
      flush()
      expect(counts.resolverRuns).toBe(3)
      expect(counts.activeDependencyReads).toBe(2)

      // Leaving the direct-session route drops the active-surface dependency
      // again, so the next ordinary session switch must not wake the resolver.
      setDirectSessionId(undefined)
      flush()
      expect(counts.resolverRuns).toBe(4)
      expect(counts.activeDependencyReads).toBe(2)

      setActiveSessionId("ses_d")
      flush()
      expect(counts.resolverRuns).toBe(4)
      expect(counts.activeDependencyReads).toBe(2)
    } finally {
      dispose()
    }
  })

  test("route directory candidates preserve priority while removing duplicates and sentinels", () => {
    expect(
      collectRouteResolutionDirectories(
        ["/project", "/shared", "/workspace", undefined],
        ["/shared", "/surface", "", "/project"],
      ),
    ).toEqual(["/project", "/shared", "/surface"])
  })
})
