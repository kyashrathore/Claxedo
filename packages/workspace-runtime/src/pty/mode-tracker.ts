/**
 * Live terminal-mode truth, tracked on the server.
 *
 * Programs set input-reporting modes ONCE, at startup — codex emits `ESC[>7u`
 * for the kitty keyboard protocol, an editor enables bracketed paste, a TUI
 * arms mouse tracking. Those bytes go straight out to whatever socket is
 * attached at the time and are then gone: they sit far back in the scrollback,
 * usually past the replay window. A renderer that attaches later gets a fresh
 * xterm with DEFAULT modes while the running program believes its modes are
 * still set — Shift+Enter starts submitting instead of inserting a newline,
 * paste arrives as keystrokes, the mouse stops working.
 *
 * The previous approach inverted the ownership: the RENDERER scanned the stream
 * with a regex, persisted the resulting mode set to localStorage, and replayed
 * that snapshot on the next mount. That snapshot is a guess about a process the
 * renderer cannot see, and when it was wrong it was wrong in the worst
 * direction — re-arming mouse reporting into a shell whose TUI had exited,
 * which sprays `ESC[<35;…M` reports into the prompt on every pointer move.
 *
 * Here the modes are read from a headless xterm fed the same bytes the real
 * terminal gets, so `buildPreamble()` describes what is ACTUALLY set right now.
 * If the TUI died and its shell reset the modes, the tracker saw that too.
 *
 * Pattern adapted from VS Code's XtermSerializer (ptyService.ts).
 */

// Imported as a default (whole-module) binding, NOT as `{ Terminal }`. The
// package ships no `exports` map and its `module` field points at a file that
// does not exist, so every loader falls back to `main`
// (lib-headless/xterm-headless.js) — a minified CJS bundle that assigns its
// exports dynamically. Node's cjs-module-lexer therefore detects ZERO named
// exports from it, and `import { Terminal } from "@xterm/headless"` dies with
// "does not provide an export named 'Terminal'" under plain Node ESM (this
// package's own `dev`/`start` scripts, and the runtime child process spawned by
// workspace-relay-e2e.test.ts). esbuild and Bun paper over it with their own
// interop shims, which is why the bundled sidecar worked and hid the break.
// The default binding is `module.exports`, which every loader agrees on.
import xtermHeadless from "@xterm/headless"

const HeadlessTerminal = xtermHeadless.Terminal

export type ModeTracker = {
  /** Feed a chunk of PTY output. Parsed synchronously. */
  feed(data: string): void
  /** Keep the emulator's geometry in step with the real one. */
  resize(cols: number, rows: number): void
  /**
   * Bytes that bring a freshly attached terminal to the modes the running
   * program already believes are active. Empty when everything is default.
   */
  buildPreamble(): string
  dispose(): void
}

/**
 * xterm's write path is async-buffered, so `term.modes` lags behind a `write()`
 * and the preamble would be built from stale state in the attach hot path. The
 * internal WriteBuffer exposes a synchronous pump; xterm's own SerializeAddon
 * reaches in the same way.
 */
type HeadlessInternals = {
  _core?: {
    _writeBuffer?: { writeSync(data: string | Uint8Array): void }
    coreService?: { kittyKeyboard?: { flags: number } }
    optionsService?: { rawOptions: { vtExtensions?: { kittyKeyboard?: boolean } } }
  }
}

export function createModeTracker(cols: number, rows: number): ModeTracker {
  const term = new HeadlessTerminal({
    cols: Math.max(2, cols),
    rows: Math.max(1, rows),
    // No scrollback: this emulator exists only to answer "what modes are set",
    // never to serve content, and a per-session 1000-line buffer is real memory.
    scrollback: 0,
    allowProposedApi: true,
  })
  const internals = term as unknown as HeadlessInternals

  // Validate the private surface once, at construction, so an @xterm/headless
  // upgrade that renames internals fails loudly here instead of throwing inside
  // every PTY-output callback for every session.
  const rawOptions = internals._core?.optionsService?.rawOptions
  const writeBuffer = internals._core?._writeBuffer
  if (!rawOptions || typeof writeBuffer?.writeSync !== "function") {
    throw new Error(
      "@xterm/headless internals not found (optionsService.rawOptions, _writeBuffer.writeSync). " +
        "Likely a version-pin regression — check the pinned version still exposes these.",
    )
  }

  // `vtExtensions.kittyKeyboard` is in the public typings but the headless
  // option sanitizer drops it (its defaults table omits the key), so the kitty
  // handlers early-return and `ESC[>7u` would be a no-op. Set it directly.
  rawOptions.vtExtensions = { kittyKeyboard: true }

  return {
    feed(data) {
      if (!data) return
      try {
        writeBuffer.writeSync(data)
      } catch {
        // A malformed sequence must never take down the PTY data path; the
        // worst case is a slightly stale preamble.
      }
    },

    resize(nextCols, nextRows) {
      const c = Math.max(2, nextCols)
      const r = Math.max(1, nextRows)
      if (term.cols === c && term.rows === r) return
      try {
        term.resize(c, r)
      } catch {}
    },

    buildPreamble() {
      const modes = term.modes
      const parts: string[] = []

      if (modes.applicationCursorKeysMode) parts.push("\x1b[?1h")
      if (modes.applicationKeypadMode) parts.push("\x1b[?66h")
      if (modes.bracketedPasteMode) parts.push("\x1b[?2004h")
      if (modes.insertMode) parts.push("\x1b[4h")
      if (modes.originMode) parts.push("\x1b[?6h")
      if (modes.reverseWraparoundMode) parts.push("\x1b[?45h")
      if (modes.sendFocusMode) parts.push("\x1b[?1004h")
      // Inverted defaults: only emit when explicitly turned off.
      if (!modes.showCursor) parts.push("\x1b[?25l")
      if (!modes.wraparoundMode) parts.push("\x1b[?7l")

      // Mouse tracking is one exclusive level, not a set of flags.
      switch (modes.mouseTrackingMode) {
        case "x10":
          parts.push("\x1b[?9h")
          break
        case "vt200":
          parts.push("\x1b[?1000h")
          break
        case "drag":
          parts.push("\x1b[?1002h")
          break
        case "any":
          parts.push("\x1b[?1003h")
          break
        default:
          break
      }

      const kittyFlags = internals._core?.coreService?.kittyKeyboard?.flags ?? 0
      // `=N;1u` sets the effective flags directly rather than trying to replay
      // the program's push/pop stack, which a fresh peer does not share.
      if (kittyFlags > 0) parts.push(`\x1b[=${kittyFlags};1u`)

      // Deliberately absent:
      //  - alternate screen (1049/47): the buffer restore owns that, and
      //    re-entering it here would hide the restored scrollback;
      //  - SGR mouse encoding (1006): meaningless without a tracking level,
      //    and emitted by the program alongside one when it wants it;
      //  - synchronized output (2026): re-asserting it would suspend rendering
      //    until the program happens to send the next end-marker.
      return parts.join("")
    },

    dispose() {
      try {
        term.dispose()
      } catch {}
    },
  }
}
