import { For } from "solid-js"
import { TASK_STATUSES, isTaskStatus, type TaskStatus } from "../contracts"
import { TASK_STATUS_LABELS } from "./view-model"

/**
 * The status control, and the board's accessible alternative to dragging a
 * card between columns. A native select is the menu: it is reachable by
 * keyboard, announces the current value, and needs no drag to change it.
 *
 * The select shows the record, never the request: a native select keeps the
 * value the user picked, so a refused change (a parent with open children)
 * would otherwise display Done while the record still says In progress.
 */
export function StatusMenu(props: {
  status: TaskStatus
  onChange: (status: TaskStatus) => void
  disabled?: boolean
  label: string
  testId?: string
}) {
  return (
    <select
      class="tsk-select"
      data-testid={props.testId}
      aria-label={props.label}
      disabled={props.disabled}
      value={props.status}
      onChange={(event) => {
        const next = event.currentTarget.value
        event.currentTarget.value = props.status
        if (isTaskStatus(next)) props.onChange(next)
      }}
    >
      <For each={TASK_STATUSES}>{(status) => <option value={status}>{TASK_STATUS_LABELS[status]}</option>}</For>
    </select>
  )
}

export function TaskStatusChip(props: { status: TaskStatus }) {
  return (
    <span class="tsk-status" data-status={props.status}>
      {TASK_STATUS_LABELS[props.status]}
    </span>
  )
}
