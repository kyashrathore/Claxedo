/// <reference types="bun" />
import { expect, test } from "bun:test"
import { sessionActivityFromWire } from "./session-activity"

test("session activity from the wire: each workspace's reads, and each failed workspace as a typed error", () => {
  const activity = sessionActivityFromWire({
    workspaces: [{ workspaceId: "ws_a", status: { ses_a: { type: "busy" } }, permissions: [{ id: "per_a" }], questions: [] }],
    failures: [
      { workspaceId: "ws_b", status: 500, error: JSON.stringify({ error: { code: "engine_down", message: "The engine stopped" } }) },
      { workspaceId: "ws_c", status: 503, error: JSON.stringify({ message: "workspace runtime startup timed out" }) },
    ],
  })
  expect(activity.read.get("ws_a")).toEqual({ status: { ses_a: { type: "busy" } }, permissions: [{ id: "per_a" }], questions: [] })
  const engine = activity.failed.get("ws_b")
  expect([engine?.class, engine?.code, engine?.message, engine?.retryable]).toEqual(["internal", "engine_down", "The engine stopped", false])
  const startup = activity.failed.get("ws_c")
  expect([startup?.class, startup?.message, startup?.retryable]).toEqual(["network", "workspace runtime startup timed out", true])
})

test("session activity from the wire: an unreadable answer is an internal error, never an empty read", () => {
  for (const body of [undefined, { workspaces: [] }, { workspaces: [{ workspaceId: "ws_a", status: {}, permissions: {}, questions: [] }], failures: [] }, { workspaces: [], failures: [{ workspaceId: "ws_b", status: 500 }] }]) {
    expect(() => sessionActivityFromWire(body)).toThrow("The session activity read answered in an unreadable shape")
  }
})
