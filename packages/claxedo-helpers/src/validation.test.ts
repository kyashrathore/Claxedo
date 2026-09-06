import { describe, expect, test } from "bun:test"
import {
  createRequireText,
  exactHttpsOrigin,
  requireCanonicalString,
  requiredText,
} from "./validation"

describe("requiredText", () => {
  test("returns the trimmed value and names the field", () => {
    expect(requiredText("  a  ", "name")).toBe("a")
    expect(() => requiredText("   ", "name")).toThrow("name is required")
    expect(() => requiredText(undefined, "name")).toThrow("name is required")
    expect(() => requiredText(5, "name")).toThrow("name is required")
  })
})

describe("requireCanonicalString", () => {
  test("returns the value UNCHANGED and never trims for the caller", () => {
    expect(requireCanonicalString("ws_1", "workspaceId")).toBe("ws_1")
  })

  test("an untrimmed identity is rejected, not silently normalized", () => {
    expect(() => requireCanonicalString(" ws_1", "workspaceId")).toThrow(
      "workspaceId must be a non-empty trimmed string",
    )
    expect(() => requireCanonicalString("ws_1 ", "workspaceId")).toThrow()
    expect(() => requireCanonicalString("", "workspaceId")).toThrow()
  })

  test("the caller's error constructor is used", () => {
    class Invalid extends Error {}
    expect(() => requireCanonicalString("", "id", (m) => new Invalid(m))).toThrow(Invalid)
  })
})

describe("exactHttpsOrigin", () => {
  test("accepts the bare origin, with or without one trailing slash", () => {
    expect(exactHttpsOrigin("https://app.dev", "ORIGIN")).toBe("https://app.dev")
    expect(exactHttpsOrigin("https://app.dev/", "ORIGIN")).toBe("https://app.dev")
    expect(exactHttpsOrigin("  https://app.dev  ", "ORIGIN")).toBe("https://app.dev")
    expect(exactHttpsOrigin("https://app.dev:8443", "ORIGIN")).toBe("https://app.dev:8443")
  })

  test("rejects paths, queries, credentials, wildcards, http and uppercase hosts", () => {
    for (const value of [
      "https://app.dev/path",
      "https://app.dev/?a=1",
      "https://app.dev/#x",
      "https://user:pw@app.dev",
      "https://*.app.dev",
      "http://app.dev",
      "https://APP.dev",
      "https://app.dev:443",
      "not a url",
      "",
      undefined,
    ]) {
      expect(() => exactHttpsOrigin(value, "ORIGIN")).toThrow()
    }
  })

  test("allowPort:false rejects an explicit port", () => {
    expect(() => exactHttpsOrigin("https://app.dev:8443", "ORIGIN", { allowPort: false })).toThrow(
      "ORIGIN must be an exact https origin",
    )
    expect(exactHttpsOrigin("https://app.dev", "ORIGIN", { allowPort: false })).toBe(
      "https://app.dev",
    )
  })

  test("missing and malformed carry different messages, both through the caller's error", () => {
    class Invalid extends Error {}
    const error = (message: string) => new Invalid(message)
    expect(() => exactHttpsOrigin("", "ORIGIN", { error })).toThrow("ORIGIN is required")
    expect(() => exactHttpsOrigin("http://a.dev", "ORIGIN", { error })).toThrow(Invalid)
  })
})

describe("createRequireText", () => {
  class Invalid extends Error {}
  const { requireText, optionalText } = createRequireText((message) => new Invalid(message))

  test("length is measured on the trimmed value, which is what is returned", () => {
    expect(requireText(`  ${"a".repeat(512)}  `, "title")).toBe("a".repeat(512))
    expect(() => requireText("a".repeat(513), "title")).toThrow(
      "title must be a non-empty string of at most 512 characters",
    )
    expect(() => requireText("abc", "title", 2)).toThrow(
      "title must be a non-empty string of at most 2 characters",
    )
  })

  test("wrong type and blank fail through the bound constructor", () => {
    expect(() => requireText(5, "title")).toThrow(Invalid)
    expect(() => requireText(5, "title")).toThrow("title must be a string")
    expect(() => requireText("   ", "title")).toThrow(Invalid)
  })

  test("optionalText passes undefined through but still validates null and blanks", () => {
    expect(optionalText(undefined, "title")).toBeUndefined()
    expect(optionalText("  a  ", "title")).toBe("a")
    expect(() => optionalText(null, "title")).toThrow(Invalid)
    expect(() => optionalText("abc", "title", 2)).toThrow(Invalid)
  })
})
