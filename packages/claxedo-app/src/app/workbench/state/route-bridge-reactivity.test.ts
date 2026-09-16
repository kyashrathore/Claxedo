import { describe, expect, test } from "bun:test"
import { createComputed, createRoot, createSignal } from "solid-js"
import {
  collectRouteResolutionDirectories,
  directSessionResolutionDependencies,
  focusMovedOffDirectSessionRoute,
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

  test("focusing a pane holding another session is not a route to resolve", () => {
    expect(focusMovedOffDirectSessionRoute(["ses_route", "ses_other"], ["ses_route", "ses_route"])).toBe(true)
    expect(focusMovedOffDirectSessionRoute(["ses_route", undefined], ["ses_route", "ses_route"])).toBe(true)
  })

  test("route, first-run, and same-session resolver runs still resolve", () => {
    expect(focusMovedOffDirectSessionRoute(["ses_next", "ses_route"], ["ses_route", "ses_route"])).toBe(false)
    expect(focusMovedOffDirectSessionRoute(["ses_route", "ses_other"], undefined)).toBe(false)
    expect(focusMovedOffDirectSessionRoute(["ses_route", "ses_route"], ["ses_route", "ses_other"])).toBe(false)
    expect(focusMovedOffDirectSessionRoute(["ses_route", "ses_other"], ["ses_route", "ses_other"])).toBe(false)
  })

  test("route directory candidates preserve priority while removing duplicates and sentinels", () => {
    expect(collectRouteResolutionDirectories(
      ["/project", "/shared", "/workspace", undefined],
      ["/shared", "/surface", "", "/project"],
    )).toEqual(["/project", "/shared", "/surface"])
  })
})
