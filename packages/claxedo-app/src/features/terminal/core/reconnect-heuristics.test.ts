import { describe, expect, test } from "bun:test"
import { cursorPlan, initialDelay, isLikelyTui, restoreSize } from "./reconnect-heuristics"

describe("terminal reconnect/restore heuristics", () => {
  test("isLikelyTui: matches title", () => {
    expect(
      isLikelyTui({ snapshotWasAltScreen: false, title: "Codex 5", initialCommand: "" }),
    ).toBe(true)
  })

  test("isLikelyTui: matches initial command", () => {
    expect(
      isLikelyTui({ snapshotWasAltScreen: false, title: "", initialCommand: "opencode" }),
    ).toBe(true)
  })

  test("isLikelyTui: matches supported agent commands", () => {
    expect(
      isLikelyTui({ snapshotWasAltScreen: false, title: "", initialCommand: "gemini" }),
    ).toBe(true)
    expect(
      isLikelyTui({ snapshotWasAltScreen: false, title: "cursor-agent", initialCommand: "" }),
    ).toBe(true)
  })

  test("isLikelyTui: snapshot alt screen implies TUI", () => {
    expect(
      isLikelyTui({ snapshotWasAltScreen: true, title: "", initialCommand: "" }),
    ).toBe(true)
  })

  // The three `filterModeSequences` cases that lived here are GONE with the
  // function. They pinned a renderer-side mode snapshot filtered by a match on
  // the tab TITLE — which is precisely what re-armed mouse reporting in shells
  // whose TUI had exited. Modes are now resynced from live server truth
  // (workspace-runtime `pty/mode-tracker.ts`, covered by mode-tracker.test.ts),
  // so there is no snapshot left to filter and nothing to port these to.

  test("cursorPlan: TUI split with snapshot uses live tail", () => {
    const plan = cursorPlan({
      likelyTui: true,
      splitWidthChanged: true,
      isReload: false,
      snapshotHasBuffer: true,
      snapshotWasAltScreen: false,
      snapshotCursor: 1234,
    })
    expect(plan.useLiveTailCursor).toBe(true)
    expect(plan.cursorParam).toBe(-1)
  })

  test("cursorPlan: reload + alt snapshot uses live tail", () => {
    const plan = cursorPlan({
      likelyTui: true,
      splitWidthChanged: false,
      isReload: true,
      snapshotHasBuffer: true,
      snapshotWasAltScreen: true,
      snapshotCursor: 5000,
    })
    expect(plan.useLiveTailCursor).toBe(true)
    expect(plan.cursorParam).toBe(-1)
  })

  test("cursorPlan: non-TUI with persisted buffer uses live tail", () => {
    const plan = cursorPlan({
      likelyTui: false,
      splitWidthChanged: false,
      isReload: false,
      snapshotHasBuffer: true,
      snapshotWasAltScreen: false,
      snapshotCursor: 9000,
    })
    expect(plan.useLiveTailCursor).toBe(true)
    expect(plan.cursorParam).toBe(-1)
  })

  test("restoreSize: prefers mountCols for TUI split", () => {
    const size = restoreSize({
      likelyTui: true,
      splitWidthChanged: true,
      mountCols: 57,
      snapshotCols: 117,
      snapshotRows: 44,
      backendCols: 57,
      backendRows: 44,
    })
    expect(size.cols).toBe(57)
    expect(size.rows).toBe(44)
  })

  test("restoreSize: ignores tiny persisted cols from hidden or unstable panes", () => {
    const size = restoreSize({
      likelyTui: true,
      splitWidthChanged: false,
      mountCols: 120,
      snapshotCols: 4,
      snapshotRows: 44,
      backendCols: 120,
      backendRows: 44,
    })
    expect(size.cols).toBe(120)
    expect(size.rows).toBe(44)
  })

  test("restoreSize: keeps plausible persisted cols for same-width restores", () => {
    const size = restoreSize({
      likelyTui: true,
      splitWidthChanged: false,
      mountCols: 120,
      snapshotCols: 100,
      snapshotRows: 44,
      backendCols: 120,
      backendRows: 44,
    })
    expect(size.cols).toBe(100)
    expect(size.rows).toBe(44)
  })

  test("initialDelay: gives TUIs more time to settle", () => {
    expect(initialDelay({ likelyTui: true })).toEqual({
      settleMs: 180,
      fallbackMs: 1200,
    })
  })

  test("initialDelay: keeps shells snappy", () => {
    expect(initialDelay({ likelyTui: false })).toEqual({
      settleMs: 100,
      fallbackMs: 500,
    })
  })
})

describe("cursorPlan: a client with no local copy must ask the server to replay", () => {
  // Regression for observed history loss: after a reload that lost the
  // localStorage snapshot, the client asked for the LIVE TAIL while the PTY was
  // still alive holding the entire session. The server's buffer was the only
  // copy of that scrollback and the user got a blank terminal.
  test("reload with no persisted buffer replays from the start, not the tail", () => {
    const plan = cursorPlan({
      likelyTui: false,
      splitWidthChanged: false,
      isReload: true,
      snapshotHasBuffer: false,
      snapshotWasAltScreen: false,
    })
    expect(plan.useLiveTailCursor).toBe(false)
    expect(plan.cursorParam).toBe(0)
  })

  test("the same holds for a TUI whose snapshot was lost", () => {
    const plan = cursorPlan({
      likelyTui: true,
      splitWidthChanged: false,
      isReload: true,
      snapshotHasBuffer: false,
      snapshotWasAltScreen: false,
    })
    expect(plan.useLiveTailCursor).toBe(false)
    expect(plan.cursorParam).toBe(0)
  })

  test("a client that DOES hold the content still takes the tail, so replay cannot duplicate it", () => {
    const plan = cursorPlan({
      likelyTui: false,
      splitWidthChanged: false,
      isReload: true,
      snapshotHasBuffer: true,
      snapshotWasAltScreen: false,
      snapshotCursor: 4096,
    })
    expect(plan.useLiveTailCursor).toBe(true)
    expect(plan.cursorParam).toBe(-1)
  })
})
