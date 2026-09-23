import { describe, expect, test } from "bun:test"
import { classifyTerminalClose, terminalRecoveryAction } from "./close"

const MAX = 6

describe("classifyTerminalClose", () => {
  test("a normal close (1000) is ignored", () => {
    expect(classifyTerminalClose({ code: 1000 })).toEqual({ kind: "ignore" })
  })

  test("session-gone (1008) surfaces without a presence check", () => {
    expect(classifyTerminalClose({ code: 1008 })).toEqual({ kind: "session-gone" })
  })

  test("an abnormal close (1006) asks the server before deciding", () => {
    expect(classifyTerminalClose({ code: 1006 })).toEqual({ kind: "recover" })
    expect(classifyTerminalClose({ code: 1011 })).toEqual({ kind: "recover" })
  })

  test("the overload code (4000) fails outright", () => {
    expect(classifyTerminalClose({ code: 4000 })).toEqual({ kind: "fail" })
  })
})

describe("terminalRecoveryAction", () => {
  test("a PTY the server does not hold is restored on the first answer, not retried", () => {
    expect(terminalRecoveryAction({ presence: "gone", reconnectAttempt: 0, maxAttempts: MAX })).toEqual({ kind: "restore" })
  })

  test("a gone PTY is restored even after the attempt budget ran out", () => {
    expect(terminalRecoveryAction({ presence: "gone", reconnectAttempt: MAX, maxAttempts: MAX })).toEqual({ kind: "restore" })
  })

  test("a live or unreachable PTY reconnects while attempts remain", () => {
    expect(terminalRecoveryAction({ presence: "live", reconnectAttempt: 0, maxAttempts: MAX })).toEqual({ kind: "reconnect" })
    expect(terminalRecoveryAction({ presence: "unreachable", reconnectAttempt: MAX - 1, maxAttempts: MAX })).toEqual({ kind: "reconnect" })
  })

  test("an unreachable server gives up once the budget is spent", () => {
    expect(terminalRecoveryAction({ presence: "unreachable", reconnectAttempt: MAX, maxAttempts: MAX })).toEqual({ kind: "give-up" })
  })
})
