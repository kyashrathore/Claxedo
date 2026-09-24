import { For, type JSX } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { TASK_STATUSES, isTaskStatus, type TaskStatus } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { TASK_STATUS_KEYS } from "../model"

const STATUS_ICONS: Readonly<
  Record<TaskStatus, "circle-dashed" | "circle" | "circle-half" | "circle-alert" | "circle-check">
> = {
  backlog: "circle-dashed",
  todo: "circle",
  doing: "circle-half",
  needs_you: "circle-alert",
  done: "circle-check",
}

export function TaskStatusIcon(props: { readonly status: TaskStatus; readonly label?: string }): JSX.Element {
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

export function TaskStatusChip(props: { readonly status: TaskStatus }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <span class="tsk-status">
      <TaskStatusIcon status={props.status} />
      {t(TASK_STATUS_KEYS[props.status])}
    </span>
  )
}

export function StatusMenuItems(props: {
  readonly status: TaskStatus
  readonly disabled?: boolean
  readonly label: string
  readonly testId?: string
  readonly onChange: (status: TaskStatus) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
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
            <span class="tsk-menu-label">{t(TASK_STATUS_KEYS[status])}</span>
            <DropdownMenu.ItemIndicator class="tsk-menu-check">
              <Icon name="check-small" size="small" />
            </DropdownMenu.ItemIndicator>
          </DropdownMenu.RadioItem>
        )}
      </For>
    </DropdownMenu.RadioGroup>
  )
}

export function StatusControl(props: {
  readonly status: TaskStatus
  readonly onChange: (status: TaskStatus) => void
  readonly disabled?: boolean
  readonly label: string
  readonly testId?: string
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <DropdownMenu placement="bottom-start">
      <DropdownMenu.Trigger
        class="tsk-status-trigger"
        data-testid={props.testId}
        aria-label={props.label}
        disabled={props.disabled}
      >
        <TaskStatusIcon status={props.status} />
        <span>{t(TASK_STATUS_KEYS[props.status])}</span>
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
