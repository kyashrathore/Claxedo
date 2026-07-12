/**
 * Detects terminal capability queries from PTY output and returns the
 * responses that should be sent back to the PTY stdin immediately.
 *
 * TUI apps (e.g. codex) probe the terminal at startup with a batch of queries
 * and wait up to ~2s per group for responses before timing out.  This module
 * provides synchronous pattern matching so callers can respond before the data
 * enters any async queue (xterm.js write buffer, buffer-restore queue, etc.).
 *
 * Returning an array of strings (instead of calling send() directly) keeps the
 * logic pure and testable.
 */

const osc10QueryRe = /\x1b\]10;\?(?:\x1b\\|\x07)/
const osc11QueryRe = /\x1b\]11;\?(?:\x1b\\|\x07)/

/**
 * Given a raw PTY output frame, return zero or more response strings that
 * should be forwarded to the PTY stdin immediately.
 *
 * Covers:
 *   - OSC 10/11  — terminal foreground/background color queries
 *   - DA1 (\x1b[c, \x1b[0c) — Primary Device Attributes
 *   - DA2 (\x1b[>c, \x1b[>0c) — Secondary Device Attributes
 *   - Kitty keyboard query (\x1b[?u) — report current flags (0 = none active)
 */
export function getCapabilityResponses(data: string): string[] {
  if (!data.includes("\x1b]") && !data.includes("\x1b[")) return []

  const responses: string[] = []

  if (data.includes("\x1b]")) {
    if (osc10QueryRe.test(data)) responses.push("\x1b]10;rgb:d4d4/d4d4/d4d4\x07")
    if (osc11QueryRe.test(data)) responses.push("\x1b]11;rgb:1c1c/1c1c/1c1c\x07")
  }

  if (data.includes("\x1b[c") || data.includes("\x1b[0c")) {
    responses.push("\x1b[?64;1;2;4;6;9;15;22;29c")
  }

  if (data.includes("\x1b[>c") || data.includes("\x1b[>0c")) {
    responses.push("\x1b[>0;276;0c")
  }

  if (data.includes("\x1b[?u")) {
    responses.push("\x1b[?0u")
  }

  return responses
}
