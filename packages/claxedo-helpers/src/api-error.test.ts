import { describe, expect, test } from "bun:test"
import { decodeApiError, encodeApiError, publicApiFailure } from "./api-error"

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
  test("a public failure carries the table's status and retryability", () => {
    expect(publicApiFailure("host_tunnel_timeout")).toMatchObject({ code: "host_tunnel_timeout", status: 503, retryable: true, message: "Host tunnel timed out" })
    expect(publicApiFailure("workspace_checkpoint_conflict", "lease fenced")).toMatchObject({ status: 409, retryable: false, message: "lease fenced" })
  })
  test("unknown failures are internal and never retryable", () => {
    expect(encodeApiError(new Error("required"))).toEqual({ error: { code: "internal_error", message: "required", retryable: false } })
  })
})
