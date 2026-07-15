import { describe, expect, test } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { normalizeRuntimeLeaseLegacyFields, run } from "../../../../convex/migrations"

// D14 — Convex schema evolution discipline (launch plan 2026-07-11-012 §1 /
// ADR 016 §5): the MIGRATE step of expand-migrate-contract runs exclusively
// through the @convex-dev/migrations component. This test pins the mechanism:
// the component is registered, migration functions are internal-only, and the
// retired hand-rolled backfill pattern does not grow back.

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const convexRoot = path.join(repoRoot, "convex")

describe("Convex migrations discipline (D14)", () => {
  test("the migrations component is registered in the app definition", () => {
    const config = fs.readFileSync(path.join(convexRoot, "convex.config.ts"), "utf8")
    expect(config).toContain('@convex-dev/migrations/convex.config')
    expect(config).toContain("app.use(migrations)")
  })

  test("migration functions are internal: runnable only with deploy credentials, never by clients", () => {
    expect((run as { isInternal?: boolean }).isInternal).toBe(true)
    expect((normalizeRuntimeLeaseLegacyFields as { isInternal?: boolean }).isInternal).toBe(true)
  })

  test("migration #001 retro-registers the runtime_leases legacy-field backfill", () => {
    const source = fs.readFileSync(path.join(convexRoot, "migrations.ts"), "utf8")
    const schema = fs.readFileSync(path.join(convexRoot, "schema.ts"), "utf8")
    expect(source).toContain('table: "runtime_leases"')
    // The normalize LOGIC stays in sandboxLeases.ts; the migration reuses it
    // instead of forking a second implementation.
    expect(source).toContain("hasLegacyLeaseFields")
    expect(source).toContain("legacyLeaseDocument")
    expect(schema).toContain("provider: v.optional(v.string())")
    expect(schema).toContain("provider_runtime_id: v.optional(v.string())")
    expect(schema).toContain("remote_access_enabled: v.optional(v.boolean())")
  })

  test("the retired hand-rolled backfill survives only as the documented break-glass export", () => {
    // architecture.test.ts pins that the export exists (the maintenance script
    // still calls it); this pins that it stays marked retired so new backfills
    // do not copy the pattern.
    const source = fs.readFileSync(path.join(convexRoot, "sandboxLeases.ts"), "utf8")
    const retiredMarker = source.indexOf("RETIRED as a hand-rolled backfill")
    const exportSite = source.indexOf("export const normalizeLegacyFields")
    expect(retiredMarker).toBeGreaterThan(-1)
    expect(exportSite).toBeGreaterThan(retiredMarker)
  })
})
