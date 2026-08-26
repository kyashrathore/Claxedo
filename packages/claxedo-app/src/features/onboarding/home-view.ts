import type { OnboardingDismissalId } from "./dismissals"
import { onboardingGoFurtherCards } from "./go-further"
import { remainingCount, resolveLocation, type SetupStepView } from "./navigation"
import { onboardingStepStates, type OnboardingStepId } from "./registry"
import { setupShellMode } from "./setup-shell-state"
import type { OnboardingState } from "./state"

export function onboardingHomeView(input: {
  state: OnboardingState
  dismissals: readonly OnboardingDismissalId[]
  /**
   * Steps the user moved past with Next without finishing them. Treated like a
   * dismissal for THIS pass only, so advancing off an optional step lands on
   * what follows it rather than resolving back to the step just left — but
   * nothing is written down, so the step is offered again next time.
   */
  passedOver?: readonly OnboardingStepId[]
  /** Deep-linked step, if the URL asked for one. */
  requestedStep?: OnboardingStepId
}) {
  const steps = onboardingStepStates(input.state).map((step) => ({
    id: step.id,
    title: step.title,
    education: step.education,
    applies: step.applies,
    done: step.done,
    locked: step.locked,
    lockedReason: step.lockReason,
    skipped: input.dismissals.includes(`step:${step.id}`),
    optional: step.optional,
    cta: step.cta,
  }))
  // Navigation treats "passed over for now" the same as dismissed, so it never
  // resolves back to a step the user has just moved off. The rendered steps
  // keep the two apart: only a real dismissal reads as skipped in the rail.
  const navSteps: SetupStepView[] = steps.map((step) => ({
    id: step.id,
    applies: step.applies,
    done: step.done,
    locked: step.locked,
    skipped: step.skipped || (input.passedOver?.includes(step.id) ?? false),
    optional: step.optional,
  }))

  return {
    mode: setupShellMode({
      hasProjects: input.state.hasProject,
      activationReady:
        input.state.surface === "web" && input.state.wantsCloud
          ? input.state.hasFirstCloudTurn
          : input.state.hasRunnableAI,
      firstTurnCompleted: input.state.hasFirstTurn,
      setupDismissed: input.dismissals.includes("setup"),
      checklistDismissed: input.dismissals.includes("checklist"),
    }),
    // The rail shows every applicable step, including ones still locked behind
    // an earlier one, so the total does not grow as the user advances. Only
    // `location` decides what is rendered, and it never resolves to a locked
    // step — so a locked step is visible as progress, never as a destination.
    steps: steps.filter((step) => step.applies),
    location: resolveLocation(navSteps, input.requestedStep),
    remaining: remainingCount(navSteps),
    goFurtherCards: onboardingGoFurtherCards.filter(
      (card) => card.appliesTo(input.state.surface) && !input.dismissals.includes(`gofurther:${card.id}`),
    ),
  }
}
