import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { ConfigurationSlot, Task } from "@claxedo/tasks"
import type { TasksScope } from "../data/queries"
import type { TasksStore } from "../store/tasks-store"
import { DialogStartTask } from "./dialogs/start-task-dialog"
import { TaskDetailPanel } from "./task-detail-panel"

export type TaskDetailPageProps = {
  store: TasksStore
  scope: () => TasksScope
  taskId: string
  onOpenTask: (taskId: string) => void
  onBack: () => void
}

/** `/tasks/<taskId>`: the task as its own page, with the Start dialog it owns. */
export function TaskDetailPage(props: TaskDetailPageProps) {
  const dialog = useDialog()

  const openStart = (input: { task: Task; slot: ConfigurationSlot; attempt: number }) =>
    void dialog.show(() => (
      <DialogStartTask
        store={props.store}
        scope={props.scope}
        task={input.task}
        slot={input.slot}
        attempt={input.attempt}
        onClose={() => dialog.close()}
      />
    ))

  return (
    <div class="tsk tsk-root" data-testid="task-detail-page">
      <TaskDetailPanel
        store={props.store}
        scope={props.scope}
        taskId={props.taskId}
        onStart={openStart}
        onOpenTask={props.onOpenTask}
        onBack={props.onBack}
      />
    </div>
  )
}
