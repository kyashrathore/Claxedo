import { unreachable } from "@/lib/machine"
import type { AddProjectState } from "@/projects"
import type { ProjectId } from "@/server"

export type OnboardingStep = "project" | "agent" | "placement"

export const onboardingSteps: readonly OnboardingStep[] = ["project", "agent", "placement"]

export type OnboardingState = { readonly kind: OnboardingStep } | { readonly kind: "done"; readonly projectId: ProjectId }

export function onboardingState(state: AddProjectState): OnboardingState {
  switch (state.kind) {
    case "choosingSource":
      return { kind: "project" }
    case "choosingAgent":
      return { kind: "agent" }
    case "choosingPlacement":
    case "creating":
    case "failed":
      return { kind: "placement" }
    case "created":
      return { kind: "done", projectId: state.projectId }
    default:
      return unreachable(state)
  }
}

export function onboardingStepIndex(state: OnboardingState): number {
  return state.kind === "done" ? onboardingSteps.length : onboardingSteps.indexOf(state.kind)
}

export function onboardingCurrentStep(state: OnboardingState): OnboardingStep {
  return state.kind === "done" ? "placement" : state.kind
}
