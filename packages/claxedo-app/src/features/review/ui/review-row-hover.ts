import { createSelector, createSignal, onCleanup, type JSX } from "solid-js"

/**
 * How long a row's control cluster stays mounted after the pointer leaves it.
 * The cluster fades out through a CSS opacity transition of the same length;
 * unmounting it before that finishes would make it vanish instead of fade.
 * Keep in sync with the `session-review-row-controls` transition in
 * `app/styles/ui-overrides.css`.
 */
export const REVIEW_ROW_CONTROLS_FADE_MS = 120

/**
 * How long the pointer must REST on a row before entering it counts as intent.
 * A pointer that is still moving is passing through, not choosing, and a
 * pointer sweeping the list would otherwise ask for every file it crossed. The
 * dwell also keeps intent strictly separated from the press that follows it: no
 * work can start in the sliver between a pointer arriving and a button going
 * down, so an interaction measured from its trusted pointerdown can never be
 * charged for it.
 */
export const REVIEW_ROW_HOVER_INTENT_MS = 60

export type ReviewRowHoverOwner = {
  /**
   * Whether this row's hover-only control cluster should exist right now: the
   * hovered row, the row still fading out, and any row holding focus.
   */
  controlsMounted: (file: string) => boolean
  onPointerOver: JSX.EventHandler<HTMLElement, PointerEvent>
  onPointerOut: JSX.EventHandler<HTMLElement, PointerEvent>
  onFocusIn: JSX.EventHandler<HTMLElement, FocusEvent>
  onFocusOut: JSX.EventHandler<HTMLElement, FocusEvent>
}

const rowOf = (node: EventTarget | null) =>
  node instanceof Element ? node.closest("[data-review-file]")?.getAttribute("data-review-file") ?? undefined : undefined

/**
 * Where the pointer last actually moved to, tracked for the DOCUMENT rather
 * than per list. A review list is rebuilt on every Files -> Review switch and
 * every panel reopen, and a list that starts out not knowing where the pointer
 * is cannot tell "the user just moved onto this row" from "these rows appeared
 * under a resting pointer" — it would read its own first boundary event as
 * intent and fetch inside an interaction that is gated at zero requests.
 *
 * Boundary events (pointerover) are dispatched BEFORE the pointermove that
 * carries the same movement, so at the moment a row is entered this still holds
 * the previous position: different from the event's point for a real move,
 * identical to it when only the DOM moved.
 */
let pointerPointX = Number.NaN
let pointerPointY = Number.NaN
let trackingPointer = false
function trackDocumentPointer() {
  if (trackingPointer || typeof document === "undefined") return
  trackingPointer = true
  document.addEventListener(
    "pointermove",
    (event) => {
      pointerPointX = event.clientX
      pointerPointY = event.clientY
    },
    { capture: true, passive: true },
  )
}

/**
 * ONE hover owner for a whole review file list.
 *
 * `pointerover` / `pointerout` / `focusin` / `focusout` all bubble, so the row
 * container answers for every row at once; per-row listeners would cost the
 * list exactly what thinning its rows removed. Two things depend on it:
 *
 * 1. Which row's control cluster is mounted. The cluster (copy, chevron, open)
 *    is `opacity: 0; pointer-events: none` until its own row is hovered or
 *    focused, so only one row can ever show it — every other row was building
 *    a dozen elements and two Kobalte Tooltips for something nobody could see.
 * 2. Hover intent: entering a row is the signal to fetch what pressing it will
 *    need, before the press rather than inside it. The owner only reports the
 *    intent; the caller decides what (if anything) to load.
 *
 * Entering a row is not by itself intent, and three things say so. Chromium
 * re-fires pointerover when rows materialize or shift under a stationary cursor
 * (the window scrolling, a row above collapsing) — the DOM moved, not the
 * pointer, and the event carries the same client point as the last real move.
 * A pointer with a button held is dragging (resizing the panel sweeps it across
 * the whole list). And a pointer that has not come to rest is passing through.
 * All three would otherwise make interactions that are gated at zero network
 * requests start making them. Mounting the control cluster is safe in every one
 * of those cases — the CSS `:hover` it mirrors matches then too — so only the
 * intent callback is gated.
 */
export function createReviewRowHoverOwner(input: { onHoverIntent: (file: string) => void }): ReviewRowHoverOwner {
  const [hoveredRow, setHoveredRow] = createSignal<string | undefined>()
  const [leavingRow, setLeavingRow] = createSignal<string | undefined>()
  const [focusedRow, setFocusedRow] = createSignal<string | undefined>()
  const isHoveredRow = createSelector(hoveredRow)
  const isLeavingRow = createSelector(leavingRow)
  const isFocusedRow = createSelector(focusedRow)

  let leaveTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (leaveTimer !== undefined) clearTimeout(leaveTimer)
  })

  // Event handlers run outside any tracking scope, so these signal reads
  // observe the current value without subscribing anything to it.
  const hoverRow = (file: string | undefined) => {
    const previous = hoveredRow()
    if (previous === file) return
    setHoveredRow(file)
    if (previous === undefined) return
    setLeavingRow(previous)
    if (leaveTimer !== undefined) clearTimeout(leaveTimer)
    leaveTimer = setTimeout(() => setLeavingRow(undefined), REVIEW_ROW_CONTROLS_FADE_MS)
  }

  trackDocumentPointer()
  let intendedRow: string | undefined
  let intentTimer: ReturnType<typeof setTimeout> | undefined
  const cancelIntent = () => {
    if (intentTimer === undefined) return
    clearTimeout(intentTimer)
    intentTimer = undefined
  }
  onCleanup(cancelIntent)
  const hoverIntent = (file: string | undefined, event: PointerEvent) => {
    cancelIntent()
    if (file === undefined || intendedRow === file) return
    // A held button is a drag, not a hover: resizing the panel sweeps the
    // pointer across rows with the button down, and every row it crosses would
    // otherwise be asked for.
    if (event.buttons !== 0) return
    if (event.clientX === pointerPointX && event.clientY === pointerPointY) return
    intentTimer = setTimeout(() => {
      intentTimer = undefined
      intendedRow = file
      input.onHoverIntent(file)
    }, REVIEW_ROW_HOVER_INTENT_MS)
  }

  return {
    controlsMounted: (file) => isHoveredRow(file) || isLeavingRow(file) || isFocusedRow(file),
    onPointerOver: (event) => {
      const file = rowOf(event.target)
      hoverRow(file)
      hoverIntent(file, event)
    },
    onPointerOut: (event) => {
      const related = event.relatedTarget
      // Moving between elements of the same list is answered by the pointerover
      // that follows; only leaving the list itself clears the hovered row.
      if (related instanceof Node && event.currentTarget.contains(related)) return
      cancelIntent()
      hoverRow(undefined)
    },
    onFocusIn: (event) => setFocusedRow(rowOf(event.target)),
    onFocusOut: (event) => {
      if (rowOf(event.relatedTarget) === focusedRow()) return
      setFocusedRow(undefined)
    },
  }
}
