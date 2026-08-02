import { describe, expect, test } from "vitest"
import { timingSafeEqualStrings } from "./web-crypto"

describe("timingSafeEqualStrings", () => {
  test("matches equal strings and rejects unequal ones", () => {
    expect(timingSafeEqualStrings("resolver-token", "resolver-token")).toBe(true)
    expect(timingSafeEqualStrings("resolver-token", "resolver-tokeN")).toBe(false)
    expect(timingSafeEqualStrings("resolver-token", "resolver-token-longer")).toBe(false)
    expect(timingSafeEqualStrings("resolver", "resolver-token")).toBe(false)
    expect(timingSafeEqualStrings("", "")).toBe(true)
    expect(timingSafeEqualStrings("", "x")).toBe(false)
  })

  test("handles multi-byte input without throwing", () => {
    expect(timingSafeEqualStrings("töken", "töken")).toBe(true)
    expect(timingSafeEqualStrings("töken", "token")).toBe(false)
  })
})
