import { describe, expect, test } from "bun:test"

import {
  TRUSTED_INPUT_EVENT_TYPES,
  TRUSTED_INPUT_WINDOW_MS,
  createTrustedInputGate,
  isTrustedActivation,
} from "./trusted-input"

const trusted = { isTrusted: true } as const
const forged = { isTrusted: false } as const

describe("isTrustedActivation", () => {
  test("accepts an event the browser marked trusted", () => {
    expect(isTrustedActivation(trusted)).toBe(true)
  })

  test("refuses a script-constructed event", () => {
    expect(isTrustedActivation(new Event("click"))).toBe(false)
    expect(isTrustedActivation(forged)).toBe(false)
  })
})

describe("createTrustedInputGate", () => {
  function clock(start = 0) {
    let t = start
    return { now: () => t, set: (v: number) => (t = v) }
  }

  test("has no recent input before any event", () => {
    const c = clock(5_000)
    expect(createTrustedInputGate(c.now).hasRecentTrustedInput()).toBe(false)
  })

  test("ignores untrusted events entirely", () => {
    const c = clock(1_000)
    const gate = createTrustedInputGate(c.now)
    gate.noteTrustedEvent(forged)
    gate.noteTrustedEvent(new Event("pointerup"))
    expect(gate.hasRecentTrustedInput()).toBe(false)
  })

  test("accepts a trusted event inside the window, including its edge", () => {
    const c = clock(1_000)
    const gate = createTrustedInputGate(c.now)
    gate.noteTrustedEvent(trusted)
    expect(gate.hasRecentTrustedInput()).toBe(true)
    c.set(1_000 + TRUSTED_INPUT_WINDOW_MS)
    expect(gate.hasRecentTrustedInput()).toBe(true)
  })

  test("refuses once the window has elapsed", () => {
    const c = clock(1_000)
    const gate = createTrustedInputGate(c.now)
    gate.noteTrustedEvent(trusted)
    c.set(1_000 + TRUSTED_INPUT_WINDOW_MS + 1)
    expect(gate.hasRecentTrustedInput()).toBe(false)
  })

  test("a later untrusted event does not refresh the window", () => {
    const c = clock(0)
    const gate = createTrustedInputGate(c.now, 100)
    gate.noteTrustedEvent(trusted)
    c.set(90)
    gate.noteTrustedEvent(forged)
    c.set(101)
    expect(gate.hasRecentTrustedInput()).toBe(false)
  })

  test("a later trusted event reopens the window", () => {
    const c = clock(0)
    const gate = createTrustedInputGate(c.now, 100)
    gate.noteTrustedEvent(trusted)
    c.set(150)
    expect(gate.hasRecentTrustedInput()).toBe(false)
    gate.noteTrustedEvent(trusted)
    expect(gate.hasRecentTrustedInput()).toBe(true)
  })
})

test("the recorded input types cover press, release, click and key", () => {
  expect([...TRUSTED_INPUT_EVENT_TYPES]).toEqual(["pointerdown", "pointerup", "mousedown", "mouseup", "click", "keydown"])
})
