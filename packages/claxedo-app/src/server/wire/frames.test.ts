/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId } from "../ids"
import { frameOf, serverEventFromFrame } from "./frames"
import type { Address } from "./session-row"

const address: Address = {
  placementFor: (directory) => (directory === "/work" ? { placementId: placementId("p1"), projectId: projectId("j1") } : undefined),
}

const ref = { projectId: projectId("j1"), placementId: placementId("p1"), sessionId: sessionId("s1") }

test("frames: a harness.health frame becomes the session's harnessHealthChanged", () => {
  const frame = frameOf({
    directory: "/work",
    payload: {
      type: "harness.health",
      properties: {
        sessionID: "s1",
        harnessHealth: { status: "degraded", reason: "harness_process_lost", message: "exited" },
        connectionState: { connectionId: "gw", state: "disconnected", processes: [] },
      },
    },
  })
  expect(frame && serverEventFromFrame(frame, address)).toEqual({
    type: "harnessHealthChanged",
    ref,
    health: { status: "degraded", reason: "harness_process_lost" },
    connectionState: { connectionId: "gw", state: "disconnected" },
  })
})

test("frames: a harness.health frame without a known health status is dropped", () => {
  const frame = frameOf({ directory: "/work", payload: { type: "harness.health", properties: { sessionID: "s1", harnessHealth: { status: "fine" } } } })
  expect(frame && serverEventFromFrame(frame, address)).toBeUndefined()
})
