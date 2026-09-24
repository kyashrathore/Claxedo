import type { JSX } from "solid-js"

export function TasksHeader(props: {
  readonly title: string
  readonly count?: number
  readonly action?: JSX.Element
}): JSX.Element {
  return (
    <header class="tsk-surface-head">
      <h2 class="tsk-surface-title">{props.title}</h2>
      <span class="tsk-count">{props.count ?? 0}</span>
      <span class="tsk-spacer" />
      {props.action}
    </header>
  )
}
