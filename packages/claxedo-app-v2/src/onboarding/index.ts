import type { Loaded } from "@/projects"
import type { Project } from "@/server"

export type { OnboardingKey, OnboardingText } from "./i18n"
export { dictionary as onboardingDictionary, useOnboardingText } from "./i18n"
export type { OnboardingState, OnboardingStep } from "./model"
export { onboardingCurrentStep, onboardingState, onboardingStepIndex, onboardingSteps } from "./model"
export { onboardingPath, onboardingRoute } from "./route"
export { OnboardingPage } from "./view/onboarding-page"

export function onboardingNeeded(projects: Loaded<readonly Project[]>): boolean {
  return projects.kind === "ready" && projects.data.length === 0
}
