import type { Accessor } from "solid-js"
import type { Project } from "@/server"

export type ProjectsState = { readonly kind: "loading" } | { readonly kind: "ready" } | { readonly kind: "failed"; readonly message: string }

export type ProjectsView = {
  readonly state: Accessor<ProjectsState>
  readonly projects: Accessor<readonly Project[]>
}

export function useProjects(): ProjectsView {
  return { state: () => ({ kind: "ready" }), projects: () => [] }
}
