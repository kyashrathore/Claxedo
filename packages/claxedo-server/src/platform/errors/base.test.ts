import { describe, expect, test } from "vitest"
import {
  ClaxedoError,
  codeOf,
  errorBody,
  isClaxedoError,
  isRetryable,
  statusOf,
} from "./base"

class SampleError extends ClaxedoError {
  constructor() {
    super({ code: "sample_failed", message: "sample failed", status: 409 })
  }
}

describe("ClaxedoError", () => {
  test("reports the subclass name, so a log line identifies the failure rather than saying 'Error'", () => {
    expect(new SampleError().name).toBe("SampleError")
  })

  test("defaults status to 500 and retryable to false, so an unclassified failure is neither served as success nor replayed", () => {
    const error = new ClaxedoError({ code: "unknown", message: "boom" })
    expect(error.status).toBe(500)
    expect(error.retryable).toBe(false)
  })

  test("keeps the cause, so the underlying failure is not lost when a layer wraps it", () => {
    const cause = new Error("socket closed")
    expect(new ClaxedoError({ code: "wrapped", message: "outer", cause }).cause).toBe(cause)
  })

  test("is an Error, so existing catch blocks and instanceof checks keep working", () => {
    expect(new SampleError()).toBeInstanceOf(Error)
    expect(isClaxedoError(new SampleError())).toBe(true)
    expect(isClaxedoError(new Error("plain"))).toBe(false)
  })
})

describe("reading an unknown thrown value", () => {
  test("statusOf reads a foreign error's status, so an error crossing a package boundary is not flattened to 500", () => {
    // instanceof fails across realms; the fields are still there.
    expect(statusOf({ status: 429 })).toBe(429)
    expect(statusOf(new SampleError())).toBe(409)
  })

  test("statusOf rejects a status outside the HTTP range, so a stray numeric field cannot become a response code", () => {
    expect(statusOf({ status: 0 })).toBe(500)
    expect(statusOf({ status: 99 })).toBe(500)
    expect(statusOf({ status: 600 })).toBe(500)
    expect(statusOf({ status: "409" })).toBe(500)
  })

  test("statusOf survives null and undefined, so a thrown non-object does not crash the handler", () => {
    expect(statusOf(null)).toBe(500)
    expect(statusOf(undefined)).toBe(500)
    expect(statusOf("a string")).toBe(500)
  })

  test("codeOf falls back rather than returning an empty string a client would branch on", () => {
    expect(codeOf({ code: "rate_limited" })).toBe("rate_limited")
    expect(codeOf({ code: "" })).toBe("internal_error")
    expect(codeOf(null)).toBe("internal_error")
  })

  test("isRetryable defaults to false for unknown shapes, so a non-idempotent write is not replayed on an unrecognised error", () => {
    expect(isRetryable({ retryable: true })).toBe(true)
    expect(isRetryable({ retryable: "yes" })).toBe(false)
    expect(isRetryable({})).toBe(false)
    expect(isRetryable(null)).toBe(false)
  })

  test("errorBody keeps the structured shape rather than flattening to a scalar", () => {
    expect(errorBody(new SampleError())).toEqual({
      error: { code: "sample_failed", message: "sample failed" },
    })
    expect(errorBody(null)).toEqual({ error: { code: "internal_error", message: "Internal error" } })
  })
})
