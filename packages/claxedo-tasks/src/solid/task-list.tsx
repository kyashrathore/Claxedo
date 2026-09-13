import { For, Show, createMemo } from "solid-js"
import { TASK_STATUSES, type TaskStatus, type TaskSummary } from "../contracts"
import { LoadMore, type MorePages } from "./load-more"
import { TaskGlyph } from "./glyphs"
import { TaskStatusDot, StatusMenu } from "./status-menu"
import { TASK_STATUS_LABELS, shortAge } from "./view-model"

/** How many of a task's children are done, out of the children the caller holds. */
export type SubtaskProgress = { done: number; total: number }

export type TaskListProps = {
  /** Flat and already filtered: this renders the rows it is given, in status groups. */
  tasks: readonly TaskSummary[]
  selectedTaskId?: string
  loading?: boolean
  emptyLabel?: string
  /** Grouping is presentational, so a caller showing one status can turn it off. */
  grouped?: boolean
  /** The parent's title for a subtask row, from the rows the caller already holds. */
  parentTitleOf?: (task: TaskSummary) => string | undefined
  subtaskProgress?: (taskId: string) => SubtaskProgress | undefined
  more?: MorePages
  onSelect: (taskId: string) => void
  onCreate?: () => void
  onStatusChange?: (input: { taskId: string; revision: number; status: TaskStatus }) => void
  busyTaskId?: string
}

export function TaskList(props: TaskListProps) {
  const groups = createMemo(() => {
    if (props.grouped === false) return [{ status: undefined, tasks: props.tasks }] as const
    return TASK_STATUSES.map((status) => ({ status, tasks: props.tasks.filter((task) => task.status === status) })).filter(
      (group) => group.tasks.length > 0,
    )
  })
  // One arrival for the whole list, so the stagger keeps running across a
  // group boundary instead of restarting at every header.
  const ordinal = createMemo(() => {
    const order = new Map<string, number>()
    let index = 0
    for (const group of groups()) for (const task of group.tasks) order.set(task.id, index++)
    return order
  })
  const now = Date.now()

  return (
    <>
      <div class="tsk tsk-listing" data-testid="tasks-list" aria-busy={props.loading ? "true" : "false"}>
        <Show
          when={props.tasks.length > 0}
          fallback={
            <div class="tsk-empty">
              <p>{props.emptyLabel ?? "No tasks here yet."}</p>
              <Show when={props.onCreate}>
                {(create) => (
                  <button type="button" class="tsk-button" data-variant="outline" onClick={() => create()()}>
                    New task
                  </button>
                )}
              </Show>
            </div>
          }
        >
          <For each={groups()}>
            {(group) => (
              <section aria-label={group.status ? TASK_STATUS_LABELS[group.status] : "Tasks"}>
                <Show when={group.status}>
                  {(status) => (
                    <h3 class="tsk-group-head">
                      <TaskStatusDot status={status()} />
                      <span>{TASK_STATUS_LABELS[status()]}</span>
                      <span class="tsk-count">{group.tasks.length}</span>
                    </h3>
                  )}
                </Show>
                <For each={group.tasks}>
                  {(task) => (
                    <TaskRow
                      task={task}
                      index={ordinal().get(task.id) ?? 0}
                      now={now}
                      parentTitle={props.parentTitleOf?.(task)}
                      progress={props.subtaskProgress?.(task.id)}
                      selected={props.selectedTaskId === task.id}
                      busy={props.busyTaskId === task.id}
                      onSelect={props.onSelect}
                      onStatusChange={props.onStatusChange}
                    />
                  )}
                </For>
              </section>
            )}
          </For>
        </Show>
      </div>
      <LoadMore more={props.more} testId="tasks-list-load-more" />
    </>
  )
}

function TaskRow(props: {
  task: TaskSummary
  index: number
  now: number
  parentTitle?: string
  progress?: SubtaskProgress
  selected: boolean
  busy: boolean
  onSelect: (taskId: string) => void
  onStatusChange?: (input: { taskId: string; revision: number; status: TaskStatus }) => void
}) {
  return (
    <div
      class="tsk-tr tsk-rise"
      style={{ "--tsk-i": String(props.index) }}
      data-selected={props.selected ? "true" : undefined}
      data-archived={props.task.archivedAt === null ? undefined : "true"}
    >
      <button
        type="button"
        class="tsk-open"
        data-testid={`tasks-list-row-${props.task.id}`}
        aria-current={props.selected ? "true" : undefined}
        onClick={() => props.onSelect(props.task.id)}
      >
        <TaskGlyph subtask={props.task.parentTaskId !== null} />
        <span class="tsk-open-name">{props.task.title}</span>
        <Show when={props.parentTitle}>{(title) => <span class="tsk-parent">in {title()}</span>}</Show>
        <Show when={props.task.archivedAt !== null}>
          <span class="tsk-parent">Archived</span>
        </Show>
      </button>

      <Show
        when={props.onStatusChange}
        fallback={
          <span class="tsk-cell">
            <TaskStatusDot status={props.task.status} />
            {TASK_STATUS_LABELS[props.task.status]}
          </span>
        }
      >
        {(change) => (
          <StatusMenu
            status={props.task.status}
            disabled={props.busy || props.task.archivedAt !== null}
            label={`Status of ${props.task.title}`}
            testId={`tasks-list-status-${props.task.id}`}
            onChange={(status) => change()({ taskId: props.task.id, revision: props.task.revision, status })}
          />
        )}
      </Show>

      <span class="tsk-cell tsk-cell-sub">
        <Show when={props.progress}>{(progress) => `${progress().done}/${progress().total}`}</Show>
      </span>
      <span class="tsk-cell tsk-cell-time">{shortAge(props.task.updatedAt, props.now)}</span>
    </div>
  )
}
