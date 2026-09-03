import { createSignal, onCleanup, type Accessor } from "solid-js"

/**
 * "Is this row the pointer's or the keyboard's current target", for rail chrome
 * that owns hover-only affordances.
 *
 * Why it exists: the rail is the app's most repeated persistent chrome, and
 * every element mounted in it is walked again by every whole-document style
 * recalculation — of which each interaction pays two. A row-action cluster
 * parked behind `opacity: 0` therefore costs its whole subtree on every pass in
 * every row, while being invisible essentially all of the time. Mounting it on
 * engagement instead removes that subtree from the pass.
 *
 * Engagement is hover OR focus OR an explicit hold, and the three are tracked
 * as independent facts: focusing a row's own control mounts its actions, so
 * keyboard users still reach them with the next Tab exactly as they did when
 * the cluster was always mounted, and losing focus never withdraws an
 * affordance the pointer is still resting on (a pointer that never left fires
 * no second `pointerenter`), just as leaving with the pointer never withdraws
 * one the keyboard is still inside.
 *
 * `releaseDelayMs` keeps the cluster mounted for the length of its own
 * fade-out transition after disengagement, so an affordance that used to fade
 * away still fades away instead of vanishing on `pointerleave`.
 */
export function createHoverEngagement(input?: { releaseDelayMs?: number }): {
  engaged: Accessor<boolean>
  hold: () => void
  release: () => void
  handlers: {
    onPointerEnter: () => void
    onPointerLeave: () => void
    onFocusIn: () => void
    onFocusOut: (event: FocusEvent) => void
  }
} {
  const releaseDelayMs = input?.releaseDelayMs ?? 0
  const [engaged, setEngaged] = createSignal(false)
  let hovered = false
  let focusWithin = false
  let held = false
  let pending: ReturnType<typeof setTimeout> | undefined

  const cancel = () => {
    if (pending === undefined) return
    clearTimeout(pending)
    pending = undefined
  }
  const settle = () => {
    const next = hovered || focusWithin || held
    if (next) {
      cancel()
      setEngaged(true)
      return
    }
    if (!engaged() || pending !== undefined) return
    if (releaseDelayMs <= 0) {
      setEngaged(false)
      return
    }
    pending = setTimeout(() => {
      pending = undefined
      setEngaged(hovered || focusWithin || held)
    }, releaseDelayMs)
  }
  const hold = () => {
    held = true
    settle()
  }
  const release = () => {
    held = false
    settle()
  }
  onCleanup(cancel)

  return {
    engaged,
    hold,
    release,
    handlers: {
      onPointerEnter: () => {
        hovered = true
        settle()
      },
      onPointerLeave: () => {
        hovered = false
        settle()
      },
      onFocusIn: () => {
        focusWithin = true
        settle()
      },
      // `focusout` fires when focus moves BETWEEN two controls inside the same
      // row as well as when it leaves; only the second one disengages.
      onFocusOut: (event: FocusEvent) => {
        const next = event.relatedTarget
        const host = event.currentTarget
        if (next instanceof Node && host instanceof Node && host.contains(next)) return
        focusWithin = false
        settle()
      },
    },
  }
}

/**
 * The box a rail header's action cluster reserves while its buttons are not
 * mounted.
 *
 * The cluster sits in the header's flex row beside a `truncate`d title, and it
 * is the tallest thing in that row. An empty cluster would therefore both let
 * the title render wider (and re-truncate the moment the pointer arrived) and
 * drop the header's own height, shifting every row beneath it — measured as a
 * 2px lift of the whole session list. Reserving the exact box the buttons
 * occupy keeps the idle and engaged headers pixel-identical.
 *
 * The arithmetic is the cluster's own layout: `size-6` buttons (1.5rem square)
 * in a `gap-0.5` (0.125rem) row.
 */
export const RAIL_HEADER_ACTION_SIZE_REM = 1.5
export const RAIL_HEADER_ACTION_GAP_REM = 0.125

export function railHeaderActionsBox(count: number) {
  if (count <= 0) return { width: "0rem", height: "0rem" }
  const width = count * RAIL_HEADER_ACTION_SIZE_REM + (count - 1) * RAIL_HEADER_ACTION_GAP_REM
  return { width: `${width}rem`, height: `${RAIL_HEADER_ACTION_SIZE_REM}rem` }
}
