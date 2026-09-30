/// <reference types="bun" />
import { expect, test } from "bun:test"
import { ServerError } from "./errors"
import { RUNNING_IN_BACKGROUND, sessionStatusWithBackgroundWork } from "./status"
import type { SessionStatus } from "./types"

test("session status: a turn that is not running while background work runs is running in background, one shared value", () => {
  const idle: SessionStatus = { kind: "idle" }
  expect(sessionStatusWithBackgroundWork(idle, true)).toBe(RUNNING_IN_BACKGROUND)
  expect(sessionStatusWithBackgroundWork({ kind: "unknown" as const }, true)).toBe(RUNNING_IN_BACKGROUND)
  expect(RUNNING_IN_BACKGROUND).toEqual({ kind: "runningInBackground" })
  expect(sessionStatusWithBackgroundWork(idle, false)).toBe(idle)
})

test("session status: a running turn and a failed turn keep their own status beside background work", () => {
  const working: SessionStatus = { kind: "working" }
  const retrying: SessionStatus = { kind: "retrying", attempt: 1, message: "later", nextAt: 2 }
  const failed: SessionStatus = { kind: "failed", error: new ServerError({ class: "internal", message: "boom" }) }
  for (const status of [working, retrying, failed]) expect(sessionStatusWithBackgroundWork(status, true)).toBe(status)
})
