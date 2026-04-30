import { describe, expect, test } from "bun:test"
import { TERMINAL_OPTIONS } from "./config"

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
  test("scrollbar.showScrollbar should be true so terminal scrollback has a visible handle", () => {
    // The pane owns the scrollbar styling, but xterm must not be configured to
    // hide the overlay entirely. The CSS keeps it slim and only exposes it when
    // the backend marks that scrollback exists.
    expect(TERMINAL_OPTIONS.scrollbar?.showScrollbar).toBe(true)
  })
})

describe("TERMINAL_OPTIONS.screenReaderMode", () => {
  test("should be false to avoid accessibility-mode performance penalty", () => {
    // When screenReaderMode is not explicitly set xterm.js leaves the option
    // undefined, which is treated the same as true in some xterm.js versions,
    // enabling the accessibility DOM layer.  That layer serialises every cell
    // of every line to the DOM causing significant paint overhead.  Explicitly
    // setting it to false disables the layer unless the user activates it
    // through the accessibility API.  The property is currently missing from
    // the config (resolves to undefined, not false).
    expect(TERMINAL_OPTIONS.screenReaderMode).toBe(false)
  })
})
