import { afterEach, describe, expect, test } from "bun:test"

import {
  configureSidecarProcessObserver,
  registerOwnedSidecar,
  type SidecarProcessObserver,
} from "./sidecar-owner"

afterEach(() => configureSidecarProcessObserver())

describe("desktop sidecar ownership", () => {
  test("registers before lifecycle completion and preserves independent operations", async () => {
    const events: unknown[] = []
    let stopped = 0
    let killed = 0
    let operations: Parameters<SidecarProcessObserver["register"]>[0] | undefined
    const observer: SidecarProcessObserver = {
      register(input) {
        operations = input
        events.push({ type: "registered", pid: input.pid })
        return {
          exit(event) {
            events.push({ type: "exited", ...event })
          },
        }
      },
    }
    configureSidecarProcessObserver(observer)
    const owner = registerOwnedSidecar({
      pid: 42,
      stopGracefully: async () => {
        stopped++
      },
      killOwnedTree: async () => {
        killed++
      },
    })
    await operations?.stopGracefully()
    await operations?.killOwnedTree()
    owner?.exit({ reason: "exited", exitCode: 0 })

    expect(events).toEqual([
      { type: "registered", pid: 42 },
      { type: "exited", reason: "exited", exitCode: 0 },
    ])
    expect(stopped).toBe(1)
    expect(killed).toBe(1)
  })

  test("is an optional no-op outside the desktop composition", () => {
    expect(
      registerOwnedSidecar({
        pid: 42,
        stopGracefully: async () => undefined,
        killOwnedTree: async () => undefined,
      }),
    ).toBeUndefined()
  })
})
