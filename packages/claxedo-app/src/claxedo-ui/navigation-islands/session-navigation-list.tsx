import { For, Show, createMemo } from "solid-js"
import { ClaxedoIcon as Icon, type ClaxedoIconProps } from "../components/claxedo-icon"
import { WORKBENCH_DRAG_MIME } from "../layout"
import type { SwitcherStatus } from "../compact-switcher/switcher-items"
import {
  navigationDragPayload,
  setWorkbenchDragMime,
  type NavigationDragStart,
  type SessionNavigationRow,
} from "./session-navigation"

export type SessionNavigationDisplayRow = {
  source: SessionNavigationRow
  title: string
  directory: string
  active: boolean
  nested?: boolean
  status: SwitcherStatus
  timeLabel?: string
  metadata?: {
    icon: ClaxedoIconProps["name"]
    label: string
  }
}

export type SessionNavigationProps = {
  rows: readonly SessionNavigationDisplayRow[]
  onActivate: (row: SessionNavigationDisplayRow) => void
  onArchive?: (row: SessionNavigationDisplayRow) => void
  onPrepareDrag: (row: SessionNavigationDisplayRow) => string | undefined
  onDragStart?: (input: NavigationDragStart) => void
}

export function SessionNavigation(props: SessionNavigationProps) {
  return (
    <For each={props.rows}>
      {(row) => (
        <SessionNavigationItem
          row={row}
          onActivate={props.onActivate}
          onArchive={props.onArchive}
          onPrepareDrag={props.onPrepareDrag}
          onDragStart={props.onDragStart}
        />
      )}
    </For>
  )
}

function SessionNavigationItem(props: {
  row: SessionNavigationDisplayRow
  onActivate: (row: SessionNavigationDisplayRow) => void
  onArchive?: (row: SessionNavigationDisplayRow) => void
  onPrepareDrag: (row: SessionNavigationDisplayRow) => string | undefined
  onDragStart?: (input: NavigationDragStart) => void
}) {
  const status = createMemo(() => props.row.status)
  const activate = () => props.onActivate(props.row)

  return (
    <div class="group/session">
      <div
        role="button"
        tabIndex={0}
        data-testid="rail-sidebar-session-row"
        data-session-id={props.row.source.sessionId}
        data-session-ref={props.row.source.sessionRef}
        data-workspace-dir={props.row.directory}
        data-active={props.row.active ? "true" : "false"}
        ref={(el) => el.setAttribute("draggable", "true")}
        class="relative flex items-center gap-2 min-h-8 py-1 pr-2.5 mx-1 text-left outline-none rounded-md hover:bg-surface-base-hover/40 transition-[background-color,box-shadow,color] duration-100"
        classList={{
          "bg-surface-base-hover": props.row.active,
          "pl-9": !!props.row.nested,
          "pl-3": !props.row.nested,
        }}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          activate()
        }}
        onDragStart={(event) => {
          const contentId = props.onPrepareDrag(props.row)
          const setWorkbenchDragData = (id: string) => {
            setWorkbenchDragMime({
              dataTransfer: event.dataTransfer ?? undefined,
              mime: WORKBENCH_DRAG_MIME,
              contentId: id,
            })
          }
          if (contentId) setWorkbenchDragData(contentId)
          props.onDragStart?.({
            event,
            row: props.row.source,
            payload: navigationDragPayload(props.row.source),
            setWorkbenchDragData,
          })
        }}
      >
        <div class="flex items-baseline gap-1.5 flex-1 min-w-0 overflow-hidden">
          <span
            class="text-[13px] leading-tight truncate flex-1 min-w-0"
            classList={{
              "text-text-strong font-semibold": props.row.active,
              "text-text-weak": !props.row.active,
            }}
          >
            {props.row.title}
          </span>
          <Show when={props.row.metadata}>
            {(metadata) => (
              <span
                role="img"
                aria-label={metadata().label}
                title={metadata().label}
                class="shrink-0 text-icon-weak-base/80 leading-none"
              >
                <Icon name={metadata().icon} size="small" />
              </span>
            )}
          </Show>
        </div>

        <div class="shrink-0 relative flex items-center justify-end self-stretch min-w-7">
          <span
            class="flex items-center justify-end text-[11px] tabular-nums group-hover/session:opacity-0 transition-opacity duration-100"
            classList={{
              "text-text-base/70": props.row.active,
              "text-text-weaker": !props.row.active,
            }}
          >
            <Show when={status() !== "idle"} fallback={props.row.timeLabel}>
              <NavigationStatusDot status={status()} active={props.row.active} />
            </Show>
          </span>
          <button
            type="button"
            aria-label={`Archive ${props.row.title}`}
            class="absolute inset-0 flex items-center justify-end opacity-0 group-hover/session:opacity-100 transition-opacity duration-100 border-none bg-transparent p-0"
            onClick={(event) => {
              event.stopPropagation()
              props.onArchive?.(props.row)
            }}
          >
            <span class="text-icon-weak-base hover:text-icon-base transition-colors cursor-pointer">
              <Icon name="archive" size="small" />
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

function NavigationStatusDot(props: { status: SwitcherStatus; active?: boolean }) {
  if (props.status === "working") {
    return (
      <span
        aria-hidden="true"
        data-sidebar-status={props.status}
        class="relative size-2.5 shrink-0 rounded-full border border-border-interactive-base/40"
        classList={{
          "border-border-interactive-base": props.active,
          "border-border-interactive-base/40": !props.active,
        }}
      >
        <span class="absolute inset-0.5 rounded-full bg-icon-warning-base animate-pulse" />
      </span>
    )
  }

  return (
    <span
      aria-hidden="true"
      data-sidebar-status={props.status}
      class="size-2.5 shrink-0 rounded-full"
      classList={{
        "bg-icon-warning-base": props.status === "permission",
        "bg-icon-success-base": props.status === "done",
        "bg-text-weaker": props.status === "idle",
      }}
    />
  )
}
