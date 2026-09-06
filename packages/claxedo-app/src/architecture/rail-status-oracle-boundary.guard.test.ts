/**
 * A Solid component body runs once, so an early `if (status === "idle") return null` in the
 * status dot freezes the glyph at whatever status existed at mount: a spec that queries the
 * dot only after driving it to "working" passes identically against that bug and against the
 * fix. `expectRailStatus` asserts the idle-mount precondition before any caller can drive a
 * transition, and `expectSurfaceParity` asserts sidebar/switcher equality rather than two
 * independent presence checks, which would let the two surfaces drift while both stay green.
 * A hand-written raw selector silently skips both checks.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const appRoot = path.resolve(import.meta.dir, "../..")
const e2eDir = path.join(appRoot, "e2e")

/** The two DOM contracts `rail-oracle.ts` (header, lines 8-14) documents. Any other
 * literal spelling (a typo, a template-built variant) would already dodge this guard,
 * same residual gap `mock-route-shadowing.ts`'s header accepts for non-literal patterns
 * -- not attempted here because both attributes are written as plain string literals
 * everywhere they currently occur (verified 2026-08-06 via a plain grep across e2e/). */
const STATUS_ATTRS = ["data-sidebar-status", "data-switcher-status"] as const

const ALLOWED: { file: string; reason: string }[] = [
  { file: "helpers/rail-oracle.ts", reason: "is the oracle every other file routes through" },
  { file: "helpers/rail-oracle.mutation.test.ts", reason: "constructs raw status mutations to test the rail oracle" },
  { file: "helpers/geometry-oracle.ts", reason: "Phase 1 D3/E1 oracle -- geometry read on the same node, not a status assertion" },
  { file: "helpers/geometry-oracle.mutation.test.ts", reason: "constructs raw status geometry to test the geometry oracle" },
  { file: "helpers/surface-parity.ts", reason: "Phase 1 B9 oracle -- equality across both surfaces is its entire purpose" },
  { file: "helpers/surface-parity.mutation.test.ts", reason: "constructs divergent raw statuses to test the parity oracle" },
  { file: "playwright/core-sidebar-tree.spec.ts", reason: "predates rail-oracle.ts; migration out of scope for this guard" },
  { file: "playwright/core-claude-native-sdk-rail.spec.ts", reason: "predates rail-oracle.ts; migration out of scope for this guard" },
  { file: "playwright/core-terminal.spec.ts", reason: "predates rail-oracle.ts; asserts terminal rows, a shape the oracle does not cover" },
  { file: "playwright/core-panes-split-tabs.spec.ts", reason: "predates surface-parity.ts; migration out of scope for this guard" },
  { file: "playwright/real-harness-local.spec.ts", reason: "predates rail-oracle.ts; Tier R spec, migration out of scope for this guard" },
]

/** Mirrors `scanners.ts`'s `walk`, kept local (not imported) so this guard -- like
 * `e2e-suite-tags.guard.test.ts` beside it -- has no dependency on anything scoped to
 * `src/`. `report`/`test-results` are Playwright's own generated output dirs; skipped
 * defensively even though neither currently contains a `.ts` file (verified 2026-08-06). */
function walkTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "report" || entry.name === "test-results") return []
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walkTs(full)
    return full.endsWith(".ts") ? [full] : []
  })
}

const relFiles = () => walkTs(e2eDir).map((full) => path.relative(e2eDir, full).split(path.sep).join("/"))

describe("rail status oracle boundary", () => {
  test("e2e/ tree exists to guard", () => {
    // A rename/empty-out of e2e/ must not turn every test below into a vacuous pass.
    expect(relFiles().length).toBeGreaterThan(30)
  })

  test("every ALLOWED entry still exists and still needs the exemption", () => {
    const offenders = ALLOWED.flatMap(({ file, reason }) => {
      const full = path.join(e2eDir, file)
      if (!existsSync(full)) return [`${file}: allow-listed (reason: ${reason}) but no longer exists -- remove this entry`]
      const text = readFileSync(full, "utf8")
      if (!STATUS_ATTRS.some((attr) => text.includes(attr))) {
        return [`${file}: allow-listed (reason: ${reason}) but no longer references a status attribute -- remove this entry`]
      }
      return []
    })
    expect(offenders).toEqual([])
  })

  test("no file outside ALLOWED asserts rail/terminal status directly", () => {
    const allowed = new Set(ALLOWED.map((entry) => entry.file))
    const offenders = relFiles()
      .filter((file) => !allowed.has(file))
      .flatMap((file) => {
        const text = readFileSync(path.join(e2eDir, file), "utf8")
        const hit = STATUS_ATTRS.find((attr) => text.includes(attr))
        if (!hit) return []
        return [
          `${file}: references "${hit}" directly -- assert rail status through e2e/helpers/rail-oracle.ts ` +
            `(expectRailRowVisible/expectRailStatus/...) or surface-parity.ts (B9), or add a reasoned entry to ` +
            `ALLOWED in src/architecture/rail-status-oracle-boundary.guard.test.ts if the exemption is deliberate.`,
        ]
      })
    expect(offenders).toEqual([])
  })
})
