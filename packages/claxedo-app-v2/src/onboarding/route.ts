import type { Component } from "solid-js"
import type { PageProps } from "@/shell/types"
import { OnboardingPage } from "./view/onboarding-page"

export type RouteEntry = {
  readonly id: string
  readonly path: string
  readonly view: Component<PageProps>
}

export const onboardingPath = "/welcome"

export const onboardingRoute: RouteEntry = { id: "onboarding", path: onboardingPath, view: OnboardingPage }
