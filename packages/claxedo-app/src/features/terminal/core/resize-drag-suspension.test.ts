/**
 * Regression test: terminal resize must NOT fire during pane drag.
 *
 * During split/pane resizing, the drag handler sets
 * `document.documentElement.dataset.terminalResizeSuspended = "1"`.
 * The ResizeObserver callback in setupResizeHandlers calls checkSuspension(),
 * which suspends the coordinator. All intermediate resize events are queued.
 * On pointer-up the flag is removed and "opencode:terminal-fit" is dispatched,
 * which calls checkSuspension() again → coordinator.resume() → single settle
 * with the final container dimensions.
 *
 * This test emulates that full drag cycle using the same fake clock/raf
 * infrastructure as resize-coordinator.test.ts.
 */

import { describe, expect, test } from "bun:test"
import { createResizeCoordinator, type ResizeCoordinatorDeps } from "./resize-coordinator"
import { SETTLE_MS } from "./config"

// ---------------------------------------------------------------------------
// Fake clock + raf (copied from resize-coordinator.test.ts)
// ---------------------------------------------------------------------------

function fakeClock() {
  const timers: Array<{ id: number; fn: () => void; at: number }> = []
  let now = 0
  let nextId = 1

  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = nextId++
      timers.push({ id, fn, at: now + ms })
      return id
    },
    clearTimeout(id: number) {
      const idx = timers.findIndex((t) => t.id === id)
      if (idx >= 0) timers.splice(idx, 1)
    },
    advance(ms: number) {
      const target = now + ms
      while (true) {
        const next = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        now = next.at
        const idx = timers.findIndex((t) => t.id === next.id)
        if (idx >= 0) timers.splice(idx, 1)
        next.fn()
      }
      now = target
    },
    pending: () => timers.length,
  }
}

function fakeRaf() {
  const queue: Array<{ id: number; fn: () => void }> = []
  let nextId = 1

  return {
    request(fn: () => void) {
      const id = nextId++
      queue.push({ id, fn })
      return id
    },
    cancel(id: number) {
      const idx = queue.findIndex((q) => q.id === id)
      if (idx >= 0) queue.splice(idx, 1)
    },
    flush() {
      const fns = queue.splice(0)
      for (const { fn } of fns) fn()
    },
    pending: () => queue.length,
  }
}

// ---------------------------------------------------------------------------
// Emulate the checkSuspension bridge from setupResizeHandlers (helpers.ts)
// ---------------------------------------------------------------------------

function createSuspensionBridge(coordinator: ReturnType<typeof createResizeCoordinator>) {
  let suspended = false

  return {
    /** Call before coordinator.request() — mirrors checkSuspension() in helpers.ts */
    check(isSuspended: boolean) {
      if (isSuspended && !suspended) {
        coordinator.suspend()
      } else if (!isSuspended && suspended) {
        coordinator.resume()
      }
      suspended = isSuspended
    },
  }
}

// ---------------------------------------------------------------------------
// Test helper: create a coordinator + container at a given width
// ---------------------------------------------------------------------------

function makeDragTestHarness(initialWidth = 800) {
  const clock = fakeClock()
  const raf = fakeRaf()
  let width = initialWidth
  const height = 600
  let cols = Math.floor(width / 8.4)
  let rows = Math.floor((height - 32) / 17)
  let fitCount = 0
  let refreshCount = 0
  let notifyCount = 0
  let lastNotifiedCols = 0
  let lastNotifiedRows = 0

  const deps: ResizeCoordinatorDeps = {
    fit: () => {
      fitCount++
      cols = Math.max(2, Math.floor(width / 8.4))
      rows = Math.max(2, Math.floor((height - 32) / 17))
    },
    measure: () => ({ width, height }),
    getCols: () => cols,
    getRows: () => rows,
    refresh: () => {
      refreshCount++
    },
    notify: (c, r) => {
      notifyCount++
      lastNotifiedCols = c
      lastNotifiedRows = r
    },
    clock,
    raf,
  }

  const coordinator = createResizeCoordinator(deps)
  const bridge = createSuspensionBridge(coordinator)

  return {
    coordinator,
    bridge,
    clock,
    raf,
    setWidth: (w: number) => {
      width = w
    },
    getWidth: () => width,
    getCols: () => cols,
    getRows: () => rows,
    stats: () => ({ fitCount, refreshCount, notifyCount, lastNotifiedCols, lastNotifiedRows }),
    resetStats: () => {
      fitCount = 0
      refreshCount = 0
      notifyCount = 0
    },
    /**
     * Emulates what happens when ResizeObserver fires:
     * checkSuspension() then coordinator.request("resize-observer")
     */
    fireResizeObserver: (isSuspended: boolean) => {
      bridge.check(isSuspended)
      coordinator.request("resize-observer")
    },
    /**
     * Emulates the "opencode:terminal-fit" event handler:
     * checkSuspension() then coordinator.request("fit-event")
     */
    fireFitEvent: (isSuspended: boolean) => {
      bridge.check(isSuspended)
      coordinator.request("fit-event")
    },
    /** Settle all pending timers + RAF */
    settle: () => {
      raf.flush()
      clock.advance(SETTLE_MS)
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resize drag suspension", () => {
  test("without suspension: every resize observer event triggers a settle", () => {
    const h = makeDragTestHarness(800)

    // Initial mount
    h.fireResizeObserver(false)
    h.settle()
    h.resetStats()

    // Simulate 10 rapid resize observer events (as during drag) — NO suspension
    for (let i = 0; i < 10; i++) {
      h.setWidth(800 - i * 30)
      h.fireResizeObserver(false)
      // Each time, advance past settle so it fires
      h.settle()
    }

    // Each settle triggers fit+refresh
    expect(h.stats().fitCount).toBe(10)
    expect(h.stats().refreshCount).toBe(10)

    h.coordinator.dispose()
  })

  test("with suspension: resize observer events during drag are all suppressed", () => {
    const h = makeDragTestHarness(800)

    // Initial mount + settle
    h.fireResizeObserver(false)
    h.settle()
    h.resetStats()

    // === DRAG START: suspension flag set ===
    const isSuspended = true

    // Simulate 20 resize observer events during drag (container shrinking)
    for (let i = 1; i <= 20; i++) {
      h.setWidth(800 - i * 20)
      h.fireResizeObserver(isSuspended)
      // Advance time — normally this would trigger settle, but suspension blocks it
      h.clock.advance(16) // one frame
      h.raf.flush()
    }

    // Also advance past multiple SETTLE_MS periods
    h.clock.advance(SETTLE_MS * 5)
    h.raf.flush()

    // CRITICAL: zero fit/refresh/notify calls during the entire drag
    expect(h.stats().fitCount).toBe(0)
    expect(h.stats().refreshCount).toBe(0)
    expect(h.stats().notifyCount).toBe(0)

    h.coordinator.dispose()
  })

  test("full drag cycle: suspend during drag, single settle on release", () => {
    const h = makeDragTestHarness(800)

    // Initial mount + settle at 800px
    h.fireResizeObserver(false)
    h.settle()

    const initialCols = h.getCols()
    expect(initialCols).toBeGreaterThan(50) // ~95 cols at 800px

    h.resetStats()

    // === DRAG START ===
    // Simulate 15 frames of dragging, container going from 800 → 400px
    for (let i = 1; i <= 15; i++) {
      h.setWidth(800 - Math.round(i * (400 / 15)))
      h.fireResizeObserver(/* suspended */ true)
      h.clock.advance(16)
      h.raf.flush()
    }

    // Container is now ~400px — NO fit/refresh should have fired
    expect(h.stats().fitCount).toBe(0)
    expect(h.stats().refreshCount).toBe(0)

    // === DRAG END: clear flag + dispatch terminal-fit ===
    h.fireFitEvent(/* suspended */ false) // checkSuspension sees flag removed → resume
    h.settle()

    // Exactly ONE fit + refresh cycle
    expect(h.stats().fitCount).toBe(1)
    expect(h.stats().refreshCount).toBe(1)

    // Dimensions updated to final 400px width
    const finalCols = h.getCols()
    expect(finalCols).toBeLessThan(initialCols)
    expect(finalCols).toBe(Math.max(2, Math.floor(400 / 8.4)))

    // notify fired because cols changed
    expect(h.stats().notifyCount).toBe(1)
    expect(h.stats().lastNotifiedCols).toBe(finalCols)

    h.coordinator.dispose()
  })

  test("drag then expand: final dimensions are correct after release", () => {
    const h = makeDragTestHarness(500)

    // Mount at 500px
    h.fireResizeObserver(false)
    h.settle()
    h.resetStats()

    // Drag to 800px (expanding)
    for (let i = 1; i <= 10; i++) {
      h.setWidth(500 + i * 30)
      h.fireResizeObserver(true)
      h.clock.advance(16)
      h.raf.flush()
    }

    expect(h.stats().fitCount).toBe(0)

    // Release at 800px
    h.fireFitEvent(false)
    h.settle()

    expect(h.stats().fitCount).toBe(1)
    expect(h.getCols()).toBe(Math.max(2, Math.floor(800 / 8.4)))

    h.coordinator.dispose()
  })

  test("multiple drags: each drag cycle produces exactly one settle", () => {
    const h = makeDragTestHarness(800)

    // Mount
    h.fireResizeObserver(false)
    h.settle()
    h.resetStats()

    // First drag: 800 → 500
    for (let i = 1; i <= 5; i++) {
      h.setWidth(800 - i * 60)
      h.fireResizeObserver(true)
      h.clock.advance(16)
      h.raf.flush()
    }
    h.fireFitEvent(false)
    h.settle()

    expect(h.stats().fitCount).toBe(1)
    expect(h.getCols()).toBe(Math.max(2, Math.floor(500 / 8.4)))

    h.resetStats()

    // Second drag: 500 → 700
    for (let i = 1; i <= 5; i++) {
      h.setWidth(500 + i * 40)
      h.fireResizeObserver(true)
      h.clock.advance(16)
      h.raf.flush()
    }
    h.fireFitEvent(false)
    h.settle()

    expect(h.stats().fitCount).toBe(1)
    expect(h.getCols()).toBe(Math.max(2, Math.floor(700 / 8.4)))

    h.coordinator.dispose()
  })

  test("suspension with no resize events: resume is a no-op", () => {
    const h = makeDragTestHarness(800)

    // Mount
    h.fireResizeObserver(false)
    h.settle()
    h.resetStats()

    // Suspend without any requests
    h.bridge.check(true) // suspend
    h.clock.advance(SETTLE_MS * 3)

    // Resume — nothing pending
    h.bridge.check(false) // resume
    h.clock.advance(SETTLE_MS)
    h.raf.flush()

    expect(h.stats().fitCount).toBe(0)

    h.coordinator.dispose()
  })

  test("non-drag resize works normally when not suspended", () => {
    const h = makeDragTestHarness(800)

    // Mount
    h.fireResizeObserver(false)
    h.settle()
    h.resetStats()

    // Window resize (not a drag — no suspension)
    h.setWidth(600)
    h.fireResizeObserver(false)
    h.settle()

    // Immediate settle (one fit cycle)
    expect(h.stats().fitCount).toBe(1)
    expect(h.getCols()).toBe(Math.max(2, Math.floor(600 / 8.4)))

    h.coordinator.dispose()
  })
})
