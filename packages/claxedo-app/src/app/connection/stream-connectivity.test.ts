import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStreamConnectivity } from "./stream-connectivity"

describe("createStreamConnectivity", () => {
  test("aggregate connected() is an OR across every stream target", () => {
    createRoot((dispose) => {
      const connectivity = createStreamConnectivity()
      const central = connectivity.track("cp")
      const workspace = connectivity.track("wr")

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
   * `document.changed` rides `cp` only. When `cp` flaps while a workspace
   * stream stays up, the aggregate count goes 2 → 1 → 2 and never reaches 0,
   * so a consumer watching the aggregate never sees a `false → true` edge and
   * never recovers the doorbells dropped during the gap.
   */
  test("central drop/recover is visible even while a workspace stream stays up", () => {
    createRoot((dispose) => {
      const connectivity = createStreamConnectivity()
      const central = connectivity.track("cp")
      const workspace = connectivity.track("wr")

      central(true)
      workspace(true)
      expect(connectivity.centralConnected()).toBe(true)

      central(false)
      expect(connectivity.connected()).toBe(true) // aggregate hides it…
      expect(connectivity.centralConnected()).toBe(false) // …the central bit does not

      central(true)
      expect(connectivity.centralConnected()).toBe(true)
      // The level's own edge is the revalidation; the counter does not repeat it.
      expect(connectivity.controlPlaneReconnects()).toBe(0)
      dispose()
    })
  })

  test("two control planes: the level holds while either is up, and a return the level never showed counts", () => {
    createRoot((dispose) => {
      const connectivity = createStreamConnectivity()
      const daemon = connectivity.track("cp")
      const account = connectivity.track("cp")
      daemon(true)
      expect(connectivity.centralConnected()).toBe(true)
      account(true)
      expect(connectivity.controlPlaneReconnects()).toBe(0)
      // The hosted stream drops while the daemon's holds: the level stays up
      // (the daemon's doorbells still arrive) and its return is the edge.
      account(false)
      expect(connectivity.centralConnected()).toBe(true)
      account(true)
      expect(connectivity.controlPlaneReconnects()).toBe(1)
      daemon(false)
      daemon(true)
      expect(connectivity.controlPlaneReconnects()).toBe(2)
      // Both down: the daemon's return is the level's edge, not a count; the
      // account's later return, under a level the daemon already holds, is.
      daemon(false)
      account(false)
      expect(connectivity.centralConnected()).toBe(false)
      daemon(true)
      expect(connectivity.centralConnected()).toBe(true)
      expect(connectivity.controlPlaneReconnects()).toBe(2)
      account(true)
      expect(connectivity.controlPlaneReconnects()).toBe(3)
      // Signed out: the account stream is torn down for good; a later report
      // from it counts for nothing.
      account.release()
      account(true)
      expect(connectivity.centralConnected()).toBe(true)
      expect(connectivity.controlPlaneReconnects()).toBe(3)
      dispose()
    })
  })

  test("a workspace stream never moves the central bit", () => {
    createRoot((dispose) => {
      const connectivity = createStreamConnectivity()
      const workspace = connectivity.track("wr")
      workspace(true)
      expect(connectivity.connected()).toBe(true)
      expect(connectivity.centralConnected()).toBe(false)
      dispose()
    })
  })

  test("repeated same-value reports do not double-count", () => {
    createRoot((dispose) => {
      const connectivity = createStreamConnectivity()
      const central = connectivity.track("cp")
      const other = connectivity.track("cp")

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
