import { describe, expect, test } from "bun:test"
import { shouldMountTerminalPane, pickAdoptedPty } from "./terminal-content-policy"

describe("terminal content mount policy", () => {
  test("keeps never-activated hidden terminal panes from reconnecting on reload", () => {
    expect(shouldMountTerminalPane({ visible: false, ptyReady: true, activated: false })).toBe(false)
  })

  test("waits for activation before mounting so pending→real route settle cannot drop the socket", () => {
    expect(shouldMountTerminalPane({ visible: true, ptyReady: true, activated: false })).toBe(false)
    expect(shouldMountTerminalPane({ visible: true, ptyReady: true, activated: true })).toBe(true)
    expect(shouldMountTerminalPane({ visible: true, ptyReady: false, activated: true })).toBe(false)
  })

  test("keeps activated live terminal panes mounted while hidden for fast switching", () => {
    expect(shouldMountTerminalPane({ visible: false, ptyReady: true, activated: true })).toBe(true)
  })
})

describe("pickAdoptedPty", () => {
  const before = new Set(["pty_old"])

  test("adopts the sole session-matched new pty", () => {
    expect(pickAdoptedPty(
      [
        { id: "pty_old", sessionId: "ses_a" },
        { id: "pty_a", sessionId: "ses_a" },
        { id: "pty_b", sessionId: "ses_b" },
      ],
      before,
      "ses_a",
    )?.id).toBe("pty_a")
  })

  test("refuses ambiguous session matches and unscoped first-candidate steal", () => {
    expect(pickAdoptedPty(
      [
        { id: "pty_a", sessionId: "ses_a" },
        { id: "pty_b", sessionId: "ses_a" },
      ],
      before,
      "ses_a",
    )).toBeUndefined()
    expect(pickAdoptedPty(
      [{ id: "pty_a" }, { id: "pty_b" }],
      before,
      undefined,
    )).toBeUndefined()
  })

  test("adopts the sole unclaimed new pty when sessionId is unknown", () => {
    expect(pickAdoptedPty(
      [{ id: "pty_old" }, { id: "pty_a" }],
      before,
      undefined,
      new Set(["pty_claimed"]),
    )?.id).toBe("pty_a")
    expect(pickAdoptedPty(
      [{ id: "pty_a" }],
      before,
      undefined,
      new Set(["pty_a"]),
    )).toBeUndefined()
  })

  test("does not fall back to an unmatched pty when sessionId is set", () => {
    expect(pickAdoptedPty(
      [{ id: "pty_a", sessionId: "ses_other" }],
      before,
      "ses_a",
    )).toBeUndefined()
    expect(pickAdoptedPty(
      [{ id: "pty_a" }],
      before,
      "ses_a",
    )).toBeUndefined()
  })
})
