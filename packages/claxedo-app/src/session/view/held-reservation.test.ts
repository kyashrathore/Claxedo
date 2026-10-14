/// <reference types="bun" />
import { expect, test } from "bun:test"
import { decodeHeldReservation, encodeHeldReservation } from "./held-reservation"

test("a draft's held reservation survives a reload with the harness and title it was reserved for", () => {
  const reservation = { workspaceId: "ws_cloud", sessionId: "ses_1", operationId: "op_1", title: "Cloud", harness: { id: "pi", access: "native" as const }, sessionHostRoot: "ses_1" }
  expect(decodeHeldReservation(encodeHeldReservation(reservation))).toEqual(reservation)
  const untitled = { workspaceId: "ws_cloud", sessionId: "ses_2", operationId: "op_2" }
  expect(decodeHeldReservation(encodeHeldReservation(untitled))).toEqual(untitled)
})

test("a persisted reservation naming a harness access the app does not know is held without that harness", () => {
  const encoded = { workspaceId: "ws_cloud", sessionId: "ses_1", operationId: "op_1", harness: { id: "pi", access: "remote" } }
  expect(decodeHeldReservation(encoded)).toEqual({ workspaceId: "ws_cloud", sessionId: "ses_1", operationId: "op_1" })
  expect(decodeHeldReservation({ workspaceId: "ws_cloud", sessionId: "ses_1" })).toBeUndefined()
})
