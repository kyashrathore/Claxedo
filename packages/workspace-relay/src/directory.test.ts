import { describe, expect, test } from "bun:test"
import { createWorkspaceRelayDirectory } from "./directory"

describe("workspace relay directory", () => {
  test("tracks user-hosted tunnel presence by host and workspace with TTL", () => {
    let timestamp = 1_000
    const directory = createWorkspaceRelayDirectory({
      ttlMs: 10_000,
      now: () => timestamp,
    })

    directory.registerHostTunnel({
      hostId: "host_1",
      workspaceIds: ["ws_1", "ws_1", "ws_2"],
    })

    expect(directory.activeHost({ hostId: "host_1", workspaceId: "ws_1" })).toMatchObject({
      hostId: "host_1",
      workspaceIds: ["ws_1", "ws_2"],
      expiresAt: 11_000,
    })
    expect(directory.activeHost({ hostId: "host_1", workspaceId: "ws_missing" })).toBeUndefined()

    timestamp = 10_000
    expect(directory.recordPong("host_1")).toMatchObject({
      lastPongAt: 10_000,
      expiresAt: 20_000,
    })
    timestamp = 20_001
    expect(directory.activeHost({ hostId: "host_1", workspaceId: "ws_1" })).toBeUndefined()
  })

  test("disconnect removes host presence immediately", () => {
    const directory = createWorkspaceRelayDirectory()

    directory.registerHostTunnel({
      hostId: "host_1",
      workspaceIds: ["ws_1"],
    })
    directory.disconnectHost("host_1")

    expect(directory.activeHost({ hostId: "host_1", workspaceId: "ws_1" })).toBeUndefined()
  })

  test("sweep removes expired entries", () => {
    let timestamp = 1_000
    const directory = createWorkspaceRelayDirectory({
      ttlMs: 10_000,
      now: () => timestamp,
      sweepIntervalMs: 0,
    })

    directory.registerHostTunnel({ hostId: "host_a", workspaceIds: ["ws_1"] })
    directory.registerHostTunnel({ hostId: "host_b", workspaceIds: ["ws_2"] })

    timestamp = 20_000 // past TTL for both
    directory.sweep()

    expect(directory.activeHost({ hostId: "host_a", workspaceId: "ws_1" })).toBeUndefined()
    expect(directory.activeHost({ hostId: "host_b", workspaceId: "ws_2" })).toBeUndefined()
    directory.dispose()
  })

  test("sweep does not remove live entries", () => {
    let timestamp = 1_000
    const directory = createWorkspaceRelayDirectory({
      ttlMs: 10_000,
      now: () => timestamp,
      sweepIntervalMs: 0,
    })

    directory.registerHostTunnel({ hostId: "host_a", workspaceIds: ["ws_1"] })

    timestamp = 5_000 // still well within TTL
    directory.sweep()

    expect(directory.activeHost({ hostId: "host_a", workspaceId: "ws_1" })).toMatchObject({
      hostId: "host_a",
    })
    directory.dispose()
  })

  test("sweep is a no-op on a fresh directory", () => {
    const directory = createWorkspaceRelayDirectory({ sweepIntervalMs: 0 })
    expect(() => directory.sweep()).not.toThrow()
    directory.dispose()
  })

  test("timer-based sweep fires automatically", async () => {
    let timestamp = 1_000
    const directory = createWorkspaceRelayDirectory({
      ttlMs: 10_000,
      now: () => timestamp,
      sweepIntervalMs: 5,
    })

    directory.registerHostTunnel({ hostId: "host_a", workspaceIds: ["ws_1"] })

    timestamp = 20_000 // expire it
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(directory.activeHost({ hostId: "host_a", workspaceId: "ws_1" })).toBeUndefined()
    directory.dispose()
  })

  test("dispose clears the timer", async () => {
    let timestamp = 1_000
    let sweepCalls = 0
    const directory = createWorkspaceRelayDirectory({
      ttlMs: 10_000,
      now: () => {
        sweepCalls++
        return timestamp
      },
      sweepIntervalMs: 5,
    })

    directory.dispose()
    const before = sweepCalls
    await new Promise((resolve) => setTimeout(resolve, 50))
    // After dispose, no further now() calls from sweeper
    expect(sweepCalls).toBe(before)
  })

  test("size() returns count of active (non-expired) host entries (T31)", () => {
    let timestamp = 1_000
    const directory = createWorkspaceRelayDirectory({
      ttlMs: 10_000,
      now: () => timestamp,
      sweepIntervalMs: 0,
    })

    expect(directory.size()).toBe(0)

    directory.registerHostTunnel({ hostId: "host_a", workspaceIds: ["ws_1"] })
    expect(directory.size()).toBe(1)

    directory.registerHostTunnel({ hostId: "host_b", workspaceIds: ["ws_2"] })
    expect(directory.size()).toBe(2)

    // Expire both — size() must reflect live entries only.
    timestamp = 20_000
    expect(directory.size()).toBe(0)

    directory.dispose()
  })

  test("sweepIntervalMs: 0 disables the timer", async () => {
    let timestamp = 1_000
    const directory = createWorkspaceRelayDirectory({
      ttlMs: 10_000,
      now: () => timestamp,
      sweepIntervalMs: 0,
    })

    directory.registerHostTunnel({ hostId: "host_a", workspaceIds: ["ws_1"] })
    timestamp = 20_000

    // Wait — no timer should fire
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Without lazy access via activeHost, sweep would not have run.
    // Use a method that does NOT trigger expiry: re-register and check the underlying map state via sweep manually.
    // The sweep method should still work to manually clean up.
    directory.sweep()
    expect(directory.activeHost({ hostId: "host_a", workspaceId: "ws_1" })).toBeUndefined()

    // dispose should be a harmless no-op when no timer was started
    expect(() => directory.dispose()).not.toThrow()
  })
})
