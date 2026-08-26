import { For, Show, createMemo } from "solid-js"
import { ClaxedoIcon as Icon, ClaxedoIconV2 } from "@/ui/controls/claxedo-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import {
  NavigationRow,
  NavigationRowGlyph,
  NavigationStatusDot,
  type SwitcherStatus,
} from "@/features/terminal/app-ports"
import { terminalSurfaceTitle } from "./terminal-surface-title"
import {
  type NavigationDragStart,
  type RowActivityDetail,
  type TerminalSurfaceRow,
} from "@/features/terminal/app-ports"

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
      class={[
        "group/terminal",
        {
          "bg-surface-base-hover": props.row.active,
          "pl-9": !!props.nested,
          "pl-3": !props.nested,
        },
      ]}
      data={{
        "data-testid": "rail-sidebar-terminal-row",
        "data-terminal-id": props.row.terminalId,
        "data-pane-id": props.row.contentId,
        "data-content-id": props.row.contentId,
        "data-active": props.row.active ? "true" : "false",
        "data-pending": props.row.pending ? "true" : "false",
      }}

      label={terminalSurfaceTitle(props.row.title, status())}
      active={props.row.active}
      onActivate={activate}
      dragRow={props.row}
      prepareContentId={() => props.row.contentId}
      onDragStart={props.onDragStart}
    >
      {/* A nested terminal row puts its glyph in the shared row-glyph column,
          out of the flow — so its title starts at the SAME x as every session
          title beside it. In flow the icon plus the row's `gap-2` pushed
          terminal text 24px right of its neighbours, which read as a broken
          hierarchy rather than a type distinction.

          Status REPLACES the terminal icon in that column rather than sitting
          beside it. Two glyphs do not fit in a 16px step without crowding the
          label, and while a terminal is working its status is the salient fact
          — its type is still carried by the monospace label and its "Claude:"
          prefix. The icon returns the moment it settles. */}
      <Show
        when={props.nested}
        fallback={
          <>
            <span
              aria-hidden="true"
              data-slot="terminal-row-icon"
              class={[
                "relative z-[1] pointer-events-none flex size-4 shrink-0 items-center justify-center",
                {
                  "text-text-strong": props.row.active,
                  "text-icon-weak-base": !props.row.active,
                },
              ]}
            >
              <Icon name="terminal" size="small" />
            </span>
            <Show when={status() !== "idle"}>
              <span class="relative z-[1] pointer-events-none flex">
                <NavigationStatusDot status={status()} active={props.row.active} />
              </span>
            </Show>
          </>
        }
      >
        <NavigationRowGlyph>
          <Show
            when={status() !== "idle"}
            fallback={
              <span
                aria-hidden="true"
                data-slot="terminal-row-icon"
                class={[
                  "flex items-center justify-center",
                  {
                    "text-text-strong": props.row.active,
                    "text-icon-weak-base": !props.row.active,
                  },
                ]}
              >
                <Icon name="terminal" size="small" />
              </span>
            }
          >
            <NavigationStatusDot status={status()} active={props.row.active} />
          </Show>
        </NavigationRowGlyph>
      </Show>
      <span
        class={[
          "relative z-[1] pointer-events-none font-mono text-sm leading-tight truncate flex-1 min-w-0",
          {
            "text-text-strong font-semibold": props.row.active,
            "text-text-weak": !props.row.active,
          },
        ]}
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
          data-slot="terminal-row-close"
          /* `rounded-sm`, matching `--radius-sm` in icon-button.css — the hover
             chip behind a dismiss X is the same shape here as on every other
             icon button, not a circle. */
          class="relative z-10 -mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm border-none bg-transparent p-0 leading-none text-icon-weak-base opacity-0 transition-[opacity,background-color,color] duration-100 hover:bg-surface-base-hover hover:text-icon-strong-base group-hover/terminal:opacity-100 focus:opacity-100 focus-visible:bg-surface-base-hover focus-visible:outline-none"
          onClick={(event) => {
            event.stopPropagation()
            props.onClose(props.row)
          }}
        >
          <ClaxedoIconV2 name="close-small" size="small" />
        </button>
      </Tooltip>
    </NavigationRow>
  )
}
