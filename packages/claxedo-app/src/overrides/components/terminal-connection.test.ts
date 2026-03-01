import { describe, expect, test } from "bun:test"
import {
  restoreThenLive,
  sigwinchToggleSize,
  WebSocketCloseError,
  socketCloseIsError,
  isRetriableClose,
  reconnectDelay,
  MAX_RECONNECT_ATTEMPTS,
  reconnectingMessage,
  reconnectedMessage,
  reconnectFailedMessage,
} from "./terminal-connection"

describe("restoreThenLive", () => {
  test("restore buffer precedes live messages in output", () => {
    const out = restoreThenLive("RESTORE|", ["L1|", "L2|"])
    expect(out).toBe("RESTORE|L1|L2|")
    expect(out.indexOf("RESTORE")).toBeLessThan(out.indexOf("L1"))
  })

  test("handles empty restore and empty live cases", () => {
    expect(restoreThenLive("", ["L1|", "L2|"])).toBe("L1|L2|")
    expect(restoreThenLive("RESTORE|", [])).toBe("RESTORE|")
    expect(restoreThenLive("", [])).toBe("")
  })
})

describe("sigwinchToggleSize", () => {
  test("returns cols-1 then cols to force SIGWINCH", () => {
    const [first, second] = sigwinchToggleSize(80, 24)
    expect(first).toEqual({ cols: 79, rows: 24 })
    expect(second).toEqual({ cols: 80, rows: 24 })
  })

  test("clamps minimum columns to 2", () => {
    const [firstA, secondA] = sigwinchToggleSize(2, 24)
    expect(firstA.cols).toBeGreaterThanOrEqual(2)
    expect(secondA.cols).toBe(2)

    const [firstB, secondB] = sigwinchToggleSize(1, 24)
    expect(firstB.cols).toBeGreaterThanOrEqual(2)
    expect(secondB.cols).toBeGreaterThanOrEqual(2)
  })
})

describe("isRetriableClose", () => {
  test("returns false for normal close (1000)", () => {
    expect(isRetriableClose(1000)).toBe(false)
  })

  test("returns false for session not found (1008)", () => {
    expect(isRetriableClose(1008)).toBe(false)
  })

  test("returns false for terminal overload (4000)", () => {
    expect(isRetriableClose(4000)).toBe(false)
  })

  test("returns true for abnormal close (1006)", () => {
    expect(isRetriableClose(1006)).toBe(true)
  })

  test("returns true for server error (1011)", () => {
    expect(isRetriableClose(1011)).toBe(true)
  })

  test("returns true for service restart (1012)", () => {
    expect(isRetriableClose(1012)).toBe(true)
  })

  test("returns true for try again later (1013)", () => {
    expect(isRetriableClose(1013)).toBe(true)
  })

  test("returns true for going away (1001)", () => {
    expect(isRetriableClose(1001)).toBe(true)
  })
})

describe("reconnectDelay", () => {
  test("returns 1s for first attempt", () => {
    expect(reconnectDelay(0)).toBe(1000)
  })

  test("returns 2s for second attempt", () => {
    expect(reconnectDelay(1)).toBe(2000)
  })

  test("returns 4s for third attempt", () => {
    expect(reconnectDelay(2)).toBe(4000)
  })

  test("caps at 16s", () => {
    expect(reconnectDelay(4)).toBe(16000)
  })

  test("caps for very large attempt numbers", () => {
    expect(reconnectDelay(100)).toBe(16000)
  })
})

describe("MAX_RECONNECT_ATTEMPTS", () => {
  test("is a positive integer", () => {
    expect(Number.isInteger(MAX_RECONNECT_ATTEMPTS)).toBe(true)
    expect(MAX_RECONNECT_ATTEMPTS).toBeGreaterThan(0)
  })
})

describe("reconnect status messages", () => {
  test("reconnectingMessage includes attempt and max", () => {
    const msg = reconnectingMessage(2, 6)
    expect(msg).toContain("2")
    expect(msg).toContain("6")
  })

  test("reconnectedMessage returns non-empty string", () => {
    const msg = reconnectedMessage()
    expect(msg.length).toBeGreaterThan(0)
    expect(msg).toContain("Reconnected")
  })

  test("reconnectFailedMessage returns non-empty string", () => {
    const msg = reconnectFailedMessage()
    expect(msg.length).toBeGreaterThan(0)
  })

  test("reconnectFailedMessage includes connection lost text", () => {
    const msg = reconnectFailedMessage()
    expect(msg).toContain("Connection lost")
  })
})

describe("existing exports still work", () => {
  test("WebSocketCloseError has code and reason", () => {
    const err = new WebSocketCloseError(1006, "abnormal")
    expect(err.code).toBe(1006)
    expect(err.reason).toBe("abnormal")
    expect(err.name).toBe("WebSocketCloseError")
    expect(err).toBeInstanceOf(Error)
  })

  test("socketCloseIsError returns true for non-1000 codes", () => {
    expect(socketCloseIsError(1006)).toBe(true)
    expect(socketCloseIsError(1000)).toBe(false)
  })
})
