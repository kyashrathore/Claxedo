import { describe, expect, test } from "bun:test"
import {
  asArray,
  asBoolean,
  asFiniteNumber,
  asRecord,
  asRecordOrEmpty,
  asString,
  assertNonNegativeSafeInteger,
  assertRecord,
  isBoolean,
  isFiniteNumber,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isRecord,
  isString,
  nonEmptyString,
  numberClaim,
  stringClaim,
  typeOf,
} from "./guards"

describe("typeOf", () => {
  test("separates null and array from object", () => {
    expect(typeOf(null)).toBe("null")
    expect(typeOf([])).toBe("array")
    expect(typeOf({})).toBe("object")
    expect(typeOf(undefined)).toBe("undefined")
    expect(typeOf(1n)).toBe("bigint")
    expect(typeOf(() => {})).toBe("function")
  })
})

describe("isRecord", () => {
  test("rejects arrays and null, accepts plain and null-prototype objects", () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord(Object.create(null))).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord("x")).toBe(false)
  })

  test("asRecord passes the SAME object through, asRecordOrEmpty totalizes", () => {
    const source = { a: 1 }
    expect(asRecord(source)).toBe(source)
    expect(asRecord([])).toBeUndefined()
    expect(asRecordOrEmpty([])).toEqual({})
    expect(asRecordOrEmpty(source)).toBe(source)
  })

  test("assertRecord names the label in the message", () => {
    expect(() => assertRecord([], "payload")).toThrow("payload must be an object")
    const source = { a: 1 }
    expect(assertRecord(source, "payload")).toBe(source)
  })
})

describe("string guards", () => {
  test("isString/asString do not trim or reject blanks", () => {
    expect(isString("")).toBe(true)
    expect(asString("  ")).toBe("  ")
    expect(asString(1)).toBeUndefined()
  })

  test("nonEmptyString rejects only the empty string and returns the ORIGINAL", () => {
    // Deliberately does not trim: a whitespace-only string is non-empty.
    expect(isNonEmptyString("")).toBe(false)
    expect(isNonEmptyString("  ")).toBe(true)
    expect(nonEmptyString(" a ")).toBe(" a ")
    expect(nonEmptyString("")).toBeUndefined()
    expect(nonEmptyString(0)).toBeUndefined()
  })
})

describe("number guards", () => {
  test("finite excludes NaN and Infinity", () => {
    expect(isFiniteNumber(Number.NaN)).toBe(false)
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false)
    expect(asFiniteNumber("1")).toBeUndefined()
    expect(asFiniteNumber(0)).toBe(0)
  })

  test("non-negative safe integer rejects fractions, negatives and unsafe magnitudes", () => {
    expect(isNonNegativeSafeInteger(0)).toBe(true)
    expect(isNonNegativeSafeInteger(-1)).toBe(false)
    expect(isNonNegativeSafeInteger(1.5)).toBe(false)
    expect(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 2)).toBe(false)
    expect(() => assertNonNegativeSafeInteger("limit", -1)).toThrow(
      "limit must be a non-negative integer",
    )
    expect(assertNonNegativeSafeInteger("limit", 3)).toBeUndefined()
  })
})

describe("boolean guards", () => {
  test("no coercion", () => {
    expect(isBoolean(0)).toBe(false)
    expect(asBoolean("true")).toBeUndefined()
    expect(asBoolean(false)).toBe(false)
  })
})

describe("claims", () => {
  test("stringClaim returns the untrimmed original but rejects blank", () => {
    expect(stringClaim({ iss: " a " }, "iss")).toBe(" a ")
    expect(stringClaim({ iss: "   " }, "iss")).toBeUndefined()
    expect(stringClaim({}, "iss")).toBeUndefined()
  })

  test("numberClaim rejects numeric strings", () => {
    expect(numberClaim({ exp: 1 }, "exp")).toBe(1)
    expect(numberClaim({ exp: "1" }, "exp")).toBeUndefined()
  })
})

describe("asArray", () => {
  test("returns the array BY REFERENCE and totalizes everything else", () => {
    const source = [1]
    expect(asArray(source)).toBe(source)
    expect(asArray("x")).toEqual([])
  })
})
