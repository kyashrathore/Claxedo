import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  TERMINAL_OPTIONS,
  getScreenReaderModePreference,
  setScreenReaderModePreference,
} from "./config"

describe("TERMINAL_OPTIONS.macOptionIsMeta", () => {
  test("should be false to allow Option+key dead-key sequences on Mac", () => {
    // macOptionIsMeta: true intercepts the Option modifier and sends it as
    // a Meta/Escape prefix, which prevents the OS from composing special
    // characters via Option+key (e.g. Option+e → é, Option+u → ü).
    // The correct value is false so that the OS IME handles those sequences
    // and only truly-Meta shortcuts (none on a standard Mac layout) are
    // forwarded as meta.
    expect(TERMINAL_OPTIONS.macOptionIsMeta).toBe(false)
  })
})

describe("TERMINAL_OPTIONS.cursorBlink", () => {
  test("should be true for cursor visibility (industry standard)", () => {
    // A blinking cursor is the de-facto terminal default (xterm, iTerm2,
    // Ghostty, WezTerm all blink by default).  A static cursor is easy to
    // lose after scrolling or switching panels, which degrades usability.
    // The correct value is true.
    expect(TERMINAL_OPTIONS.cursorBlink).toBe(true)
  })
})

describe("TERMINAL_OPTIONS.scrollbar", () => {
  test("uses the same thin scrollbar width as the app's scrollable panes", () => {
    expect(TERMINAL_OPTIONS.scrollbar).toEqual({ showScrollbar: true, width: 6 })
  })
})

describe("TERMINAL_OPTIONS.screenReaderMode", () => {
  test("defaults to false to avoid the accessibility-mode performance penalty", () => {
    // When screenReaderMode is not explicitly set xterm.js leaves the option
    // undefined, which is treated the same as true in some xterm.js versions,
    // enabling the accessibility DOM layer.  That layer serialises every cell
    // of every line to the DOM causing significant paint overhead.  The base
    // default is therefore an explicit false; users opt in via the persisted
    // screen-reader preference (createTerminalInstance seeds each terminal from
    // it) and TerminalBackend.setScreenReaderMode flips it live.
    expect(TERMINAL_OPTIONS.screenReaderMode).toBe(false)
  })
})

describe("terminal screen-reader-mode preference", () => {
  const KEY = "claxedo.terminal.screen-reader-mode"

  beforeEach(() => {
    localStorage.removeItem(KEY)
  })
  afterEach(() => {
    localStorage.removeItem(KEY)
  })

  test("defaults to disabled when nothing is stored", () => {
    expect(getScreenReaderModePreference()).toBe(false)
  })

  test("enabling persists the opt-in and reads back as true", () => {
    setScreenReaderModePreference(true)
    expect(localStorage.getItem(KEY)).toBe("1")
    expect(getScreenReaderModePreference()).toBe(true)
  })

  test("disabling clears the stored key (so absence == off)", () => {
    setScreenReaderModePreference(true)
    setScreenReaderModePreference(false)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(getScreenReaderModePreference()).toBe(false)
  })

  test("a foreign/garbage stored value is treated as disabled", () => {
    localStorage.setItem(KEY, "yes")
    expect(getScreenReaderModePreference()).toBe(false)
  })
})
