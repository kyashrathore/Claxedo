/**
 * Errors carry a machine-readable shape instead of inventing one per class.
 *
 * `ClaxedoError` supplies `code`, `status` and `retryable`. Without a common
 * base, every layer that turns an unknown error into an HTTP response has to
 * guess: probing for fields that may not exist, defaulting to 500, or matching
 * on message text to decide whether a retry is safe. The last one is the
 * dangerous case — a non-idempotent write replayed because an error "looked
 * transient".
 *
 * This is a RATCHET, not a clean assertion. 52 classes still extend raw `Error`
 * and converting them all at once would be a single unreviewable diff across
 * every domain. The count may fall freely; raising it takes a deliberate edit
 * here, which is the point at which someone has to justify a new bespoke shape.
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { walk } from "../../test-support/guards"

const SRC = path.resolve(import.meta.dirname, "../..")

/**
 * `class X extends Error` in production source. Test files are excluded: a
 * throwaway error class inside a test is not a shape anyone has to handle.
 */
function rawErrorSubclasses() {
  const found: string[] = []
  for (const file of walk(SRC).filter((entry) => entry.endsWith(".ts"))) {
    if (file.endsWith(".test.ts")) continue
    const text = fs.readFileSync(file, "utf8")
    for (const match of text.matchAll(/class\s+([A-Za-z0-9_]+)\s+extends\s+Error\b/g)) {
      found.push(`${path.relative(SRC, file)}:${match[1]}`)
    }
  }
  return found.toSorted()
}

describe("error base", () => {
  test("the number of classes extending raw Error does not grow", () => {
    const raw = rawErrorSubclasses()
    // ClaxedoError itself is the one class that MUST extend Error.
    const offenders = raw.filter((entry) => !entry.endsWith(":ClaxedoError"))

    // Pinned to the EXACT current count, not a round number above it: a
    // ceiling with slack is headroom a new bespoke class slips into without
    // anyone reviewing it, which is the one thing this ratchet exists to stop.
    expect(offenders.length).toBeLessThanOrEqual(52)
  })

  test("ClaxedoError is the only thing in platform/errors/ that extends raw Error", () => {
    // The base's own directory is where a second, competing base would appear.
    const offenders = rawErrorSubclasses().filter(
      (entry) => entry.startsWith("platform/errors/") && !entry.endsWith(":ClaxedoError"),
    )

    expect(offenders).toEqual([])
  })

  test("a ClaxedoError subclass reports its own name without restating it", () => {
    // `new.target` in the base makes `this.name = "..."` redundant in every
    // subclass. A reintroduced assignment is dead code that drifts from the
    // class name it duplicates.
    const offenders: string[] = []
    for (const file of walk(SRC).filter((entry) => entry.endsWith(".ts"))) {
      if (file.endsWith(".test.ts")) continue
      const text = fs.readFileSync(file, "utf8")
      if (!/extends\s+ClaxedoError\b/.test(text)) continue
      if (/this\.name\s*=/.test(text)) offenders.push(path.relative(SRC, file))
    }

    expect(offenders.toSorted()).toEqual([])
  })
})
