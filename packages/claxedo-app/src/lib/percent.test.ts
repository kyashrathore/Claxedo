import { describe, expect, test } from "bun:test"
import { percentText, readPercent } from "./percent"

describe("percent", () => {
  test("a vendor's measured fraction reads as whole percent", () => {
    expect(percentText(72.68615984405457)).toBe("73%")
    expect(percentText(70.77833333333334)).toBe("71%")
    expect(percentText(100)).toBe("100%")
    expect(percentText(0.4)).toBe("0%")
  })

  test("a spent window never rounds down to nothing spent, nor a full one past full", () => {
    expect(percentText(0.5)).toBe("1%")
    expect(percentText(99.6)).toBe("100%")
  })

  test("the number is what a translated sentence interpolates, without a sign", () => {
    expect(readPercent(72.68615984405457)).toBe(73)
    expect(readPercent(0.4)).toBe(0)
  })
})
