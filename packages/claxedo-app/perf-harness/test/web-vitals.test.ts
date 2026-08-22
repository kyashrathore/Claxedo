import { expect, test } from "bun:test"
import {
  cumulativeLayoutShift,
  mergeWebVitals,
  shiftsExcludingRecentInput,
  type WebVitals,
} from "../src/web-vitals"

function vitals(overrides: Partial<WebVitals>): WebVitals {
  return { interactionCount: 0, ...overrides }
}

test("merged attribution comes from ONE run, not mixed across runs", () => {
  // Two runs whose LCP landed on different elements. Pooling these field by
  // field would pair the reported timing with the other run's element and
  // invent a story neither run told.
  const merged = mergeWebVitals([
    vitals({
      lcpMs: 1000,
      lcpElement: "div[data-testid=fast]",
      lcpCandidateCount: 2,
      lcpAtFirstTrustedInputMs: 900,
      lcpAtFirstTrustedInputElement: "div[data-testid=fast]",
      firstTrustedInputMs: 950,
    }),
    vitals({
      lcpMs: 6000,
      lcpElement: "div[data-testid=slow]",
      lcpCandidateCount: 9,
      lcpAtFirstTrustedInputMs: 1200,
      lcpAtFirstTrustedInputElement: "div[data-testid=early]",
      firstTrustedInputMs: 1250,
    }),
  ])

  expect(merged.lcpMs).toBe(6000)
  expect(merged.lcpElement).toBe("div[data-testid=slow]")
  expect(merged.lcpCandidateCount).toBe(9)
  expect(merged.lcpAtFirstTrustedInputMs).toBe(1200)
  expect(merged.lcpAtFirstTrustedInputElement).toBe("div[data-testid=early]")
  expect(merged.firstTrustedInputMs).toBe(1250)
})

test("a flow with only synthetic input reports no frozen LCP", () => {
  // The distinction the whole attribution exists to make: LCP that never
  // finalised is not a load metric, and must not be silently coerced to one.
  const merged = mergeWebVitals([
    vitals({
      lcpMs: 5800,
      lcpElement: "div[data-testid=timeline]",
      lcpCandidateCount: 7,
      firstUntrustedInputMs: 2100,
    }),
  ])

  expect(merged.lcpMs).toBe(5800)
  expect(merged.lcpAtFirstTrustedInputMs).toBeUndefined()
  expect(merged.firstTrustedInputMs).toBeUndefined()
  expect(merged.firstUntrustedInputMs).toBe(2100)
})

test("attribution is absent, not zeroed, when no run supplied it", () => {
  const merged = mergeWebVitals([vitals({ lcpMs: 1200 }), vitals({ lcpMs: 1400 })])
  expect(merged.lcpMs).toBe(1400)
  expect(merged.lcpElement).toBeUndefined()
  expect(merged.lcpCandidateCount).toBeUndefined()
})

test("CLS is the heaviest session window, not the running total", () => {
  // Two clusters separated by a 2s gap: sessions do not merge across >1s, so
  // the score is the heavier cluster (0.3), never their sum (0.5).
  expect(cumulativeLayoutShift([
    { t: 100, value: 0.1 },
    { t: 500, value: 0.1 },
    { t: 3000, value: 0.3 },
  ])).toBeCloseTo(0.3, 6)

  // Within the window they accumulate.
  expect(cumulativeLayoutShift([
    { t: 100, value: 0.1 },
    { t: 500, value: 0.1 },
    { t: 900, value: 0.1 },
  ])).toBeCloseTo(0.3, 6)

  // A session also closes after 5s of continuous shifting.
  expect(cumulativeLayoutShift([
    { t: 0, value: 0.1 },
    { t: 900, value: 0.1 },
    { t: 5200, value: 0.4 },
  ])).toBeCloseTo(0.4, 6)

  expect(cumulativeLayoutShift([])).toBe(0)
})

test("shifts inside 500ms after synthetic input are excused, earlier ones are not", () => {
  const shifts = [
    { t: 100, value: 0.2 },   // before any input — the app's own instability
    { t: 1050, value: 0.3 },  // 50ms after a synthetic click — the user asked for it
    { t: 1600, value: 0.4 },  // 600ms after — outside the window, still counted
  ]
  const kept = shiftsExcludingRecentInput(shifts, [1000])
  expect(kept.map((s) => s.t)).toEqual([100, 1600])
})

test("with no synthetic input nothing is excused", () => {
  const shifts = [{ t: 100, value: 0.2 }, { t: 900, value: 0.3 }]
  expect(shiftsExcludingRecentInput(shifts, [])).toHaveLength(2)
})

test("a shift BEFORE the input it precedes is not excused", () => {
  // The window is forward-looking only: content that moved before the click
  // cannot have been caused by it.
  expect(shiftsExcludingRecentInput([{ t: 900, value: 0.2 }], [1000])).toHaveLength(1)
})
