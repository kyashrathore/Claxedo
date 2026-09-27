import { loadedDiffIdentity } from "../../src/review/loaded-diff-identity"

import type { BenchmarkPage as Page } from "./agent-cdp-page"
import { optionalText, readNumber, readNumberFields, readRecord } from "./page-value"
import {
  COLLAPSE_ALL_SELECTOR,
  REVIEW_SCROLL_SELECTOR,
  type FixtureEvidence,
} from "./workspace-panel-scenario"
import { clickVisible } from "./workspace-panel-locators"

export async function ensureAllDiffs(page: Page, fixture: FixtureEvidence, expanded: boolean) {
  let state = await readDiffState(page)
  const expected = expanded ? fixture.changed.length : 0
  if (state.openCount === expected) return
  if (expanded) {
    if (state.openCount > 0) {
      await clickVisible(page, COLLAPSE_ALL_SELECTOR)
      await waitForDiffState(page, fixture, { openCount: 0 })
      state = await readDiffState(page)
    }
    if (state.openCount !== 0) {
      throw new Error(`Claxedo Review could not reach its collapsed setup state: ${state.openCount}`)
    }
    await clickVisible(page, "button[aria-label='Expand all']")
    await waitForDiffState(page, fixture, { openCount: fixture.changed.length })
    return
  }
  await clickVisible(page, COLLAPSE_ALL_SELECTOR)
  await waitForDiffState(page, fixture, { openCount: 0 })
}

async function readDiffState(page: Page) {
  const state = readRecord(await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-testid='review-pane-root'] [data-review-diff-style]")
    return {
      style: root?.dataset.reviewDiffStyle,
      openCount: Number(root?.dataset.reviewOpenDiffCount ?? -1),
      loadedCount: Number(root?.dataset.reviewLoadedDiffCount ?? -1),
      renderedHunks: Number(root?.dataset.reviewRenderedHunks ?? -1),
    }
  }))
  // `style` is absent until the Review pane mounts; the counts are `-1` for
  // that same state, which is why they are numbers rather than optional.
  return {
    style: optionalText(state.style),
    ...readNumberFields(state, ["openCount", "loadedCount", "renderedHunks"]),
  }
}

export async function waitForDiffState(
  page: Page,
  fixture: FixtureEvidence,
  expected: { style?: "unified" | "split"; openCount?: number },
  requireActiveTrace = false,
) {
  return readNumber(await page.evaluate(async ({ changed, expected, expectedReviewIdentity, requireActiveTrace, scrollSelector }) => {
    const deadline = performance.now() + 30_000
    let stable = 0
    let previous = ""
    return new Promise<number>((resolve, reject) => {
      const paintedFrames = window.__claxedoPaintedFrames
      if (!paintedFrames) return reject(new Error("Claxedo painted-frame clock is not installed"))
      const fail = (error: Error): undefined => {
        stop()
        reject(error)
      }
      let stableSince = 0
      const stop = paintedFrames({
        sample: () => {
            const trace = window.__claxedoPublicPanelTrace
            if (requireActiveTrace) {
              if (!trace?.active) return fail(new Error("Claxedo prearmed Diff readiness observer lost its active trace"))
              if (!Number.isFinite(trace.trustedInputAt)) return
            }
            const root = document.querySelector<HTMLElement>("[data-testid='review-pane-root'] [data-review-diff-style]")
            const pane = root?.closest<HTMLElement>("[data-testid='review-pane-root']")
            const openCount = Number(root?.dataset.reviewOpenDiffCount ?? -1)
            const loadedCount = Number(root?.dataset.reviewLoadedDiffCount ?? -1)
            const canonicalRows = Array.from(pane?.querySelectorAll<HTMLElement>("[data-review-file]") ?? [])
              .filter((row) => changed.includes(row.dataset.reviewFile ?? ""))
              .filter((row, _index, rows) => !rows.some((other) => other !== row && other.dataset.reviewFile === row.dataset.reviewFile && other.contains(row)))
            const expandedRows = canonicalRows.filter((row) =>
              !!row.querySelector("[aria-expanded='true']") || !!row.shadowRoot?.querySelector("[aria-expanded='true']")
            )
            const viewportRect = pane?.querySelector<HTMLElement>(scrollSelector)
              ?.getBoundingClientRect()
            const visibleExpandedRows = expandedRows.filter((row) => {
              const rect = row.getBoundingClientRect()
              return !!viewportRect && rect.width > 0 && rect.height > 0 &&
                rect.bottom > viewportRect.top && rect.right > viewportRect.left &&
                rect.top < viewportRect.bottom && rect.left < viewportRect.right
            })
            const paintedRows = visibleExpandedRows.filter((row) => {
              const rowRect = row.getBoundingClientRect()
              const viewer = row.querySelector<HTMLElement>("diffs-container")
              const viewerRoot = viewer?.shadowRoot ?? row.shadowRoot
              if (viewerRoot) {
                return rowRect.width > 0 && rowRect.height > 0 && !!viewerRoot.querySelector("[data-line]")
              }
              return false
            })
            const expansionReady = expected.openCount === undefined || (expected.openCount === 0
              ? openCount === 0 && expandedRows.length === 0
              : openCount === expected.openCount && visibleExpandedRows.length > 0 &&
                paintedRows.length === visibleExpandedRows.length &&
                Number(root?.dataset.reviewRenderedHunks ?? 0) > 0)
            const ready = !!root && loadedCount === changed.length &&
              root.dataset.reviewLoadedDiffIdentity === expectedReviewIdentity &&
              (expected.style === undefined || root.dataset.reviewDiffStyle === expected.style) && expansionReady
            const signature = ready ? JSON.stringify([root.dataset.reviewDiffStyle, openCount, loadedCount, expandedRows.length, visibleExpandedRows.length, paintedRows.length, root.dataset.reviewRenderedHunks]) : ""
            stable = ready && signature === previous ? stable + 1 : ready ? 1 : 0
            previous = signature
            if (performance.now() >= deadline) return fail(new Error(`Claxedo Diff state did not reach its authoritative endpoint: ${JSON.stringify({
              expected,
              root: root ? Object.fromEntries(Object.entries(root.dataset)) : undefined,
              openCount,
              loadedCount,
              canonicalRows: canonicalRows.length,
              expandedRows: expandedRows.length,
              visibleExpandedRows: visibleExpandedRows.length,
              paintedRows: paintedRows.length,
              stable,
            })}`))
          return stable
        },
        painted: (frameStable, paintedAt) => {
          if (frameStable === undefined) return
          if (frameStable === 1) stableSince = paintedAt
          if (frameStable < 2) return
          if (requireActiveTrace) {
            const trace = window.__claxedoPublicPanelTrace
            const inputAt = trace?.trustedInputAt
            if ((trace?.frames ?? []).filter((frame) => inputAt !== undefined && frame.startedAt >= inputAt).length < 2) return
          }
          resolve(stableSince)
          return true
        },
      })
    })
  }, {
    changed: fixture.changed,
    expected,
    expectedReviewIdentity: loadedDiffIdentity(fixture.changed),
    requireActiveTrace,
    scrollSelector: REVIEW_SCROLL_SELECTOR,
  }))
}
