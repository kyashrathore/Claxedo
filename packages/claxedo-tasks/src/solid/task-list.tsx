import { For, Show } from "solid-js"
import type { TaskStatus, TaskSummary } from "../contracts"
import { LoadMore, type MorePages } from "./load-more"
import { TaskStatusChip, StatusMenu } from "./status-menu"

export type TaskListProps = {
  tasks: readonly TaskSummary[]
  selectedTaskId?: string
  loading?: boolean
  emptyLabel?: string
  showChildren?: boolean
  childrenOf?: (taskId: string) => readonly TaskSummary[]
  more?: MorePages
  onSelect: (taskId: string) => void
  onStatusChange?: (input: { taskId: string; revision: number; status: TaskStatus }) => void
  busyTaskId?: string
}

export function TaskList(props: TaskListProps) {
  return (
    <>
      {/* The control sits outside `role="list"`, which only admits list items. */}
      <div class="tsk tsk-surface tsk-scroll" data-testid="tasks-list" role="list" aria-busy={props.loading ? "true" : "false"}>
        <Show
          when={props.tasks.length > 0}
          fallback={<p class="tsk-empty">{props.emptyLabel ?? "No tasks yet."}</p>}
        >
          <For each={props.tasks}>
            {(task) => (
              <>
                <TaskRow
                  task={task}
                  depth={0}
                  selected={props.selectedTaskId === task.id}
                  busy={props.busyTaskId === task.id}
                  onSelect={props.onSelect}
                  onStatusChange={props.onStatusChange}
                />
                <Show when={props.showChildren}>
                  <For each={props.childrenOf?.(task.id) ?? []}>
                    {(child) => (
                      <TaskRow
                        task={child}
                        depth={1}
                        selected={props.selectedTaskId === child.id}
                        busy={props.busyTaskId === child.id}
                        onSelect={props.onSelect}
                        onStatusChange={props.onStatusChange}
                      />
                    )}
                  </For>
                </Show>
              </>
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
  depth: number
  selected: boolean
  busy: boolean
  onSelect: (taskId: string) => void
  onStatusChange?: (input: { taskId: string; revision: number; status: TaskStatus }) => void
}) {
  return (
    <div class="tsk-row tsk-nested" role="listitem" style={{ "--tsk-depth": String(props.depth) }}>
      <button
        type="button"
        class="tsk-item"
        data-testid={`tasks-list-row-${props.task.id}`}
        aria-current={props.selected ? "true" : undefined}
        onClick={() => props.onSelect(props.task.id)}
      >
        <span class="tsk-item-title">{props.task.title}</span>
        <Show when={props.task.archivedAt !== null}>
          <span class="tsk-muted">Archived</span>
        </Show>
        <Show when={!props.onStatusChange}>
          <TaskStatusChip status={props.task.status} />
        </Show>
      </button>
      <Show when={props.onStatusChange}>
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
    </div>
  )
}
