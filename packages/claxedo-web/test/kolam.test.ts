import { describe, expect, test } from "bun:test"
import { isSingleLine, mirrorCurve, symmetricMirrors } from "../src/components/lab/kolam"

describe("sikku kolam", () => {
  test("a coprime grid without mirrors is one closed line", () => {
    expect(isSingleLine(15, 7, mirrorCurve(15, 7, new Set()))).toBe(true)
  })

  test("a grid whose sides share a factor splits into several lines", () => {
    expect(isSingleLine(6, 4, mirrorCurve(6, 4, new Set()))).toBe(false)
  })

  test("the hero's mirrors keep the kolam one line, symmetric about both axes", () => {
    const mirrors = symmetricMirrors(15, 7, 0.6, 5)
    expect(mirrors.size).toBeGreaterThan(0)
    expect(isSingleLine(15, 7, mirrorCurve(15, 7, mirrors))).toBe(true)
    for (const key of mirrors) {
      const [x, y] = key.split(",").map(Number)
      expect(mirrors.has(`${30 - x},${14 - y}`)).toBe(true)
    }
  })
})
