import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStreamConnectivity } from "./stream-connectivity"

describe("createStreamConnectivity", () => {
  test("aggregate connected() is an OR across every stream target", () => {
    createRoot((dispose) => {
      const connectivity = createStreamConnectivity()
      const central = connectivity.track("central")
      const workspace = connectivity.track("workspace")

      expect(connectivity.connected()).toBe(false)
      central(true)
      expect(connectivity.connected()).toBe(true)
      workspace(true)
      central(false)
      // The workspace stream still holds the aggregate up — this is the exact
      // behavior that made the aggregate unusable as a revalidation edge.
      expect(connectivity.connected()).toBe(true)
      workspace(false)
      expect(connectivity.connected()).toBe(false)
      dispose()
    })
  })

  /**
   * THE BUG. `document.changed`
   * ride the CENTRAL stream only. When it flaps while a remote workspace relay
   * stream stays up, the aggregate count goes 2 → 1 → 2 and never reaches 0, so
   * consumers watching the aggregate never see a `false → true` edge and never
   * recover the nudges dropped during the gap.
   */
  test("central drop/recover is visible even while a workspace stream stays up", () => {
    createRoot((dispose) => {
      const connectivity = createStreamConnectivity()
      const central = connectivity.track("central")
      const workspace = connectivity.track("workspace")

      central(true)
      workspace(true)
      expect(connectivity.centralConnected()).toBe(true)

      central(false)
      expect(connectivity.connected()).toBe(true) // aggregate hides it…
      expect(connectivity.centralConnected()).toBe(false) // …the central bit does not

      central(true)
      expect(connectivity.centralConnected()).toBe(true)
      dispose()
    })
  })

  test("a workspace stream never moves the central bit", () => {
    createRoot((dispose) => {
      const connectivity = createStreamConnectivity()
      const workspace = connectivity.track("workspace")
      workspace(true)
      expect(connectivity.connected()).toBe(true)
      expect(connectivity.centralConnected()).toBe(false)
      dispose()
    })
  })

  test("repeated same-value reports do not double-count", () => {
    createRoot((dispose) => {
      const connectivity = createStreamConnectivity()
      const central = connectivity.track("central")
      const other = connectivity.track("central")

      central(true)
      central(true)
      central(true)
      other(true)
      // Three redundant `true`s must not inflate the count: one `false` from each
      // real stream still takes the bit down.
      central(false)
      expect(connectivity.centralConnected()).toBe(true)
      other(false)
      expect(connectivity.centralConnected()).toBe(false)
      expect(connectivity.connected()).toBe(false)
      dispose()
    })
  })
})
