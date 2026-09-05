import type { Page } from "@playwright/test"

/**
 * Workspace-panel interactions the review probes share. Each probe used to
 * carry its own copy of these; the timeouts that had drifted between copies
 * are parameters now, so a probe states its own patience instead of silently
 * inheriting another's.
 */

export async function syntheticVisibleClick(page: Page, selector: string) {
  await page.evaluate((selector) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const target = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible).at(-1)
    if (!target) throw new Error(`No visible element for synthetic click: ${selector}`)
    target.click()
  }, selector)
}

export async function waitForWorkspaceReviewContent(page: Page, expectedTotal: number, options: { timeout?: number } = {}) {
  await page.waitForFunction((expectedTotal) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    if (!shell || !visible(shell) || shell.getBoundingClientRect().width <= 120) return false
    const root = Array.from(shell.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    if (!root) return false
    const corpus = root.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    if (!corpus || Number(corpus.dataset.reviewTotalFiles ?? "0") !== expectedTotal) return false
    if (!Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]")).some(visible)) return false
    return !root.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
  }, expectedTotal, { timeout: options.timeout ?? 20_000 })
}

/**
 * The files navigator lives behind the panel's "Open Files" control (inside
 * `[data-testid='workspace-navigator-overlay']`), which the driver reaches via
 * measureWorkspaceFiles before it opens a file tab. `requireOverlayOpen` also
 * waits for that overlay to report open and unhidden.
 */
export async function openFilesNavigator(page: Page, options: { timeout?: number; requireOverlayOpen?: boolean } = {}) {
  await page.evaluate(() => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" &&
        style.pointerEvents !== "none"
    }
    const control = Array.from(document.querySelectorAll<HTMLElement>(
      "button[aria-label='Open Files'], [role='button'][aria-label='Open Files']",
    )).find(visible)
    if (!control) throw new Error("no visible 'Open Files' control on the workspace panel")
    control.click()
  })
  const requireOverlayOpen = options.requireOverlayOpen ?? true
  await page.waitForFunction((requireOverlayOpen) => {
    const navigator = document.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")
    if (!navigator) return false
    if (requireOverlayOpen) {
      const overlay = navigator.closest<HTMLElement>("[data-testid='workspace-navigator-overlay']")
      if (overlay && (overlay.dataset.open !== "true" || overlay.getAttribute("aria-hidden") === "true")) return false
    }
    return navigator.getAttribute("data-file-tree-data-ready") === "true" ||
      !!navigator.querySelector("[data-file-tree-path]")
  }, requireOverlayOpen, { timeout: options.timeout ?? 10_000 })
}

/** Same precondition the driver's Block B establishes: one substantial file tab open. */
export async function openWorkspaceFileTab(
  page: Page,
  filePath: string,
  options: { openNavigator?: boolean; searchTimeout?: number; readyTimeout?: number } = {},
) {
  if (options.openNavigator ?? true) await openFilesNavigator(page)
  const searchTimeout = options.searchTimeout ?? 5_000
  const navigator = page.locator("[data-testid='workspace-files-navigator'][data-mode='files']").last()
  const search = navigator.locator("input[placeholder='Search files...']").first()
  await search.waitFor({ state: "visible", timeout: searchTimeout })
  await search.fill(filePath)
  const row = navigator.locator(`[data-file-tree-path="${filePath}"]`).first()
  await row.waitFor({ state: "visible", timeout: searchTimeout })
  await row.click({ timeout: searchTimeout })
  await page.waitForFunction((filePath) => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    return !!shell?.querySelector(
      `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(filePath)}"][data-tab-file-state='ready']`,
    )
  }, filePath, { timeout: options.readyTimeout ?? 10_000 })
}

/** Same precondition the driver's Block C establishes: first diff expanded. */
export async function openFirstReviewDiff(page: Page) {
  const item = page.locator("#review-panel [data-review-file]").first()
  await item.waitFor({ state: "visible", timeout: 5_000 })
  const trigger = item.locator('[data-testid$="-trigger"]').first()
  const renderedBefore = await page.evaluate(() => Number(
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]"))
      .find((node) => !node.closest("[aria-hidden='true']"))
      ?.dataset.reviewRenderedHunks ?? "0",
  ))
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click({ timeout: 5_000 })
  await page.waitForFunction((before) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-review-rendered-hunks]"))
      .some((node) => !node.closest("[aria-hidden='true']") && Number(node.dataset.reviewRenderedHunks ?? "0") > before),
  renderedBefore, { timeout: 10_000 })
  await page.waitForFunction(() => {
    const review = document.querySelector("#review-panel [data-review-diff-style]")
    return !!review?.getAttribute("data-review-diff-style") && Number(review.getAttribute("data-review-rendered-hunks") ?? "0") > 0
  }, undefined, { timeout: 10_000 })
}
