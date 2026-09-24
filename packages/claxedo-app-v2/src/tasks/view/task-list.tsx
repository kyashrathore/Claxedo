import { For, Show, createMemo, type JSX } from "solid-js"
import { TASK_STATUSES, type TaskStatus, type TaskSummary } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { Button } from "@/ui"
import type { MorePages } from "../data/queries"
import type { TaskStartOffer } from "../data/start"
import { dictionary } from "../i18n"
import { TASK_STATUS_KEYS, taskKey, type TaskDateField } from "../model"
import { LoadMore } from "./load-more"
import { TaskStatusIcon } from "./status-control"
import { AgeCell, ProgressCell, SessionMark, type SubtaskProgress } from "./task-cells"
import { TaskRowActions, TaskStartControl } from "./task-row-controls"

type StatusChange = (input: { taskId: string; revision: number; status: TaskStatus }) => void

export type TaskListProps = {
  readonly tasks: readonly TaskSummary[]
  readonly projectName: string
  readonly dateField: TaskDateField
  readonly selectedTaskId?: string
  readonly loading?: boolean
  readonly emptyLabel?: string
  readonly grouped?: boolean
  readonly parentTitleOf?: (task: TaskSummary) => string | undefined
  readonly subtaskProgress?: (taskId: string) => SubtaskProgress | undefined
  readonly startOffer?: (task: TaskSummary) => TaskStartOffer
  readonly more?: MorePages
  readonly onSelect: (taskId: string) => void
  readonly onCreate?: () => void
  readonly onStatusChange?: StatusChange
  readonly busyTaskId?: string
}

function TaskRow(props: {
  readonly task: TaskSummary
  readonly index: number
  readonly now: number
  readonly list: TaskListProps
}): JSX.Element {
  const t = useTranslator(dictionary)
  const selected = () => props.list.selectedTaskId === props.task.id
  return (
    <div
      class="tsk-tr tsk-rise"
      style={{ "--tsk-i": String(props.index) }}
      data-selected={selected() ? "true" : undefined}
      data-archived={props.task.archivedAt === null ? undefined : "true"}
    >
      <button
        type="button"
        class="tsk-open"
        data-testid={`tasks-list-row-${props.task.id}`}
        aria-current={selected() ? "true" : undefined}
        onClick={() => props.list.onSelect(props.task.id)}
      >
        <TaskStatusIcon status={props.task.status} label={t(TASK_STATUS_KEYS[props.task.status])} />
        <span class="tsk-key">{taskKey(props.list.projectName, props.task)}</span>
        <span class="tsk-open-name">{props.task.title}</span>
        <Show when={props.list.parentTitleOf?.(props.task)}>
          {(title) => <span class="tsk-parent">{title()}</span>}
        </Show>
        <Show when={props.task.archivedAt !== null}>
          <span class="tsk-parent">{t("tasks.archived")}</span>
        </Show>
      </button>
      <span class="tsk-props">
        <ProgressCell progress={props.list.subtaskProgress?.(props.task.id)} class="tsk-cell tsk-cell-sub" />
        <SessionMark task={props.task} class="tsk-dot tsk-cell-session" />
        <AgeCell task={props.task} field={props.list.dateField} now={props.now} class="tsk-cell tsk-cell-time" />
      </span>
      <span class="tsk-row-tools" onClick={(event) => event.stopPropagation()}>
        <Show when={props.list.startOffer?.(props.task)}>
          {(offer) => <TaskStartControl task={props.task} offer={offer()} testIdPrefix="tasks-list" />}
        </Show>
        <Show when={props.list.onStatusChange}>
          {(change) => (
            <TaskRowActions
              task={props.task}
              busy={props.list.busyTaskId === props.task.id}
              testIdPrefix="tasks-list"
              onStatusChange={(input) => change()(input)}
            />
          )}
        </Show>
      </span>
    </div>
  )
}

function EmptyList(props: { readonly label?: string; readonly onCreate?: () => void }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div class="tsk-empty">
      <p>{props.label ?? t("tasks.list.empty")}</p>
      <Show when={props.onCreate}>
        {(create) => (
          <Button size="small" variant="ghost" class="tsk-empty-action" onClick={() => create()()}>
            {t("tasks.newTask")}
          </Button>
        )}
      </Show>
    </div>
  )
}

export function TaskList(props: TaskListProps): JSX.Element {
  const t = useTranslator(dictionary)
  const groups = createMemo(() => {
    if (props.grouped === false) return [{ status: undefined, tasks: props.tasks }] as const
    return TASK_STATUSES.map((status) => ({
      status,
      tasks: props.tasks.filter((task) => task.status === status),
    })).filter((group) => group.tasks.length > 0)
  })
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
        <Show when={props.tasks.length > 0} fallback={<EmptyList label={props.emptyLabel} onCreate={props.onCreate} />}>
          <For each={groups()}>
            {(group) => (
              <section aria-label={group.status ? t(TASK_STATUS_KEYS[group.status]) : t("tasks.title")}>
                <Show when={group.status}>
                  {(status) => (
                    <h3 class="tsk-group-head">
                      <TaskStatusIcon status={status()} />
                      <span class="tsk-group-name">{t(TASK_STATUS_KEYS[status()])}</span>
                      <span class="tsk-count">{group.tasks.length}</span>
                    </h3>
                  )}
                </Show>
                <For each={group.tasks}>
                  {(task) => <TaskRow task={task} index={ordinal().get(task.id) ?? 0} now={now} list={props} />}
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
