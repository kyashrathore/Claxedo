import { For, Show, createMemo, createSignal } from "solid-js"
import { TASKS_BOUNDS, type TaskStatus, type TaskSummary } from "../contracts"
import { LoadMore, type MorePages } from "./load-more"
import { StatusMenu } from "./status-menu"

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
  const [adding, setAdding] = createSignal(false)
  const done = createMemo(() => props.items.filter((child) => child.status === "done").length)
  const cancel = () => {
    setTitle("")
    setAdding(false)
  }
  const submit = () => {
    const value = title().trim()
    if (!value) return
    props.onAdd(value)
    setTitle("")
  }

  return (
    <section class="tsk tsk-stack" data-testid="task-subtasks" aria-label="Subtasks">
      <div class="tsk-row tsk-spread">
        <h3 class="tsk-section-title">Subtasks</h3>
        <Show when={props.items.length > 0}>
          <span class="tsk-cell tsk-num">
            {done()}/{props.items.length}
          </span>
        </Show>
      </div>

      <Show when={props.items.length > 0}>
        <div class="tsk-progress">
          <i style={{ width: `${Math.round((done() / props.items.length) * 100)}%` }} />
        </div>
      </Show>

      <div>
        <For each={props.items} fallback={<p class="tsk-hint">No subtasks yet.</p>}>
          {(child) => (
            <div class="tsk-checklist-row">
              <button
                type="button"
                class="tsk-check"
                data-done={child.status === "done" ? "true" : undefined}
                data-testid={`task-subtask-${child.id}`}
                onClick={() => props.onOpen(child.id)}
              >
                <span class="tsk-open-name">{child.title}</span>
              </button>
              <Show when={child.archivedAt === null} fallback={<span class="tsk-cell">Archived</span>}>
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

      <Show
        when={props.canAdd}
        fallback={<p class="tsk-hint">{props.addDisabledReason ?? "Reopen this task to add a subtask."}</p>}
      >
        {/* A placeholder in an always-present field reads as a hint, not as a
            control. The row is a button until it is pressed. */}
        <Show
          when={adding()}
          fallback={
            <button
              type="button"
              class="tsk-add-trigger"
              data-testid="task-subtask-add-trigger"
              onClick={() => setAdding(true)}
            >
              <span aria-hidden="true">+</span> Add subtask
            </button>
          }
        >
          <form
            class="tsk-add"
            data-testid="task-subtask-add"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <input
              ref={(element) => queueMicrotask(() => element.focus())}
              class="tsk-input"
              data-testid="task-subtask-title"
              aria-label="Subtask title"
              maxLength={TASKS_BOUNDS.taskTitleMax}
              placeholder="What needs doing"
              value={title()}
              onInput={(event) => setTitle(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return
                event.stopPropagation()
                cancel()
              }}
            />
            <button type="submit" class="tsk-button" disabled={props.busy || title().trim().length === 0}>
              Add
            </button>
          </form>
        </Show>
      </Show>

      <Show when={props.error}>{(message) => <p class="tsk-error">{message()}</p>}</Show>
    </section>
  )
}
