import { Show, createEffect, on, onCleanup, type JSX } from "solid-js"
import { createHoverEngagement } from "../rail/rail-hover-engagement"
import { useDragSource } from "../workbench/index"
import type { SwitcherStatus } from "../compact-switcher/switcher-items"
import {
  navigationDragPayload,
  type NavigationDragStart,
  type SessionNavigationRow,
  type TerminalSurfaceRow,
} from "../../../features/session/ui/navigation/session-navigation"

/**
 * Shared row shell for the sidebar navigation islands (session rows and
 * terminal-surface rows): activation, drag source, and engagement in one
 * place; per-island content is passed as children.
 *
 * The activate target is a native `<button>` overlaying the whole row, so
 * trailing controls (archive / close) stay siblings above it (`relative z-10`)
 * rather than interactive descendants of a button.
 */

const ROW_SHELL_CLASS =
  "relative flex items-center gap-2 min-h-7 py-0.5 pr-2.5 mx-1 text-left outline-none rounded-md hover:bg-surface-base-hover/40"

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
  /**
   * Fires when the row becomes (or stops being) the pointer or keyboard target,
   * so an island can mount its hover-only affordances instead of parking them
   * in the DOM behind `opacity: 0`.
   *
   * The rail is the app's most repeated chrome: every mounted element in a row
   * is walked again by every whole-document style recalculation, of which each
   * interaction pays two. An archive button that is invisible 99% of the time
   * still costs its subtree on every one of those passes, in every row.
   *
   * Engagement covers focus as well as hover precisely so the affordance stays
   * keyboard-reachable: focusing the row's own activate button raises this,
   * which mounts the trailing controls, so the next Tab lands on them exactly
   * as it did when they were always mounted.
   *
   * The two are tracked independently and the row is engaged while either
   * holds, so losing focus never withdraws an affordance the pointer is still
   * resting on, and leaving with the pointer never withdraws one the keyboard
   * is still inside.
   */
  onEngagedChange?: (engaged: boolean) => void
  /** Begin the row's read-only activation preparation at pointerdown. */
  onPrepareActivate?: () => void
  onActivate: () => void
  /** Secondary gestures on the row; session rows open their menu here. */
  onDblClick?: (event: MouseEvent) => void
  onContextMenu?: (event: MouseEvent) => void
  /** The domain row used to build the typed drag payload. */
  dragRow: SessionNavigationRow | TerminalSurfaceRow
  /**
   * Resolve the workbench content id the drag carries. Return `undefined` to
   * skip (session rows without a live content id).
   */
  prepareContentId?: () => string | undefined
  onDragStart?: (input: NavigationDragStart) => void
  children: JSX.Element
}

export function NavigationRow(props: NavigationRowProps) {
  const activate = () => props.onActivate()

  // The drag controller holds the payload in memory, so `setWorkbenchDragData`
  // has nothing to seed.
  const registerDrag = (el: HTMLElement) => {
    const dispose = useDragSource(el, {
      contentId: () => props.prepareContentId?.(),
      sourceKind: "navigation-row",
      label: () => props.dragRow.title,
      // The pointer engine (not native DnD) drives drags now, so the begin
      // event is a PointerEvent. `NavigationDragStart` used to carry it as a
      // `DragEvent`, which no consumer read and which only a double assertion
      // could produce — the field is gone rather than restated as a lie.
      onBegin: () => {
        props.onDragStart?.({
          row: props.dragRow,
          payload: navigationDragPayload(props.dragRow),
          setWorkbenchDragData: () => {},
        })
      },
      // A press that drifts past the 5px threshold and is released back over the
      // rail drops onto no pane. Without this the row is dead: the drag took
      // pointer capture, so the browser retargeted the click off the activate
      // button onto this element, and no drop ran either.
      onDropMissed: activate,
    })
    onCleanup(dispose)
  }


  // Hover and focus are independent reasons for a row to be engaged; the rail's
  // engagement owner tracks them separately (`createHoverEngagement`).
  const engagement = createHoverEngagement()
  createEffect(on(engagement.engaged, (engaged) => props.onEngagedChange?.(engaged), { defer: true }))

  return (
    <div
      {...props.data}
      ref={registerDrag}
      data-active={props.active ? "true" : "false"}
      class={props.class ? `${ROW_SHELL_CLASS} ${props.class}` : ROW_SHELL_CLASS}
      classList={props.classList}
      onPointerEnter={engagement.handlers.onPointerEnter}
      onPointerLeave={engagement.handlers.onPointerLeave}
      onFocusIn={engagement.handlers.onFocusIn}
      onFocusOut={engagement.handlers.onFocusOut}
      onDblClick={props.onDblClick}
      onContextMenu={props.onContextMenu}
    >
      {/* `touch-pan-y` must match the row's drag-source `touch-action`: the
          overlay covers the whole row, so `none` here kills sidebar touch
          scrolling. */}
      <button
        type="button"
        data-slot="navigation-row-activate"
        aria-label={props.label ?? props.dragRow.title}
        aria-current={props.active ? "page" : undefined}
        class="ui-navigation-row-activate absolute inset-0 rounded-md outline-none touch-pan-y focus-visible:ring-2 focus-visible:ring-border-interactive-base"
        onPointerDown={() => props.onPrepareActivate?.()}
        onClick={activate}
      />
      {props.children}
    </div>
  )
}

/**
 * The single glyph column that precedes a nested row's label.
 *
 * A single column, shared by every row type, is the whole point. The rail is
 * an indented tree — workspace, then section, then rows — and in a tree a
 * row's own mark belongs at its own indent step, immediately before its label.
 * Parking the dot at the row's far-left edge (`left-1.5`, x≈11) would put it
 * left of the workspace icon above it: the deepest item in the tree would
 * carry the outermost mark, inverting the hierarchy and reading as debris
 * floating in the margin rather than as part of the row.
 *
 * Sized and placed to match the terminal glyph that already lives here
 * (`left-4`, `size-4` → x 21-37 against a title at 41), so glyphs and labels
 * form two clean vertical columns down the whole list. Absolute, so a row with
 * no glyph still starts its title at the same x — alignment is what makes a
 * dense list read as calm.
 *
 * Nested rows only: a top-level row indents 12px, which cannot hold a glyph
 * without crowding its own label, so those keep their inline layout.
 */
export function NavigationRowGlyph(props: { children: JSX.Element }) {
  return (
    <span
      data-slot="navigation-row-glyph"
      class="absolute left-4 top-1/2 -translate-y-1/2 z-[1] pointer-events-none flex size-4 items-center justify-center"
    >
      {props.children}
    </span>
  )
}

/**
 * The status dot in that glyph column. Separate from {@link NavigationRowGlyph}
 * so a terminal row can put its own icon in the same column when idle.
 */
export function NavigationRowStatusGutter(props: { status: SwitcherStatus }) {
  // `<Show>`, not an early `if (props.status === "idle") return null`. A Solid
  // component body runs exactly once, so an early return would capture whatever
  // status the row had at mount — idle, for every row that has not started work
  // yet — and the glyph would never appear when that row later went busy.
  // `NavigationStatusDot` has the same early-return shape and survives it only
  // because every caller already wraps it in its own `<Show>`.
  return (
    <Show when={props.status !== "idle"}>
      <NavigationRowGlyph>
        <NavigationStatusDot status={props.status} />
      </NavigationRowGlyph>
    </Show>
  )
}

/**
 * Sidebar status indicator dot shared by both navigation islands. `working`
 * renders a pulsing ringed dot; every other lifecycle state renders a solid
 * dot colored by status. `aria-hidden` because the surrounding row already
 * conveys status textually.
 */
export function NavigationStatusDot(props: { status: SwitcherStatus }) {
  // Status is conveyed by a single small dot, identical to the tab/compact-
  // switcher StatusDot (keep the two in sync). Palette is deliberately minimal —
  // grey for working/done, red only for "needs you", nothing for idle:
  //   working    → pulsing grey (in progress)
  //   done       → solid grey   (finished)
  //   permission → solid red    (needs you)
  //   idle       → no dot
  if (props.status === "idle") return null
  return (
    <span
      aria-hidden="true"
      data-sidebar-status={props.status}
      class="size-1.5 shrink-0 rounded-full"
      classList={{
        "bg-text-weak": props.status === "working" || props.status === "done",
        "animate-pulse": props.status === "working",
        "bg-icon-critical-base": props.status === "permission",
      }}
    />
  )
}
