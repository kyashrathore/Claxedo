/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, type ServerEvent, type SessionStatus } from "@/server"
import { createAlertDetector } from "./alerts"

const ref = { projectId: projectId("prj_1"), placementId: placementId("plc_1"), sessionId: sessionId("ses_1") }
const status = (value: SessionStatus): ServerEvent => ({ type: "statusChanged", ref, status: value })
const backgroundWork = (active: boolean): ServerEvent => ({ type: "backgroundWorkChanged", ref, work: { agents: active ? 1 : 0, shells: 0, other: 0 } })

function alerts(...events: ServerEvent[]) {
  const detect = createAlertDetector()
  return events.map((event) => detect(event)?.kind)
}

test("alerts: a turn that ends with nothing left running is the agent alert", () => {
  expect(alerts(status({ kind: "working" }), status({ kind: "idle" }))).toEqual([undefined, "agent"])
})

test("alerts: a turn that ends while background work runs is running in background and raises nothing; the report turn's end is the one agent alert", () => {
  expect(alerts(
    status({ kind: "working" }),
    backgroundWork(true),
    status({ kind: "idle" }),
    backgroundWork(false),
    status({ kind: "working" }),
    status({ kind: "idle" }),
  )).toEqual([undefined, undefined, undefined, undefined, undefined, "agent"])
})

test("alerts: background work that settles with no report turn raises nothing, and neither does work already running at reconnect", () => {
  expect(alerts(status({ kind: "working" }), backgroundWork(true), status({ kind: "idle" }), backgroundWork(false))).toEqual([undefined, undefined, undefined, undefined])
  expect(alerts(status({ kind: "idle" }), backgroundWork(true), backgroundWork(false))).toEqual([undefined, undefined, undefined])
})

test("alerts: work that empties in the middle of a turn leaves the turn's end as the agent alert, and a failed turn is an error whatever runs beside it", () => {
  expect(alerts(status({ kind: "working" }), backgroundWork(true), backgroundWork(false), status({ kind: "idle" }))).toEqual([undefined, undefined, undefined, "agent"])
  const failed = { kind: "failed", error: new Error("boom") } as unknown as SessionStatus
  expect(alerts(status({ kind: "working" }), backgroundWork(true), status(failed), backgroundWork(false))).toEqual([undefined, undefined, "errors", undefined])
})
