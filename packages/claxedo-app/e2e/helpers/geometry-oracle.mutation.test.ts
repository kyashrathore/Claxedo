// Mutation tests for `geometry-oracle.ts`: healthy fixtures pass, regression-shaped
// fixtures fail. A real headless Chromium page drives hand-authored DOM, because
// Playwright's matchers only accept real Locators.
//
// Fixtures vary only position (`left`/`top`), never `display`/`visibility`/opacity: the
// oracle exists to catch elements that are present and visible but misplaced.
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

/** A session row with an optional status dot, inside the glyph span or as a bare sibling
 * of it. No `position:relative` anywhere, so each child's `left` is its viewport x and
 * `getBoundingClientRect().left` returns it unchanged. The row is sized explicitly because
 * every child is out of flow and a zero-area row reads as hidden. */
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

/** A terminal row: the title is an untagged `.flex-1` span, as in the real DOM. */
function terminalRowHtml(titleX: number): string {
  return `
    <div data-testid="rail-sidebar-terminal-row" style="height:24px; width:300px;">
      <span class="flex-1 min-w-0 truncate" style="position:absolute; left:${titleX}px; top:0;">Terminal title</span>
    </div>`
}

describe("expectRowGeometry — title alignment", () => {
  test("healthy: session and terminal title left-x are pixel-equal", async () => {
    const html = sessionRowHtml({ titleX: 41 }) + terminalRowHtml(41)
    await page.setContent(`<body>${html}</body>`)
    await expect(expectRowGeometry({ page })).resolves.toBeUndefined()
  })

  // 65 vs 41 are the real regression's pixel values.
  test("broken: terminal title at x=65 vs session title at x=41 fails alignment", async () => {
    const html = sessionRowHtml({ titleX: 41 }) + terminalRowHtml(65)
    await page.setContent(`<body>${html}</body>`)
    await expect(expectRowGeometry({ page })).rejects.toThrow(/terminal title left-x \(65\) !== session title left-x \(41\)/)
  })

  // A second session row proves every pair is compared, not just index 0 vs index 0.
  test("broken: second session row alone breaks alignment even though the first matches", async () => {
    const html = sessionRowHtml({ titleX: 41 }) + sessionRowHtml({ titleX: 65 }) + terminalRowHtml(41)
    await page.setContent(`<body>${html}</body>`)
    await expect(expectRowGeometry({ page })).rejects.toThrow(/terminal title left-x \(41\) !== session title left-x \(65\)/)
  })
})

describe("expectRowGeometry — dot placement", () => {
  test("healthy: dot inside the glyph column, left of its row's title, passes", async () => {
    const html = sessionRowHtml({ titleX: 41, dotX: 20, dotInsideGlyph: true })
    await page.setContent(`<body>${html}</body>`)
    await expect(expectRowGeometry({ page })).resolves.toBeUndefined()
  })

  // x=11 is left of the title at x=41, so only the containment check can catch this.
  test("broken: dot left of the title but outside the glyph column fails on containment", async () => {
    const html = sessionRowHtml({ titleX: 41, dotX: 11, dotInsideGlyph: false })
    await page.setContent(`<body>${html}</body>`)
    await expect(expectRowGeometry({ page })).rejects.toThrow(
      /is not inside \[data-slot="navigation-row-glyph"\]/,
    )
  })

  test("broken: dot inside the glyph column but right of its own row's title fails on position", async () => {
    const html = sessionRowHtml({ titleX: 41, dotX: 50, dotInsideGlyph: true })
    await page.setContent(`<body>${html}</body>`)
    await expect(expectRowGeometry({ page })).rejects.toThrow(/is not less than its own row's title left-x/)
  })
})
