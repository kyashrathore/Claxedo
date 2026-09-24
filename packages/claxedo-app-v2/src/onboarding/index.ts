import type { Loaded } from "@/projects"
import type { Project } from "@/server"

export type { OnboardingKey, OnboardingText } from "./i18n"
export { dictionary as onboardingDictionary, useOnboardingText } from "./i18n"
export { onboardingPath, onboardingRoute } from "./route"

export function onboardingNeeded(projects: Loaded<readonly Project[]>): boolean {
  return projects.kind === "ready" && projects.data.length === 0
}
