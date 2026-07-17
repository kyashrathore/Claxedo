import type { OnboardingDismissalId } from "./dismissals"
import { onboardingGoFurtherCards } from "./go-further"
import { onboardingStepStates } from "./registry"
import { activeSetupStep, setupShellMode } from "./setup-shell-state"
import type { OnboardingState } from "./state"

export function onboardingHomeView(input: {
  state: OnboardingState
  dismissals: readonly OnboardingDismissalId[]
}) {
  const steps = onboardingStepStates(input.state).filter((step) => step.applies).map((step) => ({
    id: step.id,
    title: step.title,
    education: step.education,
    done: step.done,
    locked: step.locked,
    lockedReason: step.lockReason,
    skipped: input.dismissals.includes(`step:${step.id}`),
    skippable: input.state.surface !== "web",
    cta: step.cta,
  }))

  return {
    mode: setupShellMode({
      hasProjects: input.state.hasProject,
      activationReady: input.state.surface === "web" ? input.state.hasFirstCloudTurn : input.state.hasUsableCredential,
      firstTurnCompleted: input.state.hasFirstTurn,
      setupDismissed: input.dismissals.includes("setup"),
      checklistDismissed: input.dismissals.includes("checklist"),
    }),
    steps,
    activeStep: activeSetupStep(steps),
    goFurtherCards: onboardingGoFurtherCards.filter(
      (card) => card.appliesTo(input.state.surface) && !input.dismissals.includes(`gofurther:${card.id}`),
    ),
  }
}
