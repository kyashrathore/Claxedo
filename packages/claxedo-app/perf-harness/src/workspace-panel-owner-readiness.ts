import { loadedDiffIdentity } from "../../src/review/loaded-diff-identity"

import type { BenchmarkPage as Page } from "./agent-cdp-page"
import { readNumber } from "./page-value"
import {
  REVIEW_SCROLL_SELECTOR,
  type FixtureEvidence,
  type PanelProfile,
  type PanelTarget,
} from "./workspace-panel-scenario"
import { COUNTER_END_MARK } from "./workspace-panel-trace-reading"

export async function waitForPanelOwner(
  page: Page,
  profile: PanelProfile,
  target: PanelTarget,
  fixture: FixtureEvidence,
  options: { markEnd?: boolean; expectedReviewOpenCount?: number; observerToken?: string } = {},
) {
  return readNumber(await page.evaluate(async ({
    profile,
    sessionId,
    directory,
    files,
    changed,
    endMark,
    markEnd,
    expectedReviewOpenCount,
    expectedReviewIdentity,
    observerToken,
    scrollSelector,
  }) => {
    const deadline = performance.now() + 30_000
    let stable = 0
    let previousSignature = ""
    return new Promise<number>((resolve, reject) => {
      const browser = window as typeof window & { __claxedoPanelOwnerObservers?: Map<string, () => void> }
      const observers = browser.__claxedoPanelOwnerObservers ??= new Map()
      const paintedFrames = window.__claxedoPaintedFrames
      if (!paintedFrames) return reject(new Error("Claxedo painted-frame clock is not installed"))
      let settled = false
      let stableSince = 0
      const cleanup = () => {
        stopFrames()
        if (observerToken) observers.delete(observerToken)
      }
      const fail = (error: Error): undefined => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const complete = (at: number) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(at)
      }
      if (observerToken) observers.set(observerToken, () => fail(new Error("Claxedo panel owner observer was cancelled")))
      const sample = () => {
        const trace = window.__claxedoPublicPanelTrace
        if (trace?.active && !Number.isFinite(trace.trustedInputAt)) return
        const visible = (element: HTMLElement | null | undefined) => {
          if (!element) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        }
        const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
        let ready = false
        let signature = ""
        if (profile === "closed") {
          const rect = shell?.getBoundingClientRect()
          const heavyRoots = shell?.querySelectorAll("[data-testid='workspace-files-navigator'], [data-testid='review-pane-root']").length ?? 0
          ready = (!shell || (shell.dataset.open === "false" && shell.dataset.stateOpen === "false" && !!rect && (rect.left >= innerWidth - 1 || (rect.width === 0 && rect.height === 0)))) && heavyRoots === 0
          signature = ready ? JSON.stringify([shell?.dataset.open ?? "disposed", heavyRoots]) : ""
        } else {
          const body = shell?.querySelector<HTMLElement>(`[data-workspace-panel-session-id="${CSS.escape(sessionId)}"]`)
          const ownerExact = shell?.dataset.open === "true" &&
            shell.dataset.shellSettled === "true" &&
            shell.dataset.stateWorkspaceDir === directory &&
            visible(shell) &&
            !!body &&
            body.dataset.workspacePanelSessionId === sessionId
          if (profile === "files") {
            const navigator = body?.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")
            const renderedPaths = Array.from(navigator?.querySelectorAll<HTMLElement>("[data-file-tree-path], [data-file-tree-row]") ?? [])
              .map((row) => row.dataset.fileTreePath ?? row.dataset.fileTreeRow)
              .filter((path): path is string => !!path)
            const canonicalPath = renderedPaths.some((path) => files.some((file) => file === path || file.startsWith(`${path.replace(/\/$/u, "")}/`)))
            ready = ownerExact &&
              shell?.dataset.stateNavigator === "files" &&
              visible(navigator) &&
              navigator?.dataset.fileTreeDataReady === "true" &&
              renderedPaths.length > 0 &&
              canonicalPath &&
              !navigator?.querySelector("[data-file-tree-loading], [aria-label='Loading files']")
            signature = ready ? JSON.stringify([directory, sessionId, renderedPaths, navigator?.innerText.length]) : ""
          } else {
            const root = body?.querySelector<HTMLElement>("[data-testid='review-pane-root']")
            const corpus = root?.querySelector<HTMLElement>("[data-review-total-files]")
            const renderedFiles = Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? [])
              .map((row) => row.dataset.reviewFile)
              .filter((path): path is string => !!path)
            const canonicalFile = renderedFiles.some((path) => changed.includes(path))
            const state = root?.querySelector<HTMLElement>("[data-review-diff-style]")
            const openCount = Number(state?.dataset.reviewOpenDiffCount ?? -1)
            const loadedCount = Number(state?.dataset.reviewLoadedDiffCount ?? -1)
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
            ready = ownerExact &&
              shell?.dataset.stateNavigator === "changes" &&
              visible(root) &&
              Number(corpus?.dataset.reviewTotalFiles) === changed.length &&
              loadedCount === changed.length &&
              state?.dataset.reviewLoadedDiffIdentity === expectedReviewIdentity &&
              Number(corpus?.dataset.reviewRenderedFiles) === canonicalRows.length &&
              canonicalRows.length > 0 &&
              renderedFiles.length > 0 &&
              canonicalFile &&
              expansionReady &&
              !root?.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
            signature = ready ? JSON.stringify([
              directory,
              sessionId,
              state?.dataset.reviewLoadedDiffIdentity,
              renderedFiles,
              openCount,
              expandedRows.length,
              visibleExpandedRows.length,
              paintedRows.length,
              root?.innerText.length,
            ]) : ""
          }
        }
        stable = ready && signature === previousSignature ? stable + 1 : ready ? 1 : 0
        previousSignature = signature
        if (performance.now() >= deadline) return fail(new Error(`Claxedo workspace panel did not reach atomic destination readiness: ${JSON.stringify({
          profile,
          shell: shell ? Object.fromEntries(Object.entries(shell.dataset)) : undefined,
          signature,
          stable,
        })}`))
        return stable
      }
      const stopFrames = paintedFrames({
        sample,
        painted: (frameStable, paintedAt) => {
          if (frameStable === undefined || settled) return
          if (frameStable === 1) stableSince = paintedAt
          if (frameStable < 2) return
          if (window.__claxedoPublicPanelTrace?.active && markEnd) {
            performance.clearMarks(endMark)
            performance.mark(endMark, { startTime: stableSince })
          }
          complete(stableSince)
          return true
        },
      })
    })
  }, {
    profile,
    sessionId: target.sessionId,
    directory: target.workspaceDirectory,
    files: fixture.files,
    changed: fixture.changed,
    endMark: COUNTER_END_MARK,
    markEnd: options.markEnd ?? true,
    expectedReviewOpenCount: options.expectedReviewOpenCount,
    expectedReviewIdentity: loadedDiffIdentity(fixture.changed),
    observerToken: options.observerToken,
    scrollSelector: REVIEW_SCROLL_SELECTOR,
  }))
}

export async function cancelPanelOwnerObserver(page: Page, observerToken: string) {
  await page.evaluate((token) => {
    const browser = window as typeof window & { __claxedoPanelOwnerObservers?: Map<string, () => void> }
    browser.__claxedoPanelOwnerObservers?.get(token)?.()
  }, observerToken).catch(() => undefined)
}
