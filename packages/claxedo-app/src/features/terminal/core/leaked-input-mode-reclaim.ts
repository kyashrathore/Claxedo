/**
 * Reclaiming TUI-only input modes leaked into a live shell prompt.
 *
 * A TUI (Claude Code, Codex, vim with `mouse=a`) arms input-reporting modes at
 * startup — mouse tracking, focus reporting, the kitty keyboard protocol — and
 * disarms them on a clean exit. Killed uncleanly (`kill -9`, a crash, or a
 * self-update that exits without restoring), it never writes the restore
 * sequences, so the shell that reclaims the pty inherits them:
 *
 *  - **mouse**: every pointer move over the pane writes an SGR report into the
 *    shell. zsh's line editor eats the `ESC[<` introducer and prints the rest,
 *    which is the `35;72;51M` junk in the prompt.
 *  - **focus**: focusing/blurring the window sprays `ESC[I` / `ESC[O`.
 *  - **kitty keyboard**: every keystroke arrives CSI-u encoded — `Ctrl+C`
 *    becomes `^[[99;5u` and cannot interrupt — so the pane is unusable until
 *    `reset`.
 *
 * This module holds ONLY the decision logic, with no xterm or DOM dependency,
 * so the same rules can be driven from a parser adapter today and a host-side
 * scanner later. Two rules make it safe:
 *
 *  1. **Shell-owned epoch.** Modes armed before the first prompt marker belong
 *     to shell init (a `.zshrc` enabling mouse reporting, a live tmux) and are
 *     never reclaimed — disarming those would break a working setup.
 *  2. **Mark, then re-check.** A marker only *marks* still-armed modes as
 *     leaked; the disarm bytes are collected afterwards. A mode re-armed in
 *     between — `fg` after `^Z`, or a new TUI racing the prompt — cancels its
 *     own reclaim, so a live TUI keeps its modes.
 */

const ESC = "\x1b"

/**
 * The OSC identifier and payload of our private prompt marker, emitted by the
 * shell wrappers in `agent-hooks`.
 *
 * Deliberately NOT keyed on FinalTerm's `OSC 133;A`: that is also emitted by
 * third-party shell integrations and forwarded by tmux for shells we never
 * wrapped, so disarming on it would clear a live tmux's own modes. Only our
 * wrappers emit 777.
 */
export const SHELL_READY_OSC_ID = 777
export const SHELL_READY_MARKER_PAYLOAD = "claxedo-shell-ready"

/**
 * Kitty keyboard disarm: a stack unwind (`CSI < 255 u` pops more than the stack
 * can hold, emptying it) plus an explicit set-to-zero (`CSI = 0 ; 1 u`) that
 * also covers flags armed without a push.
 */
export const KITTY_KEYBOARD_DISARM_SEQUENCE = `${ESC}[<255u${ESC}[=0;1u`

/** The TUI-only input modes a killed TUI can leak into a shell prompt. */
export type LeakableInputMode = "kitty" | "mouse" | "focus"

/**
 * Disarm bytes per mode. Mouse tracking is one xterm group — any level low
 * (`?1003l`) clears the whole protocol — so a single reset covers 9/1000/1002/
 * 1003. Shells never arm these themselves, which is what makes reclaiming them
 * at a prompt safe.
 */
export const LEAKED_MODE_DISARM: Record<LeakableInputMode, string> = {
  kitty: KITTY_KEYBOARD_DISARM_SEQUENCE,
  mouse: `${ESC}[?1003l`,
  focus: `${ESC}[?1004l`,
}

export type LeakedInputModeReclaimer = {
  /** Record a mode being armed (true) or restored (false) in the stream. */
  noteArm(mode: LeakableInputMode, armed: boolean): void
  /**
   * A prompt marker arrived: mark still-armed, non-shell-owned modes as leaked
   * and clear their shadow state. Call `collectDisarm` once the parse settles.
   */
  noteShellReady(): void
  /**
   * Disarm bytes for modes leaked at the last marker and not re-armed since.
   * Consumes the pending set; returns "" when nothing leaked.
   */
  collectDisarm(): string
}

const MODES: readonly LeakableInputMode[] = ["kitty", "mouse", "focus"]

export function createLeakedInputModeReclaimer(): LeakedInputModeReclaimer {
  const state = new Map<LeakableInputMode, { armed: boolean; shellOwned: boolean; pending: boolean }>(
    MODES.map((mode) => [mode, { armed: false, shellOwned: false, pending: false }]),
  )
  let sawMarker = false

  return {
    noteArm(mode, armed) {
      const entry = state.get(mode)
      if (!entry) return
      entry.armed = armed
      if (armed) {
        // A re-arm cancels a pending reclaim — the mode is live again.
        entry.pending = false
        // Armed before we ever saw a prompt: shell init owns it.
        if (!sawMarker) entry.shellOwned = true
      } else {
        entry.shellOwned = false
      }
    },

    noteShellReady() {
      sawMarker = true
      for (const entry of state.values()) {
        if (entry.armed && !entry.shellOwned) {
          entry.pending = true
          entry.armed = false
        }
      }
    },

    collectDisarm() {
      let disarm = ""
      for (const mode of MODES) {
        const entry = state.get(mode)
        if (!entry) continue
        if (entry.pending && !entry.armed) disarm += LEAKED_MODE_DISARM[mode]
        entry.pending = false
      }
      return disarm
    },
  }
}
