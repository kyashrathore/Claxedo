import type { BenchmarkLocator, BenchmarkPage as Page } from "./agent-cdp-page"
import { readNumber } from "./page-value"
import { measureSessionActivation, type ActivationHooks } from "./agent-browser-observer"
import { READINESS_TIMEOUT_MS, type PanelTarget } from "./workspace-panel-scenario"

export async function revealFileInNavigator(page: Page, file: string) {
  const clear = await optionalVisibleLocator(page, "[data-testid='workspace-files-navigator'][data-mode='files'] button[aria-label='Clear search']")
  if (clear) await clear.click()
  const segments = file.split("/")
  for (let index = 0; index < segments.length - 1; index += 1) {
    const directory = await directoryRowLocator(page, segments[index], index + 1)
    if ((await directory.getAttribute("aria-expanded")) !== "true") await directory.click()
  }
  await waitForTreePath(page, file)
}

export async function clickFileRow(page: Page, file: string) {
  await (await fileRowLocator(page, file)).click()
}

export async function fileRowLocator(page: Page, file: string) {
  const exact = `[data-file-tree-path=${JSON.stringify(file)}]`
  const absolute = `[data-file-tree-path$=${JSON.stringify(`/${file}`)}]`
  const locator = page.locator(
    `[data-testid='workspace-files-navigator'][data-mode='files'] :is(${exact}, ${absolute})`,
  )
  await locator.waitFor({ state: "visible" })
  const count = await locator.count()
  if (count !== 1) throw new Error(`Claxedo expected one visible canonical file row for ${file}, found ${count}`)
  return locator
}

async function directoryRowLocator(page: Page, label: string, level: number) {
  const selector = `[data-testid='workspace-files-navigator'][data-mode='files'] [role='treeitem'][aria-level='${level}']`
  try {
    await scrollTreeToRow(page, { kind: "directory", level, label })
  } catch {
    throw new Error(`Claxedo directory row did not appear: level=${level} label=${label}`)
  }
  const index = await indexByText(page, selector, label, true)
  if (index < 0) throw new Error(`Claxedo has no visible directory row for ${label}`)
  return page.locator(selector).nth(index)
}

async function waitForTreePath(page: Page, expected: string) {
  try {
    await scrollTreeToRow(page, { kind: "path", path: expected })
  } catch {
    throw new Error(`Claxedo tree path did not appear: ${expected}`)
  }
}

type TreeRowTarget =
  | { readonly kind: "directory"; readonly level: number; readonly label: string }
  | { readonly kind: "path"; readonly path: string }

/**
 * Waits for a Files tree row, scrolling the tree the way a user would when the
 * row is not rendered. A virtualized tree renders only the rows near its
 * viewport, so a row scrolled out of view is absent from the DOM rather than
 * hidden. The first miss scrolls to the top; each later frame moves down half
 * a viewport until the row renders or the tree ends.
 */
async function scrollTreeToRow(page: Page, target: TreeRowTarget) {
  await page.waitForFunction((wanted) => {
    const navigator = document.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")
    if (!navigator) return false
    const rows = Array.from(navigator.querySelectorAll<HTMLElement>(
      wanted.kind === "directory" ? `[role='treeitem'][aria-level='${wanted.level}']` : "[data-file-tree-path]",
    ))
    const found = rows.some((row) => {
      const rect = row.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      if (wanted.kind === "directory") return row.innerText.trim().split(/\s+/u).includes(wanted.label)
      const path = row.dataset.fileTreePath ?? ""
      return path === wanted.path || path.endsWith(`/${wanted.path}`)
    })
    if (found) return true
    const viewport = navigator.querySelector<HTMLElement & { __claxedoTreeSeek?: string }>("[data-scrollable]")
    if (!viewport) return false
    if (viewport.__claxedoTreeSeek !== wanted.seek) {
      viewport.__claxedoTreeSeek = wanted.seek
      viewport.scrollTop = 0
    } else if (viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight) {
      viewport.scrollTop += Math.max(1, Math.floor(viewport.clientHeight / 2))
    }
    return false
  }, { ...target, seek: crypto.randomUUID() }, { polling: "raf", timeout: READINESS_TIMEOUT_MS })
}

export const FILE_TAB_SELECTOR = "[data-slot='workspace-tab'][data-workspace-tab-kind='file']"

export function fileTabActivator(tab: BenchmarkLocator) {
  return tab.locator(":scope > button")
}

export async function hasFileTab(page: Page, file: string) {
  const basename = file.slice(file.lastIndexOf("/") + 1)
  return (await indexByText(page, FILE_TAB_SELECTOR, basename)) !== -1
}

export async function clickFileTab(page: Page, file: string) {
  const basename = file.slice(file.lastIndexOf("/") + 1)
  const index = await indexByText(page, FILE_TAB_SELECTOR, basename, true)
  if (index < 0) throw new Error(`Claxedo has no visible file tab for ${file}`)
  await fileTabActivator(page.locator(FILE_TAB_SELECTOR).nth(index)).click()
}

export async function clickVisible(page: Page, selector: string) {
  await (await visibleLocator(page, selector)).click()
}

export async function waitForVisibleSelector(page: Page, selector: string) {
  await page.waitForFunction((query) => Array.from(document.querySelectorAll<HTMLElement>(query)).some((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }), selector, { polling: "raf", timeout: READINESS_TIMEOUT_MS })
}

export async function optionalVisibleLocator(page: Page, selector: string) {
  const index = readNumber(await page.evaluate((query) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(query))
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      const element = elements[index]
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden") return index
    }
    return -1
  }, selector))
  return index < 0 ? undefined : page.locator(selector).nth(index)
}

async function visibleLocator(page: Page, selector: string) {
  const locator = await optionalVisibleLocator(page, selector)
  if (!locator) throw new Error(`Claxedo has no visible control for ${selector}`)
  return locator
}

async function indexByText(page: Page, selector: string, text: string, visible = false) {
  return readNumber(await page.evaluate(({ selector: query, text: expected, visible: requireVisible }) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(query))
    return elements.findIndex((element) => {
      if (!element.innerText.includes(expected)) return false
      if (!requireVisible) return true
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    })
  }, { selector, text, visible }))
}

export async function activateExact(page: Page, target: PanelTarget, hooks?: ActivationHooks) {
  const result = await measureSessionActivation(page, target, hooks)
  if (result.state !== "exact") throw new Error(`Claxedo session activation failed: ${result.reason}`)
  return result
}
