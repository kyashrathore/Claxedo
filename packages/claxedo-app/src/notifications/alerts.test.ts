/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type ServerEvent, type SessionAttentionEvent } from "@/server"
import { createAlertDetector } from "./alerts"

const ref = { projectId: projectId("prj_1"), placementId: placementId("plc_1"), sessionId: sessionId("ses_1") }
type Raised = Extract<ServerEvent, { type: "attentionRaised" }>

function raised(sequence: number, event: Partial<SessionAttentionEvent> = {}, extra: Partial<Raised> = {}): Raised {
  return { type: "attentionRaised", ref, generation: 1, delivery: "live", title: "A session outside the list", event: { sequence, openedAt: sequence, kind: "outcome", outcome: "completed", ...event }, ...extra }
}

test("canonical outcomes alert without an observed working transition or a loaded row", () => {
  const detect = createAlertDetector()
  expect(detect(raised(10))).toEqual({ kind: "agent", ref, title: "A session outside the list" })
  expect(detect(raised(11, { outcome: "failed" }))?.kind).toBe("errors")
  expect(detect(raised(12, { outcome: "cancelled" }))).toBeUndefined()
  expect(detect({ type: "statusChanged", ref, status: { kind: "idle" } })).toBeUndefined()
})

test("recovered attention is silent and a subsequent live outcome alerts", () => {
  const detect = createAlertDetector()
  expect(detect(raised(20, {}, { delivery: "replay" }))).toBeUndefined()
  expect(detect(raised(21))?.kind).toBe("agent")
})

test("questions and permissions alert even after they closed before the list snapshot", () => {
  const detect = createAlertDetector()
  expect(detect(raised(30, { kind: "question", requestId: "q1", outcome: undefined }))?.kind).toBe("permissions")
  expect(detect(raised(31, { kind: "permission", requestId: "p1", outcome: undefined }))?.kind).toBe("permissions")
})

test("subagent outcomes are silent", () => {
  const detect = createAlertDetector()
  expect(detect(raised(40, {}, { parentSessionId: "parent" }))).toBeUndefined()
})

test("identities are scoped by placement and session", () => {
  const detect = createAlertDetector()
  expect(detect(raised(10))?.kind).toBe("agent")
  expect(detect(raised(10, {}, { ref: { ...ref, placementId: placementId("plc_2") } }))?.kind).toBe("agent")
})
