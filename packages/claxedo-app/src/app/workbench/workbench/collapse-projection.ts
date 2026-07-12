import type { PaneRect, WorkbenchState } from "./types"

/**
 * Narrow-viewport breakpoint (Tailwind `md`). Below this canvas width the
 * workbench collapses to a single full-bleed pane and hides the rest (see the
 * WP-C3 collapse design note `2026-07-11-004-wp-c3-workbench-collapse-design.md`
 * §5). This is the TS side of the token; sweeping the ad-hoc CSS literals
 * (420/639/767/900/1200) onto a matching `--bp-md` custom property is a separate
 * C3 consolidation step and is intentionally out of scope for this module.
 */
export const BP_MD = 768

/** The rect a single pane occupies when the workbench is collapsed. */
const FULL_BLEED: PaneRect = { top: 0, left: 0, width: 1, height: 1 }

/**
 * Collapsed-mode pane projection.
 *
 * Below `BP_MD` the workbench renders exactly one pane — the focused pane,
 * falling back to the first pane when focus is null (or points at a pane that
 * no longer exists) — at full bleed, and hides every other pane (they are
 * absent from the returned map, which the view treats as `display:none`).
 *
 * PURE: never reads the DOM and never mutates `state`. Splits are
 * preserved-but-hidden, not flattened — re-widening past the breakpoint simply
 * resumes driving the real `computePaneRects` geometry with no state write and
 * no reconstruction. Returns a single-entry map, or an empty map when there are
 * no panes at all.
 */
export function collapsePaneRects(state: WorkbenchState): Map<string, PaneRect> {
  const result = new Map<string, PaneRect>()
  const focused = state.focusedPaneId
  const visiblePaneId =
    focused != null && state.panes.some((pane) => pane.id === focused) ? focused : state.panes[0]?.id
  if (visiblePaneId == null) return result
  result.set(visiblePaneId, { ...FULL_BLEED })
  return result
}

/**
 * Whether a workbench of the given measured canvas width is in collapsed
 * (single-pane) mode. `width` is the workbench's OWN canvas width (its
 * `ResizeObserver`-measured `containerSize().w`), not `window.innerWidth`, so
 * collapse triggers on the space actually available to panes.
 *
 * The `width > 0` guard avoids a false collapse before the first measure
 * (SSR/jsdom report 0 until laid out).
 */
export function isCollapsedWidth(width: number): boolean {
  return width > 0 && width < BP_MD
}

/**
 * Imperative narrow-viewport check for non-reactive resolution paths (route
 * intent, which runs as one-shot imperative resolution and cannot read a
 * reactive canvas signal). Reads the live window width directly. Returns
 * `false` when there is no `window` (SSR / DOM-less test).
 */
export function isNarrowViewport(): boolean {
  if (typeof window === "undefined") return false
  return window.innerWidth < BP_MD
}
