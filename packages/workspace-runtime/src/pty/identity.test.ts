import { describe, expect, test } from "bun:test"
import {
  EMITS_FULL_FIDELITY_WHEEL_REPORTS,
  TERMINAL_TERM_PROGRAM,
  TERMINAL_TERM_PROGRAM_VERSION,
} from "./identity"

/**
 * The identity and the wheel implementation are a coupled pair. Changing one
 * without the other silently degrades scrolling in agent TUIs — one direction
 * makes it crawl at ~1/3 speed, the other makes it over-scroll ~3x — and
 * neither shows up in any other test. These assertions are the interlock.
 */
const KITTY_CLASS = new Set(["kitty", "ghostty", "WezTerm"])

describe("terminal identity ↔ wheel handling coupling", () => {
  test("a kitty-class identity is claimed ONLY when we emit full-fidelity wheel reports", () => {
    if (KITTY_CLASS.has(TERMINAL_TERM_PROGRAM)) {
      expect(EMITS_FULL_FIDELITY_WHEEL_REPORTS).toBe(true)
    }
  })

  test("full-fidelity wheel reports require a kitty-class identity", () => {
    if (EMITS_FULL_FIDELITY_WHEEL_REPORTS) {
      expect(KITTY_CLASS.has(TERMINAL_TERM_PROGRAM)).toBe(true)
    }
  })

  test("the current pairing is stock xterm wheel handling under a vscode identity", () => {
    // Pinned so the pairing is an explicit decision, not a drift.
    expect(TERMINAL_TERM_PROGRAM).toBe("vscode")
    expect(EMITS_FULL_FIDELITY_WHEEL_REPORTS).toBe(false)
  })

  test("a version is always advertised alongside the identity", () => {
    expect(TERMINAL_TERM_PROGRAM_VERSION).toMatch(/^\d+\.\d+/)
  })
})
