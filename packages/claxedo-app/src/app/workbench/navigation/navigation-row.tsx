import { Show, onCleanup, type JSX } from "solid-js"
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
  "relative flex items-center gap-2 min-h-7 py-0.5 pr-2.5 mx-1 text-left outline-none rounded-md hover:bg-surface-base-hover/40 transition-[background-color,box-shadow,color] duration-100"

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
  /** Begin read-only activation preparation at the trusted pointer boundary. */
  onPrepareActivate?: () => void
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
        data-slot="navigation-row-activate"
        aria-label={props.label ?? props.dragRow.title}
        aria-current={props.active ? "page" : undefined}
        class="absolute inset-0 rounded-md outline-none touch-pan-y focus-visible:ring-2 focus-visible:ring-border-interactive-base"
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
 * ONE column, shared by every row type, is the whole point. The rail is an
 * indented tree — workspace, then section, then rows — and in a tree a row's
 * own mark belongs at its own indent step, immediately before its label. An
 * earlier attempt parked the status dot at the far-left edge of the row
 * (`left-1.5`, x≈11), which put it LEFT of the workspace icon above it: the
 * deepest item in the tree ended up with the outermost mark, inverting the
 * hierarchy, and it read as debris floating in the margin rather than as part
 * of the row.
 *
 * Sized and placed to match the terminal glyph that already lived here
 * (`left-4`, `size-4` → x 21-37 against a title at 41), so glyphs and labels
 * form two clean vertical columns down the whole list. Absolute, so a row with
 * no glyph still starts its title at exactly the same x — alignment is what
 * makes a dense list read as calm.
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
export function NavigationRowStatusGutter(props: { status: SwitcherStatus; active?: boolean }) {
  // `<Show>`, NOT an early `if (props.status === "idle") return null`. A Solid
  // component body runs exactly once, so an early return would capture whatever
  // status the row had at mount — idle, for every row that has not started work
  // yet — and the glyph would never appear when that row later went busy.
  // `NavigationStatusDot` has the same early-return shape and survives it only
  // because every caller already wraps it in its own `<Show>`.
  return (
    <Show when={props.status !== "idle"}>
      <NavigationRowGlyph>
        <NavigationStatusDot status={props.status} active={props.active} />
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
export function NavigationStatusDot(props: { status: SwitcherStatus; active?: boolean }) {
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
