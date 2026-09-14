import { For } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { TASK_STATUSES, isTaskStatus, type TaskStatus } from "@claxedo/tasks"
import { TASK_STATUS_LABELS } from "../../view-model"

const STATUS_ICONS: Readonly<Record<TaskStatus, "circle-dashed" | "circle" | "circle-half" | "circle-alert" | "circle-check">> = {
  backlog: "circle-dashed",
  todo: "circle",
  doing: "circle-half",
  needs_you: "circle-alert",
  done: "circle-check",
}

/** `label` where the mark stands alone; beside its own name it stays decorative. */
export function TaskStatusIcon(props: { status: TaskStatus; label?: string }) {
  return (
    <span
      class="tsk-status-icon"
      data-status={props.status}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      title={props.label}
    >
      <Icon name={STATUS_ICONS[props.status]} size="small" />
    </span>
  )
}

/** The mark and the name together, where a status is shown rather than chosen. */
export function TaskStatusChip(props: { status: TaskStatus }) {
  return (
    <span class="tsk-status">
      <TaskStatusIcon status={props.status} />
      {TASK_STATUS_LABELS[props.status]}
    </span>
  )
}

/**
 * Every status as a menu row, wherever a menu is already open.
 *
 * A radio group, so the ticked row is the record rather than the last press: a
 * refused change — a parent whose children are still open — re-renders with
 * `status` unchanged and the tick stays where the server left it.
 */
export function StatusMenuItems(props: {
  status: TaskStatus
  disabled?: boolean
  label: string
  testId?: string
  onChange: (status: TaskStatus) => void
}) {
  return (
    <DropdownMenu.RadioGroup
      aria-label={props.label}
      data-testid={props.testId}
      value={props.status}
      onChange={(next) => {
        if (isTaskStatus(next) && next !== props.status) props.onChange(next)
      }}
    >
      <For each={TASK_STATUSES}>
        {(status) => (
          <DropdownMenu.RadioItem class="tsk-menu-item" value={status} disabled={props.disabled}>
            <TaskStatusIcon status={status} />
            <span class="tsk-menu-label">{TASK_STATUS_LABELS[status]}</span>
            <DropdownMenu.ItemIndicator class="tsk-menu-check">
              <Icon name="check-small" size="small" />
            </DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>
        )}
      </For>
    </DropdownMenu.RadioGroup>
  )
}

/**
 * Status as a control of its own, where the surface around it does not already
 * say the status: the task page's properties, and a subtask row. The chip is
 * the trigger, so the value and the thing you press are one element.
 */
export function StatusControl(props: {
  status: TaskStatus
  onChange: (status: TaskStatus) => void
  disabled?: boolean
  label: string
  testId?: string
}) {
  return (
    <DropdownMenu placement="bottom-start">
      <DropdownMenu.Trigger
        class="tsk-status-trigger"
        data-testid={props.testId}
        aria-label={props.label}
        disabled={props.disabled}
      >
        <TaskStatusIcon status={props.status} />
        <span>{TASK_STATUS_LABELS[props.status]}</span>
        <Icon name="chevron-down" size="small" class="tsk-status-caret" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="tsk-menu-content">
          <StatusMenuItems
            status={props.status}
            disabled={props.disabled}
            label={props.label}
            onChange={props.onChange}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
