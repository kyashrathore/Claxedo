import { describe, expect, test } from "bun:test"
import { activeSetupStep, setupShellMode, type SetupShellStep } from "./setup-shell-state"

const step = (input: Partial<SetupShellStep> & Pick<SetupShellStep, "id">): SetupShellStep => ({
  id: input.id,
  done: input.done ?? false,
  locked: input.locked ?? false,
  skipped: input.skipped ?? false,
})

describe("setup shell state", () => {
  test.each([
    [{ hasProjects: false, activationReady: false, firstTurnCompleted: false, setupDismissed: false, checklistDismissed: false }, "form"],
    [{ hasProjects: false, activationReady: true, firstTurnCompleted: false, setupDismissed: true, checklistDismissed: false }, "checklist"],
    [{ hasProjects: false, activationReady: false, firstTurnCompleted: false, setupDismissed: true, checklistDismissed: true }, "hidden"],
    [{ hasProjects: false, activationReady: true, firstTurnCompleted: true, setupDismissed: false, checklistDismissed: false }, "go-further"],
    [{ hasProjects: false, activationReady: false, firstTurnCompleted: true, setupDismissed: true, checklistDismissed: false }, "go-further"],
    [{ hasProjects: true, activationReady: false, firstTurnCompleted: false, setupDismissed: false, checklistDismissed: false }, "form"],
    [{ hasProjects: true, activationReady: true, firstTurnCompleted: false, setupDismissed: false, checklistDismissed: false }, "hidden"],
    [{ hasProjects: true, activationReady: true, firstTurnCompleted: true, setupDismissed: false, checklistDismissed: false }, "go-further"],
  ] as const)("derives the shell without transition-local state: %o -> %s", (input, expected) => {
    expect(setupShellMode(input)).toBe(expected)
  })

  test("selects the first actionable incomplete step", () => {
    expect(
      activeSetupStep([
        step({ id: "project", done: true }),
        step({ id: "ai", skipped: true }),
        step({ id: "compute", locked: true }),
        step({ id: "remote" }),
      ]),
    ).toBe("remote")
  })

  test("keeps locked and completed steps un-actionable", () => {
    expect(activeSetupStep([step({ id: "project", done: true }), step({ id: "ai", locked: true })])).toBeUndefined()
  })

  test("a live locked-to-unlocked transition activates without a shell mutation", () => {
    const before = [step({ id: "compute", locked: true })]
    const after = [step({ id: "compute", locked: false })]
    expect(activeSetupStep(before)).toBeUndefined()
    expect(activeSetupStep(after)).toBe("compute")
  })
})
