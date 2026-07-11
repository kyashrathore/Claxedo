import { onCleanup, type JSX } from "solid-js"
import { useDragSource } from "../workbench"
import type { SwitcherStatus } from "../compact-switcher/switcher-items"
import {
  navigationDragPayload,
  type NavigationDragStart,
  type SessionNavigationRow,
  type TerminalSurfaceRow,
} from "./session-navigation"

/**
 * Shared row shell for the sidebar navigation islands (session rows and
 * terminal-surface rows). Both islands previously reimplemented the identical
 * activation + `draggable` + workbench drag-mime wiring; this primitive owns
 * that shell so a keyboard-nav or drag fix lands in one place. Per-island
 * content (title, status, trailing action) is passed as children.
 *
 * WP-C1 semantics: the row's activate target is a real native `<button>`
 * (Enter/Space handled by the platform, not a hand-rolled `role="button"` +
 * keydown div) carrying `aria-current` for the active row. It's an
 * absolutely-positioned overlay covering the row, so per-island trailing
 * controls (archive / close) stay as SIBLINGS above it rather than interactive
 * descendants of a button (`nested-interactive`). Those controls just need to
 * sit above the overlay (`relative z-10`).
 */

const ROW_SHELL_CLASS =
  "relative flex items-center gap-2 min-h-8 py-1 pr-2.5 mx-1 text-left outline-none rounded-md hover:bg-surface-base-hover/40 transition-[background-color,box-shadow,color] duration-100"

export type NavigationRowProps = {
  /** Extra classes appended to the shared shell (e.g. a `group/*` marker). */
  class?: string
  classList?: Record<string, boolean | undefined>
  /** Data attributes stamped onto the row element (test hooks + drag targets). */
  data?: Record<string, string | undefined>
  /**
   * Accessible name for the row's activate button. Defaults to the drag row's
   * title (the visible label), so AT announces e.g. "Build sidebar, button".
   */
  label?: string
  /** Marks the row as the current selection — exposes `aria-current="page"`. */
  active?: boolean
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

  // Pointer-driven drag source (mouse + touch + pen), replacing native HTML5
  // `draggable`/`onDragStart` so sidebar rows can be dragged onto a workbench
  // pane on touch devices too (WP-C3). `prepareContentId` still resolves (and
  // side-effect-mints) the workbench content id the drag carries; the typed
  // `NavigationDragStart` is still emitted on begin. The controller owns the
  // in-memory payload, so there is no `DataTransfer` to seed anymore.
  const registerDrag = (el: HTMLElement) => {
    const dispose = useDragSource(el, {
      contentId: () => props.prepareContentId?.(),
      sourceKind: "navigation-row",
      label: () => props.dragRow.title,
      onBegin: (event) => {
        props.onDragStart?.({
          // The pointer engine (not native DnD) now drives drags, so this is a
          // PointerEvent; consumers don't read `.event`, only payload + contentId.
          // as-any: NavigationDragStart still types `event` as DragEvent for API stability.
          event: event as unknown as DragEvent,
          row: props.dragRow,
          payload: navigationDragPayload(props.dragRow),
          setWorkbenchDragData: () => {},
        })
      },
    })
    onCleanup(dispose)
  }

  return (
    <div
      {...props.data}
      ref={registerDrag}
      class={props.class ? `${ROW_SHELL_CLASS} ${props.class}` : ROW_SHELL_CLASS}
      classList={props.classList}
    >
      {/* Native activate control. Absolute overlay (ROW_SHELL_CLASS is
          `relative`) so the row's own trailing buttons remain siblings, not
          nested interactive descendants. `touch-pan-y` matches the container
          drag source's `touch-action` (WP-C3a finding 2): the overlay covers the
          whole row, so it must leave vertical panning to the browser too — else
          the sidebar's touch scroll dies on top of the drag engine, which only
          begins on an intentional long-press. */}
      <button
        type="button"
        aria-label={props.label ?? props.dragRow.title}
        aria-current={props.active ? "page" : undefined}
        class="absolute inset-0 rounded-md outline-none touch-pan-y focus-visible:ring-2 focus-visible:ring-border-interactive-base"
        onClick={activate}
      />
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
