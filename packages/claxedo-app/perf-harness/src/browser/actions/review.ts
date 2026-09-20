import {
  HEAVY_WORKSPACE_MAX_RENDERED_REVIEW_ROWS,
  HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR,
} from "../scenarios/heavy-workspace-reopen-contract"
import type { fixtureFor } from "../fixtures"
import { workspacePath } from "../state"
import { waitForAnimationFrame, settleForVideo, recordVisualFailure } from "./common"
import path from "node:path"
import type { Page } from "playwright-core"

export async function openFirstReviewDiff(page: Page) {
  const item = page.locator("#review-panel [data-review-file]").first()
  await item.waitFor({ state: "visible", timeout: 2_000 })
  const trigger = item.locator('[data-testid$="-trigger"]').first()
  const renderedBefore = await page.evaluate(() => Number(
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]"))
      .find((node) => !node.closest("[aria-hidden='true']"))
      ?.dataset.reviewRenderedHunks ?? "0",
  ))
  const started = performance.now()
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click({ timeout: 2_000 })
  await page.waitForFunction((before) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]"))
      .some((node) => !node.closest("[aria-hidden='true']") && Number(node.dataset.reviewRenderedHunks ?? "0") > before),
  renderedBefore, { timeout: 2_000 })
  await waitForAnimationFrame(page, 2)
  return Math.round((performance.now() - started) * 100) / 100
}

export async function openReviewSurface(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  options: { settle?: "video" | "frame"; validateChangedFiles?: boolean } = {},
) {
  await showReviewSurfaceShell(page, fixture, options)
  await waitForReviewPanel(page, fixture)
  if ((options.settle ?? "video") === "video") await settleForVideo(page)
  else await waitForAnimationFrame(page, 2)
  if (options.validateChangedFiles ?? true) await waitForReviewChangedFiles(page, fixture)
}

async function showReviewSurfaceShell(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  options: { settle?: "video" | "frame" } = {},
) {
  const openedByWorkspacePanelToggle = await clickVisibleReviewControl(page, /^open workspace panel$/i)
    || await clickVisibleReviewControl(page, /(review|diff|changed files)/i)
  if (!openedByWorkspacePanelToggle) {
    const viewport = page.viewportSize()
    if (viewport) {
      await page.mouse.click(viewport.width - 16, 18)
      await waitForAnimationFrame(page, 2)
    }
    if (!await reviewPanelVisible(page, 1_000)) {
      await page.goto(`${new URL(page.url()).origin}${workspacePath(fixture.directory)}`, { waitUntil: "domcontentloaded" })
    }
  }
  await waitForWorkspacePanelShell(page, fixture)
  if ((options.settle ?? "video") === "video") await settleForVideo(page)
  else await waitForAnimationFrame(page, 1)
}

export async function measureWorkspacePanelOpen(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const result = await page.evaluate(async () => {
    const visible = (el: Element) => {
      if (el.closest("[aria-hidden='true']")) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none"
    }
    const shellVisible = () => {
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
      if (!shell || !visible(shell)) return false
      const rect = shell.getBoundingClientRect()
      return rect.width > 120 && rect.height > 120
    }
    const openWorkspacePanelControl = () => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(
        "button[aria-label='Open workspace panel'], [role='button'][aria-label='Open workspace panel']",
      ))) {
        if (!visible(el)) continue
        return el
      }
      return undefined
    }
    if (shellVisible()) return 0
    const control = openWorkspacePanelControl()
    if (!control) return undefined
    const started = performance.now()
    control.click()
    return await new Promise<number>((resolve) => {
      const limit = 5000
      const tick = () => {
        if (shellVisible() || performance.now() - started > limit) {
          resolve(performance.now() - started)
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  })
  if (result !== undefined) {
    await waitForAnimationFrame(page, 2)
    return result
  }
  await showReviewSurfaceShell(page, fixture, { settle: "frame" })
  return 5000
}

async function clickVisibleReviewControl(page: Page, pattern: RegExp) {
  const target = await page.evaluate((source) => {
    const pattern = new RegExp(source, "i")
    const visible = (el: Element) => {
      if (el.closest("[aria-hidden='true']")) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden"
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("button, [role='button'], [aria-controls='review-panel']"))) {
      if (!visible(el)) continue
      const labels = [el.textContent, el.getAttribute("aria-label"), el.title]
        .map((label) => label?.trim())
        .filter((label): label is string => !!label)
      if (!labels.some((label) => pattern.test(label))) continue
      const rect = el.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    return undefined
  }, pattern.source)
  if (!target) return false
  await page.mouse.click(target.x, target.y)
  return true
}

async function waitForReviewPanel(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const visible = await reviewPanelVisible(page, 10_000)
  if (!visible) recordVisualFailure(fixture, "diff/review surface did not visibly open")
}

async function waitForWorkspacePanelShell(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const visible = await workspacePanelShellVisible(page, 5_000)
  if (!visible) recordVisualFailure(fixture, "workspace panel shell did not visibly open")
}

async function workspacePanelShellVisible(page: Page, timeout: number) {
  return await page
    .waitForFunction(() => {
      const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
      const candidate = shell ?? document.querySelector<HTMLElement>(
        "#review-panel, [data-testid='review-pane-root'], [data-review-surface='workspace-review']",
      )
      if (!candidate || candidate.closest("[aria-hidden='true']")) return false
      const rect = candidate.getBoundingClientRect()
      return rect.width > 120 &&
        rect.height > 120 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth
    }, undefined, { timeout })
    .then(() => true)
    .catch(() => false)
}

async function reviewPanelVisible(page: Page, timeout: number) {
  return await page
    .waitForFunction(() => {
      const panels = document.querySelectorAll("#review-panel, [data-testid='review-pane-root'], [data-review-surface='workspace-review']")
      for (const panel of Array.from(panels)) {
        const rect = panel.getBoundingClientRect()
        const hiddenAncestor = panel.closest("[aria-hidden='true']")
        if (
          !hiddenAncestor &&
          rect.width > 120 &&
          rect.height > 120 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < innerHeight &&
          rect.left < innerWidth
        ) return true
      }
      return false
    }, undefined, { timeout })
    .then(() => true)
    .catch(() => false)
}

export async function waitForReviewChangedFiles(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  options: { timeout?: number } = {},
) {
  const expectedFile = fixture.changedFiles[0]?.file ?? "file-0.ts"
  const fileVisible = await page
    .waitForFunction(
      ({ file, basename }) => document.body.innerText.includes(file) || document.body.innerText.includes(basename),
      { file: expectedFile, basename: path.basename(expectedFile) },
      { timeout: options.timeout ?? 10_000 },
    )
    .then(() => true)
    .catch(() => false)
  if (!fileVisible) recordVisualFailure(fixture, "diff/review surface did not visibly open with changed files")
}

export async function measureReviewChangedFileReady(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  return await page.evaluate(async ({ file, basename }) => {
    const escape = globalThis.CSS?.escape ?? ((value: string) => value.replaceAll('"', '\\"'))
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return !el.closest("[aria-hidden='true']") &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden"
    }
    const ready = () => {
      const exact = document.querySelector<HTMLElement>(
        `[data-component="session-review"] [data-file="${escape(file)}"]`,
      )
      if (exact && visible(exact)) return true
      const review = document.querySelector<HTMLElement>("[data-component='session-review']")
      return !!review && review.textContent?.includes(basename)
    }
    if (ready()) return 0
    const started = performance.now()
    return await new Promise<number>((resolve) => {
      const limit = 2_000
      const tick = () => {
        const elapsed = performance.now() - started
        if (ready() || elapsed > limit) {
          resolve(elapsed)
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, {
    file: fixture.changedFiles[0]?.file ?? "file-0.ts",
    basename: path.basename(fixture.changedFiles[0]?.file ?? "file-0.ts"),
  })
}

export async function toggleDiffStyle(page: Page, options: { settle?: "video" | "frame" } = {}) {
  const previous = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-diff-style]"))
      .find((node) => !node.closest("[aria-hidden='true']"))
      ?.dataset.reviewDiffStyle)
  if (previous !== "split" && previous !== "unified") throw new Error("Visible review diff style was not ready")
  const expected = previous === "split" ? "unified" : "split"
  const settle = async () => {
    if ((options.settle ?? "video") === "video") await settleForVideo(page)
    else await waitForAnimationFrame(page, 2)
  }
  await page.locator(
    `[data-testid="review-diff-style-toggle"][data-review-next-diff-style="${expected}"]`,
  ).last().click({ timeout: 2_000 })
  await page.waitForFunction((style) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-diff-style]"))
      .some((node) => !node.closest("[aria-hidden='true']") && node.dataset.reviewDiffStyle === style),
  expected, { timeout: 2_000 })
  await settle()
}

export async function waitForReviewStable(page: Page) {
  await page.waitForFunction(() => {
    const review = document.querySelector("#review-panel [data-review-diff-style]")
    return !!review?.getAttribute("data-review-diff-style") && Number(review.getAttribute("data-review-rendered-hunks") ?? "0") > 0
  }, undefined, { timeout: 2_000 })
  await waitForAnimationFrame(page, 2)
}

export async function waitForHeavyReviewCorpus(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const expected = fixture.changedFiles.length
  const cap = HEAVY_WORKSPACE_MAX_RENDERED_REVIEW_ROWS
  // The file list is windowed: the MODEL must hold every changed file while
  // the DOM holds only a window's worth of rows -- and the two counters must
  // agree with the actual mounted rows.
  const complete = await page.waitForFunction(({ expected, cap }) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const root = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    const corpus = root?.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    if (!corpus) return false
    const rendered = Number(corpus.dataset.reviewRenderedFiles ?? "0")
    return Number(corpus.dataset.reviewTotalFiles ?? "0") === expected &&
      rendered > 0 && rendered <= cap &&
      root?.querySelectorAll("[data-review-file]").length === rendered
  }, { expected, cap }, { timeout: 12_000 }).then(() => true).catch(() => false)
  if (!complete) recordVisualFailure(fixture, `Review did not hold its ${expected}-file model behind a bounded row window`)
  await waitForAnimationFrame(page, 2)
}

export async function scrollHeavyReviewWorkingSet(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  const targetPath = fixture.changedFiles[Math.floor(fixture.changedFiles.length * 0.7)]?.file
  if (!targetPath) {
    recordVisualFailure(fixture, "heavy Review fixture had no deep-scroll target")
    return
  }
  const scrolled = await page.evaluate(async ({ targetPath, fileOrder, scrollSelector }) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const root = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    const scroll = root?.querySelector<HTMLElement>(scrollSelector)
    if (!scroll) return false
    const fileIndex = new Map(fileOrder.map((file, index) => [file, index]))
    const targetIndex = fileIndex.get(targetPath)
    if (targetIndex === undefined) return false
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const materialized = () => Array.from(root?.querySelectorAll<HTMLElement>("[data-review-file]") ?? [])
      .filter((row) => fileIndex.has(row.dataset.reviewFile ?? ""))
    const findTarget = () => materialized().find((row) => row.dataset.reviewFile === targetPath)
    // The windowed list only materializes rows near the scroll position, so a
    // deep row cannot be scrolled to directly. Hop toward it from the nearest
    // materialized row -- each hop lands within the previous height-estimate
    // error, so a few hops converge even when an expanded row above has made
    // proportional guesses land a window short -- then align exactly once the
    // row exists. The same motion as a user's scrollbar drag plus settle.
    for (let attempt = 0; attempt < 12; attempt++) {
      const target = findTarget()
      const scrollRect = scroll.getBoundingClientRect()
      if (target) {
        const targetRect = target.getBoundingClientRect()
        if (Math.abs(targetRect.top - scrollRect.top) <= 1) break
        scroll.scrollTop += targetRect.top - scrollRect.top
      } else {
        const rows = materialized()
        const nearest = rows.reduce<HTMLElement | undefined>((best, row) => {
          const index = fileIndex.get(row.dataset.reviewFile ?? "")!
          const bestIndex = best ? fileIndex.get(best.dataset.reviewFile ?? "")! : undefined
          return bestIndex === undefined || Math.abs(index - targetIndex) < Math.abs(bestIndex - targetIndex)
            ? row
            : best
        }, undefined)
        if (nearest) {
          const nearestIndex = fileIndex.get(nearest.dataset.reviewFile ?? "")!
          const rowHeight = nearest.offsetHeight || 40
          const nearestRect = nearest.getBoundingClientRect()
          scroll.scrollTop += (nearestRect.top - scrollRect.top) + (targetIndex - nearestIndex) * rowHeight
        } else {
          scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) *
            (targetIndex / Math.max(1, fileOrder.length - 1))
        }
      }
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }))
      await frame()
      await frame()
    }
    return scroll.scrollTop > 0 && !!findTarget()
  }, {
    targetPath,
    fileOrder: fixture.changedFiles.map((file) => file.file),
    scrollSelector: HEAVY_WORKSPACE_REVIEW_SCROLL_SELECTOR,
  })
  if (!scrolled) recordVisualFailure(fixture, `Review did not scroll to substantial content at ${targetPath}`)
  await waitForAnimationFrame(page, 3)
}
