import { describe, expect, test } from "bun:test"
import { transitionConnectionPlacement, type ConnectionPlacementEvent, type ConnectionPlacementState } from "./connection-placement"

describe("ConnectionPlacement", () => {
  const pending = { state: "role-pending", workspaceId: "ws_1" } satisfies ConnectionPlacementState
  const known = { state: "role-known", workspaceId: "ws_1", role: "owner" } satisfies ConnectionPlacementState
  const reconnecting = { state: "reconnecting", workspaceId: "ws_1", role: "owner" } satisfies ConnectionPlacementState
  const disconnected = { state: "disconnected", workspaceId: "ws_1", role: "owner" } satisfies ConnectionPlacementState
  const events = [
    { type: "role", role: "editor" },
    { type: "lost" },
    { type: "retry" },
    { type: "connected" },
  ] satisfies ConnectionPlacementEvent[]

  test("covers role pending, role known, reconnecting, and disconnected states", () => {
    for (const state of [pending, known, reconnecting, disconnected]) {
      for (const event of events) {
        transitionConnectionPlacement(state, event)
      }
    }
    expect(transitionConnectionPlacement(pending, { type: "role", role: "editor" })).toEqual({
      state: "role-known",
      workspaceId: "ws_1",
      role: "editor",
    })
    expect(transitionConnectionPlacement(known, { type: "role", role: "viewer" })).toEqual({
      state: "role-known",
      workspaceId: "ws_1",
      role: "viewer",
    })
    expect(transitionConnectionPlacement(known, { type: "lost" })).toEqual(reconnecting)
    expect(transitionConnectionPlacement(reconnecting, { type: "lost" })).toEqual(disconnected)
    expect(transitionConnectionPlacement(disconnected, { type: "retry" })).toEqual(reconnecting)
  })
})
