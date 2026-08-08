import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

/**
 * Drift guard for the machine-enrollment retention policy.
 *
 * The plan requires that "Convex and SQLite implement and test the same
 * bounds", and calls them "one canonical policy constants, not adapter
 * defaults". They cannot literally be one declaration: a Convex function module
 * is deployed on its own and cannot import from a workspace package (nothing in
 * `convex/*.ts` does, outside tests). So the enforcement is a drift test rather
 * than a shared import — the same trade `rate-limit-config-drift.test.ts` and
 * `worker-cron-drift.test.ts` make for values that live in two files by
 * necessity.
 *
 * The failure this catches is silent by construction: tuning one side's TTL
 * leaves both suites green, both authorities self-consistent, and a self-hosted
 * deployment retiring rows at a different age than Convex Cloud. Nothing else
 * in either suite compares the two.
 */

const repoRoot = path.resolve(import.meta.dirname, "..")

const SOURCES = {
  convex: path.join(repoRoot, "convex", "hostEnrollments.ts"),
  sqlite: path.join(
    repoRoot,
    "packages",
    "claxedo-server-core",
    "src",
    "authority",
    "adapters",
    "sqlite",
    "workspace-authority.ts",
  ),
}

/** Every `const NAME = <number expression>` the file declares, evaluated. */
function constants(file: string) {
  const source = fs.readFileSync(file, "utf8")
  const found = new Map<string, number>()
  for (const [, name, expression] of source.matchAll(
    /^(?:export )?const (ENROLLMENT_[A-Z_]+) = ([0-9_ *+]+)$/gm,
  )) {
    // Only digits, underscores and `* +` reach here, so this evaluates the
    // written form (`10 * 60_000`) rather than a value someone had to keep in
    // sync by hand in the test.
    found.set(name!, Number(new Function(`return ${expression!}`)()))
  }
  return found
}

describe("machine-enrollment retention policy", () => {
  test("both authorities declare the same canonical bounds", () => {
    const convex = constants(SOURCES.convex)
    const sqlite = constants(SOURCES.sqlite)

    // Names first: a rename on one side would otherwise make the comparison
    // below vacuously true by comparing two empty maps.
    expect([...convex.keys()].toSorted()).toEqual([
      "ENROLLMENT_CHALLENGE_TTL_MS",
      "ENROLLMENT_CONSUMED_RETENTION_MS",
      "ENROLLMENT_REQUEST_SWEEP_LIMIT",
    ])
    expect([...sqlite.keys()].toSorted()).toEqual([...convex.keys()].toSorted())

    for (const [name, value] of convex) {
      expect(sqlite.get(name), `${name} differs between the Convex and SQLite authorities`).toBe(value)
    }
  })

  test("the declared values are the policy the plan and the tests assert", () => {
    const convex = constants(SOURCES.convex)

    // 60s, deliberately STRICTER than the plan's two minutes — the nonce is
    // one-use, owner-bound and host-bound, so a lapsed one costs a free retry.
    // Pinned here so tightening or loosening it is a decision someone writes
    // down, not an edit that slides through.
    expect(convex.get("ENROLLMENT_CHALLENGE_TTL_MS")).toBe(60_000)
    // Ten minutes, NOT optional and NOT negotiable against the sweep: this is
    // what makes an exact retry answerable, so pruning may never run ahead of
    // it.
    expect(convex.get("ENROLLMENT_CONSUMED_RETENTION_MS")).toBe(10 * 60_000)
    expect(convex.get("ENROLLMENT_CONSUMED_RETENTION_MS")).toBeGreaterThan(
      convex.get("ENROLLMENT_CHALLENGE_TTL_MS")!,
    )
  })

  test("both authorities actually sweep, rather than merely declaring a bound", () => {
    // The bug this whole guard descends from was a live `expires_at` that
    // nothing acted on. A constant is not a retention policy.
    expect(fs.readFileSync(SOURCES.convex, "utf8")).toMatch(/export const sweepExpired = cronMutation\(/)
    expect(fs.readFileSync(path.join(repoRoot, "convex", "crons.ts"), "utf8")).toContain(
      "internal.hostEnrollments.sweepExpired",
    )
    expect(fs.readFileSync(SOURCES.sqlite, "utf8")).toMatch(/DELETE FROM host_enrollment_requests/)
  })
})
