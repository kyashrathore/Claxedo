import { describe, expect, test } from "bun:test"
import { flush } from "solid-js"
import { createStreamConnectivity } from "./stream-connectivity"
import { mountReactive } from "@/lib/test-support/reactive-root"

// The trackers are called from stream callbacks, with no owner current;
// `mountReactive` gives the test the same shape.
const mountConnectivity = () => mountReactive(() => createStreamConnectivity())

describe("createStreamConnectivity", () => {
  test("aggregate connected() is an OR across every stream target", () => {
    const [connectivity, dispose] = mountConnectivity()

    try {
      const central = connectivity.track("central")
      const workspace = connectivity.track("workspace")

      flush()
      // Solid 2 stages signal writes until the scheduler flushes. The app only
      // reads these bits from memos and effects — i.e. after a flush — so the
      // test settles the scheduler at each observation point rather than the
      // trackers forcing a flush of their own.
      expect(connectivity.connected()).toBe(false)
      central(true)
      flush()
      expect(connectivity.connected()).toBe(true)
      workspace(true)
      central(false)
      // The workspace stream still holds the aggregate up — this is the exact
      // behavior that made the aggregate unusable as a revalidation edge.
      flush()
      expect(connectivity.connected()).toBe(true)
      workspace(false)
      flush()
      expect(connectivity.connected()).toBe(false)
    } finally {
      dispose()
    }
  })

  /**
   * THE BUG. `workgraph.changed` / `document.changed`
   * ride the CENTRAL stream only. When it flaps while a remote workspace relay
   * stream stays up, the aggregate count goes 2 → 1 → 2 and never reaches 0, so
   * consumers watching the aggregate never see a `false → true` edge and never
   * recover the nudges dropped during the gap.
   */
  test("central drop/recover is visible even while a workspace stream stays up", () => {
    const [connectivity, dispose] = mountConnectivity()

    try {
      const central = connectivity.track("central")
      const workspace = connectivity.track("workspace")

      central(true)
      workspace(true)
      flush()
      expect(connectivity.centralConnected()).toBe(true)

      central(false)
      flush()
      expect(connectivity.connected()).toBe(true) // aggregate hides it…
      flush()
      expect(connectivity.centralConnected()).toBe(false) // …the central bit does not

      central(true)
      flush()
      expect(connectivity.centralConnected()).toBe(true)
    } finally {
      dispose()
    }
  })

  test("a workspace stream never moves the central bit", () => {
    const [connectivity, dispose] = mountConnectivity()

    try {
      const workspace = connectivity.track("workspace")
      workspace(true)
      flush()
      expect(connectivity.connected()).toBe(true)
      flush()
      expect(connectivity.centralConnected()).toBe(false)
    } finally {
      dispose()
    }
  })

  test("repeated same-value reports do not double-count", () => {
    const [connectivity, dispose] = mountConnectivity()

    try {
      const central = connectivity.track("central")
      const other = connectivity.track("central")

      central(true)
      central(true)
      central(true)
      other(true)
      // Three redundant `true`s must not inflate the count: one `false` from each
      // real stream still takes the bit down.
      central(false)
      flush()
      expect(connectivity.centralConnected()).toBe(true)
      other(false)
      flush()
      expect(connectivity.centralConnected()).toBe(false)
      flush()
      expect(connectivity.connected()).toBe(false)
    } finally {
      dispose()
    }
  })
})
