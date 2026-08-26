import type { OnboardingStepId } from "./registry"

/**
 * The navigation model for the setup page.
 *
 * Everything the page needs to answer "where am I, what can I do, where does
 * this go" lives here as plain data, so the rules can be asserted without a DOM.
 *
 * Two kinds of unavailable are deliberately NOT the same thing:
 *
 *  - **Does not apply** — the step can never succeed in this run (no sandbox
 *    provider token, so no cloud). Absent from the rail and from the count.
 *    "Nothing that cannot be done is shown as a thing to do."
 *  - **Locked** — the step is real and coming, it just is not reachable yet
 *    (connect your AI *after* opening a project). It occupies a rail segment and
 *    counts toward the total, so "Step 1 of 2" does not become "Step 1 of 1";
 *    but it is never a destination navigation can land on.
 *
 * The terminal `done` location is not a step: no rail index, cannot be passed.
 */

export type SetupStepView = {
  id: OnboardingStepId
  applies: boolean
  done: boolean
  locked: boolean
  skipped: boolean
  optional: boolean
}

/** Where the page is pointed. `done` is the recap screen after the last step. */
export type SetupLocation = { kind: "step"; step: OnboardingStepId } | { kind: "done" }

export const SETUP_DONE: SetupLocation = { kind: "done" }

export function setupStepLocation(step: OnboardingStepId): SetupLocation {
  return { kind: "step", step }
}

export function isSameLocation(a: SetupLocation, b: SetupLocation) {
  if (a.kind === "done" || b.kind === "done") return a.kind === b.kind
  return a.step === b.step
}

/**
 * Steps shown in the rail and counted in "Step N of M" — everything that
 * applies, including steps still locked behind an earlier one.
 */
export function railSteps(steps: readonly SetupStepView[]): readonly SetupStepView[] {
  return steps.filter((step) => step.applies)
}

/** The steps navigation may actually land on, in order. */
export function visibleSteps(steps: readonly SetupStepView[]): readonly SetupStepView[] {
  return steps.filter((step) => step.applies && !step.locked)
}

/** 1-based position for "Step N of M". Undefined on the recap screen. */
export function stepPosition(steps: readonly SetupStepView[], location: SetupLocation) {
  if (location.kind === "done") return
  const rail = railSteps(steps)
  const index = rail.findIndex((step) => step.id === location.step)
  if (index === -1) return
  return { index: index + 1, total: rail.length }
}

/**
 * The first thing still worth doing. Used on entry and after any state change
 * that completes a step out from under the user.
 */
export function initialLocation(steps: readonly SetupStepView[]): SetupLocation {
  const next = visibleSteps(steps).find((step) => !step.done && !step.skipped)
  return next ? setupStepLocation(next.id) : SETUP_DONE
}

/**
 * Resolve a requested destination against reality. A deep link to a step that is
 * locked, absent, or already finished lands on the first open step instead of
 * rendering something the user cannot act on.
 */
export function resolveLocation(
  steps: readonly SetupStepView[],
  requested: OnboardingStepId | undefined,
): SetupLocation {
  if (!requested) return initialLocation(steps)
  const target = visibleSteps(steps).find((step) => step.id === requested)
  if (!target) return initialLocation(steps)
  return setupStepLocation(target.id)
}

export function nextLocation(steps: readonly SetupStepView[], from: SetupLocation): SetupLocation {
  if (from.kind === "done") return SETUP_DONE
  const order = visibleSteps(steps)
  const index = order.findIndex((step) => step.id === from.step)
  if (index === -1) return initialLocation(steps)
  const rest = order.slice(index + 1)
  // Skip anything already satisfied — advancing should land on work, not on a
  // screen whose only content is a checkmark.
  const next = rest.find((step) => !step.done && !step.skipped) ?? rest[0]
  return next ? setupStepLocation(next.id) : SETUP_DONE
}

/** Undefined means there is nowhere back to go, and no Back affordance renders. */
export function backLocation(steps: readonly SetupStepView[], from: SetupLocation): SetupLocation | undefined {
  const order = visibleSteps(steps)
  if (from.kind === "done") {
    const last = order[order.length - 1]
    return last ? setupStepLocation(last.id) : undefined
  }
  const index = order.findIndex((step) => step.id === from.step)
  if (index <= 0) return
  const previous = order[index - 1]
  return previous ? setupStepLocation(previous.id) : undefined
}

/** Selecting a step from the rail. Locked and absent steps are inert. */
export function selectLocation(
  steps: readonly SetupStepView[],
  step: OnboardingStepId,
  from: SetupLocation,
): SetupLocation {
  const target = visibleSteps(steps).find((item) => item.id === step)
  if (!target) return from
  return setupStepLocation(target.id)
}

/** Only optional, unfinished steps can be skipped. */
export function canSkip(steps: readonly SetupStepView[], location: SetupLocation) {
  if (location.kind === "done") return false
  const step = visibleSteps(steps).find((item) => item.id === location.step)
  return !!step && step.optional && !step.done
}

/** How many applicable steps still want attention — the rail entry's count. */
export function remainingCount(steps: readonly SetupStepView[]) {
  return visibleSteps(steps).filter((step) => !step.done && !step.skipped).length
}

/** Required steps must all be done before setup is considered finished. */
export function isSetupComplete(steps: readonly SetupStepView[]) {
  return steps.filter((step) => step.applies && !step.optional).every((step) => step.done)
}
