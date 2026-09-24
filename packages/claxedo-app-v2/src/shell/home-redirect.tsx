import { createEffect, type JSX } from "solid-js"
import { onboardingNeeded } from "@/onboarding"
import { useProjects } from "@/projects"
import { useActivePlacement } from "./active-placement"
import { useShellRoute } from "./router"
import { draftPath } from "./routes"

export function HomeRedirect(): JSX.Element {
  const routing = useShellRoute()
  const projects = useProjects()
  const active = useActivePlacement()
  createEffect(() => {
    if (routing.route().kind !== "home") return
    if (onboardingNeeded(projects())) return
    const placement = active()
    if (placement) routing.navigate(draftPath(placement), { replace: true })
  })
  return null
}
