import { storePath } from "solid-js"
// Rail slice behavior spec (vitest — needs fake timers + a reactive owner for
// the hover/collapse timers and their onCleanup).
//
// The audit flagged the hover/hot-zone/mute/cooldown timer logic as the
// riskiest untested state machine in this slice. These specs drive it through
// the real exported `createRailSlice` against fake timers.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { createStore } from "solid-js"
import { createRailSlice, type RailSliceApi } from "./rail"
import { emptyClaxedoState } from "./persistence"
import type { ClaxedoState } from "./types"

const EXPAND_DELAY = 100
const COLLAPSE_DELAY = 100
const COOLDOWN_MS = 500

function mountRail(railSeed?: Partial<ClaxedoState["rail"]>) {
  let dispose = () => {}
  let rail!: RailSliceApi
  let state!: ClaxedoState
  createRoot((d) => {
    dispose = d
    const [s, setState] = createStore<ClaxedoState>(emptyClaxedoState())
    if (railSeed) setState(storePath("rail", railSeed))
    state = s
    rail = createRailSlice({ state: s, setState })
  })
  return { rail, state, dispose }
}

describe("rail slice — hot-zone peek", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("hot-zone enter on a collapsed unpinned rail reveals hover now and expands after the delay", () => {
    const { rail, state, dispose } = mountRail({ collapsed: true, pinned: false, hovered: false })
    rail.handleHotZoneEnter()
    expect(state.rail.hovered).toBe(true)
    expect(state.rail.collapsed).toBe(true)
    vi.advanceTimersByTime(EXPAND_DELAY)
    expect(state.rail.collapsed).toBe(false)
    dispose()
  })

  test("hot-zone enter is a no-op while pinned", () => {
    const { rail, state, dispose } = mountRail({ collapsed: true, pinned: true, hovered: false })
    rail.handleHotZoneEnter()
    vi.advanceTimersByTime(EXPAND_DELAY)
    expect(state.rail.hovered).toBe(false)
    expect(state.rail.collapsed).toBe(true)
    dispose()
  })

  test("hot-zone enter is a no-op when the rail is already expanded", () => {
    const { rail, state, dispose } = mountRail({ collapsed: false, pinned: false, hovered: false })
    rail.handleHotZoneEnter()
    expect(state.rail.hovered).toBe(false)
    dispose()
  })
})

describe("rail slice — mute after unpin toggle", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("toggling a pinned rail off mutes the immediate hot-zone peek until the cursor leaves the zone", () => {
    const { rail, state, dispose } = mountRail({ collapsed: false, pinned: true, hovered: false })
    rail.toggle() // pinned -> unpinned + collapsed, arms mutedUntilLeave
    expect(state.rail.pinned).toBe(false)
    expect(state.rail.collapsed).toBe(true)

    rail.handleHotZoneEnter() // suppressed while muted
    vi.advanceTimersByTime(EXPAND_DELAY)
    expect(state.rail.hovered).toBe(false)
    expect(state.rail.collapsed).toBe(true)

    // Cursor leaving the hot zone (tracked outside it) clears the mute.
    rail.trackPosition(200, 200, { top: 0, right: 260, bottom: 800 })
    rail.handleHotZoneEnter()
    expect(state.rail.hovered).toBe(true)
    dispose()
  })
})

describe("rail slice — leave-to-edge cooldown", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("leaving toward the left edge collapses then suppresses re-peek until the cooldown expires", () => {
    const { rail, state, dispose } = mountRail({ collapsed: false, pinned: false, hovered: true })
    rail.handleMouseLeave({ clientX: 10 } as MouseEvent) // leaving to the left edge
    vi.advanceTimersByTime(COLLAPSE_DELAY)
    expect(state.rail.collapsed).toBe(true)
    expect(state.rail.hovered).toBe(false)

    // Immediately re-entering the hot zone is suppressed by the cooldown.
    rail.handleHotZoneEnter()
    expect(state.rail.hovered).toBe(false)

    // After the cooldown, the peek works again.
    vi.advanceTimersByTime(COOLDOWN_MS)
    rail.handleHotZoneEnter()
    expect(state.rail.hovered).toBe(true)
    dispose()
  })

  test("leaving away from the edge collapses without arming a cooldown", () => {
    const { rail, state, dispose } = mountRail({ collapsed: false, pinned: false, hovered: true })
    rail.handleMouseLeave({ clientX: 400 } as MouseEvent) // not the left edge
    vi.advanceTimersByTime(COLLAPSE_DELAY)
    expect(state.rail.collapsed).toBe(true)

    rail.handleHotZoneEnter() // no cooldown -> peeks right away
    expect(state.rail.hovered).toBe(true)
    dispose()
  })
})

describe("rail slice — lock defers collapse", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("mouse leave while locked defers the collapse until unlock", () => {
    const { rail, state, dispose } = mountRail({ collapsed: false, pinned: false, locked: true })
    rail.handleMouseLeave()
    vi.advanceTimersByTime(COLLAPSE_DELAY)
    expect(state.rail.collapsed).toBe(false) // deferred while locked

    rail.unlock() // replays the deferred collapse
    vi.advanceTimersByTime(COLLAPSE_DELAY)
    expect(state.rail.collapsed).toBe(true)
    dispose()
  })

  test("cancelCollapse clears a pending collapse timer", () => {
    const { rail, state, dispose } = mountRail({ collapsed: false, pinned: false })
    rail.handleMouseLeave()
    rail.cancelCollapse()
    vi.advanceTimersByTime(COLLAPSE_DELAY)
    expect(state.rail.collapsed).toBe(false)
    dispose()
  })
})

describe("rail slice — timer cleanup", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("disposing the owner clears a pending hover timer", () => {
    const { rail, dispose } = mountRail({ collapsed: true, pinned: false })
    rail.handleHotZoneEnter()
    expect(vi.getTimerCount()).toBe(1)
    dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
