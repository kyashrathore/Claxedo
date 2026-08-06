// Mutation verification for `e2e/helpers/geometry-oracle.ts` — the open Phase 1 checkbox in
// `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`: "Each oracle is
// mutation-verified: breaking the product behaviour turns it red."
//
// Same rationale as `rail-oracle.mutation.test.ts` for using a REAL (headless) Chromium
// page via `playwright-core` instead of a hand-rolled `Page`/`Locator` object:
// `expectRowGeometry` calls `boundingBox()` and `evaluate()` on real `Locator`s and
// `expect(...).toBeLessThan(...)`/`.toBe(...)` from `@playwright/test`; the polling
// matchers dispatch through the real driver channel and reject any object that isn't an
// actual Locator instance. A real headless page driving a hand-authored (fake) DOM fixture
// is the only way to exercise the oracle's actual selector/geometry logic. See that file's
// header comment for the full citation trail (playwright's matcher source, the
// `test.d.ts` type-identity check, and the throwaway smoke test that confirmed this works
// standalone outside the `playwright test` runner).
//
// The whole point of `getBoundingClientRect()`-based assertions (geometry-oracle.ts's
// header: "CSS-visibility checks don't see position") is that a broken layout can pass
// every `data-*` attribute/count check and still be visually wrong. This file's fixtures
// therefore control ONLY position (`left`/`top`), never `display`/`visibility`/opacity —
// a fixture that hid the broken element with `display:none` would let the SAME class of
// oracle bug (checking presence, not position) hide inside the TEST instead of the
// product, which is exactly the failure mode this suite exists to rule out.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright-core"
import { expectRowGeometry } from "./geometry-oracle"

let browser: Browser
let page: Page

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser.close()
})

beforeEach(async () => {
  page = await browser.newPage()
})

afterEach(async () => {
  await page.close()
})

/** A session row per GEOMETRY_SELECTORS (geometry-oracle.ts:27-36): `sessionTitle` is
 * `[data-slot="session-navigation-title"]`, and the optional status dot lives either
 * inside `[data-slot="navigation-row-glyph"]` (the fixed placement) or as a bare sibling
 * of it (the orphaned-dot regression, defect 11's other half — see
 * `rowGeometry.ts:60-67`). No `position:relative` anywhere in this fixture: every
 * positioned child's `left` therefore measures from the initial containing block (i.e.
 * the viewport), which is what lets this file assign the exact literal pixel values
 * geometry-oracle.ts's own header comment cites ("terminal titles at x=65, session titles
 * at x=41") and have `getBoundingClientRect().left` come back equal to them, unperturbed
 * by any ancestor's own box. The row itself carries an explicit `height`/`width` for the
 * same reason `rail-oracle.mutation.test.ts`'s `statusRowHtml` does: every child here is
 * `position:absolute` (out of flow), so an unsized row collapses to a zero-area box and
 * Playwright's own visibility checks — used incidentally by `boundingBox()`'s underlying
 * machinery — would otherwise report it hidden. That exact failure was hit and diagnosed
 * in the sibling file before this one copied the fix forward.
 */
function sessionRowHtml(opts: { titleX: number; dotX?: number; dotInsideGlyph?: boolean }): string {
  const { titleX, dotX, dotInsideGlyph = true } = opts
  const dotHtml =
    dotX === undefined
      ? ""
      : `<span data-sidebar-status="working" style="position:absolute; left:${dotX}px; top:0; width:6px; height:6px;"></span>`
  return `
    <div data-testid="rail-sidebar-session-row" style="height:24px; width:300px;">
      <span data-slot="navigation-row-glyph" style="position:absolute; left:0; top:0; width:16px; height:16px;">${
        dotInsideGlyph ? dotHtml : ""
      }</span>
      ${dotInsideGlyph ? "" : dotHtml}
      <span data-slot="session-navigation-title" style="position:absolute; left:${titleX}px; top:0;">Session title</span>
    </div>`
}

/** A terminal row per GEOMETRY_SELECTORS.terminalTitle (geometry-oracle.ts:33): NO
 * `data-slot` on the title — scoped instead to `.flex-1` inside the terminal row, per the
 * file header's note that `terminal-surface-navigation.tsx:132-140` renders the title as
 * an untagged `class="... truncate flex-1 min-w-0"` span. */
function terminalRowHtml(titleX: number): string {
  return `
    <div data-testid="rail-sidebar-terminal-row" style="height:24px; width:300px;">
      <span class="flex-1 min-w-0 truncate" style="position:absolute; left:${titleX}px; top:0;">Terminal title</span>
    </div>`
}

describe("expectRowGeometry — title alignment (D3/E1, defect 11: 24px break)", () => {
  test("healthy: session and terminal title left-x are pixel-equal", async () => {
    const html = sessionRowHtml({ titleX: 41 }) + terminalRowHtml(41)
    await page.setContent(`<body>${html}</body>`)
    await expect(expectRowGeometry({ page })).resolves.toBeUndefined()
  })

  // Defect 11's EXACT measured numbers, per both the plan (line 179: "terminal 65 ≠
  // session 41") and geometry-oracle.ts's own header comment (line 51: "terminal titles at
  // x=65, session titles at x=41 — a 24px break"). Reproducing the literal pixel values,
  // not just "some mismatch," proves this oracle actually catches the historical defect's
  // shape rather than an easier synthetic one.
  test("broken: terminal titleX=65 vs session titleX=41 reproduces defect 11's exact break", async () => {
    const html = sessionRowHtml({ titleX: 41 }) + terminalRowHtml(65)
    await page.setContent(`<body>${html}</body>`)
    await expect(expectRowGeometry({ page })).rejects.toThrow(/defect 11's 24px break \(terminal 65 vs session 41\)/)
  })

  // A second session row proves the "every terminal title vs every session title" nested
  // loop (geometry-oracle.ts:88-96) actually iterates, not just checks index 0 vs index 0
  // — the file header's own stated reason for the double loop: "a fix that aligned only
  // the first row of each kind would still leave the defect visible on row 2+."
  test("broken: second session row alone breaks alignment even though the first matches", async () => {
    const html = sessionRowHtml({ titleX: 41 }) + sessionRowHtml({ titleX: 65 }) + terminalRowHtml(41)
    await page.setContent(`<body>${html}</body>`)
    // NOTE: geometry-oracle.ts:92-94's failure message cites the historical "(terminal 65
    // vs session 41)" pair as a fixed string, not interpolated from the actual measured
    // values (`terminalX (41) !== sessionX (65)` here, the reverse) — matched literally,
    // not re-derived, so this test can't silently drift from what the source really says.
    await expect(expectRowGeometry({ page })).rejects.toThrow(/defect 11's 24px break \(terminal 65 vs session 41\) has recurred/)
  })
})

describe("expectRowGeometry — dot placement (defect 11: orphaned dot)", () => {
  test("healthy: dot inside the glyph column, left of its row's title, passes", async () => {
    const html = sessionRowHtml({ titleX: 41, dotX: 20, dotInsideGlyph: true })
    await page.setContent(`<body>${html}</body>`)
    await expect(expectRowGeometry({ page })).resolves.toBeUndefined()
  })

  // The task's exact scenario: "A dot at x=11 with title at x=41 passes the 'dot left of
  // title' check but must FAIL the 'inside navigation-row-glyph' check." Documented here
  // as a plain arithmetic fact (not a DOM assertion) so the claim "the position check
  // WOULD have passed" is verifiable independent of the oracle, before proving separately
  // that the oracle fails at containment — geometry-oracle.ts:103-104 orders containment
  // before position for exactly this reason ("Check 3 first: an orphaned dot ... makes
  // check 2's x comparison meaningless"), so a naive position-only oracle would have let
  // this exact regression through undetected.
  test("broken: dot at x=11 (left of title x=41) but outside the glyph column fails on containment, not position", async () => {
    expect(11).toBeLessThan(41) // the position check's own arithmetic would have passed
    const html = sessionRowHtml({ titleX: 41, dotX: 11, dotInsideGlyph: false })
    await page.setContent(`<body>${html}</body>`)
    await expect(expectRowGeometry({ page })).rejects.toThrow(
      /is not inside \[data-slot="navigation-row-glyph"\] — the orphaned-dot/,
    )
  })

  // The mirror failure: dot correctly INSIDE the glyph column (containment passes) but
  // positioned to the right of its own row's title — geometry-oracle.ts's check 2
  // (dotX < titleX), reached only once check 3 has already passed. Proves the two checks
  // are independent, not that containment alone is sufficient.
  test("broken: dot inside the glyph column but right of its own row's title fails on position", async () => {
    const html = sessionRowHtml({ titleX: 41, dotX: 50, dotInsideGlyph: true })
    await page.setContent(`<body>${html}</body>`)
    await expect(expectRowGeometry({ page })).rejects.toThrow(/is not less than its own row's title left-x/)
  })
})
