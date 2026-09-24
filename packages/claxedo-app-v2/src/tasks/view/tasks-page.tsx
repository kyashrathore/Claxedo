import { Show, createEffect, type JSX } from "solid-js"
import type { PageProps } from "@/shell"
import { useActiveProjectId, useOpenTasksPage, useTaskProjects } from "../links"
import { createTasksStore } from "../store"
import { TaskDetailPage } from "./task-detail-page"
import { TasksView } from "./tasks-view"
import "./tasks.css"

export function TasksPage(props: PageProps): JSX.Element {
  const projects = useTaskProjects()
  const activeProjectId = useActiveProjectId()
  const openPage = useOpenTasksPage()
  const store = createTasksStore()
  const projectId = () => store.state.projectId ?? activeProjectId() ?? projects()[0]?.id ?? ""
  const taskId = () => props.params.taskId
  createEffect(() => store.selectTask(taskId()))
  return (
    <Show when={taskId()} fallback={<TasksView store={store} projectId={projectId} onOpenTask={openPage} />}>
      {(id) => (
        <TaskDetailPage
          store={store}
          taskId={id()}
          onOpenTask={openPage}
          onBack={() => openPage()}
          onOpenProject={(projectId) => {
            store.setProjectId(projectId)
            openPage()
          }}
        />
      )}
    </Show>
  )
}
