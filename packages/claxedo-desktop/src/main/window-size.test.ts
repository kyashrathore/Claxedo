import { describe, expect, test } from "bun:test"
import { parseWindowSize } from "./window-size"

describe("window size", () => {
  test("accepts exact bounded Chromium window bounds", () => {
    expect(parseWindowSize("1440,925")).toEqual({ width: 1440, height: 925 })
  })

  test("rejects malformed, unsafe, and unusable dimensions", () => {
    for (const value of ["", "1440x900", "319,900", "1440,239", "16385,900", "1440,-1"]) {
      expect(parseWindowSize(value)).toBeUndefined()
    }
  })
})
