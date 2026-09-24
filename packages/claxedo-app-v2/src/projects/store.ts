import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { AppError, Machine, Placement, Project, ProjectId } from "@/server"
import { useProjectsServer } from "./api"

export type Loaded<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: T }
  | { readonly kind: "failed"; readonly error: AppError }

export type ProjectView =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly project: Project }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly error: AppError }

type QueryLike<T> = { readonly data: T | undefined; readonly error: AppError | null; readonly isPending: boolean }

function loaded<T>(query: QueryLike<T>): Loaded<T> {
  if (query.data !== undefined) return { kind: "ready", data: query.data }
  if (query.error) return { kind: "failed", error: query.error }
  return { kind: "loading" }
}

export function useProjects(): Accessor<Loaded<readonly Project[]>> {
  const server = useProjectsServer()
  const query = useQuery(() => server.queries.projects.list())
  return createMemo(() => loaded(query))
}

export function useProject(id: Accessor<ProjectId>): Accessor<ProjectView> {
  const server = useProjectsServer()
  const query = useQuery(() => server.queries.projects.byId(id()))
  return createMemo((): ProjectView => {
    const state = loaded(query)
    if (state.kind === "ready") return { kind: "ready", project: state.data }
    if (state.kind === "failed" && state.error.class === "not_found") return { kind: "missing" }
    return state
  })
}

export function useProjectPlacements(projectId: Accessor<ProjectId>): Accessor<Loaded<readonly Placement[]>> {
  const server = useProjectsServer()
  const query = useQuery(() => server.queries.placements.byProject(projectId()))
  return createMemo(() => loaded(query))
}

export function useMachines(): Accessor<Loaded<readonly Machine[]>> {
  const server = useProjectsServer()
  const query = useQuery(() => server.queries.machines.list())
  return createMemo(() => loaded(query))
}

export function useProjectCommands() {
  const server = useProjectsServer()
  return {
    rename: (id: ProjectId, name: string) => server.projects.update(id, { name }),
    remove: (id: ProjectId) => server.projects.remove(id),
  }
}
