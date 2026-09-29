import { describe, expect, test } from "bun:test"
import { heroKolam, isSingleLine, kolamPath, maxWalkSteps, mirrorCurve, symmetricMirrors } from "../src/components/lab/kolam"

const { columns, rows, share, seed, unit } = heroKolam

describe("sikku kolam", () => {
  test("the shipped kolam builds within the step bound and closes on itself", () => {
    const mirrors = symmetricMirrors(columns, rows, share, seed)
    const walk = mirrorCurve(columns, rows, mirrors)
    expect(walk.length).toBeLessThanOrEqual(maxWalkSteps(columns, rows))
    expect(walk[0].at).toEqual([1, 0])
    expect(kolamPath(columns, rows, mirrors, unit)).toEndWith("Z")
  })

  test("any mirror set on the shipped grid terminates within the step bound", () => {
    const width = 2 * columns
    const height = 2 * rows
    const gaps: string[] = []
    for (let x = 1; x < width; x++) for (let y = 1; y < height; y++) if ((x + y) % 2 === 1) gaps.push(`${x},${y}`)
    let state = 1
    const random = () => (state = (state * 48271) % 2147483647) / 2147483647
    const sets = [new Set<string>(), new Set(gaps), ...Array.from({ length: 200 }, () => new Set(gaps.filter(() => random() < random())))]
    for (const mirrors of sets) expect(mirrorCurve(columns, rows, mirrors).length).toBeLessThanOrEqual(maxWalkSteps(columns, rows))
  })

  test("a coprime grid without mirrors is one closed line", () => {
    expect(isSingleLine(columns, rows, mirrorCurve(columns, rows, new Set()))).toBe(true)
  })

  test("a grid whose sides share a factor splits into several lines", () => {
    expect(isSingleLine(6, 4, mirrorCurve(6, 4, new Set()))).toBe(false)
  })

  test("the shipped mirrors keep the kolam one line, symmetric about both axes", () => {
    const mirrors = symmetricMirrors(columns, rows, share, seed)
    expect(mirrors.size).toBeGreaterThan(0)
    expect(isSingleLine(columns, rows, mirrorCurve(columns, rows, mirrors))).toBe(true)
    for (const key of mirrors) {
      const [x, y] = key.split(",").map(Number)
      expect(mirrors.has(`${2 * columns - x},${2 * rows - y}`)).toBe(true)
    }
  })
})
