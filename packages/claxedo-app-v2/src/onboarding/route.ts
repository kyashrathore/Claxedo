import type { Component } from "solid-js"
import type { PageProps } from "@/shell/types"

export type RouteEntry = {
  readonly id: string
  readonly path: string
  readonly view: Component<PageProps>
}

export const onboardingPath = "/welcome"
