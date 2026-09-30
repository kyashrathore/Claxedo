/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { ServerEvent } from "../events"
import { placementId, projectId, requestId, sessionId } from "../ids"
import { frameFromWire, serverEventFromFrame } from "./frames"
import type { Address } from "./session-row"

const address: Address = {
  placementFor: (directory) => (directory === "/work" ? { placementId: placementId("p1"), projectId: projectId("j1") } : undefined),
}

const ref = { projectId: projectId("j1"), placementId: placementId("p1"), sessionId: sessionId("s1") }

test("frames: a harness.health frame becomes the session's harnessHealthChanged", () => {
  const frame = frameFromWire({
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
  const frame = frameFromWire({ directory: "/work", payload: { type: "harness.health", properties: { sessionID: "s1", harnessHealth: { status: "fine" } } } })
  expect(frame && serverEventFromFrame(frame, address)).toBeUndefined()
})

test("frames: an expired permission or question closes the request exactly as its reply does", () => {
  const settled = (type: string) => {
    const frame = frameFromWire({ directory: "/work", payload: { type, properties: { sessionID: "s1", requestID: "req-1" } } })
    return frame && serverEventFromFrame(frame, address)
  }
  const closed: ServerEvent = { type: "requestClosed", ref, requestId: requestId("req-1") }
  expect(settled("permission.replied")).toEqual(closed)
  expect(settled("permission.expired")).toEqual(closed)
  expect(settled("question.rejected")).toEqual(closed)
  expect(settled("question.expired")).toEqual(closed)
})

test("frames: a part retraction names the withdrawn parts and why", () => {
  const frame = frameFromWire({
    directory: "/work",
    payload: { type: "message.part.retracted", properties: { sessionID: "s1", reason: "refusal", parts: [{ messageID: "m1", partID: "p1" }, { messageID: "m1" }] } },
  })
  expect(frame && serverEventFromFrame(frame, address)).toEqual({ type: "partsRetracted", ref, reason: "refusal", parts: [{ messageId: "m1", partId: "p1" }] })
})
