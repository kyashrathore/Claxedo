import { type JSX } from "solid-js"
import { WORKBENCH_DRAG_MIME } from "../workbench"
import type { SwitcherStatus } from "../compact-switcher/switcher-items"
import {
  navigationDragPayload,
  setWorkbenchDragMime,
  type NavigationDragStart,
  type SessionNavigationRow,
  type TerminalSurfaceRow,
} from "./session-navigation"

/**
 * Shared row shell for the sidebar navigation islands (session rows and
 * terminal-surface rows). Both islands previously reimplemented the identical
 * `role="button"` + Enter/Space keyboard activation + `draggable` + workbench
 * drag-mime wiring; this primitive owns that shell so a keyboard-nav or drag
 * fix lands in one place. Per-island content (title, status, trailing action)
 * is passed as children. ARIA semantics polish (native `<button>` /
 * `aria-current`) is deferred to WP-C1, which builds on this primitive.
 */

const ROW_SHELL_CLASS =
  "relative flex items-center gap-2 min-h-8 py-1 pr-2.5 mx-1 text-left outline-none rounded-md hover:bg-surface-base-hover/40 transition-[background-color,box-shadow,color] duration-100"

export type NavigationRowProps = {
  /** Extra classes appended to the shared shell (e.g. a `group/*` marker). */
  class?: string
  classList?: Record<string, boolean | undefined>
  /** Data attributes stamped onto the row element (test hooks + drag targets). */
  data?: Record<string, string | undefined>
  onActivate: () => void
  /** The domain row used to build the typed drag payload. */
  dragRow: SessionNavigationRow | TerminalSurfaceRow
  /**
   * Resolve the workbench content id to seed into the drag `dataTransfer`.
   * Return `undefined` to skip seeding (session rows without a live content id).
   */
  prepareContentId?: () => string | undefined
  onDragStart?: (input: NavigationDragStart) => void
  children: JSX.Element
}

export function NavigationRow(props: NavigationRowProps) {
  const activate = () => props.onActivate()

  return (
    <div
      role="button"
      tabIndex={0}
      {...props.data}
      ref={(el) => el.setAttribute("draggable", "true")}
      class={props.class ? `${ROW_SHELL_CLASS} ${props.class}` : ROW_SHELL_CLASS}
      classList={props.classList}
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
        const contentId = props.prepareContentId?.()
        if (contentId) setWorkbenchDragData(contentId)
        props.onDragStart?.({
          event,
          row: props.dragRow,
          payload: navigationDragPayload(props.dragRow),
          setWorkbenchDragData,
        })
      }}
    >
      {props.children}
    </div>
  )
}

/**
 * Sidebar status indicator dot shared by both navigation islands. `working`
 * renders a pulsing ringed dot; every other lifecycle state renders a solid
 * dot colored by status. `aria-hidden` because the surrounding row already
 * conveys status textually.
 */
export function NavigationStatusDot(props: { status: SwitcherStatus; active?: boolean }) {
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
