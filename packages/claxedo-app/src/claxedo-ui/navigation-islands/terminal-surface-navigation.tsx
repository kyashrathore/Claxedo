import { For, Show, createMemo } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { SwitcherStatus } from "../compact-switcher/switcher-items"
import { NavigationRow, NavigationStatusDot } from "./navigation-row"
import { terminalSurfaceTitle } from "./terminal-surface-title"
import {
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
    <NavigationRow
      class="group/terminal"
      data={{
        "data-testid": "rail-sidebar-terminal-row",
        "data-terminal-id": props.row.terminalId,
        "data-pane-id": props.row.contentId,
        "data-content-id": props.row.contentId,
        "data-active": props.row.active ? "true" : "false",
        "data-pending": props.row.pending ? "true" : "false",
      }}
      classList={{
        "bg-surface-base-hover": props.row.active,
        "pl-9": !!props.nested,
        "pl-3": !props.nested,
      }}
      label={terminalSurfaceTitle(props.row.title, status())}
      active={props.row.active}
      onActivate={activate}
      dragRow={props.row}
      prepareContentId={() => props.row.contentId}
      onDragStart={props.onDragStart}
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
        <NavigationStatusDot status={status()} active={props.row.active} />
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
        {/* Native button (Enter/Space handled by the platform). `relative z-10`
            keeps it above NavigationRow's absolute activate overlay so it stays
            clickable and is a sibling of — not nested inside — that button. */}
        <button
          type="button"
          aria-label={`Close terminal: ${props.row.title}`}
          class="relative z-10 shrink-0 border-none bg-transparent p-0 text-icon-base hover:text-icon-strong-base transition-colors cursor-pointer opacity-0 group-hover/terminal:opacity-100 focus:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            props.onClose(props.row)
          }}
        >
          <Icon name="close" size="small" />
        </button>
      </Tooltip>
    </NavigationRow>
  )
}
