import { describe, expect, test } from "bun:test"
import { classifyTerminalClose } from "./close"

// The reconnect/backoff decision on WebSocket close. MAX here mirrors
// MAX_RECONNECT_ATTEMPTS (6) at the call site.
const MAX = 6

describe("classifyTerminalClose", () => {
  test("a normal close (1000) is ignored regardless of attempts", () => {
    expect(classifyTerminalClose({ code: 1000, reconnectAttempt: 0, maxAttempts: MAX })).toEqual({ kind: "ignore" })
  })

  test("session-gone (1008) surfaces a connect error instead of reconnecting", () => {
    expect(classifyTerminalClose({ code: 1008, reconnectAttempt: 0, maxAttempts: MAX })).toEqual({
      kind: "session-gone",
    })
  })

  test("a retriable code with attempts remaining reconnects", () => {
    expect(classifyTerminalClose({ code: 1006, reconnectAttempt: 0, maxAttempts: MAX })).toEqual({ kind: "reconnect" })
    expect(classifyTerminalClose({ code: 1006, reconnectAttempt: 5, maxAttempts: MAX })).toEqual({ kind: "reconnect" })
  })

  test("a retriable code with attempts exhausted fails and reports exhaustion", () => {
    expect(classifyTerminalClose({ code: 1006, reconnectAttempt: 6, maxAttempts: MAX })).toEqual({
      kind: "fail",
      exhausted: true,
    })
  })

  test("the overload code (4000) is non-retriable and fails without claiming exhaustion", () => {
    expect(classifyTerminalClose({ code: 4000, reconnectAttempt: 0, maxAttempts: MAX })).toEqual({
      kind: "fail",
      exhausted: false,
    })
  })
})
