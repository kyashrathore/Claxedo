import type { Accessor, JSX } from "solid-js"
import type { SessionReference } from "@claxedo/tasks"
import type { TasksPage } from "@/platform/identity/route"
import type * as PaneCtxModule from "@/app/workbench/context/pane-ctx"
import type { ConfigurationEditor } from "./preset-editor-model"
import type { CapabilityCatalogReader } from "./view-model"

export type TasksProjectOption = { id: string; label: string }

/**
 * The Documents rich editor, as a component the app supplies.
 *
 * Markdown crosses this boundary in both directions — `value` is the stored
 * string and `onChange` is handed the same — so whichever surface the app
 * mounts, the record stays markdown. A component rather than a value because
 * the editor belongs to another feature, which this one may not import.
 */
export type ProseEditorProps = {
  value: string
  placeholder: string
  ariaLabel: string
  /** Carried onto whichever control the app mounts, so a test can find the field. */
  testId: string
  onChange: (markdown: string) => void
}

export type ProseEditor = (props: ProseEditorProps) => JSX.Element


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
  /** Resolved where it is used: the destination is a route, and a route needs the router. */
  useOpenPresetSettings: () => () => void
  /** The workbench slot a Tasks surface renders in; keys with no focus arrive through it. */
  usePaneCtx: typeof PaneCtxModule.usePaneCtx
}

let ports: TasksAppPorts | undefined

export function configureTasksAppPorts(value: TasksAppPorts) {
  ports = value
}

export function useTasksAppPorts(): TasksAppPorts {
  if (!ports) throw new Error("Tasks app ports are not configured")
  return ports
}
