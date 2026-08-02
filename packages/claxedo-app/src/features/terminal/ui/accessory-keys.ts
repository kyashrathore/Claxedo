/**
 * Pure key-sequence mapping for the mobile terminal accessory row (WP-C3).
 *
 * Soft keyboards on touch devices omit Esc / Tab / Ctrl / arrows, which are
 * essential for TUIs (vim, the agent TUI, shells). The accessory row surfaces
 * them; this module maps each button press to the exact byte sequence a
 * physical keyboard would emit, so the data can be fed straight through the
 * terminal's existing input path (xterm `onData` → PTY socket).
 *
 * `Ctrl` is a sticky modifier: pressing it arms/disarms (emitting nothing), and
 * the next arrow press uses the CSI modifier form (`1;5` = Ctrl) instead of the
 * bare cursor sequence. This mirrors how Blink/Termux-style accessory bars work.
 */

export type AccessoryKey = "esc" | "tab" | "ctrl" | "up" | "down" | "left" | "right"

export type AccessoryKeyAction =
  /** Emit `data` into the terminal input path. */
  | { kind: "send"; data: string }
  /** Toggle the sticky Ctrl modifier; emit nothing. */
  | { kind: "arm"; ctrlArmed: boolean }

/** Bare sequences (no modifier). `ctrl` never emits on its own. */
const BASE: Record<Exclude<AccessoryKey, "ctrl">, string> = {
  esc: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
}

/** CSI modifier form (`1;5` = Ctrl) for the arrow keys while Ctrl is armed. */
const CTRL_ARROW: Partial<Record<AccessoryKey, string>> = {
  up: "\x1b[1;5A",
  down: "\x1b[1;5B",
  right: "\x1b[1;5C",
  left: "\x1b[1;5D",
}

/**
 * Resolve a button press into the action the accessory row should take, given
 * the current sticky-Ctrl state. `ctrl` toggles the modifier; every other key
 * sends its sequence (the Ctrl-modified arrow form when Ctrl is armed). Callers
 * disarm Ctrl after any `send`.
 */
export function resolveAccessoryKey(key: AccessoryKey, ctrlArmed: boolean): AccessoryKeyAction {
  if (key === "ctrl") return { kind: "arm", ctrlArmed: !ctrlArmed }
  if (ctrlArmed && CTRL_ARROW[key]) return { kind: "send", data: CTRL_ARROW[key]! }
  return { kind: "send", data: BASE[key] }
}
