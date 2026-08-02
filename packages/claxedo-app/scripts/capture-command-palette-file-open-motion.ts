import { chromium, type BrowserContext, type Page } from "playwright-core"
import path from "node:path"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..")
const RESULT_DIR = path.resolve(
  Bun.env.CLAXEDO_COMMAND_PALETTE_FILE_OPEN_DIR ?? path.join(PACKAGE_DIR, "test-results/workspace-panel-motion"),
)
const RAW_VIDEO_DIR = path.join(Bun.env.TMPDIR ?? "/tmp", `claxedo-command-palette-file-open-raw-${Date.now()}`)
const baseURL = Bun.env.CLAXEDO_COMMAND_PALETTE_FILE_OPEN_URL ??
  `http://localhost:4445/w/${encodeURIComponent(REPO_ROOT)}/session`
const viewport = { width: 1280, height: 800 }
const targetFile = "packages/claxedo-app/package.json"
const query = "package.json"

type FetchLogEntry = {
  url: string
  atMs: number
  stack?: string
}

type ReviewLoadLogEntry = {
  atMs: number
  detail: unknown
}

type Snapshot = {
  name: string
  atMs: number
  workbenchX: number
  workbenchWidth: number
  panelOpen: boolean
  panelX: number
  panelWidth: number
  panelAvailableWidth: number
  panelAvailableRatio: number
  panelViewportRatio: number
  panelOpacity: number
  navigatorOpen: boolean
  navigatorX: number
  navigatorWidth: number
  navigatorOpacity: number
  fileTreeRowCount: number
  fileTreeTextLength: number
  fileTreeLoading: boolean
  selectedTabKind: string | null
  selectedTabText: string
  failedFileToasts: number
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
    id: "command-palette-file-open-user",
    primaryEmailAddress: { emailAddress: "command-palette-file-open@claxedo.test" },
    fullName: "Command Palette File Open",
  }
  w.__CLAXEDO_FETCH_LOG__ = []
  w.__CLAXEDO_REVIEW_LOAD_LOG__ = []
  window.addEventListener("claxedo:review-vcs-load", (event) => {
    ;(w.__CLAXEDO_REVIEW_LOAD_LOG__ as ReviewLoadLogEntry[]).push({
      atMs: performance.now(),
      detail: event instanceof CustomEvent ? event.detail : undefined,
    })
  })
  const originalFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    ;(w.__CLAXEDO_FETCH_LOG__ as FetchLogEntry[]).push({
      url,
      atMs: performance.now(),
      ...(/\/session\?/.test(url) && /[?&]directory=(?:workspace%3A)?[0-9a-f-]{36}(?:&|$)/i.test(url)
        ? { stack: new Error().stack }
        : {}),
    })
    return originalFetch(input, init)
  }) as typeof window.fetch
})

const page = await context.newPage()
const consoleErrors: string[] = []
const pageErrors: string[] = []
const badResponses: string[] = []
const badRequestInitiators: unknown[] = []
const cdp = await context.newCDPSession(page)
await cdp.send("Network.enable")
cdp.on("Network.requestWillBeSent", (event) => {
  const url = String(event.request?.url ?? "")
  if (/\/session\?/.test(url) && /[?&]directory=(?:workspace%3A)?[0-9a-f-]{36}(?:&|$)/i.test(url)) {
    badRequestInitiators.push({
      url,
      initiator: event.initiator,
    })
  }
})
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text())
})
page.on("pageerror", (error) => pageErrors.push(error.message))
page.on("response", (response) => {
  if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`)
})

const artifact: Record<string, unknown> = {
  baseURL,
  viewport,
  query,
  targetFile,
  capturedAt: new Date().toISOString(),
}

try {
  await waitForApp(page)
  await ensureWorkspacePanelOpen(page)
  await ensureNavigatorOpen(page, "Files")
  await waitForFilesOverlayReady(page)
  await page.waitForTimeout(180)
  const startAt = await page.evaluate(() => performance.now())
  const baseline = await sample(page, "baseline", startAt)

  await page.keyboard.press(process.platform === "darwin" ? "Meta+P" : "Control+P")
  await page.locator('input[placeholder="Search files, commands, and sessions"]').waitFor({ state: "visible", timeout: 5_000 })
  await page.locator('input[placeholder="Search files, commands, and sessions"]').fill("")
  await page.keyboard.type(query, { delay: 20 })
  await page.waitForSelector(`[data-slot="list-item"][data-key="file:${targetFile}"]`, { timeout: 10_000 })

  const beforeSelect = await sample(page, "before command-palette file select", startAt)
  const beforeLog = await readLogs(page)
  const timing = await clickFileResultAndMeasure(page, targetFile)
  const afterSelect = await sample(page, "after command-palette file select", startAt)
  await page.waitForTimeout(350)
  const final = await sample(page, "final", startAt)
  const afterLog = await readLogs(page)
  const screenshot = path.join(RESULT_DIR, "command-palette-file-open-final.png")
  await page.screenshot({ path: screenshot })

  const snapshots = [baseline, beforeSelect, afterSelect, final]
  const stableWorkbench = snapshots.every((item) =>
    Math.abs(item.workbenchX - baseline.workbenchX) <= 1 &&
    Math.abs(item.workbenchWidth - baseline.workbenchWidth) <= 1
  )
  const stablePanel = snapshots.every((item) =>
    item.panelOpen &&
    Math.abs(item.panelX - baseline.panelX) <= 1 &&
    Math.abs(item.panelWidth - baseline.panelWidth) <= 1
  )
  const defaultPanelWidthPass = snapshots.every((item) =>
    item.panelOpen &&
    Math.abs(item.panelAvailableRatio - 0.7) <= 0.02
  )
  const stableNavigator = snapshots.every((item) =>
    item.navigatorOpen &&
    Math.abs(item.navigatorX - baseline.navigatorX) <= 1 &&
    Math.abs(item.navigatorWidth - baseline.navigatorWidth) <= 1
  )
  const fileTreeStable = snapshots.every((item) =>
    !item.fileTreeLoading &&
    item.fileTreeTextLength > 0 &&
    item.fileTreeTextLength >= Math.floor(baseline.fileTreeTextLength * 0.9)
  )
  const fileListFetchUrls = afterLog.fetch
    .slice(beforeLog.fetch.length)
    .filter((entry) => /\/file\?/.test(entry.url) && /[?&]path=($|&)/.test(entry.url))
    .map((entry) => entry.url)
  const reviewLoadDelta = afterLog.review.length - beforeLog.review.length
  const badSessionListFetches = afterLog.fetch
    .filter((entry) => /\/session\?/.test(entry.url) && /[?&]directory=(?:workspace%3A)?[0-9a-f-]{36}(?:&|$)/i.test(entry.url))
  const selectedFileTab = final.selectedTabKind === "file" && final.selectedTabText.includes("package.json")
  artifact.snapshots = snapshots
  artifact.timing = timing
  artifact.fileListFetchUrls = fileListFetchUrls
  artifact.badSessionListFetches = badSessionListFetches
  artifact.reviewLoadDelta = reviewLoadDelta
  artifact.stableWorkbench = stableWorkbench
  artifact.stablePanel = stablePanel
  artifact.defaultPanelWidthPass = defaultPanelWidthPass
  artifact.stableNavigator = stableNavigator
  artifact.fileTreeStable = fileTreeStable
  artifact.selectedFileTab = selectedFileTab
  artifact.finalScreenshot = screenshot
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
  artifact.badResponses = badResponses
  artifact.badRequestInitiators = badRequestInitiators
  artifact.pass = (
    stableWorkbench &&
    stablePanel &&
    defaultPanelWidthPass &&
    stableNavigator &&
    fileTreeStable &&
    selectedFileTab &&
    fileListFetchUrls.length === 0 &&
    reviewLoadDelta === 0 &&
    snapshots.every((item) => item.failedFileToasts === 0) &&
    timing.microtaskMs <= 12 &&
    consoleErrors.length === 0 &&
    pageErrors.length === 0 &&
    badResponses.length === 0 &&
    badSessionListFetches.length === 0
  )
} catch (error) {
  artifact.pass = false
  artifact.error = error instanceof Error ? error.message : String(error)
  artifact.failureUrl = page.url()
  artifact.failureTitle = await page.title().catch(() => "")
  artifact.failureBody = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "")
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
  artifact.badResponses = badResponses
  artifact.badRequestInitiators = badRequestInitiators
} finally {
  const videoPath = await closeContextAndSaveVideo(context, page)
  artifact.video = videoPath
  await browser.close()
  await Bun.write(
    path.join(RESULT_DIR, "command-palette-file-open-manifest.json"),
    JSON.stringify(artifact, null, 2) + "\n",
  )
}

if (!artifact.pass) {
  throw new Error(`Command palette file-open motion failed; see ${path.join(RESULT_DIR, "command-palette-file-open-manifest.json")}`)
}

console.log(`Command palette file-open motion passed: ${path.join(RESULT_DIR, "command-palette-file-open-manifest.json")}`)

async function waitForApp(page: Page) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" })
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})
  await page.locator('[data-testid="workspace-panel-shell"]').waitFor({ state: "attached", timeout: 20_000 })
}

async function ensureWorkspacePanelOpen(page: Page) {
  if (await panelOpen(page)) {
    await waitForPanelRestingOpen(page)
    return
  }
  await clickVisibleButton(page, "Open workspace panel")
  await page.waitForFunction(() =>
    document.querySelector<HTMLElement>('[data-testid="workspace-panel-shell"]')?.dataset.open === "true",
    { timeout: 2_000 },
  )
  await waitForPanelRestingOpen(page)
}

async function ensureNavigatorOpen(page: Page, label: "Files") {
  if (await navigatorOpen(page, "files")) return
  await clickVisibleButton(page, `Open ${label}`)
  await page.waitForFunction((navigator) =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-navigator-overlay"]'))
      .some((item) => item.dataset.navigator === navigator && item.dataset.open === "true"),
    label.toLowerCase(),
    { timeout: 2_000 },
  )
}

async function waitForFilesOverlayReady(page: Page) {
  await page.waitForFunction(() => {
    const overlay = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-navigator-overlay"]'))
      .find((item) => item.dataset.navigator === "files" && item.dataset.open === "true")
    const fileTree = overlay?.querySelector<HTMLElement>('[data-component="filetree"]')
    return !!fileTree &&
      !overlay?.querySelector('[data-file-tree-loading]') &&
      (fileTree.textContent?.trim().length ?? 0) > 0
  }, { timeout: 20_000 })
}

async function panelOpen(page: Page) {
  return await page.locator('[data-testid="workspace-panel-shell"]').getAttribute("data-open") === "true"
}

async function waitForPanelRestingOpen(page: Page) {
  await page.waitForFunction(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="workspace-panel-shell"]')
    if (!panel) return false
    const rect = panel.getBoundingClientRect()
    return Math.max(0, rect.left - (window.innerWidth - rect.width)) <= Math.max(2, rect.width * 0.01)
  }, { timeout: 2_000 })
}

async function navigatorOpen(page: Page, navigator: "files") {
  return await page.evaluate((navigator) =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-navigator-overlay"]'))
      .some((item) => item.dataset.navigator === navigator && item.dataset.open === "true"),
    navigator,
  )
}

async function clickVisibleButton(page: Page, label: string) {
  const clicked = await page.evaluate((label) => {
    const button = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find((item) => {
        const rect = item.getBoundingClientRect()
        const style = getComputedStyle(item)
        return item.getAttribute("aria-label") === label &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.left < window.innerWidth &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.pointerEvents !== "none" &&
          Number(style.opacity || "1") > 0.01
      })
    button?.click()
    return !!button
  }, label)
  if (!clicked) {
    const available = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("button"))
      .map((item) => {
        const rect = item.getBoundingClientRect()
        return {
          label: item.getAttribute("aria-label"),
          text: item.textContent?.replace(/\s+/g, " ").trim(),
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          opacity: getComputedStyle(item).opacity,
          pointerEvents: getComputedStyle(item).pointerEvents,
        }
      })
      .filter((item) => item.label || item.text)
      .slice(0, 30))
    throw new Error(`${label} button was not available; available=${JSON.stringify(available)}`)
  }
}

async function sample(page: Page, name: string, startAt: number): Promise<Snapshot> {
  return await page.evaluate(({ name, startAt }) => {
    const rectSnapshot = (element: HTMLElement | null) => {
      if (!element) return { x: 0, width: 0, opacity: 0 }
      const rect = element.getBoundingClientRect()
      return {
        x: rect.left,
        width: rect.width,
        opacity: Number(getComputedStyle(element).opacity || "1"),
      }
    }
    const workbench = rectSnapshot(document.querySelector<HTMLElement>('[data-testid="workbench-column"]'))
    const panelEl = document.querySelector<HTMLElement>('[data-testid="workspace-panel-shell"]')
    const panel = rectSnapshot(panelEl)
    const panelAvailableWidth = panelEl?.parentElement?.getBoundingClientRect().width || window.innerWidth
    const navigatorEl = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-navigator-overlay"]'))
      .find((item) => item.dataset.navigator === "files" && item.dataset.open === "true") ?? null
    const navigator = rectSnapshot(navigatorEl)
    const fileTree = navigatorEl?.querySelector<HTMLElement>('[data-component="filetree"]') ?? null
    const selected = document.querySelector<HTMLElement>('[data-workspace-tab-id]:has(button[aria-selected="true"])')
    const bodyText = document.body.textContent ?? ""
    return {
      name,
      atMs: performance.now() - startAt,
      workbenchX: workbench.x,
      workbenchWidth: workbench.width,
      panelOpen: panelEl?.dataset.open === "true",
      panelX: panel.x,
      panelWidth: panel.width,
      panelAvailableWidth,
      panelAvailableRatio: panelAvailableWidth > 0 ? panel.width / panelAvailableWidth : 0,
      panelViewportRatio: panel.width / window.innerWidth,
      panelOpacity: panel.opacity,
      navigatorOpen: !!navigatorEl,
      navigatorX: navigator.x,
      navigatorWidth: navigator.width,
      navigatorOpacity: navigator.opacity,
      fileTreeRowCount: navigatorEl?.querySelectorAll('[data-file-tree-path]').length ?? 0,
      fileTreeTextLength: fileTree?.textContent?.trim().length ?? 0,
      fileTreeLoading: !!navigatorEl?.querySelector('[data-file-tree-loading]'),
      selectedTabKind: selected?.getAttribute("data-workspace-tab-kind") ?? null,
      selectedTabText: selected?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      failedFileToasts: (bodyText.match(/Failed to list files|CancelledError/g) ?? []).length,
    }
  }, { name, startAt })
}

async function clickFileResultAndMeasure(page: Page, file: string) {
  return await page.evaluate(async (file) => {
    const target = document.querySelector<HTMLElement>(`[data-slot="list-item"][data-key="file:${file}"]`)
    if (!target) throw new Error(`Missing command palette file result for ${file}`)
    const start = performance.now()
    target.click()
    let microtaskMs = performance.now() - start
    for (let i = 0; i < 8; i++) {
      await Promise.resolve()
      microtaskMs = performance.now() - start
      const selected = document.querySelector<HTMLElement>('[data-workspace-tab-kind="file"]:has(button[aria-selected="true"])')
      if (selected?.textContent?.includes("package.json")) break
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
        const selected = document.querySelector<HTMLElement>('[data-workspace-tab-kind="file"]:has(button[aria-selected="true"])')
        stableFrames = selected?.textContent?.includes("package.json") ? stableFrames + 1 : 0
        if (stableFrames >= 2 || now - start > 1_000) {
          stableFrameMs = now - start
          resolve()
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return {
      microtaskMs,
      firstFrameMs,
      stableFrameMs,
      frameDeltas,
      maxFrameDeltaMs: Math.max(0, ...frameDeltas),
      framesOver120HzBudget: frameDeltas.filter((delta) => delta > 8.33).length,
      framesOver60HzBudget: frameDeltas.filter((delta) => delta > 16.67).length,
    }
  }, file)
}

async function readLogs(page: Page) {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __CLAXEDO_FETCH_LOG__?: FetchLogEntry[]
      __CLAXEDO_REVIEW_LOAD_LOG__?: ReviewLoadLogEntry[]
    }
    return {
      fetch: [...(w.__CLAXEDO_FETCH_LOG__ ?? [])],
      review: [...(w.__CLAXEDO_REVIEW_LOAD_LOG__ ?? [])],
    }
  })
}

async function closeContextAndSaveVideo(context: BrowserContext, page: Page) {
  const video = page.video()
  await page.close().catch(() => {})
  await context.close().catch(() => {})
  const raw = video ? await video.path().catch(() => undefined) : undefined
  if (!raw) return undefined
  const target = path.join(RESULT_DIR, "command-palette-file-open.webm")
  await Bun.$`mv ${raw} ${target}`
  return target
}
