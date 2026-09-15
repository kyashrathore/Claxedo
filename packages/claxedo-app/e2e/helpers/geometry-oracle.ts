// Geometric assertions for the sidebar rail, measured with `getBoundingClientRect()`.
// CSS-visibility checks do not see position: a status dot that exists, carries the right
// `data-sidebar-status`, and passes `toBeVisible()` can still sit in the wrong column.
//
// DOM contract:
//   - session title:  `[data-slot="session-navigation-title"]`
//   - terminal title: the terminal row's untagged `flex-1` span (no `data-slot`)
//   - status dot:     `[data-sidebar-status]`, inside `[data-slot="navigation-row-glyph"]`
import { expect, type Page } from "@playwright/test"
import { captureEvidence, type Evidence } from "./visual-evidence"

export const GEOMETRY_SELECTORS = {
  sessionRow: '[data-testid="rail-sidebar-session-row"]',
  terminalRow: '[data-testid="rail-sidebar-terminal-row"]',
  sessionTitle: '[data-slot="session-navigation-title"]',
  // The terminal title has no data-slot; `.flex-1` is unique inside the row.
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
 * Asserts, across every rendered row:
 * 1. Every terminal title's left-x equals every session title's left-x. Tolerance is 0:
 *    both kinds share one indent column. If subpixel rounding under a non-1x
 *    devicePixelRatio ever makes this flaky, loosen this comparison only, and only then.
 * 2. Every status dot's left-x is less than its own row's title left-x.
 * 3. Every status dot is inside `[data-slot="navigation-row-glyph"]`.
 *
 * A check whose row/dot population is empty is skipped; callers that need presence assert
 * `toHaveCount` first. `evidence`, when given, captures one screenshot before measuring.
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
    // Every pair, not just the first of each kind.
    for (const sessionX of sessionXs) {
      for (const terminalX of terminalXs) {
        expect(
          terminalX,
          `terminal title left-x (${terminalX}) !== session title left-x (${sessionX}); ` +
            `terminal and session titles share one indent column`,
        ).toBe(sessionX)
      }
    }
  }

  const dotCount = await page.locator(GEOMETRY_SELECTORS.statusDot).count()
  for (let i = 0; i < dotCount; i++) {
    const dot = page.locator(GEOMETRY_SELECTORS.statusDot).nth(i)

    // Containment first: an orphaned dot makes the x comparison meaningless.
    const insideGlyph = await dot.evaluate(
      (el, glyphSelector) => el.closest(glyphSelector) !== null,
      GEOMETRY_SELECTORS.rowGlyph,
    )
    expect(
      insideGlyph,
      `status dot (nth=${i}) is not inside [data-slot="navigation-row-glyph"]`,
    ).toBe(true)

    const dotX = await leftX(page, GEOMETRY_SELECTORS.statusDot, i)
    // The dot's row may be a session or a terminal row; either title counts.
    const rowTitleX = await dot.evaluate(
      (el, sel) => {
        const row = (el.closest(sel.sessionRow) ?? el.closest(sel.terminalRow))
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
