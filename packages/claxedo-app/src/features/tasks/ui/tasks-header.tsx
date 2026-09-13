import type { JSX } from "solid-js"

export type TasksHeaderProps = {
  title: string
  count?: number
  /** The page's own primary action, right-aligned. */
  action?: JSX.Element
}

/** The title row the task list and the preset catalog share. */
export function TasksHeader(props: TasksHeaderProps) {
  return (
    <header class="tsk-surface-head">
      <h2 class="tsk-surface-title">{props.title}</h2>
      <span class="tsk-count">{props.count ?? 0}</span>
      <span class="tsk-spacer" />
      {props.action}
    </header>
  )
}
