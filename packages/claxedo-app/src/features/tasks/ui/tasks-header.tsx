import type { JSX } from "solid-js"

export type TasksHeaderProps = {
  active: "tasks" | "presets"
  count?: number
  onOpenTasks: () => void
  onOpenPresets: () => void
  /** The page's own primary action, right-aligned. */
  action?: JSX.Element
}

/** The one header both Tasks pages wear, so the tab switch keeps its place across a navigation. */
export function TasksHeader(props: TasksHeaderProps) {
  return (
    <header class="tsk-surface-head">
      <div class="tsk-segmented" role="tablist" aria-label="Tasks and presets">
        <button
          type="button"
          role="tab"
          data-testid="tasks-surface-tab-tasks"
          aria-selected={props.active === "tasks"}
          onClick={() => props.onOpenTasks()}
        >
          Tasks
        </button>
        <button
          type="button"
          role="tab"
          data-testid="tasks-surface-tab-presets"
          aria-selected={props.active === "presets"}
          onClick={() => props.onOpenPresets()}
        >
          Presets
        </button>
      </div>
      <span class="tsk-count">{props.count ?? 0}</span>
      <span class="tsk-spacer" />
      {props.action}
    </header>
  )
}
