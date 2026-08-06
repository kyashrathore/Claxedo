// Geometric assertions for the sidebar rail — scenarios D3 (terminal row layout) and
// E1 (rail geometry) from `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`.
//
// These exist because defect 11 (rail dot orphaned at x=11, terminal titles 24px right
// of session titles) was INVISIBLE to every prior DOM assertion: `[data-sidebar-status]`
// existed, had the correct `data-sidebar-status="working"` value, and passed
// `toBeVisible()` for the entire period the rail read as visually broken. CSS-visibility
// checks don't see position. Only `getBoundingClientRect()` catches a glyph that renders,
// is non-empty, and is simply in the wrong place — the same reasoning `e2e/INVARIANTS.md`
// already applies to turns ("Geometric truth ... a hit-test ... catches overlays,
// zero-height collapse, and off-screen rendering that CSS-visibility checks miss"). This
// module is that doctrine applied to the rail instead of the timeline.
//
// DOM contract measured directly from source, not assumed:
//   - session title:  `[data-slot="session-navigation-title"]`
//     (session-navigation-list.tsx:88)
//   - terminal title: the row's own flex-1 span, NO `data-slot` — it carries only
//     `class="... truncate flex-1 min-w-0"` (terminal-surface-navigation.tsx:132-140).
//     Selected below as the untagged flex-1 span inside the terminal row, which is the
//     only such span terminal-surface-navigation.tsx renders.
//   - status dot:     `[data-sidebar-status]`, rendered inside
//     `[data-slot="navigation-row-glyph"]` for nested rows (navigation-row.tsx:132-141,
//     147-161) — the fix for defect 11, which previously rendered the dot at `left-1.5`
//     outside any glyph column at all.
import { expect, type Page } from "@playwright/test"
import { captureEvidence, type Evidence } from "./visual-evidence"

export const GEOMETRY_SELECTORS = {
  sessionRow: '[data-testid="rail-sidebar-session-row"]',
  terminalRow: '[data-testid="rail-sidebar-terminal-row"]',
  sessionTitle: '[data-slot="session-navigation-title"]',
  // No data-slot exists on the terminal title (terminal-surface-navigation.tsx:132) —
  // scope to `.flex-1` inside the row, which is unique per the source read above.
  terminalTitle: '[data-testid="rail-sidebar-terminal-row"] .flex-1',
  statusDot: "[data-sidebar-status]",
  rowGlyph: '[data-slot="navigation-row-glyph"]',
} as const

/** left-x of an element's border box, per `getBoundingClientRect()`. */
async function leftX(page: Page, selector: string, nth = 0): Promise<number> {
  const box = await page.locator(selector).nth(nth).boundingBox()
  expect(box, `${selector} (nth=${nth}) has no bounding box (detached or display:none)`).not.toBeNull()
  return box!.x
}

/**
 * D3 + E1: asserts the rail's geometric invariants across every currently-rendered row —
 * not just the row a spec happens to be looking at, since defect 11 was a shared-column
 * misplacement that hit every row of a type identically.
 *
 * 1. Every terminal row's title left-x equals every session row's title left-x.
 *    Measured 2026-08-06 pre-fix: terminal titles at x=65, session titles at x=41 — a
 *    24px break that read as the terminal rows belonging to a different hierarchy level.
 *    Tolerance is 0 on purpose: these two title kinds share one indent column
 *    (terminal-surface-navigation.tsx:80-84, "so its title starts at the SAME x as every
 *    session title beside it") and are expected to land on the exact same pixel, not
 *    merely close. FOLLOW-UP, not applied pre-emptively: if CI shows subpixel layout
 *    (fractional device-pixel rounding under a non-1x devicePixelRatio) causing a flaky
 *    1px mismatch, loosen this specific comparison to `toBeCloseTo(..., 1)` — do not
 *    loosen it speculatively before that's observed.
 * 2. Every status dot's left-x is strictly less than its own row's title left-x. The dot
 *    sits in the indent column that precedes the title; pre-fix it sat at x=11, LEFT of
 *    even the workspace icon at x=20 (navigation-row.tsx:111-121), i.e. the most-nested
 *    item in the tree carried the outermost mark.
 * 3. Every status dot sits inside `[data-slot="navigation-row-glyph"]` — the shared glyph
 *    column introduced to fix defect 11 (navigation-row.tsx:132-141). A dot rendered
 *    outside that column is the orphaned-dot regression by construction, independent of
 *    where its x-coordinate happens to land.
 *
 * Silently no-ops any of the three checks whose row/dot population is empty (e.g. a spec
 * calling this before any terminal exists) rather than failing on absence — callers that
 * need presence assert `toHaveCount` themselves first, per the existing oracle pattern in
 * `turn-oracle.ts`.
 *
 * `evidence` is OPTIONAL and additive — every existing caller
 * (`desktop-unsigned-embedded.spec.ts:872`) calls `expectRowGeometry({ page })` with no
 * third field, and `if (evidence) …` below leaves that call exactly as it behaves today.
 * When provided, ONE screenshot is written per call, captured BEFORE any of the
 * `getBoundingClientRect()` assertions run below — same "capture, then assert" ordering
 * `rail-oracle.ts` uses and for the identical reason: defect 11 (dot at x=11, terminal
 * titles 24px off) is exactly the kind of failure where the pixel evidence is more useful
 * than the numeric assertion message, and that evidence must survive whichever of the
 * three checks (title alignment / dot-left-of-title / dot-inside-glyph) is the one that
 * throws. Geometry does not visibly change between this capture and the measurements
 * immediately below it — no drive/mutation call sits in between, unlike
 * `expectRailStatus`'s two-phase capture — so one screenshot correctly documents the
 * single geometric snapshot every check below reads from.
 */
export async function expectRowGeometry({ page, evidence }: { page: Page; evidence?: Evidence }): Promise<void> {
  if (evidence) await captureEvidence({ page, spec: evidence.spec, scenario: evidence.scenario })

  const sessionTitleCount = await page.locator(GEOMETRY_SELECTORS.sessionTitle).count()
  const terminalTitleCount = await page.locator(GEOMETRY_SELECTORS.terminalTitle).count()

  if (sessionTitleCount > 0 && terminalTitleCount > 0) {
    const sessionXs = await Promise.all(
      Array.from({ length: sessionTitleCount }, (_, i) => leftX(page, GEOMETRY_SELECTORS.sessionTitle, i)),
    )
    const terminalXs = await Promise.all(
      Array.from({ length: terminalTitleCount }, (_, i) => leftX(page, GEOMETRY_SELECTORS.terminalTitle, i)),
    )
    // Every terminal title must equal every session title, not just the first of each —
    // a fix that aligned only the first row of each kind would still leave the defect
    // visible on row 2+.
    for (const sessionX of sessionXs) {
      for (const terminalX of terminalXs) {
        expect(
          terminalX,
          `terminal title left-x (${terminalX}) !== session title left-x (${sessionX}) — ` +
            `defect 11's 24px break (terminal 65 vs session 41) has recurred`,
        ).toBe(sessionX)
      }
    }
  }

  const dotCount = await page.locator(GEOMETRY_SELECTORS.statusDot).count()
  for (let i = 0; i < dotCount; i++) {
    const dot = page.locator(GEOMETRY_SELECTORS.statusDot).nth(i)

    // Check 3 first: an orphaned dot (outside the glyph column) makes check 2's x
    // comparison meaningless, so fail on placement before fail on position.
    const insideGlyph = await dot.evaluate(
      (el, glyphSelector) => el.closest(glyphSelector) !== null,
      GEOMETRY_SELECTORS.rowGlyph,
    )
    expect(
      insideGlyph,
      `status dot (nth=${i}) is not inside [data-slot="navigation-row-glyph"] — the orphaned-dot ` +
        `regression (defect 11: dot rendered at left-1.5, outside any glyph column)`,
    ).toBe(true)

    const dotX = await leftX(page, GEOMETRY_SELECTORS.statusDot, i)
    // The dot's own row: whichever of session/terminal row contains it. `closest` on
    // both selectors and taking whichever matches keeps this row-type-agnostic — the
    // invariant ("dot left of its own title") holds for both row kinds identically.
    const rowTitleX = await dot.evaluate(
      (el, sel) => {
        const row = (el.closest(sel.sessionRow) ?? el.closest(sel.terminalRow)) as HTMLElement | null
        if (!row) return null
        const title = row.querySelector(sel.sessionTitle) ?? row.querySelector(".flex-1")
        return title ? title.getBoundingClientRect().left : null
      },
      GEOMETRY_SELECTORS,
    )
    expect(rowTitleX, `status dot (nth=${i}) could not resolve its own row's title element`).not.toBeNull()
    expect(
      dotX,
      `status dot left-x (${dotX}) is not less than its own row's title left-x (${rowTitleX}) — ` +
        `the dot has drifted right of (or onto) the title it should precede`,
    ).toBeLessThan(rowTitleX!)
  }
}
