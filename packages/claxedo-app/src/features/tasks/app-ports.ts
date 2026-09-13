import type { Accessor, JSX } from "solid-js"
import type { SessionReference } from "@claxedo/tasks"
import type { TasksPage } from "@/platform/identity/route"
import type { CapabilityCatalogReader, ConfigurationEditor, ProseEditor } from "@claxedo/tasks/solid"

export type TasksProjectOption = { id: string; label: string }

/** The server and the cache partition a Tasks read belongs to. */
export type TasksScope = { serverUrl: string; scopeId: string }

/**
 * What the app supplies to the Tasks feature.
 *
 * Hooks rather than values: the harness/model/effort control, the installed
 * capability catalog, the project inventory and canonical session navigation
 * are owned by other features, which a feature may not import at runtime.
 * `app/integrations/tasks` binds them, and the feature calls them inside its
 * own reactive scope.
 */
export type TasksAppPorts = {
  useScope: () => Accessor<TasksScope>
  request: (input: string, init?: RequestInit) => Promise<Response>
  useProjects: () => Accessor<readonly TasksProjectOption[]>
  useActiveProjectId: () => Accessor<string | undefined>
  useCapabilityCatalog: () => CapabilityCatalogReader
  ConfigurationEditor: ConfigurationEditor
  /** The Documents rich editor: task descriptions and preset instructions are markdown prose. */
  ProseEditor: ProseEditor
  useOpenSession: () => (session: SessionReference) => void
  /** Navigates the Tasks tab between its list and a task. */
  useOpenPage: () => (page?: TasksPage) => void
  /** Presets live in Settings; a feature may not import the dialog that holds them. */
  openPresetSettings: (dialog: { show: (element: () => JSX.Element) => unknown }) => void
}

let ports: TasksAppPorts | undefined

export function configureTasksAppPorts(value: TasksAppPorts) {
  ports = value
}

export function useTasksAppPorts(): TasksAppPorts {
  if (!ports) throw new Error("Tasks app ports are not configured")
  return ports
}
