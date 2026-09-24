import type { OnboardingKey } from "./i18n"

export type OnboardingStepId = "project" | "ai" | "execution"

export type OnboardingStep = {
  readonly id: OnboardingStepId
  readonly label: OnboardingKey
  readonly headline: OnboardingKey
  readonly lede: { readonly local: OnboardingKey; readonly hosted: OnboardingKey }
}

export const onboardingSteps: readonly OnboardingStep[] = [
  {
    id: "project",
    label: "onboarding.step.project",
    headline: "onboarding.project.headline",
    lede: { local: "onboarding.project.lede.local", hosted: "onboarding.project.lede.hosted" },
  },
  {
    id: "ai",
    label: "onboarding.step.ai",
    headline: "onboarding.ai.headline",
    lede: { local: "onboarding.ai.lede.local", hosted: "onboarding.ai.lede.hosted" },
  },
  {
    id: "execution",
    label: "onboarding.step.execution",
    headline: "onboarding.execution.headline",
    lede: { local: "onboarding.execution.lede.local", hosted: "onboarding.execution.lede.hosted" },
  },
]

export type ExecutionChoice = "local" | "cloud" | "connected"
