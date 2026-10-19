import type { PluginApi, ProjectSummary, SessionRef, WorkspaceStartResult } from "@claxedo/plugin-api"
import type { TasksClient } from "../../client/client"
import type { Translate } from "../dictionary"
import type { SurfaceSync } from "../surface/sync"
import type { PageState } from "./state"

export type PageDeps = {
  readonly client: TasksClient
  readonly t: Translate
  readonly ui: PluginApi["ui"]
  readonly openPage: (params?: Readonly<Record<string, string>>) => void
  readonly openPresets: () => void
  readonly openSession: (session: SessionRef) => Promise<void>
  readonly followStart: (workspaceId: string, onProgress: (text: string | undefined) => void) => Promise<WorkspaceStartResult>
  readonly projects: () => readonly ProjectSummary[]
  readonly currentProjectId: () => string | undefined
  readonly watchProjects: (changed: () => void) => void
  readonly requestId: () => string
  readonly now: () => number
}

export type PageModel = {
  readonly deps: PageDeps
  readonly sync: SurfaceSync
  readonly state: () => PageState
  readonly patch: (change: Partial<PageState> | ((state: PageState) => Partial<PageState>)) => void
  readonly projectId: () => string | undefined
}

export function projectIdOf(deps: Pick<PageDeps, "projects" | "currentProjectId">, state: PageState): string | undefined {
  const projects = deps.projects()
  const known = (id: string | undefined) => (id !== undefined && projects.some((project) => project.id === id) ? id : undefined)
  return known(state.chosenProjectId) ?? known(deps.currentProjectId()) ?? projects[0]?.id
}
