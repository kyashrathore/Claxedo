import { Match, Switch, createEffect, createMemo } from "solid-js"
import type { TasksPage } from "@/platform/identity/route"
import { useTasksAppPorts } from "../app-ports"
import { useTasksScope } from "../data/queries"
import { createTasksStore } from "../store/tasks-store"
import { PresetsView } from "./presets-view"
import { TaskDetailPage } from "./task-detail-page"
import { TasksView } from "./tasks-view"

export type TasksSurfaceProps = {
  /** The nested page the URL names; absent is the task list. */
  page?: () => TasksPage | undefined
}

/**
 * The Tasks content surface: one tab whose page comes from the URL.
 *
 * The store spans every page so an inline preset created from the Start dialog
 * lands in the same catalog the Presets page lists, and so returning to the
 * list finds the filters the user left there.
 */
export function TasksSurface(props: TasksSurfaceProps) {
  const ports = useTasksAppPorts()
  const projects = ports.useProjects()
  const activeProjectId = ports.useActiveProjectId()
  const openPage = ports.useOpenPage()
  const scope = useTasksScope()
  // The project a task read belongs to: the user's explicit choice, else the
  // one the app is already showing, else the first the inventory knows.
  const store = createTasksStore()
  const projectId = () => store.state.projectId ?? activeProjectId() ?? projects()[0]?.id ?? ""
  const page = createMemo(() => props.page?.())
  // The URL owns which task is open; the store carries it so the list marks
  // the row a Back returns to.
  createEffect(() => {
    const current = page()
    store.selectTask(current?.kind === "task" ? current.taskId : undefined)
  })

  return (
    <Switch
      fallback={
        <TasksView
          store={store}
          scope={scope}
          projectId={projectId}
          onOpenTask={(taskId) => openPage({ kind: "task", taskId })}
          onOpenPresets={() => openPage({ kind: "presets" })}
        />
      }
    >
      <Match when={pageOf(page(), "task")}>
        {(task) => (
          <TaskDetailPage
            store={store}
            scope={scope}
            taskId={task().taskId}
            onOpenTask={(taskId) => openPage({ kind: "task", taskId })}
            onBack={() => openPage()}
            onOpenProject={(projectId) => {
              store.setProjectId(projectId)
              openPage()
            }}
          />
        )}
      </Match>
      <Match when={page()?.kind === "presets" || page()?.kind === "preset"}>
        <PresetsView
          store={store}
          scope={scope}
          presetId={() => {
            const current = page()
            return current?.kind === "preset" ? current.presetId : undefined
          }}
          onOpenPreset={(presetId) => openPage(presetId ? { kind: "preset", presetId } : { kind: "presets" })}
          onOpenTasks={() => openPage()}
        />
      </Match>
    </Switch>
  )
}

function pageOf(page: TasksPage | undefined, kind: "task") {
  return page?.kind === kind ? page : undefined
}
