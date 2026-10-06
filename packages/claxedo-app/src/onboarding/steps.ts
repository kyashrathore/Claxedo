import type { OnboardingKey } from "./i18n"

export type OnboardingStepId = "project" | "ai" | "execution"

export type OnboardingStep = {
  readonly id: OnboardingStepId
  readonly label: OnboardingKey
  readonly headline: OnboardingKey
  readonly lede: OnboardingKey
}

const wizardStep = (id: OnboardingStepId, lede: OnboardingKey): OnboardingStep => ({ id, label: `onboarding.step.${id}`, headline: `onboarding.${id}.headline`, lede })

export function onboardingSteps(localExecution: boolean): readonly OnboardingStep[] {
  if (localExecution) return [wizardStep("project", "onboarding.project.lede.local"), wizardStep("ai", "onboarding.ai.lede.local"), wizardStep("execution", "onboarding.execution.lede.local")]
  return [wizardStep("execution", "onboarding.execution.lede.hosted"), wizardStep("project", "onboarding.project.lede.hosted"), wizardStep("ai", "onboarding.ai.lede.hosted")]
}
