/// <reference types="bun" />
import { expect, test } from "bun:test"
import { ServerError } from "./errors"
import { WAKE_IDLE, wakeTransition } from "./wake-machine"

test("wake machine: a start moves to waking, names its boot mode, and ends idle or failed; stray events change nothing", () => {
  const error = new ServerError({ class: "conflict", message: "Cloud runtime is unavailable" })
  const waking = wakeTransition(WAKE_IDLE, { type: "wakeStarted" })
  expect(waking).toEqual({ kind: "waking" })
  expect(wakeTransition(waking, { type: "provisioning", bootMode: "restore" })).toEqual({ kind: "waking", bootMode: "restore" })
  expect(wakeTransition(waking, { type: "woke" })).toEqual(WAKE_IDLE)
  const failed = wakeTransition(waking, { type: "wakeFailed", error })
  expect(failed).toEqual({ kind: "failed", error })
  expect(wakeTransition(failed, { type: "wakeStarted" })).toEqual({ kind: "waking" })
  expect(wakeTransition(WAKE_IDLE, { type: "woke" })).toBe(WAKE_IDLE)
  expect(wakeTransition(WAKE_IDLE, { type: "wakeFailed", error })).toBe(WAKE_IDLE)
})
