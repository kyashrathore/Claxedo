import type { RouteEntry } from "@/shell"
import { OnboardingPage } from "./view/onboarding-page"

export const onboardingPath = "/welcome"

export const onboardingRoute: RouteEntry = { id: "onboarding", path: onboardingPath, view: OnboardingPage }
