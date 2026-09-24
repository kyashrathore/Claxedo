import { createEffect, type JSX } from "solid-js"
import { onboardingNeeded, onboardingPath } from "@/onboarding"
import { useProjects } from "@/projects"
import { useShellRoute } from "./router"

export function FirstRunRedirect(): JSX.Element {
  const routing = useShellRoute()
  const projects = useProjects()
  createEffect(() => {
    if (routing.route().kind === "home" && onboardingNeeded(projects())) routing.navigate(onboardingPath, { replace: true })
  })
  return null
}
