import { describe, expect, test } from "bun:test"
import { cliFlagPositiveNumber, cliFlagValue } from "./cli"

describe("cliFlagValue", () => {
  test("accepts both the space form and the equals form", () => {
    expect(cliFlagValue(["--port", "8080"], "port")).toBe("8080")
    expect(cliFlagValue(["--port=8080"], "port")).toBe("8080")
    expect(cliFlagValue(["x", "--port=8080", "y"], "port")).toBe("8080")
  })

  test("an explicitly supplied empty string is returned verbatim, not treated as missing", () => {
    expect(cliFlagValue(["--name="], "name")).toBe("")
    expect(cliFlagValue(["--name", ""], "name")).toBe("")
    expect(cliFlagValue(["--name", "  x  "], "name")).toBe("  x  ")
  })

  test("the first occurrence wins", () => {
    expect(cliFlagValue(["--port", "1", "--port", "2"], "port")).toBe("1")
  })

  test("a missing flag and a trailing space-form flag both fall back", () => {
    expect(cliFlagValue([], "port")).toBeUndefined()
    expect(cliFlagValue(["--port"], "port")).toBeUndefined()
    expect(cliFlagValue(["--port"], "port", "3000")).toBe("3000")
    expect(cliFlagValue(["--portable=1"], "port")).toBeUndefined()
  })
})

describe("cliFlagPositiveNumber", () => {
  test("parses positive numbers, including fractions", () => {
    expect(cliFlagPositiveNumber(["--rate", "2.5"], "rate", 1)).toBe(2.5)
    expect(cliFlagPositiveNumber(["--rate=4"], "rate", 1)).toBe(4)
  })

  test("missing, non-numeric, zero, negative and Infinity all fall back", () => {
    expect(cliFlagPositiveNumber([], "rate", 1)).toBe(1)
    expect(cliFlagPositiveNumber(["--rate", "abc"], "rate", 1)).toBe(1)
    expect(cliFlagPositiveNumber(["--rate", "0"], "rate", 1)).toBe(1)
    expect(cliFlagPositiveNumber(["--rate", "-2"], "rate", 1)).toBe(1)
    expect(cliFlagPositiveNumber(["--rate", "Infinity"], "rate", 1)).toBe(1)
    expect(cliFlagPositiveNumber(["--rate", ""], "rate", 1)).toBe(1)
  })
})
