import { loadedDiffIdentity } from "../../src/review/loaded-diff-identity"

import type { BenchmarkPage as Page } from "./agent-cdp-page"
import { readNumber, readNumberFields } from "./page-value"
import {
  REVIEW_SCROLL_SELECTOR,
  type FixtureEvidence,
  type PanelProfile,
} from "./workspace-panel-scenario"

async function waitForOpenFiles(page: Page, fixture: FixtureEvidence, requireActiveTrace = false) {
  return readNumberFields(await page.evaluate(async ({ expectedFiles, requireActiveTrace }) => {
    const deadline = performance.now() + 30_000
    let shellVisible: number | undefined
    let animationSettled: number | undefined
    let dataReady: number | undefined
    let aboveFoldPainted: number | undefined
    let lastSignature = ""
    let stable = 0
    let stableSince = 0
    return new Promise<{ shellVisible: number; animationSettled: number; dataReady: number; aboveFoldPainted: number }>((resolve, reject) => {
      const paintedFrames = window.__claxedoPaintedFrames
      if (!paintedFrames) return reject(new Error("Claxedo painted-frame clock is not installed"))
      const visible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
      }
      const stop = paintedFrames({
        sample: () => {
          const trace = window.__claxedoPublicPanelTrace
          if (requireActiveTrace) {
            if (!trace?.active) {
              stop()
              return reject(new Error("Claxedo prearmed Files readiness observer lost its active trace"))
            }
            if (!Number.isFinite(trace.trustedInputAt)) return
          }
          const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
          const navigator = Array.from(shell?.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']") ?? [])
            .find((element) => visible(element))
          const rows = navigator?.querySelectorAll("[data-file-tree-path], [data-component='filetree'] button").length ?? 0
          const ready = !!navigator && visible(navigator) && navigator.dataset.fileTreeDataReady === "true" && rows > 0 && !navigator.querySelector("[data-file-tree-loading], [aria-label='Loading files']")
          const signature = ready ? JSON.stringify([shell?.dataset.stateWorkspaceDir, rows, navigator?.innerText.length, expectedFiles]) : ""
          if (performance.now() >= deadline) {
            stop()
            return reject(new Error(`Claxedo Files panel did not reach stable above-fold readiness: ${JSON.stringify({
              shell: shell ? Object.fromEntries(Object.entries(shell.dataset)) : undefined,
              navigator: navigator ? Object.fromEntries(Object.entries(navigator.dataset)) : undefined,
              rows,
              stable,
            })}`))
          }
          return { shellVisible: !!shell && visible(shell), shellSettled: shell?.dataset.shellSettled === "true", ready, signature }
        },
        painted: (frame, paintedAt) => {
          if (!frame) return
          if (frame.shellVisible && shellVisible === undefined) shellVisible = paintedAt
          if (frame.shellSettled && animationSettled === undefined) animationSettled = paintedAt
          if (frame.ready && dataReady === undefined) dataReady = paintedAt
          stable = frame.ready && shellVisible !== undefined && frame.signature === lastSignature ? stable + 1 : frame.ready ? 1 : 0
          if (stable === 1) stableSince = paintedAt
          lastSignature = frame.signature
          if (stable >= 2 && aboveFoldPainted === undefined) aboveFoldPainted = stableSince
          if (shellVisible !== undefined && animationSettled !== undefined && dataReady !== undefined && aboveFoldPainted !== undefined) {
            resolve({ shellVisible, animationSettled, dataReady, aboveFoldPainted })
            return true
          }
        },
      })
    })
  }, { expectedFiles: fixture.files.length, requireActiveTrace }),
  ["shellVisible", "animationSettled", "dataReady", "aboveFoldPainted"])
}

export async function waitForPanelProfile(
  page: Page,
  profile: Exclude<PanelProfile, "closed">,
  fixture: FixtureEvidence,
  expectedReviewOpenCount?: number,
  requireActiveTrace = false,
) {
  if (profile === "files") return (await waitForOpenFiles(page, fixture, requireActiveTrace)).aboveFoldPainted
  return readNumber(await page.evaluate(async ({ changed, expectedReviewOpenCount, expectedReviewIdentity, requireActiveTrace, scrollSelector }) => {
    const deadline = performance.now() + 30_000
    let prior = ""
    let stable = 0
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
              if (!trace?.active) return fail(new Error("Claxedo prearmed Review readiness observer lost its active trace"))
              if (!Number.isFinite(trace.trustedInputAt)) return
            }
            const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
            const root = shell?.querySelector<HTMLElement>("[data-testid='review-pane-root']")
            const corpus = root?.querySelector<HTMLElement>("[data-review-total-files]")
            const state = root?.querySelector<HTMLElement>("[data-review-diff-style]")
            const rendered = Number(corpus?.dataset.reviewRenderedFiles)
            const openCount = Number(state?.dataset.reviewOpenDiffCount ?? -1)
            const loadedCount = Number(state?.dataset.reviewLoadedDiffCount ?? -1)
            // Today's app also marks each file's header inside its row, and v2 marks
            // only the row; a row is the outermost element carrying its file.
            const canonicalRows = Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? [])
              .filter((row) => changed.includes(row.dataset.reviewFile ?? ""))
              .filter((row, _index, rows) => !rows.some((other) => other !== row && other.dataset.reviewFile === row.dataset.reviewFile && other.contains(row)))
            const expandedRows = canonicalRows.filter((row) =>
              !!row.querySelector("[aria-expanded='true']") || !!row.shadowRoot?.querySelector("[aria-expanded='true']")
            )
            const viewportRect = root?.querySelector<HTMLElement>(scrollSelector)
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
            const expansionReady = expectedReviewOpenCount === undefined ||
              (openCount === expectedReviewOpenCount &&
                (expectedReviewOpenCount === 0
                  ? expandedRows.length === 0
                  : visibleExpandedRows.length > 0 && paintedRows.length === visibleExpandedRows.length &&
                    Number(state?.dataset.reviewRenderedHunks ?? 0) > 0))
            const ready = shell?.dataset.shellSettled === "true" && shell.dataset.stateMode === "review" && !!root &&
              Number(corpus?.dataset.reviewTotalFiles) === changed.length && loadedCount === changed.length &&
              state?.dataset.reviewLoadedDiffIdentity === expectedReviewIdentity && rendered > 0 &&
              rendered === canonicalRows.length && expansionReady &&
              !root.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
            const signature = ready ? JSON.stringify([rendered, openCount, expandedRows.length, visibleExpandedRows.length, paintedRows.length, root.innerText.length]) : ""
            stable = ready && signature === prior ? stable + 1 : ready ? 1 : 0
            prior = signature
            if (performance.now() >= deadline) return fail(new Error(`Claxedo Diff panel did not reach stable canonical readiness: ${JSON.stringify({
              shell: shell ? Object.fromEntries(Object.entries(shell.dataset)) : undefined,
              root: root ? Object.fromEntries(Object.entries(root.dataset)) : undefined,
              corpus: corpus ? Object.fromEntries(Object.entries(corpus.dataset)) : undefined,
              rendered,
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
    expectedReviewOpenCount,
    expectedReviewIdentity: loadedDiffIdentity(fixture.changed),
    requireActiveTrace,
    scrollSelector: REVIEW_SCROLL_SELECTOR,
  }))
}

export async function waitForPanelClosed(page: Page, requireActiveTrace = false) {
  return readNumber(await page.evaluate(async (mustHaveTrace) => {
    const deadline = performance.now() + 30_000
    let stable = 0
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
            if (mustHaveTrace) {
              if (!trace?.active) return fail(new Error("Claxedo prearmed panel-close observer lost its active trace"))
              if (!Number.isFinite(trace.trustedInputAt)) return
            }
            const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
            const rect = shell?.getBoundingClientRect()
            // A closed shell is either translated past the right edge (today's app)
            // or taken out of layout with display: none (v2); both leave nothing on screen.
            const closed = !shell || (shell.dataset.open === "false" && !!rect && (rect.left >= window.innerWidth - 1 || (rect.width === 0 && rect.height === 0)))
            stable = closed ? stable + 1 : 0
            if (performance.now() >= deadline) return fail(new Error(`Claxedo workspace panel did not close: ${JSON.stringify(shell ? {
              data: Object.fromEntries(Object.entries(shell.dataset)),
              rect: rect ? { left: rect.left, right: rect.right, width: rect.width } : undefined,
              transform: getComputedStyle(shell).transform,
              transition: getComputedStyle(shell).transition,
            } : { disposed: true })}`))
          return stable
        },
        painted: (frameStable, paintedAt) => {
          if (frameStable === undefined) return
          if (frameStable === 1) stableSince = paintedAt
          if (frameStable < 2) return
          if (mustHaveTrace) {
            const trace = window.__claxedoPublicPanelTrace
            const inputAt = trace?.trustedInputAt
            if ((trace?.frames ?? []).filter((frame) => inputAt !== undefined && frame.startedAt >= inputAt).length < 2) return
          }
          resolve(stableSince)
          return true
        },
      })
    })
  }, requireActiveTrace))
}

export async function waitForPaintedFile(page: Page, file: string, requireActiveTrace = false) {
  return readNumber(await page.evaluate(async ({ expected, requireActiveTrace }) => {
    const deadline = performance.now() + 30_000
    let previous = ""
    let stable = 0
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
              if (!trace?.active) return fail(new Error("Claxedo prearmed file readiness observer lost its active trace"))
              if (!Number.isFinite(trace.trustedInputAt)) return
            }
            const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='tab-file-root']"))
            const element = roots.find((candidate) => {
              const path = candidate.dataset.tabFilePath ?? ""
              return (path === expected || path.endsWith(`/${expected}`)) && candidate.dataset.tabFileState === "ready" && candidate.dataset.tabFileRenderState === "painted"
            })
            const rect = element?.getBoundingClientRect()
            const ready = !!element && !!rect && rect.width > 0 && rect.height > 0 && !!element.dataset.tabFileRenderedCacheKey && Number(element.dataset.tabFileContentChars) > 0
            const signature = ready ? JSON.stringify([rect.width, rect.height, element.dataset.tabFileRenderedCacheKey]) : ""
            stable = ready && signature === previous ? stable + 1 : ready ? 1 : 0
            previous = signature
            if (performance.now() >= deadline) {
              const tabs = Array.from(document.querySelectorAll<HTMLElement>("[data-slot='workspace-tab']"))
                .map((tab) => ({
                  id: tab.dataset.workspaceTabId,
                  kind: tab.dataset.workspaceTabKind,
                  selected: tab.dataset.selected,
                  label: tab.innerText.trim(),
                }))
              const fileRoots = roots.map((root) => {
                const rootRect = root.getBoundingClientRect()
                return {
                  path: root.dataset.tabFilePath,
                  state: root.dataset.tabFileState,
                  renderState: root.dataset.tabFileRenderState,
                  contentChars: root.dataset.tabFileContentChars,
                  renderedCacheKey: root.dataset.tabFileRenderedCacheKey,
                  visible: rootRect.width > 0 && rootRect.height > 0,
                }
              })
              return fail(new Error(`Claxedo file did not reach painted readiness: ${expected}; ${JSON.stringify({ tabs, fileRoots })}`))
            }
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
  }, { expected: file, requireActiveTrace }))
}

export async function twoPaintedFrames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const paintedFrames = window.__claxedoPaintedFrames
    if (!paintedFrames) return reject(new Error("Claxedo painted-frame clock is not installed"))
    let count = 0
    const painted = () => {
      count += 1
      if (count < 2) return
      resolve()
      return true
    }
    paintedFrames({ sample: () => undefined, painted })
  }))
}
