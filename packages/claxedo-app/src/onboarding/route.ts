import type { RouteEntry } from "@/shell"
import { lazyView } from "@/lib/lazy-view"

export const onboardingPath = "/welcome"

export const onboardingRoute: RouteEntry = { id: "onboarding", path: onboardingPath, view: lazyView(() => import("./view/first-project-canvas").then((module) => module.FirstProjectCanvas)), requiresSignIn: true }
