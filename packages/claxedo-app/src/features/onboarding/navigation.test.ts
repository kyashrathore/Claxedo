import { describe, expect, test } from "bun:test"
import type { OnboardingStepId } from "./registry"
import {
  backLocation, canSkip, initialLocation, isSetupComplete, nextLocation,
  railSteps, remainingCount, resolveLocation, selectLocation, setupStepLocation,
  stepPosition, visibleSteps, SETUP_DONE, type SetupStepView,
} from "./navigation"

function step(id: OnboardingStepId, overrides: Partial<SetupStepView> = {}): SetupStepView {
  return { id, applies: true, done: false, locked: false, skipped: false, optional: false, ...overrides }
}
function steps(): SetupStepView[] {
  return [step("destination"), step("ai"), step("remote-access", { optional: true })]
}

describe("setup navigation", () => {
  test("locked steps remain counted in the rail but cannot be destinations", () => {
    const run = [step("destination"), step("ai", { locked: true }), step("remote-access", { applies: false })]
    expect(railSteps(run).map((s) => s.id)).toEqual(["destination", "ai"])
    expect(visibleSteps(run).map((s) => s.id)).toEqual(["destination"])
    expect(stepPosition(run, setupStepLocation("destination"))).toEqual({ index: 1, total: 2 })
    expect(resolveLocation(run, "ai")).toEqual({ kind: "step", step: "destination" })
    expect(resolveLocation(run, "remote-access")).toEqual({ kind: "step", step: "destination" })
    expect(selectLocation(run, "ai", setupStepLocation("destination"))).toEqual({ kind: "step", step: "destination" })
    expect(selectLocation(run, "remote-access", setupStepLocation("destination"))).toEqual({ kind: "step", step: "destination" })
  })

  test("entry chooses the first unfinished, unskipped step and then the recap", () => {
    const run = steps()
    expect(initialLocation(run)).toEqual({ kind: "step", step: "destination" })
    expect(resolveLocation(run, undefined)).toEqual({ kind: "step", step: "destination" })
    run[0] = step("destination", { done: true })
    expect(initialLocation(run)).toEqual({ kind: "step", step: "ai" })
    run[1] = step("ai", { done: true })
    expect(initialLocation(run)).toEqual({ kind: "step", step: "remote-access" })
    run[2] = step("remote-access", { optional: true, skipped: true })
    expect(initialLocation(run)).toEqual({ kind: "done" })
  })

  test("an open deep link is honored even for a completed step", () => {
    const run = steps()
    run[0] = step("destination", { done: true })
    expect(resolveLocation(run, "ai")).toEqual({ kind: "step", step: "ai" })
    expect(resolveLocation(run, "destination")).toEqual({ kind: "step", step: "destination" })
    expect(selectLocation(run, "destination", setupStepLocation("ai"))).toEqual({ kind: "step", step: "destination" })
  })

  test("next advances, skips completed or skipped work, and stops at the recap", () => {
    const run = steps()
    expect(nextLocation(run, setupStepLocation("destination"))).toEqual({ kind: "step", step: "ai" })
    run[1] = step("ai", { done: true })
    expect(nextLocation(run, setupStepLocation("destination"))).toEqual({ kind: "step", step: "remote-access" })
    run[1] = step("ai", { skipped: true })
    expect(nextLocation(run, setupStepLocation("destination"))).toEqual({ kind: "step", step: "remote-access" })
    expect(nextLocation(run, setupStepLocation("remote-access"))).toEqual({ kind: "done" })
    expect(nextLocation(run, SETUP_DONE)).toEqual({ kind: "done" })
  })

  test("back follows visible steps, including completed work", () => {
    const run = steps()
    expect(backLocation(run, setupStepLocation("destination"))).toBeUndefined()
    expect(backLocation(run, setupStepLocation("ai"))).toEqual({ kind: "step", step: "destination" })
    expect(backLocation(run, SETUP_DONE)).toEqual({ kind: "step", step: "remote-access" })
    run[1] = step("ai", { applies: false })
    expect(backLocation(run, setupStepLocation("remote-access"))).toEqual({ kind: "step", step: "destination" })
  })

  test("only unfinished visible optional steps can be skipped", () => {
    const run = steps()
    expect(canSkip(run, setupStepLocation("destination"))).toBe(false)
    expect(canSkip(run, setupStepLocation("remote-access"))).toBe(true)
    expect(canSkip(run, SETUP_DONE)).toBe(false)
    run[2] = step("remote-access", { optional: true, done: true })
    expect(canSkip(run, setupStepLocation("remote-access"))).toBe(false)
    run[2] = step("remote-access", { optional: true, locked: true })
    expect(canSkip(run, setupStepLocation("remote-access"))).toBe(false)
  })

  test("progress counts unfinished visible work and has no recap position", () => {
    const run = steps()
    expect(stepPosition(run, setupStepLocation("ai"))).toEqual({ index: 2, total: 3 })
    expect(stepPosition(run, SETUP_DONE)).toBeUndefined()
    expect(remainingCount(run)).toBe(3)
    run[0] = step("destination", { done: true })
    run[2] = step("remote-access", { optional: true, skipped: true })
    expect(remainingCount(run)).toBe(1)
    run[1] = step("ai", { locked: true })
    expect(remainingCount(run)).toBe(0)
  })

  test("completion requires all applicable required steps, including locked ones", () => {
    const run = steps()
    expect(isSetupComplete(run)).toBe(false)
    run[0] = step("destination", { done: true })
    run[1] = step("ai", { locked: true })
    expect(isSetupComplete(run)).toBe(false)
    run[1] = step("ai", { done: true })
    expect(isSetupComplete(run)).toBe(true)
    run[1] = step("ai", { applies: false })
    expect(isSetupComplete(run)).toBe(true)
  })
})
