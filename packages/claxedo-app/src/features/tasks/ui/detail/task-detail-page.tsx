import type { TasksScope } from "../../data/queries"
import type { TasksStore } from "../../store/tasks-store"
import { TaskDetailPanel } from "./task-detail-panel"

export type TaskDetailPageProps = {
  store: TasksStore
  scope: () => TasksScope
  taskId: string
  onOpenTask: (taskId: string) => void
  onBack: () => void
  onOpenProject: (projectId: string) => void
}

/** `/tasks/<taskId>`: the task as its own page. */
export function TaskDetailPage(props: TaskDetailPageProps) {
  return (
    <div class="tsk tsk-root" data-testid="task-detail-page">
      <TaskDetailPanel
        store={props.store}
        scope={props.scope}
        taskId={props.taskId}
        onOpenTask={props.onOpenTask}
        onBack={props.onBack}
        onOpenProject={props.onOpenProject}
      />
    </div>
  )
}
