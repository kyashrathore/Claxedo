import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { SessionReference } from "@claxedo/tasks"
import { placementId, sessionId, useServer } from "@/server"
import { localSessionPath, sessionPath, settingsPath, useShellRoute } from "@/shell"

export type TaskProject = { readonly id: string; readonly label: string }

export const TASKS_PAGE_PATH = "/tasks/:taskId?"

export function useTaskProjects(): Accessor<readonly TaskProject[]> {
  const server = useServer()
  const projects = useQuery(() => server.queries.projects.list())
  return createMemo(() => (projects.data ?? []).map((project) => ({ id: project.id, label: project.name })))
}

export function useActiveProjectId(): Accessor<string | undefined> {
  const server = useServer()
  const route = useShellRoute()
  const placements = useQuery(() => server.queries.placements.list())
  return createMemo(() => {
    const id = route.placementId()
    return id === undefined ? undefined : placements.data?.find((placement) => placement.id === id)?.projectId
  })
}

export function useOpenTaskSession() {
  const route = useShellRoute()
  return (session: SessionReference) => {
    const workspace = session.workspaceId
    const id = sessionId(session.sessionId)
    route.navigate(
      workspace ? sessionPath({ placementId: placementId(workspace), sessionId: id }) : localSessionPath(id),
    )
  }
}

export function useOpenTasksPage() {
  const route = useShellRoute()
  return (taskId?: string) => route.navigate(taskId ? `/tasks/${encodeURIComponent(taskId)}` : "/tasks")
}

export const PRESETS_SECTION_ID = "tasks-presets"

export function useOpenPresetSettings() {
  const route = useShellRoute()
  return () => route.navigate(settingsPath(PRESETS_SECTION_ID))
}
