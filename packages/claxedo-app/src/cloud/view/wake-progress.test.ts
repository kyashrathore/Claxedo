/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { WorkspaceRuntime } from "@/server"
import type { CloudText } from "../i18n"
import { wakeProgressText } from "./wake-progress"

const t: CloudText = (key, params) => (params ? `${key}(${Object.values(params).join("|")})` : key)
const list = (items: readonly string[]) => items.join("+")
const NOW = 1_000_000

type Waking = Extract<WorkspaceRuntime, { kind: "waking" }>
const say = (runtime: Waking) => wakeProgressText(t, runtime, NOW, list)

test("a wake with no recorded steps names what its boot path does, without guessing a time", () => {
  expect(say({ kind: "waking" })).toBe("cloud.wake.step.starting")
  expect(say({ kind: "waking", bootMode: "cold-start" })).toBe("cloud.wake.step.starting")
  expect(say({ kind: "waking", bootMode: "resume" })).toBe("cloud.wake.step.resuming")
  expect(say({ kind: "waking", bootMode: "restore" })).toBe("cloud.wake.step.restoring")
})

test("a wake names the step it is on with that step's time, the steps it has done, and the whole wake's time once it differs", () => {
  expect(say({ kind: "waking", bootMode: "resume", steps: { done: [], startedAt: NOW - 72_400, stepStartedAt: NOW - 72_300 } }))
    .toBe("cloud.wake.stepFor(cloud.wake.step.resuming|1m 12s)")
  expect(say({ kind: "waking", bootMode: "cold-start", steps: { done: ["machine"], startedAt: NOW - 41_000, stepStartedAt: NOW - 40_000 } }))
    .toBe("cloud.wake.stepFor(cloud.wake.step.image|40s) · cloud.wake.done(cloud.wake.done.machine) · cloud.wake.total(41s)")
  expect(say({ kind: "waking", bootMode: "resume", steps: { done: ["machine", "image"], startedAt: NOW - 95_000, stepStartedAt: NOW - 4_000 } }))
    .toBe("cloud.wake.stepFor(cloud.wake.step.runtime|4s) · cloud.wake.done(cloud.wake.done.machine+cloud.wake.done.image) · cloud.wake.total(1m 35s)")
  expect(say({ kind: "waking", steps: { done: ["machine", "image", "runtime"], startedAt: NOW - 99_000, stepStartedAt: NOW - 1_000 } }))
    .toBe("cloud.wake.stepFor(cloud.wake.step.connecting|1s) · cloud.wake.done(cloud.wake.done.machine+cloud.wake.done.image+cloud.wake.done.runtime) · cloud.wake.total(1m 39s)")
})

test("a wake the server is retrying says why, with the whole wake's time", () => {
  expect(say({ kind: "waking", bootMode: "resume", failure: "quota exceeded" })).toBe("cloud.wake.retrying(quota exceeded)")
  expect(say({ kind: "waking", bootMode: "resume", failure: "quota exceeded", steps: { done: ["machine"], startedAt: NOW - 130_000, stepStartedAt: NOW - 5_000 } }))
    .toBe("cloud.wake.retrying(quota exceeded) · cloud.wake.total(2m 10s)")
})

test("a clock behind the anchors reads no negative time", () => {
  expect(say({ kind: "waking", bootMode: "resume", steps: { done: [], startedAt: NOW + 400, stepStartedAt: NOW + 300 } }))
    .toBe("cloud.wake.stepFor(cloud.wake.step.resuming|0s)")
})
