/**
 * The terminal identity we present to programs running in a PTY.
 *
 * Agent TUIs branch on `TERM_PROGRAM` to tune behaviour they cannot probe —
 * most visibly wheel-scroll compensation. Passing the host's own
 * `TERM_PROGRAM` through would make a TUI see whatever launched the desktop
 * app — `Apple_Terminal`, `iTerm.app`, or nothing at all. None of those
 * describe our terminal, so behaviour would be effectively random per user.
 *
 * ## Why `vscode`
 *
 * This value is coupled to how our renderer emits wheel events, and the two
 * must always agree:
 *
 * - We use xterm.js's stock wheel handling, which damps trackpad deltas to ~30%
 *   and emits at most one report per DOM wheel event. VS Code's terminal
 *   behaves the same way, and Claude Code's documented compensation for a
 *   `vscode` identity is to amplify its own scrolling to match. That is the
 *   behaviour we want.
 * - A kitty-class identity tells a TUI the terminal already emits a
 *   native-fidelity, one-report-per-line stream, so it disables its multiplier.
 *   Claiming `kitty` while emitting a damped stock stream makes transcript
 *   scrolling crawl at roughly a third of native speed.
 *
 * If a full-fidelity wheel handler is ever added (synthesising SGR reports per
 * line rather than per event), this constant must flip to `kitty` in the same
 * change. `identity.test.ts` pins the coupling in both directions.
 */
export const TERMINAL_TERM_PROGRAM = "vscode"

/**
 * A plausible version for the claimed identity — TUIs sometimes version-gate
 * quirk handling. Keep roughly current when touching terminal code.
 */
export const TERMINAL_TERM_PROGRAM_VERSION = "1.99.0"

/**
 * Whether our renderer synthesises full-fidelity wheel reports (one sequence
 * per scrolled line) rather than relying on xterm's stock damped handling.
 *
 * Read by the coupling test, not by runtime code. Flip it in the same commit
 * that lands such a handler, together with TERMINAL_TERM_PROGRAM.
 */
export const EMITS_FULL_FIDELITY_WHEEL_REPORTS = false
