import type { Loaded } from "@/projects"
import type { Project } from "@/server"

export { onboardingPath, onboardingRoute } from "./route"

export function onboardingNeeded(projects: Loaded<readonly Project[]>): boolean {
  return projects.kind === "ready" && projects.data.length === 0
}
