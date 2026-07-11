import { describe, expect, test } from "bun:test"
import { getCapabilityResponses } from "./capability-responder"

describe("terminal capability responder", () => {
  // -------------------------------------------------------------------------
  // OSC color queries
  // -------------------------------------------------------------------------

  test("OSC 10 fg-color query (BEL) triggers fg-color response", () => {
    expect(getCapabilityResponses("\x1b]10;?\x07")).toContain("\x1b]10;rgb:d4d4/d4d4/d4d4\x07")
  })

  test("OSC 10 fg-color query (ST) triggers fg-color response", () => {
    expect(getCapabilityResponses("\x1b]10;?\x1b\\")).toContain("\x1b]10;rgb:d4d4/d4d4/d4d4\x07")
  })

  test("OSC 11 bg-color query triggers bg-color response", () => {
    expect(getCapabilityResponses("\x1b]11;?\x07")).toContain("\x1b]11;rgb:1c1c/1c1c/1c1c\x07")
  })

  test("OSC set-color command (no ?) does not trigger a response", () => {
    // \x1b]10;rgb:... is a set command, not a query — the ? distinguishes them
    const r = getCapabilityResponses("\x1b]10;rgb:abcd/abcd/abcd\x07")
    expect(r.some((s) => s.startsWith("\x1b]10;"))).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Device attributes
  // -------------------------------------------------------------------------

  test("DA1 query triggers primary device attributes response", () => {
    expect(getCapabilityResponses("\x1b[c")).toContain("\x1b[?64;1;2;4;6;9;15;22;29c")
  })

  test("DA1 with explicit zero parameter triggers primary device attributes response", () => {
    expect(getCapabilityResponses("\x1b[0c")).toContain("\x1b[?64;1;2;4;6;9;15;22;29c")
  })

  test("DA2 query triggers secondary device attributes response", () => {
    expect(getCapabilityResponses("\x1b[>c")).toContain("\x1b[>0;276;0c")
  })

  test("DA2 with explicit zero triggers secondary device attributes response", () => {
    expect(getCapabilityResponses("\x1b[>0c")).toContain("\x1b[>0;276;0c")
  })

  // -------------------------------------------------------------------------
  // Kitty keyboard protocol
  // -------------------------------------------------------------------------

  test("kitty keyboard query triggers no-flags response", () => {
    expect(getCapabilityResponses("\x1b[?u")).toContain("\x1b[?0u")
  })

  // -------------------------------------------------------------------------
  // Non-query output — no spurious responses
  // -------------------------------------------------------------------------

  test("ordinary TUI redraw output produces no responses", () => {
    // Cursor moves, SGR, mode sets — none are terminal queries
    expect(getCapabilityResponses("\x1b[2J\x1b[H\x1b[1mOpenAI Codex\x1b[0m\x1b[?25h")).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Multiple queries in one frame
  // -------------------------------------------------------------------------

  test("codex startup batch (DA1 + kitty keyboard) each receive a response", () => {
    // Codex sends \x1b[?u\x1b[c together in one WebSocket frame
    const r = getCapabilityResponses("\x1b[?u\x1b[c")
    expect(r).toContain("\x1b[?64;1;2;4;6;9;15;22;29c")
    expect(r).toContain("\x1b[?0u")
  })

  test("both OSC color queries in one frame each receive a response", () => {
    const r = getCapabilityResponses("\x1b]10;?\x07\x1b]11;?\x07")
    expect(r).toContain("\x1b]10;rgb:d4d4/d4d4/d4d4\x07")
    expect(r).toContain("\x1b]11;rgb:1c1c/1c1c/1c1c\x07")
  })

  // NOTE (single source of truth): the dead OSC 10/11 duplicate that once lived
  // in backend/xterm.ts (and the unused TerminalBackend.onTerminalResponse hook)
  // was removed in Wave 1, so getCapabilityResponses is now the ONLY place these
  // magic RGB values are produced. The structural drift guard for that ("OSC
  // 10/11 escape handling may appear in exactly one production file") is a
  // source-shape rule and now lives in src/architecture/scanners.ts as the named
  // `oscColorEscapesOutsideResponder` rule, enforced by
  // src/architecture/osc-color-responder.guard.test.ts (baseline empty) — per
  // CONTRIBUTING tests-as-specs, not as a source-text scan in this feature spec.
})
