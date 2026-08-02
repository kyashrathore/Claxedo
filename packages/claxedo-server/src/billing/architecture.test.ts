import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"

/**
 * WP-BILLING architecture guards (D4/D5, invariants I-1/I-3):
 *
 * 1. SINGLE WRITER (I-3, the grep-style guard the design doc calls for): the
 *    mirrored org billing fields are written by convex/billing.ts and nowhere
 *    else. Any other convex module naming them is either a new writer (bug)
 *    or a read that belongs behind the billing module's helpers.
 * 2. POLAR CONFINEMENT (D4 addendum): all Polar code lives in src/billing/**.
 *    `@polar-sh/sdk` imports outside that directory — and any Polar token in
 *    the storage-agnostic control-plane core (R8's spirit) — are boundary
 *    breaches.
 */

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const convexRoot = path.join(repoRoot, "convex")
const serverSrc = path.resolve(import.meta.dirname, "..")

const BILLING_FIELDS = [
  "polar_customer_id",
  "polar_subscription_id",
  "seats_licensed",
  "subscription_status",
  "current_period_end",
  "billing_synced_at",
  "polar_state_modified_at",
  "billing_reconcile_flagged_at",
]

// schema.ts declares the fields; billing.ts is the single writer (and the
// home of every billing-field read helper, e.g. enforceSeatCapacity).
const CONVEX_ALLOWED = new Set(["schema.ts", "billing.ts"])

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return []
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

describe("billing single-writer guard (I-3)", () => {
  test("no convex module outside schema.ts/billing.ts names a mirrored billing field", () => {
    const offenders = fs.readdirSync(convexRoot)
      .filter((file) => file.endsWith(".ts") && !CONVEX_ALLOWED.has(file))
      .flatMap((file) => {
        const text = fs.readFileSync(path.join(convexRoot, file), "utf8")
        return BILLING_FIELDS.filter((field) => text.includes(field)).map((field) => `convex/${file}:${field}`)
      })
    expect(offenders).toEqual([])
  })

  test("the applyPolarState writer is invoked from src/billing/** only", () => {
    const offenders = walk(serverSrc)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => !file.includes(`${path.sep}billing${path.sep}`))
      .filter((file) => fs.readFileSync(file, "utf8").includes("applyPolarState"))
      .map((file) => path.relative(serverSrc, file))
    expect(offenders).toEqual([])
  })
})

describe("Polar confinement (D4 addendum)", () => {
  test("@polar-sh/sdk is imported only under src/billing/**", () => {
    const offenders = walk(serverSrc)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))
      .filter((file) => !file.includes(`${path.sep}billing${path.sep}`))
      .filter((file) => fs.readFileSync(file, "utf8").includes("@polar-sh/sdk"))
      .map((file) => path.relative(serverSrc, file))
    expect(offenders).toEqual([])
  })

  test("the storage-agnostic control-plane core stays Polar-free (R8's vendor-token rule)", () => {
    const controlPlaneSrc = path.join(serverSrc, "authority")
    const offenders = walk(controlPlaneSrc)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => /polar/i.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(controlPlaneSrc, file))
    expect(offenders).toEqual([])
  })

  test("self-host entrypoints stay Polar-free (I-1): server.ts and main.ts never import billing", () => {
    for (const entrypoint of ["deployments/local/server.ts", "deployments/local/main.ts"]) {
      const text = fs.readFileSync(path.join(serverSrc, entrypoint), "utf8")
      expect(text.includes("billing/"), `${entrypoint} must not import billing modules`).toBe(false)
      expect(/polar/i.test(text), `${entrypoint} must not name Polar`).toBe(false)
    }
  })
})
