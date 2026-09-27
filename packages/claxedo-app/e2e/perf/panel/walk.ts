import type { Page } from "@playwright/test"
import { sessionRoute } from "../../harness/ui-names"
import { ensureNavigator, ensureOpen, fileTab, railRow, reviewTab, settle, toggle, treeRow } from "./page-actions"
import type { Runner } from "./runner"
import type { Workspace } from "./workspaces"

const RUNS = Number(process.env.PANEL_RUNS ?? "5")
const PRESS_MS = Number(process.env.PANEL_PRESS_MS ?? "0")
const SECTIONS = (process.env.PANEL_SECTIONS ?? "open,navigator,tabs,tree,review,maximize,session").split(",")

async function section(name: string, run: () => Promise<void>) {
  if (!SECTIONS.includes(name)) return
  await run()
}

async function goToSession(page: Page, sessionId: string) {
  await railRow(page, sessionId).click()
  await page.waitForFunction((id) => document.querySelector(`[data-testid='session-page-root'][data-session-id='${id}'] [data-component='prompt-input']`) !== null, sessionId, { polling: "raf" })
}

async function openFileTabs(page: Page, files: readonly string[]) {
  for (const file of files) {
    if (await fileTab(page, file).count()) continue
    await (await treeRow(page, file)).click()
    await page.waitForFunction((path) => [...document.querySelectorAll<HTMLElement>("[data-testid='tab-file-root']")].some((root) => root.dataset.tabFilePath === path && root.dataset.tabFileRenderState === "painted"), file, { polling: "raf" })
  }
}

export async function walk(page: Page, runner: Runner, workspace: Workspace, origin: string, checkpoint: (label: string) => Promise<void>) {
  const name = workspace.name
  const [sessionA, sessionB] = workspace.sessions
  if (!sessionA || !sessionB) throw new Error("two sessions needed")
  await page.goto(`${origin}${sessionRoute(workspace.id, sessionA)}`)
  await page.locator("[data-testid='session-page-root'][data-session-id='" + sessionA + "'] [data-component='prompt-input']").waitFor({ timeout: 60_000 })
  const cleared = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((key) => key.includes("panel:navigator") || key.includes("panel:width"))
    for (const key of keys) localStorage.removeItem(key)
    return keys
  })
  if (cleared.length) {
    console.log(`[panel] cleared ${cleared.join(", ")}`)
    await page.reload()
    await page.locator("[data-testid='session-page-root'][data-session-id='" + sessionA + "'] [data-component='prompt-input']").waitFor({ timeout: 60_000 })
  }
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)))
  await runner.attach()
  const openFiles = workspace.files.filter((file) => !workspace.changed.includes(file)).slice(0, 12)
  const tabFiles = openFiles.slice(0, 3)
  const [first, second, third] = tabFiles
  if (!first || !second || !third) throw new Error("three tab files needed")

  await section("open", async () => {
    await runner.measure(name, "open-panel-first", 0, { kind: "panel-open-files" }, () => toggle(page, true).click({ delay: PRESS_MS }))
    await settle(page)
    await openFileTabs(page, tabFiles)
    await reviewTab(page).click()
    await settle(page)
    for (let run = 1; run <= RUNS; run += 1) {
      await runner.measure(name, "close-panel", run, { kind: "panel-closed" }, () => toggle(page, false).click())
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)))
      await runner.measure(name, "open-panel-warm", run, { kind: "panel-open-files" }, () => toggle(page, true).click({ delay: PRESS_MS }))
      await settle(page)
    }
  })
  await ensureNavigator(page, "files")
  await openFileTabs(page, tabFiles)
  await section("navigator", async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      await runner.measure(name, "files-to-changes", run, { kind: "navigator", navigator: "changes" }, () => page.locator("button[aria-label='Open Changes']").click())
      await settle(page)
      await runner.measure(name, "changes-to-files", run, { kind: "navigator", navigator: "files" }, () => page.locator("button[aria-label='Open Files']").click())
      await settle(page)
      if (run % 5 === 0) await checkpoint(`after ${run * 2} navigator switches`)
    }
  })
  await section("tabs", async () => {
    await reviewTab(page).click()
    await settle(page)
    for (let run = 1; run <= RUNS; run += 1) {
      await runner.measure(name, "review-to-file-tab", run, { kind: "file-tab", path: first }, () => fileTab(page, first).click())
      await runner.measure(name, "file-tab-to-file-tab", run, { kind: "file-tab", path: second }, () => fileTab(page, second).click())
      await runner.measure(name, "file-tab-to-review", run, { kind: "review" }, () => reviewTab(page).click())
    }
  })
  await section("tree", async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      const file = openFiles[3 + run]
      if (!file) break
      const row = await treeRow(page, file)
      await settle(page)
      await runner.measure(name, "open-file-from-tree", run, { kind: "file-tab", path: file }, () => row.click())
      await reviewTab(page).click()
      await settle(page)
    }
  })
  await section("review", async () => {
    await ensureNavigator(page, "changes")
    await checkpoint("changes navigator shown, files hidden")
    await reviewTab(page).click()
    await page.waitForFunction(() => Number(document.querySelector<HTMLElement>("[data-review-total-files]")?.dataset.reviewRenderedFiles ?? 0) > 0, undefined, { polling: "raf" })
    await settle(page)
    const changedCount = workspace.changed.length
    for (let run = 1; run <= Math.min(RUNS, 3); run += 1) {
      await runner.measure(name, "expand-all", run, { kind: "review", openCount: changedCount }, () => page.locator("button[aria-label='Expand all']").click())
      await runner.measure(name, "collapse-all", run, { kind: "review", openCount: 0 }, () => page.locator("button[aria-label='Collapse all']").click())
    }
    await runner.measure(name, "expand-one", 1, { kind: "review", openCount: 1 }, () => page.locator(`button[aria-label='Toggle diff for ${workspace.changed[0]}']`).click())
    await runner.measure(name, "collapse-one", 1, { kind: "review", openCount: 0 }, () => page.locator(`button[aria-label='Toggle diff for ${workspace.changed[0]}']`).click())
  })
  await section("maximize", async () => {
    for (let run = 1; run <= Math.min(RUNS, 3); run += 1) {
      await runner.measure(name, "maximize", run, { kind: "maximized", maximized: true }, () => page.locator("button[aria-label='Maximize workspace panel']").click())
      await settle(page)
      await runner.measure(name, "restore", run, { kind: "maximized", maximized: false }, () => page.locator("button[aria-label='Restore workspace panel width']").click())
      await settle(page)
    }
  })
  await section("session", async () => {
    await ensureNavigator(page, "files")
    await goToSession(page, sessionB)
    await ensureNavigator(page, "files")
    await settle(page)
    for (let run = 1; run <= RUNS; run += 1) {
      await runner.measure(name, "session-switch-panel-files", run, { kind: "session", sessionId: sessionA, panel: "files" }, () => railRow(page, sessionA).click())
      await settle(page)
      await runner.measure(name, "session-switch-panel-files-back", run, { kind: "session", sessionId: sessionB, panel: "files" }, () => railRow(page, sessionB).click())
      await settle(page)
    }
    await ensureNavigator(page, "changes")
    await goToSession(page, sessionA)
    await ensureNavigator(page, "changes")
    await settle(page)
    for (let run = 1; run <= RUNS; run += 1) {
      await runner.measure(name, "session-switch-panel-changes", run, { kind: "session", sessionId: sessionB, panel: "changes" }, () => railRow(page, sessionB).click())
      await settle(page)
      await runner.measure(name, "session-switch-panel-changes-back", run, { kind: "session", sessionId: sessionA, panel: "changes" }, () => railRow(page, sessionA).click())
      await settle(page)
    }
    await goToSession(page, sessionB)
    await ensureOpen(page)
    await settle(page)
    await toggle(page, false).click()
    await settle(page)
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)))
    for (let run = 1; run <= Math.min(RUNS, 3); run += 1) {
      await runner.measure(name, "session-switch-panel-restores-open", run, { kind: "session", sessionId: sessionA, panel: "changes" }, () => railRow(page, sessionA).click())
      await settle(page)
      await runner.measure(name, "session-switch-panel-restores-closed", run, { kind: "session", sessionId: sessionB, panel: "closed" }, () => railRow(page, sessionB).click())
      await settle(page)
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)))
    }
  })
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
  await checkpoint("walk end, panel closed")
}
