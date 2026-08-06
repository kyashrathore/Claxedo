/**
 * GUARD: rail/terminal status (`data-sidebar-status`, `data-switcher-status`) is
 * asserted through the shared oracles ONLY.
 *
 * WHY THIS EXISTS -- `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`
 * Phase 1 built `expectRailStatus` (`e2e/helpers/rail-oracle.ts`) specifically because a
 * bare `row.locator("[data-sidebar-status]")` cannot see defect #12: a Solid component
 * body runs ONCE, so an early `if (status === "idle") return null` freezes the glyph at
 * whatever status existed at MOUNT. A spec that queries the dot only AFTER driving it to
 * "working" passes identically against the frozen bug and the fix -- the exact failure
 * mode this suite exists to close (`e2e/INVARIANTS.md` rule 5: "an assertion that can
 * pass while the feature is unusable is a defect in the suite"). `expectRailStatus`
 * closes the hole structurally by asserting the idle-mount precondition itself
 * (`rail-oracle.ts:181-187`) before any caller can drive a transition, so a raw selector
 * written by hand can silently skip the one check that makes the proof mean anything.
 * `surface-parity.ts`'s `expectSurfaceParity`/`expectSurfaceStatus` exist for the same
 * reason on the equality side: a spec that asserts `data-sidebar-status` and
 * `data-switcher-status` as two independent presence checks (rather than one equality
 * assertion) lets the two surfaces drift apart while both stay green -- precisely the gap
 * compact-switcher.tsx's untested "kept in sync with NavigationStatusDot" comment invited
 * (`surface-parity.ts:7-12`).
 *
 * WHAT IT DOES -- greps every `.ts` file under `e2e/` for the literal attribute names. A
 * hit outside `ALLOWED` fails: either route the assertion through `rail-oracle.ts` /
 * `surface-parity.ts`, or add a reasoned entry here. This is a boundary ratchet, not a
 * shrink-only baseline (contrast `source-text-assertions-baseline.json`): `ALLOWED` names
 * every file allowed to touch the raw attribute and WHY, and a second test keeps each
 * entry honest -- an entry whose file no longer references the attribute is stale and
 * must be deleted, not left to rot into a blank check.
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

/**
 * Every file, relative to `e2e/`, allowed to reference a status attribute directly.
 *
 *   helpers/rail-oracle.ts    -- IS the oracle this guard routes everything through
 *                                (B1/B3/B5/B6/B7/B8 -- `expectRailStatus` et al.).
 *   helpers/geometry-oracle.ts -- Phase 1's D3/E1 oracle (`expectRowGeometry`); its whole
 *                                job is measuring `getBoundingClientRect()` on the SAME
 *                                `[data-sidebar-status]` node rail-oracle.ts asserts
 *                                presence/value on, so it needs the raw selector for a
 *                                geometry read the status oracle does not perform.
 *   helpers/surface-parity.ts -- Phase 1's B9 oracle (`expectSurfaceParity`/
 *                                `expectSurfaceStatus`); reads BOTH `data-sidebar-status`
 *                                and `data-switcher-status` because asserting their
 *                                equality (not presence) is its entire purpose --
 *                                routing that through rail-oracle.ts (sidebar-only) would
 *                                make the switcher half of the comparison impossible.
 *   playwright/core-sidebar-tree.spec.ts          -- predates rail-oracle.ts (landed
 *                                2026-08-06 Phase 1); this spec's own status-dot
 *                                assertions (lines 648-745) are the ones the plan's B7/B9
 *                                scenarios were extracted FROM. Migrating it is out of
 *                                scope for this guard; it does not gain new direct
 *                                assertions going forward because THIS guard now blocks
 *                                every file that is not already on this list.
 *   playwright/core-claude-native-sdk-rail.spec.ts -- predates rail-oracle.ts; lines
 *                                396-424 are the literal sequence `expectRailStatus`'s
 *                                own doc comment (rail-oracle.ts:157-158) cites as the
 *                                pattern it generalizes. Same out-of-scope rationale.
 *   playwright/core-terminal.spec.ts               -- predates rail-oracle.ts; asserts
 *                                `data-sidebar-status` on TERMINAL rows (SELECTORS.
 *                                terminalRow), a shape `expectRailStatus` does not cover
 *                                (it is scoped to `SELECTORS.sessionRow`). Same
 *                                out-of-scope rationale; not a candidate for silent
 *                                migration since the oracle would need a terminal-row
 *                                variant first.
 *   playwright/core-panes-split-tabs.spec.ts       -- predates surface-parity.ts; asserts
 *                                `data-switcher-status` directly (lines 568-831) as part
 *                                of split/tab-pane coverage unrelated to B9's
 *                                sidebar-vs-switcher equality claim. Same out-of-scope
 *                                rationale.
 *   playwright/real-harness-local.spec.ts          -- predates rail-oracle.ts; Tier R
 *                                real-harness spec (line 938), not part of the Tier M
 *                                core suite rail-oracle.ts was built against first. Same
 *                                out-of-scope rationale.
 */
const ALLOWED: { file: string; reason: string }[] = [
  { file: "helpers/rail-oracle.ts", reason: "is the oracle every other file routes through" },
  { file: "helpers/geometry-oracle.ts", reason: "Phase 1 D3/E1 oracle -- geometry read on the same node, not a status assertion" },
  { file: "helpers/surface-parity.ts", reason: "Phase 1 B9 oracle -- equality across both surfaces is its entire purpose" },
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
