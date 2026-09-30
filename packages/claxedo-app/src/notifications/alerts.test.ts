/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type ServerEvent, type SessionStatus } from "@/server"
import { createAlertDetector } from "./alerts"

const ref = { projectId: projectId("prj_1"), placementId: placementId("plc_1"), sessionId: sessionId("ses_1") }
const status = (value: SessionStatus): ServerEvent => ({ type: "statusChanged", ref, status: value })
const backgroundWork = (active: boolean): ServerEvent => ({ type: "backgroundWorkChanged", ref, active })

function alerts(...events: ServerEvent[]) {
  const detect = createAlertDetector()
  return events.map((event) => detect(event)?.kind)
}

test("alerts: a turn that ends with nothing left running is the agent alert", () => {
  expect(alerts(status({ kind: "working" }), status({ kind: "idle" }))).toEqual([undefined, "agent"])
})

test("alerts: a turn that ends while background work runs raises nothing until that work settles", () => {
  expect(alerts(
    status({ kind: "working" }),
    backgroundWork(true),
    status({ kind: "idle" }),
    backgroundWork(false),
  )).toEqual([undefined, undefined, undefined, "agent"])
})

test("alerts: background work already running at reconnect alerts once when it settles, and a failed turn is an error whatever runs beside it", () => {
  expect(alerts(status({ kind: "idle" }), backgroundWork(true), backgroundWork(false))).toEqual([undefined, undefined, "agent"])
  const failed = { kind: "failed", error: new Error("boom") } as unknown as SessionStatus
  expect(alerts(status({ kind: "working" }), backgroundWork(true), status(failed), backgroundWork(false))).toEqual([undefined, undefined, "errors", undefined])
})
