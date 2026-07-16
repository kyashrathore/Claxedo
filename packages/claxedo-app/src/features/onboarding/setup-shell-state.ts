import type { OnboardingStepId } from "./registry"

export type SetupShellStep = {
  id: OnboardingStepId
  done: boolean
  locked: boolean
  skipped: boolean
}

export type SetupShellMode = "hidden" | "form" | "checklist" | "go-further"

export function setupShellMode(input: {
  hasProjects: boolean
  firstTurnCompleted: boolean
  setupDismissed: boolean
  checklistDismissed: boolean
}): SetupShellMode {
  if (input.hasProjects) return "hidden"
  if (input.firstTurnCompleted) return "go-further"
  if (input.checklistDismissed) return "hidden"
  if (input.setupDismissed) return "checklist"
  return "form"
}

export function activeSetupStep(steps: SetupShellStep[]) {
  return steps.find((step) => !step.done && !step.locked && !step.skipped)?.id
}
