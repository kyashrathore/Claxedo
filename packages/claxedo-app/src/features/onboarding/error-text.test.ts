import { describe, expect, test } from "bun:test"
import { errorText } from "./error-text"

describe("errorText", () => {
  test("an Error contributes its message, which is what the server's words arrive in", () => {
    expect(errorText(new Error("workspace already connected"))).toBe("workspace already connected")
  })

  test("a subclass is still an Error", () => {
    class HttpError extends Error {}
    expect(errorText(new HttpError("403 forbidden"))).toBe("403 forbidden")
  })

  test("a thrown string is already the text", () => {
    expect(errorText("token expired")).toBe("token expired")
  })

  test.each([
    ["undefined", undefined],
    ["null", null],
  ])("%s has no text, and must not become the literal word", (_label, value) => {
    expect(errorText(value)).toBe("")
  })

  test("a thrown object is serialised rather than stringified", () => {
    // `String({ code: 401 })` is "[object Object]" — copy that matches none of
    // the setup failure checks and tells the user nothing. The serialised form
    // at least carries the server's own fields.
    expect(errorText({ code: 401, message: "unauthorized" })).toBe('{"code":401,"message":"unauthorized"}')
  })

  test("a value JSON cannot represent yields empty text, not the string \"undefined\"", () => {
    expect(errorText(() => "boom")).toBe("")
  })
})
