import { describe, expect, test } from "bun:test"
import { createWorkspaceRelayDirectory } from "./directory"

describe("workspace relay directory", () => {
  test("tracks host tunnel presence by host and workspace with TTL", () => {
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
})
