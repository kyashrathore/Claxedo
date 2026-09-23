// CSS visibility alone misses displaced rows, transparent ancestors, and overlays.
import { expect, type Locator, type Page } from "@playwright/test"
import { captureEvidence, type Evidence } from "./visual-evidence"

export function timelineScroller(page: Page) {
  return page.locator('[data-slot="session-timeline-scroll"] [data-scrollable]:visible').first()
}

export async function scrollTimelineToTop(page: Page) {
  const scroller = timelineScroller(page)
  await scroller.hover()
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.mouse.wheel(0, -500)
    // Two frames let gesture tracking observe the wheel before testing its offset.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    if (await scroller.evaluate(element => element.scrollTop) < 100) break
  }
}

/**
 * The timeline mounts only the rows near the viewport (one row of overscan until a
 * scroll gesture, six after), so a row at the end of a turn that grew above the
 * viewport is not in the DOM until the reader scrolls down to it.
 */
export async function scrollTimelineToEnd(page: Page) {
  const scroller = timelineScroller(page)
  await scroller.hover()
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.mouse.wheel(0, 500)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    if (await scroller.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop) < 100) break
  }
}

export async function readPaintGeometry(locator: Locator) {
  return locator.evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect()
    let opacity = 1
    let visibility = true
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      opacity *= Number(style.opacity)
      visibility &&= style.visibility !== "hidden" && style.visibility !== "collapse"
    }
    const hit = document.elementFromPoint(x + width / 2, y + height / 2)
    return { x, y, width, height, opacity, visibility, hit: !!hit && element.contains(hit) }
  })
}

export async function readControlLabelSpacing(locator: Locator) {
  return locator.evaluate(control => {
    const label = control.querySelector('[data-slot="composer-control-label"]')
    const caret = control.lastElementChild
    if (!label || !caret) throw new Error("control label or trailing icon is missing")
    const range = document.createRange()
    range.selectNodeContents(label)
    const text = range.getBoundingClientRect()
    const end = caret.getBoundingClientRect()
    return { width: control.getBoundingClientRect().width, label: label.textContent, textWidth: text.width, caretGap: end.left - text.right }
  })
}

export async function readTextRangeGeometry(locator: Locator, text: string) {
  return locator.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(text) ?? -1
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + text.length)
      const { x, y, width, height } = range.getBoundingClientRect()
      return { x, y, width, height }
    }
    throw new Error(`Text range not found: ${text}`)
  }, text)
}

export async function readScrollPosition(locator: Locator) {
  return locator.evaluate(element => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }))
}

export async function sampleElementDuringAction(page: Page, selector: string, action: () => Promise<void>) {
  const probe = await page.evaluateHandle((selector) => {
    const samples: Array<{
      time: number; path: string; visible: number; messageIDs: Array<string | null>
      elements: Array<{ messageID: string | null; slot: string | null; hasText: boolean; painted: boolean }>
    }> = []
    let frame = 0
    const sample = () => {
      const visible = [...document.querySelectorAll(selector)].filter(element => {
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor)
          if (style.visibility === "hidden" || style.opacity === "0") return false
        }
        return true
      })
      samples.push({
        time: performance.now(), path: location.pathname, visible: visible.length,
        messageIDs: visible.map(element => element.closest("[data-message-id]")?.getAttribute("data-message-id") ?? null),
        elements: visible.map(element => {
          const rect = element.getBoundingClientRect()
          const left = Math.max(0, rect.left)
          const right = Math.min(innerWidth, rect.right)
          const top = Math.max(0, rect.top)
          const bottom = Math.min(innerHeight, rect.bottom)
          const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
          return {
            messageID: element.closest("[data-message-id]")?.getAttribute("data-message-id") ?? null,
            slot: element.getAttribute("data-slot"), hasText: !!element.textContent?.trim(),
            painted: right > left && bottom > top && element.getAttribute("aria-hidden") !== "true" && !!hit && element.contains(hit),
          }
        }),
      })
      frame = requestAnimationFrame(sample)
    }
    sample()
    return { samples, stop: () => cancelAnimationFrame(frame) }
  }, selector)
  try {
    await action()
    return await probe.evaluate(async (probe) => {
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      probe.stop()
      return probe.samples
    })
  } finally {
    if (!page.isClosed()) await probe.evaluate(probe => probe.stop())
    await probe.dispose()
  }
}

export async function sampleTranscriptGeometry(page: Page, input: {
  rowSelector: string
  composerSelector: string
  submitSelector: string
  frames: number
}) {
  return page.evaluate(async ({ rowSelector, composerSelector, submitSelector, frames }) => {
    const visible = (selector: string) => [...document.querySelectorAll(selector)]
      .find(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)
    const row = visible(rowSelector)
    const composer = visible(composerSelector)
    const rect = (element: Element | undefined) => {
      if (!element?.isConnected) return null
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    const samples = []
    for (let frame = 0; frame < frames; frame++) {
      samples.push({ row: rect(row), composer: rect(composer), submitIcon: visible(submitSelector)?.getAttribute("data-icon") })
      await new Promise(requestAnimationFrame)
    }
    return samples
  }, input)
}

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
