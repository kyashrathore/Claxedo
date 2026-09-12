import { For, Show, createSignal } from "solid-js"
import { TASK_STATUSES, type TaskStatus, type TaskSummary } from "../contracts"
import { StatusMenu } from "./status-menu"
import { TASK_STATUS_LABELS } from "./view-model"

export type TaskBoardProps = {
  tasks: readonly TaskSummary[]
  selectedTaskId?: string
  busyTaskId?: string
  onSelect: (taskId: string) => void
  onStatusChange: (input: { taskId: string; revision: number; status: TaskStatus }) => void
}

/**
 * Status columns with a per-card status menu. Drag is an accelerator layered
 * on top of that menu, never the only way to move a card: the menu is what a
 * keyboard and a screen reader use, and it is present on every card.
 */
export function TaskBoard(props: TaskBoardProps) {
  const [dragging, setDragging] = createSignal<string | undefined>()
  const column = (status: TaskStatus) => props.tasks.filter((task) => task.status === status)
  const drop = (status: TaskStatus) => {
    const id = dragging()
    setDragging(undefined)
    if (!id) return
    const task = props.tasks.find((candidate) => candidate.id === id)
    if (!task || task.status === status) return
    props.onStatusChange({ taskId: task.id, revision: task.revision, status })
  }

  return (
    <div class="tsk tsk-board" data-testid="tasks-board">
      <For each={TASK_STATUSES}>
        {(status) => (
          <section
            class="tsk-column"
            data-testid={`tasks-board-column-${status}`}
            aria-label={TASK_STATUS_LABELS[status]}
            onDragOver={(event) => {
              if (dragging()) event.preventDefault()
            }}
            onDrop={(event) => {
              event.preventDefault()
              drop(status)
            }}
          >
            <header class="tsk-row tsk-spread">
              <h3 class="tsk-section-title">{TASK_STATUS_LABELS[status]}</h3>
              <span class="tsk-muted">{column(status).length}</span>
            </header>
            <For each={column(status)} fallback={<p class="tsk-muted">Empty</p>}>
              {(task) => (
                <div
                  class="tsk-card"
                  data-testid={`tasks-board-card-${task.id}`}
                  draggable={task.archivedAt === null}
                  onDragStart={() => setDragging(task.id)}
                  onDragEnd={() => setDragging(undefined)}
                >
                  <button
                    type="button"
                    class="tsk-item-title"
                    data-testid={`tasks-board-open-${task.id}`}
                    aria-current={props.selectedTaskId === task.id ? "true" : undefined}
                    onClick={() => props.onSelect(task.id)}
                  >
                    {task.title}
                  </button>
                  <Show when={task.parentTaskId}>
                    <span class="tsk-muted">Subtask</span>
                  </Show>
                  <StatusMenu
                    status={task.status}
                    disabled={props.busyTaskId === task.id || task.archivedAt !== null}
                    label={`Status of ${task.title}`}
                    testId={`tasks-board-status-${task.id}`}
                    onChange={(next) => props.onStatusChange({ taskId: task.id, revision: task.revision, status: next })}
                  />
                </div>
              )}
            </For>
          </section>
        )}
      </For>
    </div>
  )
}
