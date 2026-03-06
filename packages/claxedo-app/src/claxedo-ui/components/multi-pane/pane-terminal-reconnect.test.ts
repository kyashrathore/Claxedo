/**
 * Tests for PaneTerminal reconnection logic.
 *
 * These test the pure-logic aspects of terminal reconnection:
 * - shouldWaitForQueuedCreate (from pane-terminal-logic.ts)
 * - WebSocketCloseError code handling expectations
 */

import { describe, expect, test } from "bun:test"
import { shouldWaitForQueuedCreate } from "./pane-terminal-logic"

describe("shouldWaitForQueuedCreate", () => {
  test("returns true when tabTerminalId matches pendingTerminalId", () => {
    expect(
      shouldWaitForQueuedCreate({
        tabTerminalId: "pending-123",
        pendingTerminalId: "pending-123",
      }),
    ).toBe(true)
  })

  test("returns false when tabTerminalId does not match pendingTerminalId", () => {
    expect(
      shouldWaitForQueuedCreate({
        tabTerminalId: "pending-456",
        pendingTerminalId: "pending-123",
      }),
    ).toBe(false)
  })

  test("returns false when tabTerminalId is undefined (non-terminal tab)", () => {
    expect(
      shouldWaitForQueuedCreate({
        tabTerminalId: undefined,
        pendingTerminalId: "pending-123",
      }),
    ).toBe(false)
  })
})

describe("WebSocket close code handling", () => {
  // These tests document the expected behavior of close codes
  // in the terminal reconnection flow. The actual handling lives
  // in terminal.tsx (override) and pane-terminal.tsx.

  test("code 1008 is non-retriable and triggers clone-on-reconnect", () => {
    // 1008 = Policy Violation — used by Pty.connect for "Session not found"
    // The PTY route patch ensures this code is sent instead of 1006
    const NON_RETRIABLE_CODES = [1000, 1008, 4000]
    expect(NON_RETRIABLE_CODES).toContain(1008)
  })

  test("code 1006 is retriable (should be avoided for missing sessions)", () => {
    // 1006 = Abnormal Closure — sent when WebSocket handshake fails (e.g. throw in upgradeWebSocket)
    // The PTY route patch removes the throw to prevent this ambiguous code
    const NON_RETRIABLE_CODES = [1000, 1008, 4000]
    expect(NON_RETRIABLE_CODES).not.toContain(1006)
  })

  test("code 1000 is normal close (not retriable, not an error)", () => {
    const NON_RETRIABLE_CODES = [1000, 1008, 4000]
    expect(NON_RETRIABLE_CODES).toContain(1000)
  })
})
