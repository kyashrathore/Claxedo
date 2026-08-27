import { chromium, type BrowserContext, type Page } from "playwright-core"
import path from "node:path"
import { workspaceCaptureUrl } from "./workspace-capture-url.mjs"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const RESULT_DIR = path.resolve(
  Bun.env.CLAXEDO_WORKSPACE_TAB_MOTION_DIR ?? path.join(PACKAGE_DIR, "test-results/workspace-panel-motion"),
)
const RAW_VIDEO_DIR = path.join(RESULT_DIR, "raw")
const baseURL = workspaceCaptureUrl({
  override: Bun.env.CLAXEDO_WORKSPACE_TAB_MOTION_URL,
  workspaceId: Bun.env.CLAXEDO_WORKSPACE_ID,
  origin: "http://localhost:4445",
})
const viewport = { width: 1280, height: 800 }
const frameBudgetMs = 8.33
const longFrameBudgetMs = 16.67

type TabSnapshot = {
  id: string | null
  kind: string | null
  text: string
  selected: boolean
}

type TimingSample = {
  name: string
  baselineFrameMs: number
  microtaskMs: number
  firstFrameMs: number
  stableFrameMs: number
  frameDeltas: number[]
  maxFrameDeltaMs: number
  framesOver120HzBudget: number
  framesOver60HzBudget: number
  framesOverUnexpectedBudget: number
  maxUnexpectedFrameDeltaMs: number
  tabs: TabSnapshot[]
}

type WorkbenchSnapshot = {
  index: number
  text: string
  selected: boolean
}

await Bun.$`mkdir -p ${RESULT_DIR} ${RAW_VIDEO_DIR}`

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport,
  recordVideo: { dir: RAW_VIDEO_DIR, size: viewport },
})
await context.addInitScript(() => {
  const w = window as unknown as Record<string, unknown>
  w.__CLAXEDO_TEST_AUTH_TOKEN__ = "test-bypass-token"
  w.__CLAXEDO_TEST_AUTH_USER__ = {
    id: "workspace-tab-motion-user",
    primaryEmailAddress: { emailAddress: "workspace-tab-motion@claxedo.test" },
    fullName: "Workspace Tab Motion",
  }
})
const page = await context.newPage()
const consoleErrors: string[] = []
const pageErrors: string[] = []
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text())
})
page.on("pageerror", (error) => pageErrors.push(error.message))

const artifact: Record<string, unknown> = {
  baseURL,
  viewport,
  frameBudgetMs,
  longFrameBudgetMs,
  capturedAt: new Date().toISOString(),
}

try {
  await waitForApp(page)
  const firstOpen = await clickReviewOpenFileAndMeasure(page, 0, "open first review file")
  await clickTabAndMeasure(page, "review", "Review", "return to Review")
  const secondOpen = await clickReviewOpenFileAndMeasure(page, 1, "open second review file")
  const firstFileTab = firstOpen.tabs.find((tab) => tab.kind === "file" && tab.selected)
  const secondFileTab = secondOpen.tabs.find((tab) => tab.kind === "file" && tab.selected)
  if (!firstFileTab?.id || !secondFileTab?.id || firstFileTab.id === secondFileTab.id) {
    throw new Error(`Expected two distinct opened file tabs, got ${JSON.stringify({ firstFileTab, secondFileTab })}`)
  }
  const skippedSamples: string[] = []
  if (!await tryOpenWorkspaceMenuTab(page, "Context", "context")) skippedSamples.push("workspace-panel context tab unavailable")
  if (!await tryOpenWorkspaceMenuTab(page, "Browser", "browser")) skippedSamples.push("workspace-panel browser tab unavailable")

  const switchToReview = await clickTabAndMeasure(page, "review", "Review", "switch already-open workspace-panel Review tab")
  const switchToContext = await maybeClickTabAndMeasure(
    page,
    "context",
    "Context",
    "switch already-open workspace-panel Context tab",
    skippedSamples,
  )
  const switchToBrowser = await maybeClickTabAndMeasure(
    page,
    "browser",
    "Browser",
    "switch already-open workspace-panel Browser tab",
    skippedSamples,
  )
  const switchToFirstFile = await clickTabAndMeasure(
    page,
    firstFileTab.id,
    firstFileTab.text,
    `switch already-open workspace-panel File tab ${firstFileTab.text}`,
  )
  const switchToSecondFile = await clickTabAndMeasure(
    page,
    secondFileTab.id,
    secondFileTab.text,
    `switch already-open workspace-panel File tab ${secondFileTab.text}`,
  )
  const reselectFirst = await clickTabAndMeasure(
    page,
    firstFileTab.id,
    firstFileTab.text,
    `reselect ${firstFileTab.text}`,
  )
  const closeFirst = await closeActiveFileTabAndMeasure(page, secondFileTab.text, `close ${firstFileTab.text}`)
  const workbenchSwitchSamples = await captureWorkbenchTabSwitches(page, skippedSamples)
  const workspaceTabSwitchSamples = [
    switchToReview,
    switchToContext,
    switchToBrowser,
    switchToFirstFile,
    switchToSecondFile,
  ].filter((sample): sample is TimingSample => sample !== undefined)
  const samples = [
    firstOpen,
    secondOpen,
    ...workspaceTabSwitchSamples,
    reselectFirst,
    closeFirst,
    ...workbenchSwitchSamples,
  ]

  const screenshot = path.join(RESULT_DIR, "workspace-tab-motion-final.png")
  await page.screenshot({ path: screenshot })
  artifact.samples = samples
  artifact.fileOpenSamples = [firstOpen, secondOpen].map((sample) => sample.name)
  artifact.workspaceTabSwitchSamples = workspaceTabSwitchSamples.map((sample) => sample.name)
  artifact.workbenchTabSwitchSamples = workbenchSwitchSamples.map((sample) => sample.name)
  artifact.skippedSamples = skippedSamples
  const mountedSurfaceSamples = [...workspaceTabSwitchSamples, reselectFirst, closeFirst, ...workbenchSwitchSamples]
  const mountedSurfaceMotionPass = mountedSurfaceSamples.every((sample) =>
    sample.microtaskMs <= frameBudgetMs && sample.maxFrameDeltaMs <= longFrameBudgetMs
  )
  const fileOpen60HzPass = [firstOpen, secondOpen].every((sample) =>
    sample.microtaskMs <= frameBudgetMs && sample.maxFrameDeltaMs <= longFrameBudgetMs
  )
  const tabSwitchSamples = [...workspaceTabSwitchSamples, ...workbenchSwitchSamples]
  const tabSwitchWorkBudgetPass = tabSwitchSamples.every((sample) => sample.microtaskMs <= frameBudgetMs)
  const tabSwitchPaintBudgetPass = tabSwitchSamples.every((sample) => sample.framesOver60HzBudget === 0)
  const tabSwitchObserved120HzCadence = tabSwitchSamples.every((sample) => sample.framesOver120HzBudget === 0)
  const tabSwitchUnexpectedFramePass = tabSwitchSamples.every((sample) => sample.framesOverUnexpectedBudget === 0)
  artifact.mountedSurfaceMotionPass = mountedSurfaceMotionPass
  artifact.fileOpen60HzPass = fileOpen60HzPass
  artifact.tabSwitchWorkBudgetPass = tabSwitchWorkBudgetPass
  artifact.tabSwitchPaintBudgetPass = tabSwitchPaintBudgetPass
  artifact.tabSwitchObserved120HzCadence = tabSwitchObserved120HzCadence
  artifact.tabSwitchUnexpectedFramePass = tabSwitchUnexpectedFramePass
  artifact.pass = (
    mountedSurfaceMotionPass &&
    fileOpen60HzPass &&
    tabSwitchWorkBudgetPass &&
    tabSwitchPaintBudgetPass &&
    tabSwitchUnexpectedFramePass
  )
  artifact.finalScreenshot = screenshot
  artifact.finalTabs = await readTabs(page)
  artifact.finalWorkbenchTabs = await readWorkbenchTabs(page)
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
} catch (error) {
  artifact.pass = false
  artifact.error = error instanceof Error ? error.message : String(error)
  artifact.failureUrl = page.url()
  artifact.failureTitle = await page.title().catch(() => "")
  artifact.failureBody = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "")
  artifact.finalTabs = await readTabs(page).catch(() => [])
  artifact.finalWorkbenchTabs = await readWorkbenchTabs(page).catch(() => [])
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
} finally {
  const videoPath = await closeContextAndSaveVideo(context, page)
  artifact.video = videoPath
  await browser.close()
  await Bun.write(path.join(RESULT_DIR, "workspace-tab-motion-manifest.json"), JSON.stringify(artifact, null, 2) + "\n")
}

if (!artifact.pass) {
  throw new Error(`Workspace tab motion capture failed; see ${path.join(RESULT_DIR, "workspace-tab-motion-manifest.json")}`)
}

console.log(`Workspace tab motion capture passed: ${path.join(RESULT_DIR, "workspace-tab-motion-manifest.json")}`)

async function waitForApp(page: Page) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" })
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})
  await page.locator('[data-testid="workspace-panel-shell"]').waitFor({ state: "attached", timeout: 20_000 })
  if (!await page.locator('[data-testid="workspace-tab-header"]').count()) {
    const opened = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLElement>('button[aria-label="Open workspace panel"]'))
      const button = buttons.find((item) => {
        const rect = item.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      button?.click()
      return !!button
    })
    if (!opened) throw new Error("Open workspace panel button was not available")
  }
  await page.locator('[data-testid="workspace-tab-header"]').waitFor({ state: "visible", timeout: 20_000 })
  await waitForVisibleReviewOpenFileButtons(page)
  await page.waitForTimeout(500)
}

async function waitForVisibleReviewOpenFileButtons(page: Page) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const count = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('button[aria-label="Open file"]'))
      .filter((button) => {
        const rect = button.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
      }).length)
    if (count > 0) return
    await page.waitForTimeout(250)
  }
  throw new Error("Review open-file buttons were not visible")
}

async function clickTabAndMeasure(page: Page, tabId: string, selectedLabel: string, name: string) {
  return await measureClick(page, {
    name,
    selector: `[data-workspace-tab-id="${tabId}"] button[aria-selected]`,
    selectedLabel,
  })
}

async function maybeClickTabAndMeasure(
  page: Page,
  tabId: string,
  selectedLabel: string,
  name: string,
  skippedSamples: string[],
) {
  if (!await page.locator(`[data-workspace-tab-id="${tabId}"] button[aria-selected]`).count()) {
    skippedSamples.push(`${name} unavailable`)
    return undefined
  }
  return await clickTabAndMeasure(page, tabId, selectedLabel, name)
}

async function closeActiveFileTabAndMeasure(page: Page, selectedLabel: string, name: string) {
  const activeTabId = await page.evaluate(() =>
    document.querySelector('[data-workspace-tab-kind="file"]:has(button[aria-selected="true"])')
      ?.getAttribute("data-workspace-tab-id") ?? null
  )
  if (!activeTabId) throw new Error("No active file tab was available to close")
  return await measureClick(page, {
    name,
    selector: `[data-testid="workspace-tab-close"][data-workspace-tab-id="${activeTabId}"] button`,
    selectedLabel,
    waitForGone: `[data-workspace-tab-id="${activeTabId}"]`,
  })
}

async function clickReviewOpenFileAndMeasure(page: Page, visibleIndex: number, name: string) {
  const baselineFrameMs = await waitForAnimationIdle(page)
  const before = await readTabs(page)
  return await page.evaluate(async ({ name, visibleIndex, before, baselineFrameMs, frameBudgetMs }) => {
    const readTabs = () => Array.from(document.querySelectorAll<HTMLElement>("[data-workspace-tab-id]"))
      .filter((node) => node.getAttribute("data-workspace-tab-kind"))
      .map((node) => ({
        id: node.getAttribute("data-workspace-tab-id"),
        kind: node.getAttribute("data-workspace-tab-kind"),
        text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
        selected: node.querySelector('button[aria-selected="true"]') !== null,
      }))
    const visibleOpenButtons = Array.from(document.querySelectorAll<HTMLElement>('button[aria-label="Open file"]'))
      .filter((button) => {
        const rect = button.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
      })
    const target = visibleOpenButtons[visibleIndex]
    if (!target) throw new Error(`Missing visible Review open-file button ${visibleIndex}`)

    const beforeFileIds = new Set(before.filter((tab) => tab.kind === "file").map((tab) => tab.id))
    const start = performance.now()
    target.click()
    let microtaskMs = performance.now() - start
    let selectedFile: { id: string | null; kind: string | null; text: string; selected: boolean } | undefined
    for (let i = 0; i < 8; i++) {
      await Promise.resolve()
      microtaskMs = performance.now() - start
      selectedFile = readTabs().find((tab) => tab.kind === "file" && tab.selected && !beforeFileIds.has(tab.id))
      if (selectedFile) break
    }

    const frameDeltas: number[] = []
    let previous = performance.now()
    let firstFrameMs = 0
    let stableFrameMs = 0
    await new Promise<void>((resolve) => {
      let stableFrames = 0
      const tick = () => {
        const now = performance.now()
        frameDeltas.push(now - previous)
        previous = now
        if (!firstFrameMs) firstFrameMs = now - start
        selectedFile = readTabs().find((tab) => tab.kind === "file" && tab.selected && !beforeFileIds.has(tab.id))
        stableFrames = selectedFile ? stableFrames + 1 : 0
        if (stableFrames >= 1 || now - start > 1_000) {
          stableFrameMs = now - start
          resolve()
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const tabs = readTabs()
    const maxFrameDeltaMs = Math.max(0, ...frameDeltas)
    const unexpectedBudgetMs = Math.max(baselineFrameMs, frameBudgetMs) + 1
    const unexpectedFrameDeltas = frameDeltas.filter((delta) => delta > unexpectedBudgetMs)
    return {
      name,
      baselineFrameMs,
      microtaskMs,
      firstFrameMs,
      stableFrameMs,
      frameDeltas,
      maxFrameDeltaMs,
      framesOver120HzBudget: frameDeltas.filter((delta) => delta > 8.33).length,
      framesOver60HzBudget: frameDeltas.filter((delta) => delta > 16.67).length,
      framesOverUnexpectedBudget: unexpectedFrameDeltas.length,
      maxUnexpectedFrameDeltaMs: Math.max(0, ...unexpectedFrameDeltas),
      tabs,
    }
  }, { name, visibleIndex, before, baselineFrameMs, frameBudgetMs })
}

async function tryOpenWorkspaceMenuTab(page: Page, label: "Context" | "Browser", kind: "context" | "browser") {
  try {
    if (await page.locator(`[data-workspace-tab-kind="${kind}"]`).count()) return true
    await page.getByRole("button", { name: "Add workspace tab", exact: true }).click({ timeout: 2_000 })
    await page.getByRole("menuitem", { name: label, exact: true }).click({ timeout: 2_000 })
    await page.locator(`[data-workspace-tab-kind="${kind}"]`).waitFor({ state: "attached", timeout: 5_000 })
    await page.waitForTimeout(120)
    return true
  } catch {
    await page.keyboard.press("Escape").catch(() => {})
    return false
  }
}

async function captureWorkbenchTabSwitches(page: Page, skippedSamples: string[]) {
  if (!await ensureCompactSwitcherAvailable(page)) {
    skippedSamples.push("workbench compact switcher unavailable")
    return []
  }
  if ((await readWorkbenchTabs(page)).length < 2) {
    await clickFirstVisibleNonSidebarButton(page, ["New Codex Terminal", "New Claude Terminal", "New Session"])
    await waitForWorkbenchTabCount(page, 2)
  }
  const tabs = await readWorkbenchTabs(page)
  if (tabs.length < 2) {
    skippedSamples.push(`workbench tab switch unavailable; only ${tabs.length} tab found`)
    return []
  }
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.selected))
  const inactiveIndex = tabs.findIndex((tab) => !tab.selected)
  if (inactiveIndex === -1) {
    skippedSamples.push("workbench tab switch unavailable; no inactive tab found")
    return []
  }
  const switchInactive = await measureWorkbenchTabClick(
    page,
    inactiveIndex,
    `switch already-open workbench tab ${tabs[inactiveIndex]?.text || inactiveIndex}`,
  )
  const switchBack = await measureWorkbenchTabClick(
    page,
    activeIndex,
    `switch back already-open workbench tab ${tabs[activeIndex]?.text || activeIndex}`,
  )
  return [switchInactive, switchBack]
}

async function ensureCompactSwitcherAvailable(page: Page) {
  if (await page.locator('[data-testid="compact-switcher-tab"]').count()) return true
  await clickVisibleButtonIfAvailable(page, "Pin sidebar")
  await page.waitForTimeout(200)
  return await page.locator('[data-testid="compact-switcher-tab"]').count() > 0
}

async function waitForWorkbenchTabCount(page: Page, minCount: number) {
  await page.waitForFunction(
    (minCount) => document.querySelectorAll('[data-testid="compact-switcher-tab"]').length >= minCount,
    minCount,
    { timeout: 5_000 },
  ).catch(() => {})
}

async function clickVisibleButtonIfAvailable(page: Page, label: string) {
  return await page.evaluate((label) => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((item) => {
        const rect = item.getBoundingClientRect()
        return item.getAttribute("aria-label") === label &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight
      })
    button?.click()
    return !!button
  }, label)
}

async function clickFirstVisibleNonSidebarButton(page: Page, labels: string[]) {
  const clicked = await page.evaluate((labels) => {
    const visible = (item: HTMLElement) => {
      const rect = item.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
    }
    for (const label of labels) {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .filter((item) => item.getAttribute("aria-label") === label && visible(item))
      const button = buttons.find((item) => !item.closest('[data-testid="rail-sidebar"]')) ?? buttons[0]
      if (!button) continue
      button.click()
      return label
    }
    return undefined
  }, labels)
  if (!clicked) throw new Error(`Visible button not found: ${labels.join(", ")}`)
}

async function measureWorkbenchTabClick(page: Page, index: number, name: string): Promise<TimingSample> {
  const baselineFrameMs = await waitForAnimationIdle(page)
  return await page.evaluate(async ({ index, name, baselineFrameMs, frameBudgetMs }) => {
    const readTabs = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="compact-switcher-tab"]'))
      .map((node, index) => ({
        index,
        text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
        selected: node.querySelector('button[aria-current="page"]') !== null,
      }))
    const readWorkspaceTabs = () => Array.from(document.querySelectorAll<HTMLElement>("[data-workspace-tab-id]"))
      .filter((node) => node.getAttribute("data-workspace-tab-kind"))
      .map((node) => ({
        id: node.getAttribute("data-workspace-tab-id"),
        kind: node.getAttribute("data-workspace-tab-kind"),
        text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
        selected: node.querySelector('button[aria-selected="true"]') !== null,
      }))
    const targetTab = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="compact-switcher-tab"]'))[index]
    const target = targetTab?.querySelector<HTMLElement>('button[aria-label]')
    if (!target) throw new Error(`Missing workbench tab target ${index}`)

    const selected = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid="compact-switcher-tab"]'))[index]
        ?.querySelector('button[aria-current="page"]') !== null
    const start = performance.now()
    target.click()
    let microtaskMs = performance.now() - start
    for (let i = 0; i < 8; i++) {
      await Promise.resolve()
      microtaskMs = performance.now() - start
      if (selected()) break
    }

    const frameDeltas: number[] = []
    let previous = performance.now()
    let firstFrameMs = 0
    let stableFrameMs = 0
    await new Promise<void>((resolve) => {
      let stableFrames = 0
      const tick = () => {
        const now = performance.now()
        frameDeltas.push(now - previous)
        previous = now
        if (!firstFrameMs) firstFrameMs = now - start
        stableFrames = selected() ? stableFrames + 1 : 0
        if (stableFrames >= 1 || now - start > 1_000) {
          stableFrameMs = now - start
          resolve()
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const maxFrameDeltaMs = Math.max(0, ...frameDeltas)
    const unexpectedBudgetMs = Math.max(baselineFrameMs, frameBudgetMs) + 1
    const unexpectedFrameDeltas = frameDeltas.filter((delta) => delta > unexpectedBudgetMs)
    return {
      name,
      baselineFrameMs,
      microtaskMs,
      firstFrameMs,
      stableFrameMs,
      frameDeltas,
      maxFrameDeltaMs,
      framesOver120HzBudget: frameDeltas.filter((delta) => delta > 8.33).length,
      framesOver60HzBudget: frameDeltas.filter((delta) => delta > 16.67).length,
      framesOverUnexpectedBudget: unexpectedFrameDeltas.length,
      maxUnexpectedFrameDeltaMs: Math.max(0, ...unexpectedFrameDeltas),
      tabs: readWorkspaceTabs(),
      workbenchTabs: readTabs(),
    }
  }, { index, name, baselineFrameMs, frameBudgetMs }) as TimingSample
}

async function measureClick(
  page: Page,
  input: { name: string; selector: string; selectedLabel: string; waitForGone?: string },
): Promise<TimingSample> {
  const baselineFrameMs = await waitForAnimationIdle(page)
  return await page.evaluate(async (input) => {
    const readTabs = () => Array.from(document.querySelectorAll<HTMLElement>("[data-workspace-tab-id]"))
      .filter((node) => node.getAttribute("data-workspace-tab-kind"))
      .map((node) => ({
        id: node.getAttribute("data-workspace-tab-id"),
        kind: node.getAttribute("data-workspace-tab-kind"),
        text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
        selected: node.querySelector('button[aria-selected="true"]') !== null,
      }))
    const selectedText = () =>
      document.querySelector('[data-testid="workspace-tab-header"] button[aria-selected="true"]')
        ?.textContent?.replace(/\s+/g, " ").trim() ?? ""
    const target = document.querySelector<HTMLElement>(input.selector)
    if (!target) throw new Error(`Missing click target ${input.selector}`)

    const start = performance.now()
    target.click()
    let microtaskMs = performance.now() - start
    for (let i = 0; i < 8; i++) {
      await Promise.resolve()
      microtaskMs = performance.now() - start
      const gone = input.waitForGone ? !document.querySelector(input.waitForGone) : true
      if (selectedText() === input.selectedLabel && gone) break
    }

    const frameDeltas: number[] = []
    let previous = performance.now()
    let firstFrameMs = 0
    let stableFrameMs = 0
    await new Promise<void>((resolve) => {
      let stableFrames = 0
      const tick = () => {
        const now = performance.now()
        frameDeltas.push(now - previous)
        previous = now
        if (!firstFrameMs) firstFrameMs = now - start
        const gone = input.waitForGone ? !document.querySelector(input.waitForGone) : true
        if (selectedText() === input.selectedLabel && gone) stableFrames += 1
        else stableFrames = 0
        if (stableFrames >= 1 || now - start > 1_000) {
          stableFrameMs = now - start
          resolve()
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const maxFrameDeltaMs = Math.max(0, ...frameDeltas)
    const unexpectedBudgetMs = Math.max(input.baselineFrameMs, input.frameBudgetMs) + 1
    const unexpectedFrameDeltas = frameDeltas.filter((delta) => delta > unexpectedBudgetMs)
    return {
      name: input.name,
      baselineFrameMs: input.baselineFrameMs,
      microtaskMs,
      firstFrameMs,
      stableFrameMs,
      frameDeltas,
      maxFrameDeltaMs,
      framesOver120HzBudget: frameDeltas.filter((delta) => delta > 8.33).length,
      framesOver60HzBudget: frameDeltas.filter((delta) => delta > 16.67).length,
      framesOverUnexpectedBudget: unexpectedFrameDeltas.length,
      maxUnexpectedFrameDeltaMs: Math.max(0, ...unexpectedFrameDeltas),
      tabs: readTabs(),
    }
  }, { ...input, baselineFrameMs, frameBudgetMs })
}

async function readTabs(page: Page): Promise<TabSnapshot[]> {
  return await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[data-workspace-tab-id]"))
    .filter((node) => node.getAttribute("data-workspace-tab-kind"))
    .map((node) => ({
      id: node.getAttribute("data-workspace-tab-id"),
      kind: node.getAttribute("data-workspace-tab-kind"),
      text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
      selected: node.querySelector('button[aria-selected="true"]') !== null,
    })))
}

async function readWorkbenchTabs(page: Page): Promise<WorkbenchSnapshot[]> {
  return await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="compact-switcher-tab"]'))
    .map((node, index) => ({
      index,
      text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
      selected: node.querySelector('button[aria-current="page"]') !== null,
    })))
}

async function closeContextAndSaveVideo(context: BrowserContext, page: Page) {
  const video = page.video()
  await page.close().catch(() => {})
  await context.close().catch(() => {})
  const raw = video ? await video.path().catch(() => undefined) : undefined
  if (!raw) return undefined
  const target = path.join(RESULT_DIR, "workspace-tab-motion.webm")
  await Bun.$`mv ${raw} ${target}`
  return target
}

async function waitForAnimationIdle(page: Page) {
  return await page.evaluate(() => new Promise<number>((resolve) => {
    requestAnimationFrame((first) => requestAnimationFrame((second) => resolve(second - first)))
  }))
}
