import type { BenchmarkPage as Page } from "./agent-cdp-page"
import { optionalText, readBooleanFields, readNumber, readRecord } from "./page-value"
import {
  PUBLIC_PANEL_LOAD_PROFILES,
  READINESS_TIMEOUT_MS,
  type FixtureEvidence,
  type PublicPanelLoadPreset,
} from "./workspace-panel-scenario"
import {
  clickFileRow,
  clickVisible,
  fileRowLocator,
  hasFileTab,
  optionalVisibleLocator,
  revealFileInNavigator,
  waitForVisibleSelector,
} from "./workspace-panel-locators"
import {
  twoPaintedFrames,
  waitForPaintedFile,
  waitForPanelClosed,
  waitForPanelProfile,
} from "./workspace-panel-readiness"
import { ensureAllDiffs, waitForDiffState } from "./workspace-panel-diff-readiness"

export async function seedPanelLoad(page: Page, fixture: FixtureEvidence, preset: PublicPanelLoadPreset) {
  await ensureFilesOpen(page, fixture)
  await retainCanonicalFileTabs(page, fixture, preset.retainedFileTabCount)
  await seedExpandedDirectories(page, fixture, preset.expandedDirectoryCount)
  await ensureDiffOpen(page, fixture)
  await ensureReviewExpansionCount(page, fixture, preset.expandedReviewFileCount)
}

async function seedExpandedDirectories(page: Page, fixture: FixtureEvidence, count: number) {
  await collapseVisibleDirectories(page)
  for (const directory of fixture.manifest.directories.slice(0, count)) {
    const file = fixture.files.find((candidate) => candidate.startsWith(`${directory}/`))
    if (!file) throw new Error(`Claxedo public panel fixture has no file below ${directory}`)
    await revealFileInNavigator(page, file)
  }
}

async function collapseVisibleDirectories(page: Page) {
  for (;;) {
    const found = readNumber(await page.evaluate(() => {
      const visible = Array.from(document.querySelectorAll<HTMLElement>(
        "[data-testid='workspace-files-navigator'][data-mode='files'] [role='treeitem'][aria-expanded='true']",
      )).filter((row) => {
        const rect = row.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && getComputedStyle(row).visibility !== "hidden"
      })
      if (visible.length === 0) return -1
      let selected = 0
      let level = -1
      visible.forEach((row, index) => {
        const current = Number(row.getAttribute("aria-level") ?? 0)
        if (current >= level) { selected = index; level = current }
      })
      return selected
    }))
    if (found < 0) return
    await page.locator(
      "[data-testid='workspace-files-navigator'][data-mode='files'] [role='treeitem'][aria-expanded='true']",
    ).nth(found).click()
    await twoPaintedFrames(page)
  }
}

async function retainCanonicalFileTabs(page: Page, fixture: FixtureEvidence, count: number) {
  const desired = fixture.openFiles.slice(0, count)
  for (const file of desired) {
    if (await hasFileTab(page, file)) continue
    await revealFileInNavigator(page, file)
    await clickFileRow(page, file)
    await waitForPaintedFile(page, file)
  }
  for (;;) {
    const extra = readNumber(await page.evaluate((basenames) => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>(
        "[data-slot='workspace-tab'][data-workspace-tab-kind='file']",
      ))
      return tabs.findIndex((tab) => !basenames.some((basename) => tab.innerText.includes(basename)))
    }, desired.map((file) => file.slice(file.lastIndexOf("/") + 1))))
    if (extra < 0) break
    const tab = page.locator("[data-slot='workspace-tab'][data-workspace-tab-kind='file']").nth(extra)
    await tab.locator("button").click()
    await tab.locator("[data-testid='workspace-tab-close'] button").click()
    await twoPaintedFrames(page)
  }
}

export function actionFile(fixture: FixtureEvidence, preset: PublicPanelLoadPreset) {
  const retainedByAnyProfile = new Set(fixture.openFiles)
  const candidates = fixture.files.filter((candidate) => !retainedByAnyProfile.has(candidate))
  const file = candidates[PUBLIC_PANEL_LOAD_PROFILES.indexOf(preset.id)]
  if (!file) throw new Error(`Claxedo public panel fixture has no distinct ${preset.id} action file`)
  return file
}

export async function prepareDataWarmFileOpen(
  page: Page,
  fixture: FixtureEvidence,
  preset: PublicPanelLoadPreset,
  file: string,
) {
  // Workspace interaction cases run after their authoritative data is ready.
  // A deliberate row hover uses the product's canonical request cache without
  // ever mounting the target TabFile; the trusted click still owns first
  // surface creation and painting.
  await retainCanonicalFileTabs(page, fixture, preset.retainedFileTabCount)
  await revealFileInNavigator(page, file)
  await assertFileSurfaceAbsent(page, file)
  await (await fileRowLocator(page, file)).hover()
  await page.waitForFunction((expected) => {
    const navigator = document.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")
    return navigator?.dataset.filePrefetchPath === expected && ["ready", "error"].includes(navigator.dataset.filePrefetchState ?? "")
  }, file, { polling: "raf", timeout: READINESS_TIMEOUT_MS })
  const prefetchState = await page.evaluate(() =>
    document.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")?.dataset.filePrefetchState
  )
  if (prefetchState !== "ready") throw new Error(`Claxedo file prefetch failed: ${file}`)
  await assertFileSurfaceAbsent(page, file)
}

/**
 * An app without hover prefetch gets the same surface-cold start and the same
 * painted-file end, with the file's bytes loaded by the measured click itself.
 */
export async function prepareSurfaceColdFileOpen(
  page: Page,
  fixture: FixtureEvidence,
  preset: PublicPanelLoadPreset,
  file: string,
) {
  await retainCanonicalFileTabs(page, fixture, preset.retainedFileTabCount)
  await revealFileInNavigator(page, file)
  await assertFileSurfaceAbsent(page, file)
}

async function assertFileSurfaceAbsent(page: Page, file: string) {
  await twoPaintedFrames(page)
  const state = readBooleanFields(await page.evaluate((expected) => {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>("[data-slot='workspace-tab'][data-workspace-tab-kind='file']"))
    const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='tab-file-root']"))
    const matches = (candidate: string) => candidate === expected || candidate.endsWith(`/${expected}`)
    return {
      tab: tabs.some((tab) => matches(tab.dataset.workspaceTabId ?? "") || tab.innerText.includes(expected.slice(expected.lastIndexOf("/") + 1))),
      root: roots.some((root) => matches(root.dataset.tabFilePath ?? "")),
    }
  }, file), ["tab", "root"])
  if (state.tab || state.root) throw new Error(`Claxedo data-warm open-file target surface was mounted: ${file}; ${JSON.stringify(state)}`)
}

export async function ensureReviewExpansionCount(page: Page, fixture: FixtureEvidence, count: number) {
  await ensureAllDiffs(page, fixture, false)
  if (count === 0) return
  if (count === fixture.changed.length) {
    await clickVisible(page, "button[aria-label='Expand all']")
    await waitForDiffState(page, fixture, { openCount: count })
    return
  }
  throw new Error(
    `Claxedo workspace-panel benchmark does not support partial Review expansion without scrolling: ${count}/${fixture.changed.length}`,
  )
}

/**
 * Session activation restores the destination's remembered panel, which can
 * leave the shell mounted mid-close (`data-open="false"`, `shellSettled`
 * false) with its own Files/Changes buttons still laid out. Input sent into
 * that closing shell is dropped with the shell, so untimed setup waits until
 * the shell has settled or unmounted, matching the protocol rule that no
 * panel input is sent during an opening or closing transition.
 */
export async function waitForFastSessionSwitchQuiet(page: Page) {
  await page.waitForFunction(() => {
    const carrier = window as Window & { __claxedoFastSessionSwitch?: { until: number; networkQuietUntil?: number } }
    const fast = carrier.__claxedoFastSessionSwitch
    return !fast || Date.now() > Math.max(fast.until, fast.networkQuietUntil ?? 0)
  }, undefined, { polling: "raf", timeout: READINESS_TIMEOUT_MS })
}

async function waitForPanelTransitionSettled(page: Page) {
  await page.waitForFunction(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
    return !shell || shell.dataset.shellSettled === "true"
  }, undefined, { polling: "raf", timeout: READINESS_TIMEOUT_MS })
}

export async function ensureFilesOpen(page: Page, fixture: FixtureEvidence) {
  await waitForPanelTransitionSettled(page)
  const state = await panelState(page)
  if (!state.open) {
    const files = await optionalVisibleLocator(page, "button[aria-label='Open Files']")
    if (files) await files.click()
    else {
      // A cold session can paint before workspace-backed toolbar actions are
      // available. The generic toggle preserves the last navigator by design,
      // so opening from a prior Changes profile is only step one: once the
      // workspace header exists, select Files explicitly before readiness.
      await clickVisible(page, "[data-testid='workspace-panel-toggle'][aria-label='Open workspace panel']")
      await waitForVisibleSelector(page, "button[aria-label='Open Files'], button[aria-label='Close Files']")
      if ((await panelState(page)).navigator !== "files") {
        await clickVisible(page, "button[aria-label='Open Files']")
      }
    }
  } else if (state.navigator !== "files") {
    await clickVisible(page, "button[aria-label='Open Files']")
  }
  await waitForPanelProfile(page, "files", fixture)
}

export async function ensureDiffOpen(page: Page, fixture: FixtureEvidence) {
  await ensureFilesOpen(page, fixture)
  const state = await panelState(page)
  if (state.navigator !== "changes") await clickVisible(page, "button[aria-label='Open Changes']")
  const reviewTab = await optionalVisibleLocator(page, "[data-slot='workspace-tab'][data-workspace-tab-kind='review'] > button")
  if (reviewTab) await reviewTab.click()
  await waitForPanelProfile(page, "diff", fixture)
}

/**
 * A closed panel may keep its body mounted: the rebuilt app retains it so the
 * next open is warm, and the old app disposes it. Either way nothing of the
 * panel may be on screen when a measurement starts from the closed state.
 */
export async function ensurePanelClosed(page: Page) {
  await waitForPanelTransitionSettled(page)
  if ((await panelState(page)).open) {
    await clickVisible(page, "[data-testid='workspace-panel-toggle'][aria-label='Close workspace panel']")
  }
  await waitForPanelClosed(page)
  await Bun.sleep(180)
  const shown = readNumber(await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(
    "[data-testid='workspace-panel-shell'] :is([data-testid='workspace-files-navigator'], [data-testid='review-pane-root'])",
  )).filter((root) => {
    const rect = root.getBoundingClientRect()
    const style = getComputedStyle(root)
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" &&
      rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth - 1 && rect.top < window.innerHeight
  }).length))
  if (shown !== 0) throw new Error(`Claxedo closed panel still shows ${shown} panel surfaces`)
}

async function panelState(page: Page) {
  const state = readRecord(await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
    const navigator = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='workspace-files-navigator']"))
      .find((item) => item.getBoundingClientRect().width > 0 && getComputedStyle(item).visibility !== "hidden")
    return {
      open: shell?.dataset.open === "true",
      navigator: navigator?.dataset.mode ??
        (document.querySelector("button[aria-label='Close Changes'][aria-pressed='true']") ? "changes" : undefined),
    }
  }))
  // `navigator` is absent whenever no navigator is laid out yet, which every
  // caller branches on; `open` is a fact the shell always states.
  return { open: state.open === true, navigator: optionalText(state.navigator) }
}
