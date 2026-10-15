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

test("wake machine: a waking start names the failure the server is retrying, keeps its boot mode, and drops the failure once a step reports none", () => {
  const resuming = wakeTransition(wakeTransition(WAKE_IDLE, { type: "wakeStarted" }), { type: "provisioning", bootMode: "resume" })
  const retrying = wakeTransition(resuming, { type: "provisioning", failure: "quota exceeded" })
  expect(retrying).toEqual({ kind: "waking", bootMode: "resume", failure: "quota exceeded" })
  expect(wakeTransition(retrying, { type: "provisioning", bootMode: "resume" })).toEqual({ kind: "waking", bootMode: "resume" })
})

test("wake machine: a start's steps follow the server, keep the earlier anchor when a later poll only jitters it, and stay while an answer carries none", () => {
  const waking = wakeTransition(WAKE_IDLE, { type: "wakeStarted" })
  const first = wakeTransition(waking, { type: "provisioning", bootMode: "resume", steps: { done: [], startedAt: 10_000, stepStartedAt: 10_100 } })
  const jittered = wakeTransition(first, { type: "provisioning", steps: { done: [], startedAt: 10_300, stepStartedAt: 10_350 } })
  expect(jittered).toEqual({ kind: "waking", bootMode: "resume", steps: { done: [], startedAt: 10_000, stepStartedAt: 10_100 } })
  const stepped = wakeTransition(jittered, { type: "provisioning", steps: { done: ["machine", "image"], startedAt: 10_200, stepStartedAt: 90_000 } })
  expect(stepped).toEqual({ kind: "waking", bootMode: "resume", steps: { done: ["machine", "image"], startedAt: 10_000, stepStartedAt: 90_000 } })
  expect(wakeTransition(stepped, { type: "provisioning", failure: "quota exceeded" })).toEqual({
    kind: "waking",
    bootMode: "resume",
    failure: "quota exceeded",
    steps: { done: ["machine", "image"], startedAt: 10_000, stepStartedAt: 90_000 },
  })
  const retried = wakeTransition(stepped, { type: "provisioning", steps: { done: [], startedAt: 10_100, stepStartedAt: 140_000 } })
  expect(retried).toEqual({ kind: "waking", bootMode: "resume", steps: { done: [], startedAt: 10_000, stepStartedAt: 140_000 } })
})
