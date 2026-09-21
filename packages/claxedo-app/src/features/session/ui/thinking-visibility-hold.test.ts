import { describe, expect, test } from "bun:test"
import { THINKING_HIDE_HOLD_MS, nextThinkingVisibilityHold } from "./thinking-visibility-hold"

describe("thinking visibility hold", () => {
  test("a request failure hides live or held thinking immediately and recovery resumes it", () => {
    for (const want of [true, false]) {
      const blocked = nextThinkingVisibilityHold({ want, blocked: true, heldUntilMs: 1_080, nowMs: 1_040 })
      expect(blocked).toEqual({ visible: false, heldUntilMs: undefined })
      expect(nextThinkingVisibilityHold({ want: true, blocked: false, heldUntilMs: blocked.heldUntilMs, nowMs: 1_041 }))
        .toEqual({ visible: true, heldUntilMs: undefined })
    }
  })
  test("shows immediately when wanted", () => {
    expect(
      nextThinkingVisibilityHold({
        want: true,
        heldUntilMs: undefined,
        nowMs: 1_000,
      }),
    ).toEqual({ visible: true, heldUntilMs: undefined })
  })

  test("keeps the row for the hide hold after want clears", () => {
    const started = nextThinkingVisibilityHold({
      want: false,
      heldUntilMs: undefined,
      nowMs: 1_000,
    })
    expect(started).toEqual({
      visible: true,
      heldUntilMs: 1_000 + THINKING_HIDE_HOLD_MS,
    })

    expect(
      nextThinkingVisibilityHold({
        want: false,
        heldUntilMs: started.heldUntilMs,
        nowMs: 1_000 + THINKING_HIDE_HOLD_MS - 1,
      }),
    ).toEqual({
      visible: true,
      heldUntilMs: started.heldUntilMs,
    })
  })

  test("drops the row only after the hold elapses", () => {
    const heldUntilMs = 1_000 + THINKING_HIDE_HOLD_MS
    expect(
      nextThinkingVisibilityHold({
        want: false,
        heldUntilMs,
        nowMs: heldUntilMs,
      }),
    ).toEqual({ visible: false, heldUntilMs: undefined })
  })

  test("a mid-hold re-want clears the deadline so the next hide starts fresh", () => {
    const heldUntilMs = 1_000 + THINKING_HIDE_HOLD_MS
    expect(
      nextThinkingVisibilityHold({
        want: true,
        heldUntilMs,
        nowMs: 1_040,
      }),
    ).toEqual({ visible: true, heldUntilMs: undefined })
  })

  test("hide hold stays inside the 50–100ms band callers may tune", () => {
    expect(THINKING_HIDE_HOLD_MS).toBeGreaterThanOrEqual(50)
    expect(THINKING_HIDE_HOLD_MS).toBeLessThanOrEqual(100)
  })
})
