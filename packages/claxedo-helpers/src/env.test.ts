import { describe, expect, test } from "bun:test"
import { envText, positiveIntegerEnv, stringRecord } from "./env"

describe("envText", () => {
  test("blank, whitespace-only and missing are indistinguishable", () => {
    const env = { SET: " value ", BLANK: "", SPACES: "   " }
    expect(envText(env, "SET")).toBe("value")
    expect(envText(env, "BLANK")).toBeUndefined()
    expect(envText(env, "SPACES")).toBeUndefined()
    expect(envText(env, "MISSING")).toBeUndefined()
  })
})

describe("stringRecord", () => {
  test("keeps only string-valued own entries", () => {
    expect(stringRecord({ a: "1", b: 2, c: null, d: {}, e: undefined })).toEqual({ a: "1" })
  })

  test("non-records totalize to an empty record", () => {
    expect(stringRecord(null)).toEqual({})
    expect(stringRecord(["a"])).toEqual({})
    expect(stringRecord("a")).toEqual({})
  })
})

describe("positiveIntegerEnv", () => {
  test("missing or blank falls back", () => {
    expect(positiveIntegerEnv({}, "PORT", { fallback: 3000 })).toBe(3000)
    expect(positiveIntegerEnv({ PORT: "   " }, "PORT", { fallback: 3000 })).toBe(3000)
  })

  test("present-but-invalid ALWAYS throws, even with a fallback", () => {
    expect(() => positiveIntegerEnv({ PORT: "0" }, "PORT", { fallback: 3000 })).toThrow(
      "PORT must be a positive integer",
    )
    expect(() => positiveIntegerEnv({ PORT: "abc" }, "PORT", { fallback: 3000 })).toThrow()
    expect(() => positiveIntegerEnv({ PORT: "-1" }, "PORT", { fallback: 3000 })).toThrow()
  })

  test("missing with no fallback throws", () => {
    expect(() => positiveIntegerEnv({}, "PORT")).toThrow("PORT must be a positive integer")
  })

  test("a valid value parses", () => {
    expect(positiveIntegerEnv({ PORT: " 8080 " }, "PORT", { fallback: 3000 })).toBe(8080)
  })

  test("the caller's error taxonomy is preserved", () => {
    class ConfigError extends Error {}
    expect(() =>
      positiveIntegerEnv({ PORT: "0" }, "PORT", { error: (key) => new ConfigError(key) }),
    ).toThrow(ConfigError)
  })
})
