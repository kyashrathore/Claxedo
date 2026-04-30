// Tests for pane-guards.ts connection guards
import { describe, expect, test } from "bun:test"
import { isPtyDestroyed, shouldAttemptConnect } from "./pane-guards"

describe("isPtyDestroyed", () => {
  test("returns false when ptyId is in activePtyIds", () => {
    const active = new Set(["pty-1", "pty-2"])
    expect(isPtyDestroyed("pty-1", active)).toBe(false)
  })

  test("returns true when ptyId is NOT in activePtyIds", () => {
    const active = new Set(["pty-2"])
    expect(isPtyDestroyed("pty-1", active)).toBe(true)
  })

  test("returns true when activePtyIds is empty", () => {
    expect(isPtyDestroyed("pty-1", new Set())).toBe(true)
  })
})

describe("shouldAttemptConnect", () => {
  const base = {
    ptyId: "pty-1",
    activePtyIds: new Set(["pty-1"]),
    isDisposed: false,
    attemptCount: 0,
    maxAttempts: 6,
  }

  test("returns true when all conditions are normal", () => {
    expect(shouldAttemptConnect(base)).toBe(true)
  })

  test("returns false when PTY is destroyed (not in active set)", () => {
    // This is the CORE bug fix:
    // Current code has no such check — it will try to reconnect even after
    // the PTY was removed from the store (e.g., user closed terminal panel)
    expect(shouldAttemptConnect({ ...base, activePtyIds: new Set() })).toBe(false)
  })

  test("returns false when component is disposed", () => {
    expect(shouldAttemptConnect({ ...base, isDisposed: true })).toBe(false)
  })

  test("returns false when attempt count exceeds max", () => {
    expect(shouldAttemptConnect({ ...base, attemptCount: 7, maxAttempts: 6 })).toBe(false)
  })

  test("returns false when attempt count equals max", () => {
    expect(shouldAttemptConnect({ ...base, attemptCount: 6, maxAttempts: 6 })).toBe(false)
  })
})
