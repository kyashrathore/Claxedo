import { For, Show, createMemo } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { WORKBENCH_DRAG_MIME } from "../layout"
import type { SwitcherStatus } from "../compact-switcher/switcher-items"
import { terminalSurfaceTitle } from "./terminal-surface-title"
import {
  navigationDragPayload,
  setWorkbenchDragMime,
  type NavigationDragStart,
  type RowActivityDetail,
  type TerminalSurfaceRow,
} from "./session-navigation"

export type TerminalSurfaceNavigationProps = {
  rows: readonly TerminalSurfaceRow[]
  nested?: boolean
  onActivate: (row: TerminalSurfaceRow) => void
  onClose: (row: TerminalSurfaceRow) => void
  onDragStart?: (input: NavigationDragStart) => void
}

export function TerminalSurfaceNavigation(props: TerminalSurfaceNavigationProps) {
  return (
    <Show when={props.rows.length > 0}>
      <div data-testid="terminal-section" class="flex flex-col gap-0.5">
        <For each={props.rows}>
          {(row) => (
            <TerminalSurfaceNavigationRow
              row={row}
              nested={props.nested}
              onActivate={props.onActivate}
              onClose={props.onClose}
              onDragStart={props.onDragStart}
            />
          )}
        </For>
      </div>
    </Show>
  )
}

export function terminalSurfaceSwitcherStatus(activity: RowActivityDetail): SwitcherStatus {
  if (activity.state === "needs_input") return "permission"
  if (activity.state === "working") return "working"
  if (activity.state === "done") return "done"
  return "idle"
}

function TerminalSurfaceNavigationRow(props: {
  row: TerminalSurfaceRow
  nested?: boolean
  onActivate: (row: TerminalSurfaceRow) => void
  onClose: (row: TerminalSurfaceRow) => void
  onDragStart?: (input: NavigationDragStart) => void
}) {
  const status = createMemo(() => terminalSurfaceSwitcherStatus(props.row.activity))
  const activate = () => props.onActivate(props.row)

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="rail-sidebar-terminal-row"
      data-terminal-id={props.row.terminalId}
      data-pane-id={props.row.contentId}
      data-content-id={props.row.contentId}
      data-active={props.row.active ? "true" : "false"}
      data-pending={props.row.pending ? "true" : "false"}
      ref={(el) => el.setAttribute("draggable", "true")}
      class="group/terminal relative flex items-center gap-2 min-h-8 py-1 pr-2.5 mx-1 text-left outline-none rounded-md hover:bg-surface-base-hover/40 transition-[background-color,box-shadow,color] duration-100"
      classList={{
        "bg-surface-base-hover": props.row.active,
        "pl-9": !!props.nested,
        "pl-3": !props.nested,
      }}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        activate()
      }}
      onDragStart={(event) => {
        const setWorkbenchDragData = (contentId: string) => {
          setWorkbenchDragMime({
            dataTransfer: event.dataTransfer ?? undefined,
            mime: WORKBENCH_DRAG_MIME,
            contentId,
          })
        }
        setWorkbenchDragData(props.row.contentId)
        props.onDragStart?.({
          event,
          row: props.row,
          payload: navigationDragPayload(props.row),
          setWorkbenchDragData,
        })
      }}
    >
      <span
        aria-hidden="true"
        class="shrink-0 select-none font-mono text-[12px] leading-none"
        classList={{
          "text-text-strong": props.row.active,
          "text-text-weaker": !props.row.active,
        }}
      >
        &gt;
      </span>
      <Show when={status() !== "idle"}>
        <SidebarStatusDot status={status()} active={props.row.active} />
      </Show>
      <span
        class="font-mono text-[12px] leading-tight truncate flex-1 min-w-0"
        classList={{
          "text-text-strong font-semibold": props.row.active,
          "text-text-weak": !props.row.active,
        }}
      >
        {terminalSurfaceTitle(props.row.title, status())}
      </span>
      <Tooltip placement="top" value="Close terminal">
        <span
          role="button"
          tabIndex={0}
          aria-label={`Close terminal: ${props.row.title}`}
          class="shrink-0 text-icon-base hover:text-icon-strong-base transition-colors cursor-pointer opacity-0 group-hover/terminal:opacity-100 focus:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            props.onClose(props.row)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            event.stopPropagation()
            props.onClose(props.row)
          }}
        >
          <Icon name="close" size="small" />
        </span>
      </Tooltip>
    </div>
  )
}

function SidebarStatusDot(props: { status: SwitcherStatus; active?: boolean }) {
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
