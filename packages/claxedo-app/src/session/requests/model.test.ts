/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type AppError, type SessionLocation } from "@/server"
import { applyRequestsEvent, initialRequestsData, readErrorOf, type RequestsData, type RequestsEvent } from "./model"

const ref: SessionLocation = { projectId: projectId("prj"), placementId: placementId("plc"), sessionId: sessionId("ses") }
const refused: AppError = { class: "network", retryable: true, message: "connection refused" }

function apply(...events: RequestsEvent[]): RequestsData {
  return events.reduce(applyRequestsEvent, initialRequestsData)
}

test("a read sent before a failed read does not clear its error when it lands after it", () => {
  const data = apply({ type: "readFailed", ref, error: refused, sentAt: 20 }, { type: "read", ref, requests: [], sentAt: 10 })
  expect(readErrorOf(data, ref.sessionId)).toEqual(refused)
})

test("a read sent after a failed read clears its error", () => {
  const data = apply({ type: "readFailed", ref, error: refused, sentAt: 20 }, { type: "read", ref, requests: [], sentAt: 30 })
  expect(readErrorOf(data, ref.sessionId)).toBeUndefined()
})

test("a failed read sent before a read that already landed shows no error", () => {
  const data = apply({ type: "read", ref, requests: [], sentAt: 30 }, { type: "readFailed", ref, error: refused, sentAt: 20 })
  expect(readErrorOf(data, ref.sessionId)).toBeUndefined()
})

test("a failure is kept per session", () => {
  const other: SessionLocation = { ...ref, sessionId: sessionId("ses-other") }
  const data = apply({ type: "readFailed", ref, error: refused, sentAt: 20 }, { type: "read", ref: other, requests: [], sentAt: 30 })
  expect(readErrorOf(data, ref.sessionId)).toEqual(refused)
  expect(readErrorOf(data, other.sessionId)).toBeUndefined()
})
