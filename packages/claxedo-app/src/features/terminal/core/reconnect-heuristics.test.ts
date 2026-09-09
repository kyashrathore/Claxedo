import { describe, expect, test } from "bun:test"
import { isLikelyTui } from "./reconnect-heuristics"

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
})
