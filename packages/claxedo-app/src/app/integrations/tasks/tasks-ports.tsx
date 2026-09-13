import { createMemo, lazy } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useLocation } from "@solidjs/router"
import { useShellQueryOptions } from "@/app/integrations/sync/query-options"
import type { TasksAppPorts, TasksProjectOption } from "@/features/tasks/app-ports"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { principalDataScope, usePrincipal } from "@/platform/auth/identity-provider"
import { shellRouteDirectoryFromPathname } from "@/platform/identity/route"
import { useCapabilityCatalog } from "./capability-catalog"
import { useOpenTaskSession } from "./open-task-session"
import { useOpenTasksPage } from "./open-tasks-page"
import type { ConfigurationEditorProps, ProseEditorProps } from "@claxedo/tasks/solid"

/**
 * The configuration control arrives with the Tasks chunk, not with the shell:
 * it pulls the composer's harness and provider catalogs, which nothing else on
 * this path needs until a preset is actually being edited.
 */
const PresetConfigurationEditor = lazy(() =>
  import("./preset-configuration-editor").then((module) => ({ default: module.PresetConfigurationEditor })),
)

/**
 * The Documents rich editor arrives with the Tasks chunk rather than the shell:
 * Tiptap and ProseMirror are the largest thing this surface pulls, and nothing
 * on the path to a task list needs them until a description is on screen.
 */
const TasksProseEditor = lazy(() =>
  import("./tasks-prose-editor").then((module) => ({ default: module.TasksProseEditor })),
)

export function useTasksProjectsPort() {
  const queryOptions = useShellQueryOptions()
  const projects = useQuery(() => queryOptions.projects())
  return createMemo<readonly TasksProjectOption[]>(() =>
    (projects.data ?? []).map((project) => ({ id: project.id, label: project.name ?? project.worktree })),
  )
}

export function useTasksActiveProjectIdPort() {
  const queryOptions = useShellQueryOptions()
  const projects = useQuery(() => queryOptions.projects())
  const location = useLocation()
  return createMemo(() => {
    const scope = shellRouteDirectoryFromPathname(location.pathname)
    if (!scope) return undefined
    return (projects.data ?? []).find((project) => project.worktree === scope || project.id === scope)?.id
  })
}

export function useTasksScopePort() {
  const principal = usePrincipal()
  return createMemo(() => ({
    serverUrl: getClaxedoServerUrl(),
    // `null` while a signed principal has no resolved subject: that is not a
    // scope, and serving the previous one would leak the last account's tasks.
    scopeId: principalDataScope(principal()) ?? "unresolved",
  }))
}

/** Bound once from the shell's secondary port wiring, before the shell renders. */
export function tasksAppPorts(): TasksAppPorts {
  return {
    useScope: useTasksScopePort,
    request: (input, init) => authFetch(input, init),
    useProjects: useTasksProjectsPort,
    useActiveProjectId: useTasksActiveProjectIdPort,
    useCapabilityCatalog,
    ConfigurationEditor: (props: ConfigurationEditorProps) => PresetConfigurationEditor(props),
    ProseEditor: (props: ProseEditorProps) => TasksProseEditor(props),
    useOpenSession: useOpenTaskSession,
    useOpenPage: useOpenTasksPage,
  }
}
