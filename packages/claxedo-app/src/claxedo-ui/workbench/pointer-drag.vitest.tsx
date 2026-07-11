import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { workbenchDrag, useDragSource, type DropZone } from "./pointer-drag"

// The hand-rolled pointer-events drag engine (WP-C3): one controller that
// unifies mouse + touch + pen, with movement/long-press thresholds so lists and
// tab strips stay scrollable. These tests drive it directly (no workbench mount)
// to pin threshold behavior and drop-zone dispatch.

function pointer(
  target: EventTarget,
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number; pointerType?: string; button?: number },
) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, "clientX", { value: init.clientX ?? 0 })
  Object.defineProperty(ev, "clientY", { value: init.clientY ?? 0 })
  Object.defineProperty(ev, "pointerId", { value: init.pointerId ?? 1 })
  Object.defineProperty(ev, "pointerType", { value: init.pointerType ?? "mouse" })
  Object.defineProperty(ev, "button", { value: init.button ?? 0 })
  target.dispatchEvent(ev)
}

let el: HTMLElement
let dispose: () => void

function mountSource(opts?: { contentId?: () => string | undefined; enabled?: () => boolean }) {
  el = document.createElement("button")
  document.body.appendChild(el)
  dispose = useDragSource(el, {
    contentId: opts?.contentId ?? (() => "surface-1"),
    sourceKind: "tab",
    enabled: opts?.enabled,
  })
}

afterEach(() => {
  workbenchDrag.cancel()
  dispose?.()
  el?.remove()
  vi.useRealTimers()
  document.querySelector('[data-testid="workbench-drag-ghost"]')?.remove()
})

describe("useDragSource — contentId resolution is deferred (no side effects on tap)", () => {
  // Sidebar rows resolve their contentId via a SIDE-EFFECTING minter
  // (`prepareSessionDrag` → `openSession`). Resolving on every pointerdown would
  // open a session on a mere press/tap/click. The resolver contract: `contentId`
  // is invoked ONLY when a drag actually begins (threshold/long-press crossed).
  test("does NOT resolve contentId on a plain press/tap", () => {
    let resolveCount = 0
    el = document.createElement("button")
    document.body.appendChild(el)
    dispose = useDragSource(el, {
      contentId: () => {
        resolveCount += 1
        return "surface-1"
      },
      sourceKind: "navigation-row",
    })
    pointer(el, "pointerdown", { clientX: 0, clientY: 0 })
    // A sub-threshold wiggle is still a tap, not a drag.
    pointer(window, "pointermove", { clientX: 2, clientY: 0 })
    pointer(window, "pointerup", { clientX: 2, clientY: 0 })
    expect(resolveCount).toBe(0)
    expect(workbenchDrag.active()).toBe(false)
  })

  test("resolves contentId exactly once, only when the drag begins", () => {
    let resolveCount = 0
    el = document.createElement("button")
    document.body.appendChild(el)
    dispose = useDragSource(el, {
      contentId: () => {
        resolveCount += 1
        return "surface-1"
      },
      sourceKind: "navigation-row",
    })
    pointer(el, "pointerdown", { clientX: 0, clientY: 0 })
    expect(resolveCount).toBe(0)
    pointer(window, "pointermove", { clientX: 40, clientY: 0 })
    expect(resolveCount).toBe(1)
    expect(workbenchDrag.active()).toBe(true)
    pointer(window, "pointerup", { clientX: 40, clientY: 0 })
  })
})

describe("useDragSource — touch-action (lists stay scrollable)", () => {
  test("defaults to pan-y so a vertical list still scrolls by touch", () => {
    mountSource()
    expect(el.style.touchAction).toBe("pan-y")
  })

  test("honors an explicit touchAction override (e.g. pan-x strips, none grips)", () => {
    el = document.createElement("button")
    document.body.appendChild(el)
    dispose = useDragSource(el, {
      contentId: () => "surface-1",
      sourceKind: "tab",
      touchAction: "pan-x",
    })
    expect(el.style.touchAction).toBe("pan-x")
  })
})

describe("useDragSource — mouse", () => {
  test("does NOT start a drag below the movement threshold", () => {
    mountSource()
    pointer(el, "pointerdown", { clientX: 0, clientY: 0 })
    pointer(window, "pointermove", { clientX: 3, clientY: 0 })
    expect(workbenchDrag.active()).toBe(false)
    pointer(window, "pointerup", { clientX: 3, clientY: 0 })
  })

  test("starts a drag once movement crosses the threshold, then ends on pointerup", () => {
    mountSource()
    pointer(el, "pointerdown", { clientX: 0, clientY: 0 })
    pointer(window, "pointermove", { clientX: 40, clientY: 0 })
    expect(workbenchDrag.active()).toBe(true)
    expect(workbenchDrag.contentId()).toBe("surface-1")
    // Ghost element follows the pointer.
    expect(document.querySelector('[data-testid="workbench-drag-ghost"]')).not.toBeNull()
    pointer(window, "pointerup", { clientX: 40, clientY: 0 })
    expect(workbenchDrag.active()).toBe(false)
    expect(document.querySelector('[data-testid="workbench-drag-ghost"]')).toBeNull()
  })

  test("a disabled source never begins a drag", () => {
    mountSource({ enabled: () => false })
    pointer(el, "pointerdown", { clientX: 0, clientY: 0 })
    pointer(window, "pointermove", { clientX: 40, clientY: 0 })
    expect(workbenchDrag.active()).toBe(false)
  })

  test("a non-primary button is ignored", () => {
    mountSource()
    pointer(el, "pointerdown", { clientX: 0, clientY: 0, button: 2 })
    pointer(window, "pointermove", { clientX: 40, clientY: 0 })
    expect(workbenchDrag.active()).toBe(false)
  })
})

describe("useDragSource — touch", () => {
  test("a long-press (no movement) starts the drag", () => {
    vi.useFakeTimers()
    mountSource()
    pointer(el, "pointerdown", { clientX: 0, clientY: 0, pointerType: "touch" })
    expect(workbenchDrag.active()).toBe(false)
    vi.advanceTimersByTime(260)
    expect(workbenchDrag.active()).toBe(true)
    pointer(window, "pointerup", { clientX: 0, clientY: 0, pointerType: "touch" })
  })

  test("moving before the long-press elapses is treated as a scroll (no drag)", () => {
    vi.useFakeTimers()
    mountSource()
    pointer(el, "pointerdown", { clientX: 0, clientY: 0, pointerType: "touch" })
    pointer(window, "pointermove", { clientX: 40, clientY: 0, pointerType: "touch" })
    vi.advanceTimersByTime(300)
    expect(workbenchDrag.active()).toBe(false)
  })
})

describe("workbenchDrag — drop zone dispatch", () => {
  function makeZone(): { zone: DropZone; moves: Array<[string, number, number]>; drops: string[]; cancels: number } {
    const moves: Array<[string, number, number]> = []
    const drops: string[] = []
    let cancels = 0
    const zone: DropZone = {
      onMove: (cid, x, y) => moves.push([cid, x, y]),
      onDrop: (cid) => drops.push(cid),
      onCancel: () => {
        cancels += 1
      },
    }
    return {
      zone,
      moves,
      drops,
      get cancels() {
        return cancels
      },
    }
  }

  test("begin/move/end drive onMove then onDrop with the carried contentId", () => {
    const rec = makeZone()
    const off = workbenchDrag.registerDropZone(rec.zone)
    try {
      workbenchDrag.begin({ contentId: "c1", sourceKind: "tab", x: 10, y: 20 })
      workbenchDrag.move(30, 40)
      workbenchDrag.end()
      expect(rec.moves).toEqual([
        ["c1", 10, 20],
        ["c1", 30, 40],
      ])
      expect(rec.drops).toEqual(["c1"])
      expect(rec.cancels).toBe(0)
    } finally {
      off()
    }
  })

  test("cancel fires onCancel and suppresses the drop", () => {
    const rec = makeZone()
    const off = workbenchDrag.registerDropZone(rec.zone)
    try {
      workbenchDrag.begin({ contentId: "c1", sourceKind: "tab", x: 0, y: 0 })
      workbenchDrag.cancel()
      workbenchDrag.end() // late/no-op after cancel
      expect(rec.drops).toEqual([])
      expect(rec.cancels).toBe(1)
      expect(workbenchDrag.active()).toBe(false)
    } finally {
      off()
    }
  })

  test("a de-registered zone stops receiving events", () => {
    const rec = makeZone()
    const off = workbenchDrag.registerDropZone(rec.zone)
    off()
    workbenchDrag.begin({ contentId: "c1", sourceKind: "tab", x: 0, y: 0 })
    workbenchDrag.end()
    expect(rec.moves).toEqual([])
    expect(rec.drops).toEqual([])
  })
})
