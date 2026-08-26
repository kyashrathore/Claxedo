import { describe, expect, test } from "bun:test"
import { createComputed, createRoot, createSignal } from "solid-js"
import {
  collectRouteResolutionDirectories,
  directSessionResolutionDependencies,
} from "./route-bridge-reactivity"

describe("route bridge reactive dependencies", () => {
  test("ordinary session switches do not wake the direct-session resolver", () => {
    createRoot((dispose) => {
      const [directSessionId, setDirectSessionId] = createSignal<string>()
      const [activeSessionId, setActiveSessionId] = createSignal("ses_a")
      let resolverRuns = 0
      let activeDependencyReads = 0

      createComputed(() => {
        directSessionResolutionDependencies(directSessionId(), () => {
          activeDependencyReads += 1
          return [activeSessionId()] as const
        })
        resolverRuns += 1
      })

      setActiveSessionId("ses_b")
      expect(resolverRuns).toBe(1)
      expect(activeDependencyReads).toBe(0)

      setDirectSessionId("ses_direct")
      expect(resolverRuns).toBe(2)
      expect(activeDependencyReads).toBe(1)

      setActiveSessionId("ses_c")
      expect(resolverRuns).toBe(3)
      expect(activeDependencyReads).toBe(2)

      setDirectSessionId(undefined)
      setActiveSessionId("ses_d")
      expect(resolverRuns).toBe(4)
      expect(activeDependencyReads).toBe(2)
      dispose()
    })
  })

  test("route directory candidates preserve priority while removing duplicates and sentinels", () => {
    expect(collectRouteResolutionDirectories(
      ["/project", "/shared", "/workspace", undefined],
      ["/shared", "/surface", "", "/project"],
    )).toEqual(["/project", "/shared", "/surface"])
  })
})
