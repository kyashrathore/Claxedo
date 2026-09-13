import { For, Show, createSignal } from "solid-js"
import { Popover } from "@opencode-ai/ui/popover"
import { TASK_STATUSES, isTaskStatus } from "@claxedo/tasks"
import { TASK_COLLECTIONS, TASK_COLLECTION_LABELS, TASK_STATUS_LABELS } from "../view-model"
import type { TasksProjectOption } from "../app-ports"
import type { TasksStore } from "../store/tasks-store"

export type TasksToolbarProps = {
  store: TasksStore
  projects: readonly TasksProjectOption[]
  projectId: string
}

/**
 * Collection, filter and display controls for the task list.
 *
 * The filter selects live in a popover but the view toggle does not: it is the
 * one control that changes what the page is, and a control behind a popover
 * cannot be reached by the keyboard without opening it first.
 */
export function TasksToolbar(props: TasksToolbarProps) {
  const [filterOpen, setFilterOpen] = createSignal(false)
  const [displayOpen, setDisplayOpen] = createSignal(false)
  const projectLabel = () => props.projects.find((project) => project.id === props.projectId)?.label
  const statusFilter = () => props.store.state.statusFilter
  const board = () => props.store.state.view === "board"
  // Assigned through a call rather than as a literal: an inline object literal
  // is excess-property-checked against the bare button attributes, which do not
  // admit `data-*`.
  const trigger = (testId: string) => ({ type: "button" as const, class: "tsk-button", "data-testid": testId })

  return (
    <div class="tsk-toolbar">
      <div class="tsk-segmented" role="group" aria-label="Task collection">
        <For each={TASK_COLLECTIONS}>
          {(collection) => (
            <button
              type="button"
              data-testid={`tasks-collection-${collection}`}
              aria-pressed={props.store.state.collection === collection}
              onClick={() => props.store.setCollection(collection)}
            >
              {TASK_COLLECTION_LABELS[collection]}
            </button>
          )}
        </For>
      </div>

      <Show when={props.projects.length > 1 && projectLabel()}>
        {(label) => (
          <span class="tsk-chip">
            Project <b>{label()}</b>
          </span>
        )}
      </Show>
      <Show when={statusFilter()}>
        {(status) => (
          <span class="tsk-chip">
            Status <b>{TASK_STATUS_LABELS[status()]}</b>
            <button
              type="button"
              class="tsk-icon-button"
              data-testid="tasks-status-filter-clear"
              aria-label={`Clear the ${TASK_STATUS_LABELS[status()]} filter`}
              onClick={() => props.store.setStatusFilter(null)}
            >
              ×
            </button>
          </span>
        )}
      </Show>

      <span class="tsk-spacer" />

      <Popover
        open={filterOpen()}
        onOpenChange={setFilterOpen}
        placement="bottom-end"
        triggerAs="button"
        triggerProps={trigger("tasks-filter")}
        trigger={<span>Filter</span>}
      >
        <div class="tsk-popover-body">
          <label class="tsk-field">
            <span class="tsk-label">Project</span>
            <select
              class="tsk-select"
              data-testid="tasks-project"
              aria-label="Project"
              value={props.projectId}
              onChange={(event) => props.store.setProjectId(event.currentTarget.value)}
            >
              <For each={props.projects}>{(project) => <option value={project.id}>{project.label}</option>}</For>
            </select>
          </label>

          <label class="tsk-field">
            <span class="tsk-label">Status</span>
            <select
              class="tsk-select"
              data-testid="tasks-status-filter"
              aria-label="Status filter"
              value={statusFilter() ?? ""}
              onChange={(event) => {
                const next = event.currentTarget.value
                props.store.setStatusFilter(isTaskStatus(next) ? next : null)
              }}
            >
              <option value="">Any status</option>
              <For each={TASK_STATUSES}>{(status) => <option value={status}>{TASK_STATUS_LABELS[status]}</option>}</For>
            </select>
          </label>
        </div>
      </Popover>

      <Popover
        open={displayOpen()}
        onOpenChange={setDisplayOpen}
        placement="bottom-end"
        triggerAs="button"
        triggerProps={trigger("tasks-display")}
        trigger={<span>Display</span>}
      >
        <div class="tsk-popover-body">
          <label class="tsk-checkbox">
            <input
              type="checkbox"
              data-testid="tasks-show-children"
              checked={props.store.state.showChildren}
              onChange={(event) => props.store.setShowChildren(event.currentTarget.checked)}
            />
            <span>Show subtasks</span>
          </label>
          <label class="tsk-checkbox">
            <input
              type="checkbox"
              data-testid="tasks-group-by-status"
              checked={props.store.state.grouped}
              onChange={(event) => props.store.setGrouped(event.currentTarget.checked)}
            />
            <span>Group by status</span>
          </label>
        </div>
      </Popover>

      {/*
        One of the two buttons always switches, and it is the one the toggle
        identifies: pressing the view you are already in is not a toggle.
      */}
      <div class="tsk-segmented" role="group" aria-label="View">
        <button
          type="button"
          data-testid={board() ? "tasks-view-toggle" : undefined}
          aria-pressed={!board()}
          onClick={() => props.store.setView("list")}
        >
          List
        </button>
        <button
          type="button"
          data-testid={board() ? undefined : "tasks-view-toggle"}
          aria-pressed={board()}
          onClick={() => props.store.setView("board")}
        >
          Board
        </button>
      </div>
    </div>
  )
}
