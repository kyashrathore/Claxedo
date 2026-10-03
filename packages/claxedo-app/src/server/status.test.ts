/// <reference types="bun" />
import { expect, test } from "bun:test"
import { ServerError } from "./errors"
import { placementId, projectId, sessionId } from "./ids"
import { createStatusOwner, RUNNING_IN_BACKGROUND, sessionStatusWithBackgroundWork } from "./status"
import type { Transport } from "./transport"
import type { SessionStatus } from "./status-types"

test("session status: a turn that is not running while background work runs is running in background, one shared value", () => {
  const idle: SessionStatus = { kind: "idle" }
  expect(sessionStatusWithBackgroundWork(idle, { agents: 1, shells: 0, other: 0 })).toBe(RUNNING_IN_BACKGROUND)
  expect(sessionStatusWithBackgroundWork({ kind: "unknown" as const }, { agents: 0, shells: 1, other: 0 })).toBe(RUNNING_IN_BACKGROUND)
  expect(RUNNING_IN_BACKGROUND).toEqual({ kind: "runningInBackground" })
  expect(sessionStatusWithBackgroundWork(idle, { agents: 0, shells: 0, other: 0 })).toBe(idle)
})

test("session status: a running turn and a failed turn keep their own status beside background work", () => {
  const working: SessionStatus = { kind: "working" }
  const retrying: SessionStatus = { kind: "retrying", attempt: 1, message: "later", nextAt: 2 }
  const failed: SessionStatus = { kind: "failed", error: new ServerError({ class: "internal", message: "boom" }) }
  for (const status of [working, retrying, failed]) expect(sessionStatusWithBackgroundWork(status, { agents: 1, shells: 0, other: 0 })).toBe(status)
})

test("session status: an idle held for settling after a failed turn keeps the lastTurn its frame carried", () => {
  const owner = createStatusOwner({} as Transport)
  const ref = { projectId: projectId("j1"), placementId: placementId("p1"), sessionId: sessionId("s1") }
  owner.apply({ type: "statusChanged", ref, status: { kind: "failed", error: new ServerError({ class: "internal", message: "boom" }) } })
  const idle = { type: "statusChanged" as const, ref, status: { kind: "idle" as const }, lastTurn: { status: "completed" as const, completedAt: 9 } }
  expect(owner.apply(idle)).toEqual({ kind: "held", event: idle })
})
