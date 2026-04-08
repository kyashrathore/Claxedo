// Tests for terminal-attach-state.ts pending detach lifecycle
import { describe, expect, test, vi } from "bun:test"
import {
  schedulePendingDetach,
  cancelPendingDetach,
  hasPendingDetach,
  nextAttachSequence,
  isAttachActive,
  clearAttachSequence,
} from "./terminal-attach-state"

describe("pendingDetach", () => {
  test("schedulePendingDetach registers a detach callback", () => {
    const detach = vi.fn()
    schedulePendingDetach("pane-reg", detach, 60000)
    expect(hasPendingDetach("pane-reg")).toBe(true)
    // cleanup so the timeout doesn't leak into other tests
    cancelPendingDetach("pane-reg")
  })

  test("cancelPendingDetach prevents detach from firing and returns true", () => {
    // This is the CORE bug fix:
    // When terminal remounts (SolidJS reactivity / tab switch), it should cancel
    // any pending detach before reconnecting.
    // Without this: the detach fires after reconnect → kills live terminal
    const detach = vi.fn()
    schedulePendingDetach("pane-1", detach, 5000)

    expect(hasPendingDetach("pane-1")).toBe(true)

    const cancelled = cancelPendingDetach("pane-1")
    expect(cancelled).toBe(true)
    expect(hasPendingDetach("pane-1")).toBe(false)
    // detach should never fire (use fake timers to advance)
    vi.useFakeTimers()
    vi.advanceTimersByTime(10000)
    expect(detach).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  test("cancelPendingDetach returns false when no pending detach exists", () => {
    const result = cancelPendingDetach("pane-no-such")
    expect(result).toBe(false)
  })

  test("after cancel, hasPendingDetach returns false", () => {
    const detach = vi.fn()
    schedulePendingDetach("pane-after-cancel", detach, 60000)
    cancelPendingDetach("pane-after-cancel")
    expect(hasPendingDetach("pane-after-cancel")).toBe(false)
  })

  test("scheduling a second detach for the same pane replaces the first", () => {
    const first = vi.fn()
    const second = vi.fn()
    schedulePendingDetach("pane-replace", first, 60000)
    schedulePendingDetach("pane-replace", second, 60000)
    // only one pending detach remains
    expect(hasPendingDetach("pane-replace")).toBe(true)
    vi.useFakeTimers()
    vi.advanceTimersByTime(120000)
    // first was replaced so it must never have fired
    expect(first).not.toHaveBeenCalled()
    vi.useRealTimers()
    cancelPendingDetach("pane-replace")
  })
})

describe("attachSequence", () => {
  test("nextAttachSequence increments per paneId", () => {
    const id1 = nextAttachSequence("pane-2")
    const id2 = nextAttachSequence("pane-2")
    expect(id2).toBeGreaterThan(id1)
  })

  test("isAttachActive returns true for current sequence", () => {
    const id = nextAttachSequence("pane-3")
    expect(isAttachActive("pane-3", id)).toBe(true)
  })

  test("isAttachActive returns false for stale sequence", () => {
    // This is the CORE bug fix:
    // Stale callbacks from a previous attach attempt should not update state
    // after a new attach has started.
    const staleId = nextAttachSequence("pane-4")
    nextAttachSequence("pane-4") // advance to new sequence
    expect(isAttachActive("pane-4", staleId)).toBe(false)
  })

  test("clearAttachSequence makes all sequence IDs inactive", () => {
    const id = nextAttachSequence("pane-5")
    clearAttachSequence("pane-5")
    expect(isAttachActive("pane-5", id)).toBe(false)
  })

  test("different paneIds have independent sequences", () => {
    const idA = nextAttachSequence("pane-a")
    const idB = nextAttachSequence("pane-b")
    // clearing pane-a does not affect pane-b
    clearAttachSequence("pane-a")
    expect(isAttachActive("pane-b", idB)).toBe(true)
  })

  test("nextAttachSequence returns a positive integer", () => {
    const id = nextAttachSequence("pane-pos")
    expect(Number.isInteger(id)).toBe(true)
    expect(id).toBeGreaterThan(0)
  })

  test("sequence IDs are unique across successive calls", () => {
    const ids = Array.from({ length: 5 }, () => nextAttachSequence("pane-unique"))
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  test("isAttachActive returns false for unknown paneId", () => {
    expect(isAttachActive("pane-unknown-xyz", 999)).toBe(false)
  })

  test("clearAttachSequence is idempotent for unknown paneId", () => {
    // Must not throw when called on a pane that was never registered
    expect(() => clearAttachSequence("pane-never-seen")).not.toThrow()
  })
})
