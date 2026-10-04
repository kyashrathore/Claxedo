import type { Loaded } from "@/projects"
import type { Project } from "@/server"

export { onboardingPath, onboardingRoute } from "./route"

export function onboardingNeeded(projects: Loaded<readonly Project[]>, sharedSessions: number | undefined): boolean {
  return projects.kind === "ready" && projects.data.length === 0 && sharedSessions === 0
}
