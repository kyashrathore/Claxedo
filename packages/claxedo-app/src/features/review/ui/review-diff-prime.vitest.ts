/**
 * createReviewDiffPrime — ahead-of-need and intent priming.
 *
 * The hover-intent and guard-pane paths prime synchronously (the dwell IS the
 * head start), while the first-fold ahead prime is deferred to idle so its
 * parse-and-dispatch never lands inside the interaction that revealed the
 * diffs. jsdom has no requestIdleCallback, so these tests exercise the timer
 * fallback deterministically with fake timers.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot, createSignal } from "solid-js"

const h = vi.hoisted(() => ({
  prime: vi.fn(),
}))

vi.mock("@/ui/session-kit-loaders", () => ({
  primeDiffHighlight: h.prime,
}))

import { createReviewDiffPrime } from "./review-diff-prime"
import type { ReviewDiffShape } from "./review-session-logic"
import { resolveFileDiff } from "@/ui/session-kit"

const diff = (file: string, patch = `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old ${file}\n+new ${file}\n`): ReviewDiffShape => ({
  file,
  additions: 1,
  deletions: 1,
  patch,
})

// Identity through the same resolver the implementation uses: identical diff
// content resolves to one cached object with one cacheKey.
const primedKeys = () => h.prime.mock.calls.map(([, fileDiff]) => fileDiff.cacheKey)
const keysOf = (diffs: readonly ReviewDiffShape[]) => diffs.map((d) => resolveFileDiff(d).cacheKey)

const mount = (input: {
  diffs: () => readonly ReviewDiffShape[]
  diffStyle?: () => "unified" | "split"
}) => {
  let prime!: ReturnType<typeof createReviewDiffPrime>
  const dispose = createRoot((dispose) => {
    prime = createReviewDiffPrime({
      diffs: input.diffs,
      diffStyle: input.diffStyle ?? (() => "split"),
      isForcedFile: () => false,
      isExpandedFile: () => false,
    })
    return dispose
  })
  return { prime, dispose }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  h.prime.mockClear()
})

describe("createReviewDiffPrime (ahead of need)", () => {
  test("primes only the first-fold rows, and only at idle", () => {
    const diffs = Array.from({ length: 12 }, (_, i) => diff(`src/file-${String(i).padStart(2, "0")}.ts`))
    const { dispose } = mount({ diffs: () => diffs })
    expect(h.prime).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600)
    expect(primedKeys()).toEqual(keysOf(diffs.slice(0, 8)))
    dispose()
  })

  test("skips media and above-ceiling rows without spending the head start on them", () => {
    const tooLarge: ReviewDiffShape = { ...diff("src/huge.ts"), additions: 600, deletions: 0 }
    const diffs = [diff("a.ts"), { ...diff("logo.png") }, tooLarge, diff("b.ts")]
    const { dispose } = mount({ diffs: () => diffs })
    vi.advanceTimersByTime(600)
    expect(primedKeys()).toEqual(keysOf([diffs[0]!, diffs[3]!]))
    dispose()
  })

  test("a style change re-primes the ahead rows under the new style", () => {
    const [style, setStyle] = createSignal<"unified" | "split">("split")
    const { dispose } = mount({ diffs: () => [diff("a.ts")], diffStyle: style })
    vi.advanceTimersByTime(600)
    expect(h.prime.mock.calls.map(([s]) => s)).toEqual(["split"])
    setStyle("unified")
    vi.advanceTimersByTime(600)
    expect(h.prime.mock.calls.map(([s]) => s)).toEqual(["split", "unified"])
    dispose()
  })

  test("disposal cancels a pending ahead prime", () => {
    const { dispose } = mount({ diffs: () => [diff("a.ts")] })
    dispose()
    vi.advanceTimersByTime(600)
    expect(h.prime).not.toHaveBeenCalled()
  })
})

describe("createReviewDiffPrime (intent)", () => {
  test("hover intent primes immediately and is not re-primed by the ahead pass", () => {
    const diffs = [diff("a.ts"), diff("b.ts")]
    const { prime, dispose } = mount({ diffs: () => diffs })
    prime.intend("b.ts")
    expect(primedKeys()).toEqual(keysOf([diffs[1]!]))
    vi.advanceTimersByTime(600)
    expect(primedKeys()).toEqual(keysOf([diffs[1]!, diffs[0]!]))
    dispose()
  })
})
