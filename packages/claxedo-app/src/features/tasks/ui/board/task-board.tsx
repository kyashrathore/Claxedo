import { For, Show, createSignal } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TASK_STATUSES, type TaskStatus, type TaskSummary } from "@claxedo/tasks"
import { LoadMore, type MorePages } from "../shared/load-more"
import { TaskStatusIcon } from "../shared/status-control"
import { TaskRowActions, TaskStartControl, type TaskStartOffer } from "../shared/task-row-controls"
import { TASK_STATUS_LABELS, shortAge } from "../../view-model"
import type { SubtaskProgress } from "../list/task-list"

export type TaskBoardProps = {
  tasks: readonly TaskSummary[]
  selectedTaskId?: string
  busyTaskId?: string
  subtaskProgress?: (taskId: string) => SubtaskProgress | undefined
  /** The card's own Start control; absent where the caller cannot start anything. */
  startOffer?: (task: TaskSummary) => TaskStartOffer
  more?: MorePages
  onSelect: (taskId: string) => void
  /** Offered on To do alone: `task.create` takes no status, so a card starts there. */
  onCreate?: () => void
  onStatusChange: (input: { taskId: string; revision: number; status: TaskStatus }) => void
}

/**
 * Status columns with a per-card status menu. Drag is an accelerator layered
 * on top of that menu, never the only way to move a card: the menu is what a
 * keyboard and a screen reader use, and it is present on every card.
 */
export function TaskBoard(props: TaskBoardProps) {
  const [dragging, setDragging] = createSignal<string | undefined>()
  const [over, setOver] = createSignal<TaskStatus | undefined>()
  const column = (status: TaskStatus) => props.tasks.filter((task) => task.status === status)
  const drop = (status: TaskStatus) => {
    const id = dragging()
    setDragging(undefined)
    setOver(undefined)
    if (!id) return
    const task = props.tasks.find((candidate) => candidate.id === id)
    if (!task || task.status === status) return
    props.onStatusChange({ taskId: task.id, revision: task.revision, status })
  }
  const now = Date.now()

  return (
    <>
      <div class="tsk tsk-board" data-testid="tasks-board">
        <For each={TASK_STATUSES}>
          {(status, columnIndex) => (
            <section
              class="tsk-column"
              data-testid={`tasks-board-column-${status}`}
              data-over={over() === status ? "true" : undefined}
              aria-label={TASK_STATUS_LABELS[status]}
              onDragOver={(event) => {
                if (!dragging()) return
                event.preventDefault()
                setOver(status)
              }}
              onDragLeave={() => setOver((current) => (current === status ? undefined : current))}
              onDrop={(event) => {
                event.preventDefault()
                drop(status)
              }}
            >
              <header class="tsk-column-head">
                <TaskStatusIcon status={status} />
                <span>{TASK_STATUS_LABELS[status]}</span>
                <span class="tsk-count">{column(status).length}</span>
                <span class="tsk-spacer" />
                {/* `task.create` takes no status, so a new card can only land in
                    To do; a plus on Done would promise a task it cannot make. */}
                <Show when={status === "todo" && props.onCreate}>
                  {(create) => (
                    <IconButton
                      icon="plus-small"
                      size="small"
                      variant="ghost"
                      data-testid="tasks-board-create"
                      aria-label="New task"
                      onClick={() => create()()}
                    />
                  )}
                </Show>
              </header>

              <div class="tsk-column-body">
                {/* A dashed box in every empty column would be four marks for
                    something that is only a target while a card is in the air. */}
                <For
                  each={column(status)}
                  fallback={
                    <Show when={dragging()}>
                      <div class="tsk-card-drop" />
                    </Show>
                  }
                >
                  {(task, index) => (
                    <div
                      class="tsk-card tsk-rise"
                      style={{ "--tsk-i": String(columnIndex() + index() * 2) }}
                      data-testid={`tasks-board-card-${task.id}`}
                      data-selected={props.selectedTaskId === task.id ? "true" : undefined}
                      data-dragging={dragging() === task.id ? "true" : undefined}
                      draggable={task.archivedAt === null}
                      // The card is the target, as a list row is. The title
                      // button stays for the keyboard and lets its click bubble
                      // here rather than calling `onSelect` a second time.
                      onClick={() => props.onSelect(task.id)}
                      onDragStart={() => setDragging(task.id)}
                      onDragEnd={() => {
                        setDragging(undefined)
                        setOver(undefined)
                      }}
                    >
                      <button
                        type="button"
                        class="tsk-card-title"
                        data-testid={`tasks-board-open-${task.id}`}
                        aria-current={props.selectedTaskId === task.id ? "true" : undefined}
                      >
                        {task.title}
                      </button>

                      {/* The column already names the status, so the card carries
                          the menu that changes it rather than a second label. */}
                      <div class="tsk-card-meta">
                        <Show when={(props.subtaskProgress?.(task.id)?.total ?? 0) > 0 ? props.subtaskProgress?.(task.id) : undefined}>
                          {(progress) => (
                            <span class="tsk-cell">
                              <Icon name="checklist" size="small" />
                              {`${progress().done}/${progress().total}`}
                            </span>
                          )}
                        </Show>
                        <Show when={task.parentTaskId}>
                          <span class="tsk-cell">Subtask</span>
                        </Show>
                        <span class="tsk-cell">{shortAge(task.updatedAt, now)}</span>
                      </div>

                      <span class="tsk-row-tools" onClick={(event) => event.stopPropagation()}>
                        <Show when={props.startOffer}>
                          {(offer) => <TaskStartControl task={task} offer={offer()(task)} testIdPrefix="tasks-board" />}
                        </Show>
                        <TaskRowActions
                          task={task}
                          busy={props.busyTaskId === task.id}
                          testIdPrefix="tasks-board"
                          statusTestId={`tasks-board-status-${task.id}`}
                          onStatusChange={(input) => props.onStatusChange(input)}
                        />
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </div>
      <LoadMore more={props.more} testId="tasks-board-load-more" />
    </>
  )
}
