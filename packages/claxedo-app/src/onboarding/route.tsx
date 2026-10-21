import { createEffect, type JSX } from "solid-js"
import { loadAccountsTranslations, loadOnboardingAccountViews } from "@/accounts"
import { useTranslatedLazyView } from "@/i18n"
import { loadUsageTranslations } from "@/usage"
import { loadProjectCreate } from "@/projects"
import { useServer } from "@/server"
import type { PageProps, RouteEntry } from "@/shell"
import { prefetchOnboardingReads } from "./prefetch"

export const onboardingPath = "/welcome"

const loadFirstProjectCanvas = () => Promise.all([import("./view/first-project-canvas"), loadOnboardingAccountViews(), loadProjectCreate()]).then(([module]) => module.FirstProjectCanvas)

const onboardingTranslations = () => Promise.all([loadAccountsTranslations(), loadUsageTranslations()])

function OnboardingRoute(props: PageProps): JSX.Element {
  const server = useServer()
  const FirstProjectCanvas = useTranslatedLazyView(loadFirstProjectCanvas, onboardingTranslations)
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
