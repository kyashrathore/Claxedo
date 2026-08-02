import { describe, expect, test } from "vitest"
import type { OnboardingStepId } from "./registry"
import {
  backLocation,
  canSkip,
  initialLocation,
  isSetupComplete,
  nextLocation,
  railSteps,
  remainingCount,
  resolveLocation,
  selectLocation,
  setupStepLocation,
  stepPosition,
  visibleSteps,
  SETUP_DONE,
  type SetupStepView,
} from "./navigation"

function step(id: OnboardingStepId, overrides: Partial<SetupStepView> = {}): SetupStepView {
  return { id, applies: true, done: false, locked: false, skipped: false, optional: false, ...overrides }
}

/** The common shape: both required steps open, neither optional step applicable. */
function freshLocalRun(): SetupStepView[] {
  return [
    step("project"),
    step("ai"),
    step("compute", { applies: false, optional: true }),
    step("cloud-credentials", { applies: false, optional: true }),
  ]
}

/** A machine with a working sandbox provider token and a local credential. */
function cloudCapableRun(): SetupStepView[] {
  return [
    step("project", { done: true }),
    step("ai", { done: true }),
    step("compute", { optional: true }),
    step("cloud-credentials", { optional: true }),
  ]
}

describe("visible steps", () => {
  test("omits steps that do not apply", () => {
    expect(visibleSteps(freshLocalRun()).map((s) => s.id)).toEqual(["project", "ai"])
  })

  test("omits locked steps as destinations", () => {
    const steps = [step("project"), step("ai", { locked: true })]
    expect(visibleSteps(steps).map((s) => s.id)).toEqual(["project"])
  })

  test("but keeps locked steps in the rail so the total does not grow", () => {
    // "Step 1 of 2" must not become "Step 1 of 1" just because step 2 is not
    // reachable until step 1 is done.
    const steps = [step("project"), step("ai", { locked: true })]
    expect(railSteps(steps).map((s) => s.id)).toEqual(["project", "ai"])
    expect(stepPosition(steps, setupStepLocation("project"))).toEqual({ index: 1, total: 2 })
  })

  test("the rail still omits steps that do not apply", () => {
    expect(railSteps(freshLocalRun()).map((s) => s.id)).toEqual(["project", "ai"])
  })

  test("includes optional steps once they apply", () => {
    expect(visibleSteps(cloudCapableRun()).map((s) => s.id)).toEqual([
      "project",
      "ai",
      "compute",
      "cloud-credentials",
    ])
  })
})

describe("initial location", () => {
  test("is the first unfinished step", () => {
    expect(initialLocation(freshLocalRun())).toEqual(setupStepLocation("project"))
  })

  test("skips finished steps", () => {
    const steps = freshLocalRun()
    steps[0] = step("project", { done: true })
    expect(initialLocation(steps)).toEqual(setupStepLocation("ai"))
  })

  test("skips steps the user chose to skip", () => {
    const steps = cloudCapableRun()
    steps[2] = step("compute", { optional: true, skipped: true })
    expect(initialLocation(steps)).toEqual(setupStepLocation("cloud-credentials"))
  })

  test("is the recap once nothing is left", () => {
    const steps = freshLocalRun().map((s) => ({ ...s, done: true }))
    expect(initialLocation(steps)).toEqual(SETUP_DONE)
  })
})

describe("deep links", () => {
  test("an applicable open step is honoured", () => {
    const steps = freshLocalRun()
    steps[0] = step("project", { done: true })
    expect(resolveLocation(steps, "ai")).toEqual(setupStepLocation("ai"))
  })

  test("a locked step falls back to the first open step (D10)", () => {
    const steps = [step("project"), step("ai", { locked: true })]
    expect(resolveLocation(steps, "ai")).toEqual(setupStepLocation("project"))
  })

  test("a step that does not apply falls back", () => {
    expect(resolveLocation(freshLocalRun(), "compute")).toEqual(setupStepLocation("project"))
  })

  test("no request lands on the first open step", () => {
    expect(resolveLocation(freshLocalRun(), undefined)).toEqual(setupStepLocation("project"))
  })
})

describe("next", () => {
  test("advances to the following step", () => {
    expect(nextLocation(freshLocalRun(), setupStepLocation("project"))).toEqual(setupStepLocation("ai"))
  })

  test("jumps over steps that are already done", () => {
    const steps = cloudCapableRun()
    steps[2] = step("compute", { optional: true, done: true })
    expect(nextLocation(steps, setupStepLocation("ai"))).toEqual(setupStepLocation("cloud-credentials"))
  })

  test("reaches the recap from the last step", () => {
    expect(nextLocation(freshLocalRun(), setupStepLocation("ai"))).toEqual(SETUP_DONE)
  })

  test("cannot advance past the recap", () => {
    expect(nextLocation(freshLocalRun(), SETUP_DONE)).toEqual(SETUP_DONE)
  })
})

describe("back", () => {
  test("is absent on the first step", () => {
    expect(backLocation(freshLocalRun(), setupStepLocation("project"))).toBeUndefined()
  })

  test("returns to the previous visible step", () => {
    expect(backLocation(freshLocalRun(), setupStepLocation("ai"))).toEqual(setupStepLocation("project"))
  })

  test("steps over a step that does not apply", () => {
    const steps = cloudCapableRun()
    steps[2] = step("compute", { applies: false, optional: true })
    expect(backLocation(steps, setupStepLocation("cloud-credentials"))).toEqual(setupStepLocation("ai"))
  })

  test("returns from the recap to the last step", () => {
    expect(backLocation(freshLocalRun(), SETUP_DONE)).toEqual(setupStepLocation("ai"))
  })
})

describe("selecting from the rail", () => {
  test("moves to the selected step", () => {
    const from = setupStepLocation("project")
    expect(selectLocation(freshLocalRun(), "ai", from)).toEqual(setupStepLocation("ai"))
  })

  test("selecting a locked step is a no-op (D9)", () => {
    const steps = [step("project"), step("ai", { locked: true })]
    const from = setupStepLocation("project")
    expect(selectLocation(steps, "ai", from)).toEqual(from)
  })

  test("selecting a done step is allowed — review is not a mistake", () => {
    const steps = cloudCapableRun()
    const from = setupStepLocation("compute")
    expect(selectLocation(steps, "project", from)).toEqual(setupStepLocation("project"))
  })
})

describe("skip", () => {
  test("required steps cannot be skipped", () => {
    expect(canSkip(freshLocalRun(), setupStepLocation("ai"))).toBe(false)
  })

  test("optional steps can", () => {
    expect(canSkip(cloudCapableRun(), setupStepLocation("compute"))).toBe(true)
  })

  test("a finished optional step has nothing to skip", () => {
    const steps = cloudCapableRun()
    steps[2] = step("compute", { optional: true, done: true })
    expect(canSkip(steps, setupStepLocation("compute"))).toBe(false)
  })

  test("the recap has no skip", () => {
    expect(canSkip(cloudCapableRun(), SETUP_DONE)).toBe(false)
  })
})

describe("progress", () => {
  test("counts only visible steps", () => {
    expect(stepPosition(freshLocalRun(), setupStepLocation("ai"))).toEqual({ index: 2, total: 2 })
  })

  test("grows when optional steps become applicable", () => {
    expect(stepPosition(cloudCapableRun(), setupStepLocation("compute"))).toEqual({ index: 3, total: 4 })
  })

  test("has no position on the recap", () => {
    expect(stepPosition(freshLocalRun(), SETUP_DONE)).toBeUndefined()
  })

  test("remaining counts unfinished, unskipped steps", () => {
    expect(remainingCount(cloudCapableRun())).toBe(2)
  })
})

describe("completion", () => {
  test("requires every required step", () => {
    expect(isSetupComplete(freshLocalRun())).toBe(false)
  })

  test("ignores optional steps", () => {
    expect(isSetupComplete(cloudCapableRun())).toBe(true)
  })

  test("ignores required steps that do not apply", () => {
    const steps = [step("project", { done: true }), step("ai", { applies: false })]
    expect(isSetupComplete(steps)).toBe(true)
  })
})
