/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId, ServerError, type ServerEvent } from "@/server"
import { createAlertDetector, type AlertKind } from "./alerts"

const ref = { projectId: projectId("prj_1"), placementId: placementId("plc_1"), sessionId: sessionId("ses_1") }
const working: ServerEvent = { type: "statusChanged", ref, status: { kind: "working" } }
const idle: ServerEvent = { type: "statusChanged", ref, status: { kind: "idle" } }
const failed: ServerEvent = { type: "statusChanged", ref, status: { kind: "failed", error: new ServerError({ class: "internal", message: "boom" }) } }
const background: ServerEvent = { type: "backgroundWorkChanged", ref, work: { agents: 1, shells: 0, other: 0 } }
const settled: ServerEvent = { type: "backgroundWorkChanged", ref, work: { agents: 0, shells: 0, other: 0 } }

test.each<[string, ServerEvent[], (AlertKind | undefined)[]]>([
  ["a finished turn", [working, idle], [undefined, "agent"]],
  ["only the report turn alerts", [working, background, idle, settled, working, idle], [undefined, undefined, undefined, undefined, undefined, "agent"]],
  ["settling without a report turn", [working, background, idle, settled], [undefined, undefined, undefined, undefined]],
  ["background work at reconnect", [idle, background, settled], [undefined, undefined, undefined]],
  ["work settles during the turn", [working, background, settled, idle], [undefined, undefined, undefined, "agent"]],
  ["a failure while background work runs", [working, background, failed, settled], [undefined, undefined, "errors", undefined]],
])("alerts: %s", (_name, events, expected) => {
  const detect = createAlertDetector()
  expect(events.map((event) => detect(event)?.kind)).toEqual(expected)
})
