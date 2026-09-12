import { For, Show, createSignal } from "solid-js"
import { TASKS_BOUNDS, type TaskStatus, type TaskSummary } from "../contracts"
import { LoadMore, type MorePages } from "./load-more"
import { TaskStatusChip, StatusMenu } from "./status-menu"

export type TaskSubtasksProps = {
  /** Not named `children`: Solid gives that prop name its own resolution semantics. */
  items: readonly TaskSummary[]
  /** False while the parent is Done or archived: a child cannot be added under a closed parent. */
  canAdd: boolean
  addDisabledReason?: string
  busy?: boolean
  error?: string
  more?: MorePages
  onOpen: (taskId: string) => void
  onAdd: (title: string) => void
  onStatusChange: (input: { taskId: string; revision: number; status: TaskStatus }) => void
}

export function TaskSubtasks(props: TaskSubtasksProps) {
  const [title, setTitle] = createSignal("")
  const submit = () => {
    const value = title().trim()
    if (!value) return
    props.onAdd(value)
    setTitle("")
  }

  return (
    <section class="tsk tsk-stack" data-testid="task-subtasks" aria-label="Subtasks">
      <h3 class="tsk-section-title">Subtasks</h3>
      <div class="tsk-surface">
        <For each={props.items} fallback={<p class="tsk-empty">No subtasks.</p>}>
          {(child) => (
            <div class="tsk-row">
              <button
                type="button"
                class="tsk-item"
                data-testid={`task-subtask-${child.id}`}
                onClick={() => props.onOpen(child.id)}
              >
                <span class="tsk-item-title">{child.title}</span>
                <Show when={child.archivedAt !== null} fallback={<TaskStatusChip status={child.status} />}>
                  <span class="tsk-muted">Archived</span>
                </Show>
              </button>
              <Show when={child.archivedAt === null}>
                <StatusMenu
                  status={child.status}
                  disabled={props.busy}
                  label={`Status of ${child.title}`}
                  testId={`task-subtask-status-${child.id}`}
                  onChange={(status) => props.onStatusChange({ taskId: child.id, revision: child.revision, status })}
                />
              </Show>
            </div>
          )}
        </For>
      </div>
      <LoadMore more={props.more} testId="task-subtasks-load-more" />
      <Show when={props.canAdd} fallback={<p class="tsk-muted">{props.addDisabledReason ?? "Reopen this task to add a subtask."}</p>}>
        <form
          class="tsk-row"
          data-testid="task-subtask-add"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <input
            class="tsk-input"
            data-testid="task-subtask-title"
            aria-label="Subtask title"
            maxLength={TASKS_BOUNDS.taskTitleMax}
            placeholder="Add a subtask"
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
          <button type="submit" class="tsk-button" disabled={props.busy || title().trim().length === 0}>
            Add
          </button>
        </form>
      </Show>
      <Show when={props.error}>{(message) => <p class="tsk-error">{message()}</p>}</Show>
    </section>
  )
}
