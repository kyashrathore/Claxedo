import { For, Show, createSignal } from "solid-js"
import { useTasksAppPorts } from "../app-ports"
import { useTasksScope } from "../data/queries"
import { createTasksStore } from "../store/tasks-store"
import { PresetsView } from "./presets-view"
import { TasksView } from "./tasks-view"

const VIEWS = [
  { id: "tasks", label: "Tasks" },
  { id: "presets", label: "Presets" },
] as const

type SurfaceView = (typeof VIEWS)[number]["id"]

/**
 * The Tasks content surface: the task catalog and the personal preset catalog,
 * side by side under one tab. One store spans both so an inline preset created
 * from the Start dialog lands in the same catalog the Presets view lists.
 */
export function TasksSurface() {
  const ports = useTasksAppPorts()
  const projects = ports.useProjects()
  const activeProjectId = ports.useActiveProjectId()
  const scope = useTasksScope()
  // The project a task read belongs to: the user's explicit choice, else the
  // one the app is already showing, else the first the inventory knows.
  const store = createTasksStore()
  const projectId = () => store.state.projectId ?? activeProjectId() ?? projects()[0]?.id ?? ""
  const [view, setView] = createSignal<SurfaceView>("tasks")

  return (
    <div class="tsk tsk-stack tsk-root" data-testid="tasks-surface">
      <div class="tsk-toolbar" role="tablist" aria-label="Tasks and presets">
        <For each={VIEWS}>
          {(entry) => (
            <button
              type="button"
              role="tab"
              class="tsk-button"
              data-testid={`tasks-surface-tab-${entry.id}`}
              data-variant={view() === entry.id ? "primary" : undefined}
              aria-selected={view() === entry.id}
              onClick={() => setView(entry.id)}
            >
              {entry.label}
            </button>
          )}
        </For>
      </div>

      <Show when={view() === "tasks"} fallback={<PresetsView store={store} scope={scope} />}>
        <TasksView store={store} scope={scope} projectId={projectId} />
      </Show>
    </div>
  )
}
