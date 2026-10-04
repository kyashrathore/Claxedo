import { describe, expect, test } from "bun:test"
import { SESSION_RESTORED_NOTICE, shouldMarkRestored } from "./restored-notice"

describe("shouldMarkRestored", () => {
  test("marks a replacement session whose history restored content", () => {
    expect(shouldMarkRestored({ previousPtyId: "pty_old", restoredLength: 4096 })).toBe(true)
  })

  test("does not mark a fresh session that replaced nothing", () => {
    expect(shouldMarkRestored({ previousPtyId: undefined, restoredLength: 0 })).toBe(false)
  })

  test("does not mark a replacement whose history was empty", () => {
    // Nothing above the prompt, so there is no seam the user can see.
    expect(shouldMarkRestored({ previousPtyId: "pty_old", restoredLength: 0 })).toBe(false)
  })

  test("does not mark a live session even if history exists on disk", () => {
    expect(shouldMarkRestored({ previousPtyId: undefined, restoredLength: 9999 })).toBe(false)
  })
})

describe("SESSION_RESTORED_NOTICE", () => {
  test("starts on a fresh line — restored buffers rarely end at a line boundary", () => {
    expect(SESSION_RESTORED_NOTICE.startsWith("\r\n")).toBe(true)
  })

  test("ends on a fresh line so the shell prompt starts at column 0", () => {
    expect(SESSION_RESTORED_NOTICE.endsWith("\r\n")).toBe(true)
  })

  test("is dim and resets its own styling so it cannot bleed into shell output", () => {
    expect(SESSION_RESTORED_NOTICE).toContain("\x1b[2m")
    expect(SESSION_RESTORED_NOTICE).toContain("\x1b[0m")
    expect(SESSION_RESTORED_NOTICE.indexOf("\x1b[0m")).toBeGreaterThan(
      SESSION_RESTORED_NOTICE.indexOf("\x1b[2m"),
    )
  })

  test("says what happened in words, not just a rule", () => {
    expect(SESSION_RESTORED_NOTICE.toLowerCase()).toContain("restored")
  })

  test("carries no control characters that would move the cursor", () => {
    // Only SGR (m) sequences plus CRLF — nothing that repositions or erases,
    // which would damage the restored scrollback above it.
    const withoutSgr = SESSION_RESTORED_NOTICE.replace(/\x1b\[[0-9;]*m/g, "")
    expect(withoutSgr).not.toContain("\x1b")
  })
})
