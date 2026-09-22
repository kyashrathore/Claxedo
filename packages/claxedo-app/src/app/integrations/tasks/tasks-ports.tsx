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
import { TASKS_PRESETS_SETTINGS_TAB } from "./settings-section"
import { useNavigate } from "@solidjs/router"
import { settingsRoute } from "@/platform/settings/route"
import { usePaneCtx } from "@/app/workbench/context/pane-ctx"
import type { ConfigurationEditorProps } from "@/features/tasks/preset-editor-model"
import type { ProseEditorProps } from "@/features/tasks/app-ports"

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

export function useTasksScopePort() {
  const principal = usePrincipal()
  return createMemo(() => ({
    serverUrl: getClaxedoServerUrl(),
    // `null` while a signed principal has no resolved subject: that is not a
    // scope, and serving the previous one would leak the last account's tasks.
    scopeId: principalDataScope(principal()) ?? "unresolved",
  }))
}

/** The installed capabilities, read in the scope this principal reads Tasks in. */
export function useCapabilityCatalogPort() {
  return useCapabilityCatalog(useTasksScopePort())
}

/**
 * Sends a Start control to the preset catalog.
 *
 * A hook rather than a plain function: `tasksAppPorts()` is built at
 * contribution time, outside any component, so the navigation has to be
 * resolved where it is used. The destination is the settings section Tasks
 * contributed, which the shell draws without unmounting the caller.
 */
export function useOpenPresetSettings() {
  const navigate = useNavigate()
  return () => navigate(settingsRoute(TASKS_PRESETS_SETTINGS_TAB))
}

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

/** Bound once from the shell's secondary port wiring, before the shell renders. */
export function tasksAppPorts(): TasksAppPorts {
  return {
    useScope: useTasksScopePort,
    request: (input, init) => authFetch(input, init),
    useProjects: useTasksProjectsPort,
    useActiveProjectId: useTasksActiveProjectIdPort,
    useCapabilityCatalog: useCapabilityCatalogPort,
    ConfigurationEditor: (props: ConfigurationEditorProps) => PresetConfigurationEditor(props),
    ProseEditor: (props: ProseEditorProps) => TasksProseEditor(props),
    useOpenSession: useOpenTaskSession,
    useOpenPage: useOpenTasksPage,
    useOpenPresetSettings,
    usePaneCtx,
  }
}
