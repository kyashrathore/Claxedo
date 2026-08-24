import { storePath } from "solid-js"
// Rail slice — collapsed/pinned/hovered/locked + lock/unlock/toggle/expand/collapse.
//
// Hot-zone tracking and hover timers are transient (timer references live in
// closure scope) and only affect the persisted booleans on the slice.

import { createMemo, onCleanup, type Accessor } from "solid-js"
import type { StoreSetter } from "solid-js"
import type { ClaxedoState } from "./types"

const RAIL_COLLAPSED_WIDTH = 0
const RAIL_EXPANDED_WIDTH = 260
const RAIL_MIN_WIDTH = 220
const RAIL_MAX_WIDTH = 520
const HOT_ZONE_WIDTH = 48
const HOT_ZONE_HEIGHT = 48
const EXPAND_DELAY_MS = 100
const COLLAPSE_DELAY_MS = 100

export type RailSliceApi = {
  collapsed: Accessor<boolean>
  hovered: Accessor<boolean>
  pinned: Accessor<boolean>
  locked: Accessor<boolean>
  width: Accessor<number>

  lock(): void
  unlock(): void
  expand(): void
  collapse(): void
  toggle(): void
  pin(): void
  unpin(): void
  setWidth(width: number): void

  handleHotZoneEnter(): void
  handleMouseLeave(e?: MouseEvent): void
  cancelCollapse(): void
  trackPosition(clientX: number, clientY: number, railRect: { top: number; right: number; bottom: number }): void
}

export function createRailSlice(input: { state: ClaxedoState; setState: StoreSetter<ClaxedoState> }): RailSliceApi {
  const { state, setState } = input

  let expandTimer: number | undefined
  let collapseTimer: number | undefined
  let cooldownUntil: number | undefined
  let collapseNeeded = false
  // Set when the user toggles from pinned → unpinned. The cursor is almost
  // always still inside the hot zone at that point, which would otherwise
  // re-fire the peek immediately. Cleared once the cursor leaves the hot zone.
  let mutedUntilLeave = false

  onCleanup(() => {
    if (expandTimer) clearTimeout(expandTimer)
    if (collapseTimer) clearTimeout(collapseTimer)
  })

  const rail: RailSliceApi = {
    collapsed: (() => state.rail.collapsed) as Accessor<boolean>,
    hovered: (() => state.rail.hovered) as Accessor<boolean>,
    pinned: (() => state.rail.pinned) as Accessor<boolean>,
    locked: (() => state.rail.locked) as Accessor<boolean>,
    width: createMemo(() =>
      state.rail.collapsed && !state.rail.pinned ? RAIL_COLLAPSED_WIDTH : (state.rail.width ?? RAIL_EXPANDED_WIDTH),
    ),

    lock() {
      setState(storePath("rail", "locked", true))
    },

    unlock() {
      setState(storePath("rail", "locked", false))
      if (collapseNeeded) {
        collapseNeeded = false
        rail.handleMouseLeave()
      }
    },

    expand() {
      if (collapseTimer) {
        clearTimeout(collapseTimer)
        collapseTimer = undefined
      }
      setState(storePath("rail", "collapsed", false))
    },

    collapse() {
      if (state.rail.pinned) return
      if (expandTimer) {
        clearTimeout(expandTimer)
        expandTimer = undefined
      }
      setState(storePath("rail", "collapsed", true))
      setState(storePath("rail", "hovered", false))
    },

    toggle() {
      if (expandTimer) {
        clearTimeout(expandTimer)
        expandTimer = undefined
      }
      if (collapseTimer) {
        clearTimeout(collapseTimer)
        collapseTimer = undefined
      }
      void (() => {
        if (state.rail.pinned) {
          mutedUntilLeave = true
          setState(storePath("rail", "pinned", false))
          setState(storePath("rail", "collapsed", true))
          setState(storePath("rail", "hovered", false))
          return
        }
        setState(storePath("rail", "pinned", true))
        setState(storePath("rail", "collapsed", false))
        setState(storePath("rail", "hovered", false))
      })()
    },

    pin() {
      setState(storePath("rail", "pinned", true))
      setState(storePath("rail", "collapsed", false))
    },

    unpin() {
      setState(storePath("rail", "pinned", false))
    },

    setWidth(width) {
      if (!Number.isFinite(width)) return
      setState(storePath("rail", "width", Math.min(Math.max(width, RAIL_MIN_WIDTH), RAIL_MAX_WIDTH)))
    },

    handleHotZoneEnter() {
      if (state.rail.pinned || !state.rail.collapsed) return
      if (mutedUntilLeave) return
      if (cooldownUntil && Date.now() < cooldownUntil) return
      setState(storePath("rail", "hovered", true))
      if (collapseTimer) {
        clearTimeout(collapseTimer)
        collapseTimer = undefined
      }
      const timer = window.setTimeout(() => {
        setState(storePath("rail", "collapsed", false))
        expandTimer = undefined
      }, EXPAND_DELAY_MS)
      expandTimer = timer
    },

    handleMouseLeave(e?: MouseEvent) {
      if (state.rail.pinned) return
      if (state.rail.locked) {
        collapseNeeded = true
        return
      }
      collapseNeeded = false
      if (expandTimer) {
        clearTimeout(expandTimer)
        expandTimer = undefined
      }
      const isLeavingToLeft = e && e.clientX <= HOT_ZONE_WIDTH
      const timer = window.setTimeout(() => {
        if (state.rail.locked) {
          collapseNeeded = true
          return
        }
        void (() => {
          setState(storePath("rail", "collapsed", true))
          setState(storePath("rail", "hovered", false))
          collapseTimer = undefined
          if (isLeavingToLeft) {
            cooldownUntil = Date.now() + 500
          }
        })()
      }, COLLAPSE_DELAY_MS)
      collapseTimer = timer
    },

    cancelCollapse() {
      collapseNeeded = false
      if (collapseTimer) {
        clearTimeout(collapseTimer)
        collapseTimer = undefined
      }
    },

    trackPosition(clientX, clientY, railRect) {
      if (state.rail.pinned) {
        mutedUntilLeave = false
        return
      }
      if (state.rail.collapsed) {
        const inHotZone = clientX <= HOT_ZONE_WIDTH && clientY <= HOT_ZONE_HEIGHT
        if (inHotZone) {
          rail.handleHotZoneEnter()
        } else {
          mutedUntilLeave = false
        }
        return
      }
      const isOutside = clientX > railRect.right || clientY < railRect.top || clientY > railRect.bottom
      if (isOutside) {
        if (!collapseTimer) rail.handleMouseLeave()
        return
      }
      rail.cancelCollapse()
    },
  }

  return rail
}
