import { describe, expect, test } from "bun:test"
import { buildRestoreWrite, shouldTrimRestoredTail, trimTrailingLines } from "./restore"

// Buffer-restore ordering across terminal remount/reload. These pin the exact
// bytes written to xterm and the narrow condition under which the trailing
// (stale wrapped-prompt) line is trimmed.

describe("trimTrailingLines", () => {
  // Correct contract (derived from the terminal.tsx call site, which always
  // passes count = 2 to drop the stale wrapped-prompt row(s) after a width
  // change): remove the last `count` lines, each line's terminator included, so
  // what remains ends at a clean line boundary for the live shell to redraw.
  test("drops the last un-terminated line (the shell prompt case)", () => {
    expect(trimTrailingLines("a\nb\nc", 1)).toBe("a\nb\n")
  })

  test("drops the last line even when the buffer already ends in a terminator", () => {
    // The old verbatim extraction no-op'd both of these (it kept the terminator).
    expect(trimTrailingLines("a\nb\nc\n", 1)).toBe("a\nb\n")
    expect(trimTrailingLines("a\rb\r", 1)).toBe("a\r")
  })

  test("count > 1 removes that many trailing lines", () => {
    expect(trimTrailingLines("a\nb\nc", 2)).toBe("a\n")
    expect(trimTrailingLines("a\nb\nc\n", 2)).toBe("a\n")
  })

  test("treats CRLF (\\r\\n) as a single terminator — the real serialized-buffer case", () => {
    // xterm's SerializeAddon joins rows with \r\n and omits a trailing newline,
    // so a normal shell's serialized buffer ends with the unterminated prompt.
    expect(trimTrailingLines("line1\r\nline2\r\nuser@host:~$ ", 2)).toBe("line1\r\n")
    // A buffer that does end in \r\n still has its last full line removed.
    expect(trimTrailingLines("a\r\nb\r\n", 1)).toBe("a\r\n")
  })

  test("returns empty when there are fewer lines than requested (drop-everything fallback)", () => {
    expect(trimTrailingLines("no-newline", 1)).toBe("")
    expect(trimTrailingLines("a\nb", 3)).toBe("")
  })
})

describe("shouldTrimRestoredTail", () => {
  const base = {
    isReload: false,
    wasAltScreen: false,
    snapshotWasAtBottom: true as boolean | undefined,
    widthChanged: true,
    likelyTui: false,
  }

  test("trims a bottom-anchored normal shell whose width changed", () => {
    expect(shouldTrimRestoredTail(base)).toBe(true)
  })

  test("never trims on reload", () => {
    expect(shouldTrimRestoredTail({ ...base, isReload: true })).toBe(false)
  })

  test("never trims in an alt-screen/TUI session", () => {
    expect(shouldTrimRestoredTail({ ...base, wasAltScreen: true })).toBe(false)
    expect(shouldTrimRestoredTail({ ...base, likelyTui: true })).toBe(false)
  })

  test("never trims when the user had scrolled up", () => {
    expect(shouldTrimRestoredTail({ ...base, snapshotWasAtBottom: false })).toBe(false)
  })

  test("never trims when width did not change", () => {
    expect(shouldTrimRestoredTail({ ...base, widthChanged: false })).toBe(false)
  })
})

describe("buildRestoreWrite", () => {
  test("the serialized snapshot owns its buffer switches", () => {
    expect(
      buildRestoreWrite({ modeSequences: "MODE", restoreBuffer: "NORMAL\x1b[?1049hALT", likelyTui: true }),
    ).toBe("MODENORMAL\x1b[?1049hALT\x1b[0m")
  })

  test("normal-screen restore writes modes then scrollback with no alt-buffer switch", () => {
    expect(
      buildRestoreWrite({ modeSequences: "MODE", restoreBuffer: "BUF", likelyTui: false }),
    ).toBe("MODEBUF")
  })

  test("a TUI gets a trailing SGR reset; a plain shell does not", () => {
    expect(
      buildRestoreWrite({ modeSequences: "", restoreBuffer: "x", likelyTui: true }),
    ).toBe("x\x1b[0m")
    expect(
      buildRestoreWrite({ modeSequences: "", restoreBuffer: "x", likelyTui: false }),
    ).toBe("x")
  })
})
