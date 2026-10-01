import { describe, expect, test } from "bun:test"
import { decodeApiError, encodeApiError } from "./api-error"

describe("API error envelope", () => {
  test("round trips code, status and retryability without interpreting the message", () => {
    const error = Object.assign(new Error("required is just prose"), { code: "busy", status: 503, retryable: true })
    expect(decodeApiError(503, encodeApiError(error))).toEqual({ code: "busy", status: 503, message: error.message, retryable: true })
  })
  test("refuses scalar and malformed envelopes", () => {
    for (const body of [null, { error: "denied" }, { code: "denied", message: "denied" }, { error: { code: 3, message: "denied" } }]) {
      expect(decodeApiError(403, body)).toBeUndefined()
    }
  })
  test("unknown failures are internal and never retryable", () => {
    expect(encodeApiError(new Error("required"))).toEqual({ error: { code: "internal_error", message: "required", retryable: false } })
  })
})
