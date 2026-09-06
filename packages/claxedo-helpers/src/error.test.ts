import { describe, expect, test } from "bun:test"
import { errorMessage } from "./error"

describe("errorMessage", () => {
  test("plain Error and string", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
    expect(errorMessage("boom")).toBe("boom")
  })

  test("the data probe stays AHEAD of instanceof Error", () => {
    // ACP's RequestError extends Error and carries the informative half in
    // .data; an Error-first check would make this branch dead.
    const requestError = Object.assign(new Error("Internal error"), {
      data: { details: "tool call failed: exit 2" },
    })
    expect(errorMessage(requestError)).toBe("Internal error: tool call failed: exit 2")
  })

  test("a duplicated outer message is not repeated", () => {
    const err = Object.assign(new Error("same"), { data: { message: "same" } })
    expect(errorMessage(err)).toBe("same")
  })

  test("a bare detail with no outer message is returned alone", () => {
    expect(errorMessage({ data: { message: "detail" } })).toBe("detail")
    expect(errorMessage({ error: "detail" })).toBe("detail")
    expect(errorMessage({ error: { details: "nested" } })).toBe("nested")
  })

  test("a message-only object needs no Error prototype", () => {
    expect(errorMessage({ message: "plain" })).toBe("plain")
  })

  test("objects with no message at all are JSON encoded", () => {
    expect(errorMessage({ code: 500 })).toBe('{"code":500}')
    expect(errorMessage([1, 2])).toBe("[1,2]")
  })

  test("an empty message falls through rather than returning empty", () => {
    expect(errorMessage(new Error(""), "fallback")).toBe("fallback")
    expect(errorMessage("", "fallback")).toBe("fallback")
  })

  test("unencodable payloads reach the fallback", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorMessage(circular, "fallback")).toBe("fallback")
    expect(errorMessage({ big: 1n }, "fallback")).toBe("fallback")
  })

  test("with no fallback the value is stringified", () => {
    expect(errorMessage(undefined)).toBe("undefined")
    expect(errorMessage(null)).toBe("null")
    expect(errorMessage(404)).toBe("404")
  })
})

describe("errorMessage: content-free objects", () => {
  test("an empty encoding is not a message", () => {
    expect(errorMessage({}, "fallback")).toBe("fallback")
    expect(errorMessage({})).toBe("[object Object]")
  })

  test("but an Error carrying enumerable detail still encodes", () => {
    expect(errorMessage(Object.assign(new Error(""), { code: 500 }), "fallback")).toBe('{"code":500}')
  })
})
