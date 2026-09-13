import { For, Show, createMemo, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { TASKS_BOUNDS, type TaskStatus, type TaskSummary } from "@claxedo/tasks"
import { LoadMore, type MorePages } from "../shared/load-more"
import { StatusControl } from "../shared/status-control"

export type TaskSubtasksProps = {
  /** Not named `children`: Solid gives that prop name its own resolution semantics. */
  items: readonly TaskSummary[]
  /** False while the parent is Done or archived: a child cannot be added under a closed parent. */
  canAdd: boolean
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
    <section class="tsk-subtasks" data-testid="task-subtasks" aria-label="Subtasks">
      <div class="tsk-subtasks-head">
        <h3 class="tsk-section-title">Subtasks</h3>
        {/* 0/0 counts nothing; the add row below is the whole of an empty section. */}
        <Show when={props.items.length > 0}>
          <span class="tsk-count">
            {done()}/{props.items.length}
          </span>
        </Show>
      </div>

      <For each={props.items}>
        {(child) => (
          <div class="tsk-subtask">
            <button
              type="button"
              class="tsk-subtask-open"
              data-done={child.status === "done" ? "true" : undefined}
              data-testid={`task-subtask-${child.id}`}
              onClick={() => props.onOpen(child.id)}
            >
              {child.title}
            </button>
            <Show when={child.archivedAt === null} fallback={<span class="tsk-cell">Archived</span>}>
              <StatusControl
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

      <LoadMore more={props.more} testId="task-subtasks-load-more" />

      <Show
        when={props.canAdd}
        fallback={<p class="tsk-hint">Reopen this task to add a subtask.</p>}
      >
        {/* A placeholder in an always-present field reads as a hint, not as a
            control. The row is a link until it is pressed. */}
        <Show
          when={adding()}
          fallback={
            <button
              type="button"
              class="tsk-add-trigger"
              data-testid="task-subtask-add-trigger"
              onClick={() => setAdding(true)}
            >
              <Icon name="plus-small" size="small" />
              Add a subtask
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
            <TextField
              ref={(element: HTMLInputElement) => queueMicrotask(() => element.focus())}
              data-testid="task-subtask-title"
              aria-label="Subtask title"
              maxLength={TASKS_BOUNDS.taskTitleMax}
              placeholder="What needs doing"
              value={title()}
              onChange={setTitle}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key !== "Escape") return
                event.stopPropagation()
                cancel()
              }}
            />
            <Button type="submit" size="small" disabled={props.busy || title().trim().length === 0}>
              Add
            </Button>
          </form>
        </Show>
      </Show>

      <Show when={props.error}>{(message) => <p class="tsk-error">{message()}</p>}</Show>
    </section>
  )
}
