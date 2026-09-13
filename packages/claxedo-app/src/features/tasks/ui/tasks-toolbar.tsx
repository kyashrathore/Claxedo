import { For, Show, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { TASK_STATUSES, type TaskStatus } from "@claxedo/tasks"
import {
  TASK_COLLECTIONS,
  TASK_COLLECTION_LABELS,
  TASK_DATE_FIELDS,
  TASK_DATE_FIELD_LABELS,
  TASK_STATUS_LABELS,
  type TaskDateField,
} from "../view-model"
import type { TasksProjectOption } from "../app-ports"
import type { TasksStore } from "../store/tasks-store"

export type TasksToolbarProps = {
  store: TasksStore
  projects: readonly TasksProjectOption[]
  projectId: string
}

const ANY_STATUS = "any" as const
type StatusChoice = TaskStatus | typeof ANY_STATUS
const STATUS_CHOICES: readonly StatusChoice[] = [ANY_STATUS, ...TASK_STATUSES]
const statusChoiceLabel = (choice: StatusChoice) => (choice === ANY_STATUS ? "Any status" : TASK_STATUS_LABELS[choice])

const GROUPINGS = [
  { value: true, label: "Status" },
  { value: false, label: "No grouping" },
] as const
type Grouping = (typeof GROUPINGS)[number]

/**
 * Collection, filter and display controls for the task list.
 *
 * The view toggle is in the bar as well as in Display: it is the one control
 * that changes what the page is, and a control behind a popover cannot be
 * reached by the keyboard without opening it first.
 */
export function TasksToolbar(props: TasksToolbarProps) {
  const [filterOpen, setFilterOpen] = createSignal(false)
  const [displayOpen, setDisplayOpen] = createSignal(false)
  const project = () => props.projects.find((entry) => entry.id === props.projectId)
  const statusFilter = () => props.store.state.statusFilter
  const board = () => props.store.state.view === "board"
  const grouping = () => GROUPINGS.find((entry) => entry.value === props.store.state.grouped)
  const dateField = () => props.store.state.dateField
  // Assigned through a call rather than as a literal: an inline object literal
  // is excess-property-checked against the button's own props, which do not
  // admit `data-*`.
  const trigger = (testId: string, icon?: "sliders") => ({
    size: "small" as const,
    variant: "ghost" as const,
    icon,
    "data-testid": testId,
  })

  return (
    <div class="tsk-toolbar">
      <div class="tsk-segmented" role="group" aria-label="Task collection">
        <For each={TASK_COLLECTIONS}>
          {(collection) => (
            <Button
              size="small"
              variant="ghost"
              data-testid={`tasks-collection-${collection}`}
              data-selected={props.store.state.collection === collection ? "true" : undefined}
              aria-pressed={props.store.state.collection === collection}
              onClick={() => props.store.setCollection(collection)}
            >
              {TASK_COLLECTION_LABELS[collection]}
            </Button>
          )}
        </For>
      </div>

      <Show when={props.projects.length > 1 && project()}>
        {(entry) => (
          <Tag class="tsk-filter-tag">
            Project: {entry().label}
          </Tag>
        )}
      </Show>
      <Show when={statusFilter()}>
        {(status) => (
          <Tag class="tsk-filter-tag">
            {TASK_STATUS_LABELS[status()]}
            <IconButton
              icon="close-small"
              size="small"
              variant="ghost"
              data-testid="tasks-status-filter-clear"
              aria-label={`Clear the ${TASK_STATUS_LABELS[status()]} filter`}
              onClick={() => props.store.setStatusFilter(null)}
            />
          </Tag>
        )}
      </Show>

      <span class="tsk-spacer" />

      <Popover
        open={filterOpen()}
        onOpenChange={setFilterOpen}
        placement="bottom-end"
        triggerAs={Button}
        triggerProps={trigger("tasks-filter")}
        trigger={<span>Filter</span>}
      >
        <div class="tsk-popover">
          <div class="tsk-option">
            <span class="tsk-option-label">Project</span>
            <Select
              size="small"
              options={[...props.projects]}
              current={project()}
              value={(entry: TasksProjectOption) => entry.id}
              label={(entry: TasksProjectOption) => entry.label}
              placeholder="Any project"
              triggerProps={{ "data-testid": "tasks-project", "aria-label": "Project" }}
              onSelect={(entry) => {
                if (entry) props.store.setProjectId(entry.id)
              }}
            />
          </div>

          <div class="tsk-option">
            <span class="tsk-option-label">Status</span>
            <Select
              size="small"
              options={[...STATUS_CHOICES]}
              current={statusFilter() ?? ANY_STATUS}
              value={(choice: StatusChoice) => choice}
              label={statusChoiceLabel}
              triggerProps={{ "data-testid": "tasks-status-filter", "aria-label": "Status filter" }}
              onSelect={(choice) => props.store.setStatusFilter(choice && choice !== ANY_STATUS ? choice : null)}
            />
          </div>
        </div>
      </Popover>

      <Popover
        open={displayOpen()}
        onOpenChange={setDisplayOpen}
        placement="bottom-end"
        triggerAs={Button}
        triggerProps={trigger("tasks-display", "sliders")}
        trigger={<span>Display</span>}
      >
        <div class="tsk-popover">
          <div class="tsk-segmented tsk-segmented-wide" role="group" aria-label="View">
            <Button
              size="small"
              variant="ghost"
              data-selected={board() ? undefined : "true"}
              aria-pressed={!board()}
              onClick={() => props.store.setView("list")}
            >
              List
            </Button>
            <Button
              size="small"
              variant="ghost"
              data-selected={board() ? "true" : undefined}
              aria-pressed={board()}
              onClick={() => props.store.setView("board")}
            >
              Board
            </Button>
          </div>

          <div class="tsk-option">
            <span class="tsk-option-label">Show subtasks</span>
            <Switch
              data-testid="tasks-show-children"
              checked={props.store.state.showChildren}
              onChange={(value: boolean) => props.store.setShowChildren(value)}
              hideLabel
            >
              Show subtasks
            </Switch>
          </div>

          <div class="tsk-option">
            <span class="tsk-option-label">Grouping</span>
            <Select
              size="small"
              options={[...GROUPINGS]}
              current={grouping()}
              value={(entry: Grouping) => String(entry.value)}
              label={(entry: Grouping) => entry.label}
              triggerProps={{ "data-testid": "tasks-group-by-status", "aria-label": "Grouping" }}
              onSelect={(entry) => {
                if (entry) props.store.setGrouped(entry.value)
              }}
            />
          </div>

          <div class="tsk-option">
            <span class="tsk-option-label">Date</span>
            <Select
              size="small"
              options={[...TASK_DATE_FIELDS]}
              current={dateField()}
              value={(field: TaskDateField) => field}
              label={(field: TaskDateField) => TASK_DATE_FIELD_LABELS[field]}
              triggerProps={{ "data-testid": "tasks-date-field", "aria-label": "Date" }}
              onSelect={(field) => {
                if (field) props.store.setDateField(field)
              }}
            />
          </div>
        </div>
      </Popover>

      {/*
        One of the two buttons always switches, and it is the one the toggle
        identifies: pressing the view you are already in is not a toggle.
      */}
      <div class="tsk-segmented" role="group" aria-label="View">
        <Button
          size="small"
          variant="ghost"
          data-testid={board() ? "tasks-view-toggle" : undefined}
          data-selected={board() ? undefined : "true"}
          aria-pressed={!board()}
          onClick={() => props.store.setView("list")}
        >
          List
        </Button>
        <Button
          size="small"
          variant="ghost"
          data-testid={board() ? undefined : "tasks-view-toggle"}
          data-selected={board() ? "true" : undefined}
          aria-pressed={board()}
          onClick={() => props.store.setView("board")}
        >
          Board
        </Button>
      </div>
    </div>
  )
}
