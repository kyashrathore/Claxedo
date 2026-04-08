/**
 * Shared helpers for e2e test scenarios.
 *
 * Each test file gets its own browser session via setup/teardown,
 * its own screenshot directory, and its own video.
 */
import { setup as baseSetup, teardown as baseTeardown } from "../setup"
import {
  initScreenshots,
  setTestContext,
  screenshot,
  compileVideo,
  snapshot,
  countOccurrences,
  countTabs,
  settle,
  waitFor,
} from "../ab"
import { resolve } from "node:path"

/**
 * Create a beforeAll/afterAll pair scoped to a test suite.
 * Each suite gets its own screenshot subdirectory and video.
 */
export function suiteLifecycle(suiteName: string) {
  const dir = resolve(import.meta.dir, "../screenshots", suiteName)

  async function before() {
    initScreenshots(dir)
    const result = await baseSetup()
    // Wait for initial render to complete
    await settle(2000)
    return result
  }

  async function after() {
    await compileVideo()
    await baseTeardown()
  }

  return { before, after }
}

/**
 * Assert that a substring appears exactly `expected` times in the snapshot.
 * Throws with a descriptive message on mismatch.
 */
export function assertCount(
  snap: string,
  needle: string,
  expected: number,
  message?: string,
): void {
  const actual = countOccurrences(snap, needle)
  if (actual !== expected) {
    throw new Error(
      message ??
        `Expected "${needle}" to appear ${expected} time(s), found ${actual}`,
    )
  }
}

/**
 * Assert that a substring appears at least `min` times in the snapshot.
 */
export function assertMinCount(
  snap: string,
  needle: string,
  min: number,
  message?: string,
): void {
  const actual = countOccurrences(snap, needle)
  if (actual < min) {
    throw new Error(
      message ??
        `Expected "${needle}" to appear at least ${min} time(s), found ${actual}`,
    )
  }
}

/**
 * Runtime conditional skip for E2E tests where the condition is only
 * knowable after browser state loads (e.g. whether process button exists).
 *
 * bun:test has no runtime skip API, so this logs a prominent SKIP marker
 * for CI visibility and returns. Callers must `return` after calling this.
 *
 * Usage: if (!condition) { runtimeSkip("test name", "reason"); return }
 */
export function runtimeSkip(testName: string, reason: string): void {
  console.warn(`\n[RUNTIME-SKIP] ${testName}: ${reason}\n`)
}

export {
  setTestContext,
  screenshot,
  snapshot,
  countOccurrences,
  countTabs,
  settle,
  waitFor,
}
