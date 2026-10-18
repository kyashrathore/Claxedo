import { loadOnboardingAccountViews } from "@/accounts"
import { loadProjectCreate } from "@/projects"
import { lazyView } from "@/lib/lazy-view"
import type { RouteEntry } from "@/shell"

export const onboardingPath = "/welcome"

export const onboardingRoute: RouteEntry = { id: "onboarding", path: onboardingPath, view: lazyView(() => Promise.all([import("./view/first-project-canvas"), loadOnboardingAccountViews(), loadProjectCreate()]).then(([module]) => module.FirstProjectCanvas)), requiresSignIn: true }
