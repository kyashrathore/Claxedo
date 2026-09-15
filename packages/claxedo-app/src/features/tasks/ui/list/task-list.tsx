import { For, Show, createMemo } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { TASK_STATUSES, type TaskChildSummary, type TaskStatus, type TaskSummary } from "@claxedo/tasks"
import { LoadMore, type MorePages } from "../shared/load-more"
import { TaskStatusIcon } from "../shared/status-control"
import { TaskRowActions, TaskStartControl, type TaskStartOffer } from "../shared/task-row-controls"
import { TASK_STATUS_LABELS, shortAge, taskDate, taskKey, type TaskDateField } from "../../view-model"

/** The store's own child counts, which is what a row reports. */
export type SubtaskProgress = TaskChildSummary

export type TaskListProps = {
  /** Flat and already filtered: this renders the rows it is given, in status groups. */
  tasks: readonly TaskSummary[]
  /** The name every row's key is derived from; the list spans one project. */
  projectName: string
  dateField: TaskDateField
  selectedTaskId?: string
  loading?: boolean
  emptyLabel?: string
  /** Grouping is presentational: off renders the rows as one run, with no status headers. */
  grouped?: boolean
  /** The parent's title for a subtask row, from the rows the caller already holds. */
  parentTitleOf?: (task: TaskSummary) => string | undefined
  subtaskProgress?: (taskId: string) => SubtaskProgress | undefined
  /** The row's own Start control; absent where the caller cannot start anything. */
  startOffer?: (task: TaskSummary) => TaskStartOffer
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
                  <Button size="small" variant="ghost" class="tsk-empty-action" onClick={() => create()()}>
                    New task
                  </Button>
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
                      <TaskStatusIcon status={status()} />
                      <span class="tsk-group-name">{TASK_STATUS_LABELS[status()]}</span>
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
                      projectName={props.projectName}
                      dateField={props.dateField}
                      parentTitle={props.parentTitleOf?.(task)}
                      progress={props.subtaskProgress?.(task.id)}
                      selected={props.selectedTaskId === task.id}
                      busy={props.busyTaskId === task.id}
                      offer={props.startOffer?.(task)}
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
  projectName: string
  dateField: TaskDateField
  parentTitle?: string
  progress?: SubtaskProgress
  selected: boolean
  busy: boolean
  offer?: TaskStartOffer
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
        <TaskStatusIcon status={props.task.status} label={TASK_STATUS_LABELS[props.task.status]} />
        <span class="tsk-key">{taskKey(props.projectName, props.task)}</span>
        <span class="tsk-open-name">{props.task.title}</span>
        <Show when={props.parentTitle}>{(title) => <span class="tsk-parent">{title()}</span>}</Show>
        <Show when={props.task.archivedAt !== null}>
          <span class="tsk-parent">Archived</span>
        </Show>
      </button>

      <span class="tsk-props">
        {/* A task with no subtasks says nothing rather than `0/0`. */}
        <Show when={props.progress && props.progress.total > 0 ? props.progress : undefined}>
          {(progress) => (
            <span class="tsk-cell tsk-cell-sub" title={`${progress().done} of ${progress().total} subtasks done`}>
              {`${progress().done}/${progress().total}`}
            </span>
          )}
        </Show>
        {/* A list read carries a count and no liveness, so the mark says a
            session exists and the hollow ring says nothing further. */}
        <Show when={props.task.links.count > 0}>
          <span class="tsk-dot tsk-cell-session" role="img" aria-label="Has a session" />
        </Show>
        <span class="tsk-cell tsk-cell-time" title={new Date(taskDate(props.task, props.dateField)).toLocaleString()}>
          {shortAge(taskDate(props.task, props.dateField), props.now)}
        </span>
      </span>

      <span class="tsk-row-tools" onClick={(event) => event.stopPropagation()}>
        <Show when={props.offer}>
          {(offer) => <TaskStartControl task={props.task} offer={offer()} testIdPrefix="tasks-list" />}
        </Show>
        <Show when={props.onStatusChange}>
          {(change) => (
            <TaskRowActions
              task={props.task}
              busy={props.busy}
              testIdPrefix="tasks-list"
              onStatusChange={(input) => change()(input)}
            />
          )}
        </Show>
      </span>
    </div>
  )
}
