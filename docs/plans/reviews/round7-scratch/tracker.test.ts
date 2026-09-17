import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStreamConnectivity } from "/Users/yashvardhansingh/test/opencode-streams/packages/claxedo-app/src/app/connection/stream-connectivity"

describe("tracker under three streams", () => {
  test("three cp streams: edges the level shows are not counted, others are; release retires", () => {
    createRoot((dispose) => {
      const c = createStreamConnectivity()
      const a = c.track("cp"), b = c.track("cp"), d = c.track("cp"), w = c.track("wr")
      a(true); b(true); d(true); w(true)
      expect(c.centralConnected()).toBe(true); expect(c.controlPlaneReconnects()).toBe(0)
      a(false); expect(c.centralConnected()).toBe(true)
      a(true); expect(c.controlPlaneReconnects()).toBe(1)
      a(false); b(false); d(false); expect(c.centralConnected()).toBe(false); expect(c.workspaceConnected()).toBe(true); expect(c.connected()).toBe(true)
      b(true); expect(c.centralConnected()).toBe(true); expect(c.controlPlaneReconnects()).toBe(1)
      a(true); expect(c.controlPlaneReconnects()).toBe(2)
      // release while up, another holds the level
      a.release(); expect(c.centralConnected()).toBe(true); expect(c.controlPlaneReconnects()).toBe(2)
      a(true); expect(c.controlPlaneReconnects()).toBe(2) // retired: counts nothing
      w(false); expect(c.workspaceConnected()).toBe(false); expect(c.connected()).toBe(true)
      w.release(); w(true); expect(c.workspaceConnected()).toBe(false)
      b.release(); expect(c.connected()).toBe(false)
      dispose()
    })
  })
})
