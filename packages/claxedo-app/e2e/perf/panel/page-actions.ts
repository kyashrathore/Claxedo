import type { Locator, Page } from "@playwright/test"

const shellSelector = "[data-testid='workspace-panel-shell']"

export async function settle(page: Page) {
  await page.waitForFunction((selector) => {
    const shell = document.querySelector<HTMLElement>(selector)
    return !shell || shell.dataset.shellSettled === "true"
  }, shellSelector, { polling: "raf" })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

export async function panelOpen(page: Page) {
  return page.evaluate((selector) => document.querySelector<HTMLElement>(selector)?.dataset.open === "true", shellSelector)
}

export function toggle(page: Page, open: boolean): Locator {
  return page.locator(`[data-testid='workspace-panel-toggle'][aria-label='${open ? "Open" : "Close"} workspace panel']`)
}

export async function ensureOpen(page: Page) {
  await settle(page)
  if (!(await panelOpen(page))) {
    await toggle(page, true).click()
    await settle(page)
  }
}

export async function ensureNavigator(page: Page, navigator: "files" | "changes") {
  await ensureOpen(page)
  const label = navigator === "files" ? "Files" : "Changes"
  const open = page.locator(`button[aria-label='Open ${label}']`)
  if (await open.count()) await open.click()
  await page.waitForFunction((kind) => document.querySelector(`[data-testid='workspace-navigator-overlay'][data-navigator-kind='${kind}'][data-open='true']`) !== null, navigator, { polling: "raf" })
  await settle(page)
}

const navigatorScroller = "[data-testid='workspace-files-navigator'][data-mode='files'] [data-scrollable], [data-testid='workspace-files-navigator'][data-mode='files'] [data-slot='scroll-view-viewport']"

async function scrollTreeTo(page: Page, rowPath: string): Promise<Locator> {
  const row = page.locator(`[data-testid='workspace-files-navigator'][data-mode='files'] [data-file-tree-path='${rowPath}']`).first()
  const scroller = page.locator(navigatorScroller).first()
  await scroller.evaluate((element) => (element.scrollTop = 0))
  for (let step = 0; step < 200; step += 1) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    if (await row.count()) {
      await row.scrollIntoViewIfNeeded()
      return row
    }
    const atEnd = await scroller.evaluate((element) => {
      const next = Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + element.clientHeight * 0.8)
      const done = next <= element.scrollTop
      element.scrollTop = next
      return done
    })
    if (atEnd) break
  }
  throw new Error(`tree row ${rowPath} not found`)
}

export async function treeRow(page: Page, file: string): Promise<Locator> {
  const segments = file.split("/")
  for (let depth = 1; depth < segments.length; depth += 1) {
    const dir = segments.slice(0, depth).join("/")
    const expanded = await page.locator(`[data-testid='workspace-files-navigator'][data-mode='files'] [data-file-tree-path^='${dir}/']`).count()
    if (expanded > 0) continue
    const row = await scrollTreeTo(page, dir)
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click()
  }
  return scrollTreeTo(page, file)
}

export function fileTab(page: Page, file: string): Locator {
  return page.locator(`[data-slot='workspace-tab'][data-workspace-tab-kind='file'][data-workspace-tab-id$='${file}'] > button`)
}

export function reviewTab(page: Page): Locator {
  return page.locator("[data-slot='workspace-tab'][data-workspace-tab-kind='review'] > button")
}

export function railRow(page: Page, sessionId: string): Locator {
  return page.locator(`[data-testid='rail-sidebar-session-row'][data-session-id='${sessionId}']`)
}
