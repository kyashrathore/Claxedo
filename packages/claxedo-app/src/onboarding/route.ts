import type { RouteEntry } from "@/shell"
import { FirstProjectCanvas } from "./view/first-project-canvas"

export const onboardingPath = "/welcome"

export const onboardingRoute: RouteEntry = { id: "onboarding", path: onboardingPath, view: FirstProjectCanvas, requiresSignIn: true }
