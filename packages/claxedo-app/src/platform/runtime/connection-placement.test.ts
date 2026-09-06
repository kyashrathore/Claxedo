import { describe, expect, test } from "bun:test"
import { transitionConnectionPlacement, type ConnectionPlacementEvent, type ConnectionPlacementState } from "./connection-placement"

describe("ConnectionPlacement", () => {
  const pending = { state: "role-pending", workspaceId: "ws_1" } satisfies ConnectionPlacementState
  const known = { state: "role-known", workspaceId: "ws_1", role: "owner" } satisfies ConnectionPlacementState
  const reconnecting = { state: "reconnecting", workspaceId: "ws_1", role: "owner" } satisfies ConnectionPlacementState
  const disconnected = { state: "disconnected", workspaceId: "ws_1", role: "owner" } satisfies ConnectionPlacementState

  const cases: Array<[string, ConnectionPlacementState, ConnectionPlacementEvent, ConnectionPlacementState | undefined]> = [
    ["pending receives role", pending, { type: "role", role: "editor" }, { state: "role-known", workspaceId: "ws_1", role: "editor" }],
    ["pending loses connection", pending, { type: "lost" }, { state: "reconnecting", workspaceId: "ws_1" }],
    ["pending ignores retry", pending, { type: "retry" }, undefined],
    ["pending ignores connected without reconnect", pending, { type: "connected" }, undefined],
    ["known changes role", known, { type: "role", role: "viewer" }, { state: "role-known", workspaceId: "ws_1", role: "viewer" }],
    ["known loses connection", known, { type: "lost" }, reconnecting],
    ["known ignores retry", known, { type: "retry" }, undefined],
    ["known ignores duplicate connected", known, { type: "connected" }, undefined],
    ["reconnecting ignores role until connected", reconnecting, { type: "role", role: "editor" }, undefined],
    ["reconnecting loses connection", reconnecting, { type: "lost" }, disconnected],
    ["reconnecting ignores retry", reconnecting, { type: "retry" }, undefined],
    ["reconnecting retains known role", reconnecting, { type: "connected" }, known],
    ["disconnected ignores role", disconnected, { type: "role", role: "editor" }, undefined],
    ["disconnected ignores repeated loss", disconnected, { type: "lost" }, undefined],
    ["disconnected retries", disconnected, { type: "retry" }, reconnecting],
    ["disconnected ignores connected without retry", disconnected, { type: "connected" }, undefined],
  ]

  test.each(cases)("%s", (_name, state, event, expected) => {
    expect(transitionConnectionPlacement(state, event)).toEqual(expected)
  })

  test("reconnection accepts the newly authorized role over the cached role", () => {
    expect(transitionConnectionPlacement(reconnecting, { type: "connected", role: "viewer" })).toEqual({
      state: "role-known", workspaceId: "ws_1", role: "viewer",
    })
  })

  test("a connection with no known role stays pending until the server supplies one", () => {
    const roleless = { state: "reconnecting", workspaceId: "ws_2" } satisfies ConnectionPlacementState
    expect(transitionConnectionPlacement(roleless, { type: "connected" })).toEqual({
      state: "role-pending", workspaceId: "ws_2",
    })
    expect(transitionConnectionPlacement(roleless, { type: "connected", role: "viewer" })).toEqual({
      state: "role-known", workspaceId: "ws_2", role: "viewer",
    })
    const lost = transitionConnectionPlacement(roleless, { type: "lost" })
    expect(lost).toEqual({ state: "disconnected", workspaceId: "ws_2" })
    expect(transitionConnectionPlacement(lost!, { type: "retry" })).toEqual(roleless)
  })
})
