import { describe, expect, test } from "bun:test"
import { detachedNodes, tailSlope, type MemorySample } from "../src/memory-runner"

const sweep = (heaps: number[]): MemorySample[] =>
  heaps.map((heapBytes, index) => ({
    step: index * 10, heapBytes, domNodes: 0, queries: 0, cachedSessions: 0, families: {}, documents: 0, nodes: 0, listeners: 0,
  }))

const MB = 1024 * 1024

describe("tail slope", () => {
  test("ignores startup, which always looks like growth", () => {
    // Chunks evaluate and caches warm during the first visits, so a fit over
    // the whole sweep would call every app a leak. Asserted against the
    // genuinely-growing case rather than an absolute: the claim is that these
    // two shapes are told apart, and a hard byte threshold here would be
    // tuned to the fixture rather than to the behaviour.
    const startupThenFlat = sweep([20 * MB, 60 * MB, 90 * MB, 92 * MB, 92 * MB, 92 * MB, 92 * MB])
    const linear = sweep([20, 30, 40, 50, 60, 70, 80, 90].map((mb) => mb * MB))
    expect(tailSlope(startupThenFlat)).toBeLessThan(tailSlope(linear) / 10)
  })

  test("reports steady growth that startup cannot explain", () => {
    const linear = sweep([20, 30, 40, 50, 60, 70, 80, 90].map((mb) => mb * MB))
    // ~10MB per 10 steps = ~1MB per step, well clear of a plateau.
    expect(tailSlope(linear)).toBeGreaterThan(0.5 * MB)
  })

  test("a flat curve from a sweep that never accumulated is still flat", () => {
    // The shape of the false pass this lane exists to prevent: an earlier
    // harness reloaded the page each step, so the heap was discarded every
    // time and read as a perfect plateau. The slope cannot detect that on its
    // own — `cachedSessions` staying at its boot value is the tell — so this
    // test pins the arithmetic and the lane keeps the counter alongside it.
    expect(tailSlope(sweep([22 * MB, 22 * MB, 22 * MB, 22 * MB, 22 * MB, 22 * MB]))).toBe(0)
  })

  test("a sweep too short to have a tail reports no slope rather than a guess", () => {
    expect(tailSlope(sweep([20 * MB]))).toBe(0)
    expect(tailSlope([])).toBe(0)
  })
})

describe("detached nodes", () => {
  const counts = (nodes: number, domNodes: number) => ({ nodes, domNodes })

  test("is the gap between live nodes and attached ones", () => {
    // The whole point: the page can only count what is still in the document,
    // so a sweep reading `domNodes` alone sees 3821 -> 5530 and calls it fine
    // while the browser is holding 16986 live nodes.
    expect(detachedNodes(counts(16986, 5530))).toBe(11456)
  })

  test("never reports negative when attached exceeds the sampled total", () => {
    // The two counts come from different sources sampled moments apart, so
    // they can cross; a negative "detached" would read as the leak reversing.
    expect(detachedNodes(counts(100, 140))).toBe(0)
  })
})
