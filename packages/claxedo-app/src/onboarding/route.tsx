import { createEffect, type JSX } from "solid-js"
import { loadOnboardingAccountViews } from "@/accounts"
import { loadProjectCreate } from "@/projects"
import { lazyView } from "@/lib/lazy-view"
import { useServer } from "@/server"
import type { PageProps, RouteEntry } from "@/shell"
import { prefetchOnboardingReads } from "./prefetch"

export const onboardingPath = "/welcome"

const FirstProjectCanvas = lazyView(() => Promise.all([import("./view/first-project-canvas"), loadOnboardingAccountViews(), loadProjectCreate()]).then(([module]) => module.FirstProjectCanvas))

function OnboardingRoute(props: PageProps): JSX.Element {
  const server = useServer()
  let prefetched = false
  createEffect(() => {
    const capabilities = server.capabilities()
    if (!capabilities || prefetched) return
    prefetched = true
    prefetchOnboardingReads(server, capabilities)
  })
  return <FirstProjectCanvas params={props.params} />
}

export const onboardingRoute: RouteEntry = { id: "onboarding", path: onboardingPath, view: OnboardingRoute, requiresSignIn: true }
