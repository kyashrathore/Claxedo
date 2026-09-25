import { For, Show, createSignal, type Accessor, type JSX } from "solid-js"
import { IconButton } from "@/ui"
import { isTaskCreateStatus, type TaskCreateStatus, type TaskStatus, type TaskSummary } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import type { MorePages } from "../data/queries"
import type { TaskStartOffer } from "../data/start"
import { dictionary } from "../i18n"
import { TASK_STATUS_KEYS, taskKey, type TaskDateField } from "../model"
import { LoadMore } from "./load-more"
import { TaskStatusIcon } from "./status-control"
import { AgeCell, ProgressCell, SessionMark, type SubtaskProgress } from "./task-cells"
import { createRowToolsMenus, TaskRowActions, TaskStartControl } from "./task-row-controls"

export type TaskBoardProps = {
  readonly tasks: readonly TaskSummary[]
  readonly statuses: readonly TaskStatus[]
  readonly projectName: string
  readonly dateField: TaskDateField
  readonly selectedTaskId?: string
  readonly busyTaskId?: string
  readonly subtaskProgress?: (taskId: string) => SubtaskProgress | undefined
  readonly startOffer?: (task: TaskSummary) => TaskStartOffer
  readonly more?: MorePages
  readonly onSelect: (taskId: string) => void
  readonly onCreate?: (status: TaskCreateStatus) => void
  readonly onStatusChange: (input: { taskId: string; revision: number; status: TaskStatus }) => void
}

type Drag = {
  readonly dragging: Accessor<string | undefined>
  readonly setDragging: (id: string | undefined) => void
  readonly over: Accessor<TaskStatus | undefined>
  readonly setOver: (status: TaskStatus | undefined) => void
}

function BoardCard(props: {
  readonly task: TaskSummary
  readonly order: number
  readonly now: number
  readonly board: TaskBoardProps
  readonly drag: Drag
}): JSX.Element {
  const t = useTranslator(dictionary)
  const selected = () => props.board.selectedTaskId === props.task.id
  const menus = createRowToolsMenus()
  return (
    <div
      class="tsk-card tsk-rise"
      style={{ "--tsk-i": String(props.order) }}
      data-testid={`tasks-board-card-${props.task.id}`}
      data-selected={selected() ? "true" : undefined}
      data-tools-open={menus.open() ? "true" : undefined}
      data-dragging={props.drag.dragging() === props.task.id ? "true" : undefined}
      draggable={props.task.archivedAt === null}
      onClick={() => props.board.onSelect(props.task.id)}
      onDragStart={() => props.drag.setDragging(props.task.id)}
      onDragEnd={() => {
        props.drag.setDragging(undefined)
        props.drag.setOver(undefined)
      }}
    >
      <span class="tsk-key tsk-card-key">{taskKey(props.board.projectName, props.task)}</span>
      <button
        type="button"
        class="tsk-card-title"
        data-testid={`tasks-board-open-${props.task.id}`}
        aria-current={selected() ? "true" : undefined}
      >
        {props.task.title}
      </button>
      <div class="tsk-card-meta">
        <ProgressCell progress={props.board.subtaskProgress?.(props.task.id)} />
        <SessionMark task={props.task} class="tsk-dot" />
        <Show when={props.task.parentTaskId}>
          <span class="tsk-cell">{t("tasks.board.subtask")}</span>
        </Show>
        <AgeCell task={props.task} field={props.board.dateField} now={props.now} class="tsk-cell" />
      </div>
      <span class="tsk-row-tools" onClick={(event) => event.stopPropagation()}>
        <Show when={props.board.startOffer}>
          {(offer) => <TaskStartControl task={props.task} offer={offer()(props.task)} testIdPrefix="tasks-board" onMenuOpenChange={menus.track("start")} />}
        </Show>
        <TaskRowActions
          task={props.task}
          busy={props.board.busyTaskId === props.task.id}
          testIdPrefix="tasks-board"
          onStatusChange={(input) => props.board.onStatusChange(input)}
          onMenuOpenChange={menus.track("actions")}
        />
      </span>
    </div>
  )
}

function ColumnHead(props: { readonly status: TaskStatus; readonly count: number; readonly board: TaskBoardProps }) {
  const t = useTranslator(dictionary)
  const label = () => t(TASK_STATUS_KEYS[props.status])
  return (
    <header class="tsk-column-head">
      <TaskStatusIcon status={props.status} />
      <span>{label()}</span>
      <span class="tsk-count">{props.count}</span>
      <span class="tsk-spacer" />
      <Show when={isTaskCreateStatus(props.status) && props.board.onCreate ? props.board.onCreate : undefined}>
        {(create) => (
          <IconButton
            icon="plus-small"
            size="small"
            variant="ghost"
            data-testid={`tasks-board-create-${props.status}`}
            aria-label={t("tasks.board.newIn", { status: label() })}
            onClick={() => {
              if (isTaskCreateStatus(props.status)) create()(props.status)
            }}
          />
        )}
      </Show>
    </header>
  )
}

function BoardColumn(props: {
  readonly status: TaskStatus
  readonly index: number
  readonly now: number
  readonly board: TaskBoardProps
  readonly drag: Drag
  readonly onDrop: (status: TaskStatus) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  const tasks = () => props.board.tasks.filter((task) => task.status === props.status)
  return (
    <section
      class="tsk-column"
      data-testid={`tasks-board-column-${props.status}`}
      data-over={props.drag.over() === props.status ? "true" : undefined}
      aria-label={t(TASK_STATUS_KEYS[props.status])}
      onDragOver={(event) => {
        if (!props.drag.dragging()) return
        event.preventDefault()
        props.drag.setOver(props.status)
      }}
      onDragLeave={() => {
        if (props.drag.over() === props.status) props.drag.setOver(undefined)
      }}
      onDrop={(event) => {
        event.preventDefault()
        props.onDrop(props.status)
      }}
    >
      <ColumnHead status={props.status} count={tasks().length} board={props.board} />
      <div class="tsk-column-body">
        <For
          each={tasks()}
          fallback={
            <Show when={props.drag.dragging()}>
              <div class="tsk-card-drop" />
            </Show>
          }
        >
          {(task, index) => (
            <BoardCard
              task={task}
              order={props.index + index() * 2}
              now={props.now}
              board={props.board}
              drag={props.drag}
            />
          )}
        </For>
      </div>
    </section>
  )
}

export function TaskBoard(props: TaskBoardProps): JSX.Element {
  const [dragging, setDragging] = createSignal<string | undefined>()
  const [over, setOver] = createSignal<TaskStatus | undefined>()
  const drag: Drag = { dragging, setDragging, over, setOver }
  const drop = (status: TaskStatus) => {
    const id = dragging()
    setDragging(undefined)
    setOver(undefined)
    const task = id ? props.tasks.find((candidate) => candidate.id === id) : undefined
    if (!task || task.status === status) return
    props.onStatusChange({ taskId: task.id, revision: task.revision, status })
  }
  const now = Date.now()
  return (
    <>
      <div class="tsk tsk-board" data-testid="tasks-board">
        <For each={props.statuses}>
          {(status, index) => (
            <BoardColumn status={status} index={index()} now={now} board={props} drag={drag} onDrop={drop} />
          )}
        </For>
      </div>
      <LoadMore more={props.more} testId="tasks-board-load-more" />
    </>
  )
}
