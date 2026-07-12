import { describe, expect, test } from "bun:test"
import { formatServerError, parseReadableConfigInvalidError } from "./server-errors"

describe("formatServerError", () => {
  test("returns the message of a plain Error", () => {
    expect(formatServerError(new Error("boom"))).toBe("boom")
  })

  test("returns a raw string error unchanged", () => {
    expect(formatServerError("raw failure")).toBe("raw failure")
  })

  test("falls back to the provided fallback for an opaque error", () => {
    expect(formatServerError({}, undefined, "fallback text")).toBe("fallback text")
  })

  test("returns a generic message when nothing else is available", () => {
    expect(formatServerError(null)).toBe("Unknown error")
  })

  test("surfaces a readable message carried on error.data.message", () => {
    expect(formatServerError({ data: { message: "  server said no  " } })).toBe("server said no")
  })

  test("unwraps a named error nested under error.cause.body", () => {
    const wrapped = Object.assign(new Error("wrapper"), {
      cause: { body: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "denied" } } },
    })
    expect(formatServerError(wrapped)).toBe("anthropic auth failed: denied")
  })

  test("formats a ConfigInvalidError with path and detail", () => {
    const result = formatServerError({
      name: "ConfigInvalidError",
      data: { path: "opencode.json", message: "bad value", issues: [] },
    })
    expect(result).toBe("Config file at opencode.json is invalid: bad value")
  })
})

describe("parseReadableConfigInvalidError", () => {
  test("joins issue paths and messages", () => {
    const result = parseReadableConfigInvalidError({
      name: "ConfigInvalidError",
      data: {
        path: "opencode.json",
        message: "",
        issues: [
          { path: ["provider", "id"], message: "required" },
          { path: [], message: "top-level problem" },
        ],
      },
    })
    expect(result).toContain("provider.id: required")
    expect(result).toContain("top-level problem")
  })

  test("uses a generic invalid message when there is no detail", () => {
    const result = parseReadableConfigInvalidError({
      name: "ConfigInvalidError",
      data: { path: "config", message: "", issues: [] },
    })
    expect(result).toBe("Config file at config is invalid")
  })
})
