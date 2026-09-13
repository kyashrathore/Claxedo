import { Dialog } from "@opencode-ai/ui/dialog"
import type { ConfigurationSlot, Task } from "@claxedo/tasks"
import type { TasksScope } from "../../data/queries"
import type { TasksStore } from "../../store/tasks-store"
import { StartTaskFlow } from "./start-task-flow"

export type DialogStartTaskProps = {
  store: TasksStore
  scope: () => TasksScope
  task: Task
  slot: ConfigurationSlot
  attempt: number
  onClose: () => void
}

export function DialogStartTask(props: DialogStartTaskProps) {
  return (
    <Dialog title="Start task" size="large">
      <StartTaskFlow
        store={props.store}
        scope={props.scope}
        task={props.task}
        slot={props.slot}
        attempt={props.attempt}
        onClose={props.onClose}
      />
    </Dialog>
  )
}
