import { chromium, type BrowserContext, type Page } from "playwright-core"
import path from "node:path"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..")
const RESULT_DIR = path.resolve(
  Bun.env.CLAXEDO_APP_SHELL_MOTION_DIR ?? path.join(PACKAGE_DIR, "test-results/workspace-panel-motion"),
)
const RAW_VIDEO_DIR = path.join(Bun.env.TMPDIR ?? "/tmp", `claxedo-app-shell-motion-raw-${Date.now()}`)
const baseURL = Bun.env.CLAXEDO_APP_SHELL_MOTION_URL ??
  `http://localhost:4445/w/${encodeURIComponent(REPO_ROOT)}/session`
const viewport = { width: 1280, height: 800 }
const frameBudgetMs = 8.33
const longFrameBudgetMs = 16.67
const rapidClickDelayMs = 20
const interruptedFrameBudgetMs = rapidClickDelayMs * 2 + Math.max(longFrameBudgetMs, 18)

type ShellSnapshot = {
  name: string
  atMs: number
  workbenchX: number
  workbenchWidth: number
  sidebarX: number
  sidebarWidth: number
  sidebarOpacity: number
  panelOpen: boolean
  panelX: number
  panelWidth: number
  panelOpacity: number
  navigatorOpen: boolean
  navigatorX: number
  navigatorWidth: number
  navigatorOpacity: number
  reviewRootVisible: boolean
  reviewLoading: boolean
  reviewTextLength: number
  failedFileToasts: number
  fileTreeRowCount: number
  fileTreeFileCount: number
  fileTreeTextLength: number
  fileTreeLoading: boolean
  firstFileTreeRows: string[]
  firstFilePaths: string[]
}

type InteractionSample = {
  name: string
  interruptionBudgetMs: number
  microtaskMs: number
  clickTimings: Array<{ label: string; ms: number }>
  frameDeltas: number[]
  maxFrameDeltaMs: number
  framesOver120HzBudget: number
  framesOver60HzBudget: number
  framesOverInterruptionBudget: number
  maxUnexpectedFrameDeltaMs: number
  snapshots: ShellSnapshot[]
  reviewFetchDelta: number
  reviewFetchUrls: string[]
  reviewLoadDetails: unknown[]
  fileListFetchDelta: number
  fileListFetchUrls: string[]
}

type FetchLogEntry = {
  url: string
  atMs: number
}

type ReviewLoadLogEntry = {
  atMs: number
  detail: unknown
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
    id: "app-shell-motion-user",
    primaryEmailAddress: { emailAddress: "app-shell-motion@claxedo.test" },
    fullName: "App Shell Motion",
  }
  w.__CLAXEDO_FETCH_LOG__ = []
  w.__CLAXEDO_REVIEW_LOAD_LOG__ = []
  window.addEventListener("claxedo:review-vcs-load", (event) => {
    ;(w.__CLAXEDO_REVIEW_LOAD_LOG__ as ReviewLoadLogEntry[]).push({
      atMs: performance.now(),
      detail: event instanceof CustomEvent ? event.detail : undefined,
    })
  })
  const visible = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.left < window.innerWidth &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.pointerEvents !== "none" &&
      Number(style.opacity || "1") > 0.01
  }
  const rectSnapshot = (element: HTMLElement | null) => {
    if (!element) return { x: 0, width: 0, opacity: 0 }
    const rect = element.getBoundingClientRect()
    return {
      x: rect.left,
      width: rect.width,
      opacity: Number(getComputedStyle(element).opacity || "1"),
    }
  }
  const buttonsByLabel = (label: string) => {
    const escaped = globalThis.CSS?.escape ? CSS.escape(label) : label.replaceAll('"', '\\"')
    return Array.from(document.querySelectorAll<HTMLButtonElement>(`button[aria-label="${escaped}"]`))
  }
  const buttonVisibleFast = (button: HTMLElement) => {
    const rect = button.getBoundingClientRect()
    const style = getComputedStyle(button)
    return rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.left < window.innerWidth &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.pointerEvents !== "none" &&
      Number(style.opacity || "1") > 0.01 &&
      !button.closest('[hidden], [aria-hidden="true"]')
  }
  w.__CLAXEDO_HAS_VISIBLE_BUTTON__ = (label: string) =>
    buttonsByLabel(label).some(buttonVisibleFast)
  w.__CLAXEDO_CLICK_VISIBLE_BUTTON__ = (label: string) => {
    const button = buttonsByLabel(label).find((item) => {
      if (!buttonVisibleFast(item)) return false
      const parentPanel = item.closest<HTMLElement>('[data-testid="workspace-panel-shell"]')
      if (!parentPanel) return true
      return parentPanel.dataset.open === "true" && buttonVisibleFast(parentPanel)
    }) ?? buttonsByLabel(label).find(buttonVisibleFast)
    button?.click()
    return !!button
  }
  w.__CLAXEDO_READ_SHELL_SNAPSHOT__ = (name: string, startAt: number) => {
    const workbench = rectSnapshot(document.querySelector<HTMLElement>('[data-testid="workbench-column"]'))
    const sidebar = rectSnapshot(document.querySelector<HTMLElement>('[data-testid="rail-sidebar"]'))
    const panelEl = document.querySelector<HTMLElement>('[data-testid="workspace-panel-shell"]')
    const panel = rectSnapshot(panelEl)
    const navigatorEl = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-navigator-overlay"]'))
      .find((item) => item.dataset.navigator === "files" && item.dataset.open === "true") ?? null
    const navigator = rectSnapshot(navigatorEl)
    const reviewRoot = document.querySelector<HTMLElement>('[data-testid="review-pane-root"]')
    const fileTree = navigatorEl?.querySelector<HTMLElement>('[data-component="filetree"]') ?? null
    const bodyText = document.body.textContent ?? ""
    return {
      name,
      atMs: performance.now() - startAt,
      workbenchX: workbench.x,
      workbenchWidth: workbench.width,
      sidebarX: sidebar.x,
      sidebarWidth: sidebar.width,
      sidebarOpacity: sidebar.opacity,
      panelOpen: panelEl?.dataset.open === "true",
      panelX: panel.x,
      panelWidth: panel.width,
      panelOpacity: panel.opacity,
      navigatorOpen: !!navigatorEl,
      navigatorX: navigator.x,
      navigatorWidth: navigator.width,
      navigatorOpacity: navigator.opacity,
      reviewRootVisible: !!reviewRoot && visible(reviewRoot),
      reviewLoading: !!document.querySelector('[data-testid="review-pane-loading"]'),
      reviewTextLength: reviewRoot?.textContent?.trim().length ?? 0,
      failedFileToasts: (bodyText.match(/Failed to list files|CancelledError/g) ?? []).length,
      fileTreeRowCount: navigatorEl?.querySelectorAll('[data-file-tree-row]').length ?? 0,
      fileTreeFileCount: navigatorEl?.querySelectorAll('[data-file-tree-path]').length ?? 0,
      fileTreeTextLength: fileTree?.textContent?.trim().length ?? 0,
      fileTreeLoading: !!navigatorEl?.querySelector('[data-file-tree-loading]'),
      firstFileTreeRows: Array.from(navigatorEl?.querySelectorAll<HTMLElement>('[data-file-tree-row]') ?? [])
        .slice(0, 10)
        .map((node) => node.getAttribute("data-file-tree-row") ?? node.textContent?.trim() ?? ""),
      firstFilePaths: Array.from(navigatorEl?.querySelectorAll<HTMLElement>('[data-file-tree-path]') ?? [])
        .slice(0, 10)
        .map((node) => node.getAttribute("data-file-tree-path") ?? node.textContent?.trim() ?? ""),
    }
  }
  const originalFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    ;(w.__CLAXEDO_FETCH_LOG__ as FetchLogEntry[]).push({ url, atMs: performance.now() })
    return originalFetch(input, init)
  }) as typeof window.fetch
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
  rapidClickDelayMs,
  interruptedFrameBudgetMs,
  capturedAt: new Date().toISOString(),
}

try {
  await waitForApp(page)
  await ensureWorkspacePanelOpen(page)
  await ensureNavigatorOpen(page, "Files")
  await waitForFileNavigatorWarm(page)
  await ensureNavigatorClosed(page, "Files")
  await waitForReviewSettled(page)
  const baseline = await sampleShell(page, "baseline", await page.evaluate(() => performance.now()))

  const files = await measureSequence(page, "filetree overlay interrupted open-close-open", [
    { label: "Open Files" },
    { waitMs: rapidClickDelayMs },
    { label: "Close Files" },
    { waitMs: rapidClickDelayMs },
    { label: "Open Files" },
  ])
  await page.waitForTimeout(180)
  await ensureNavigatorClosed(page, "Files")

  const panel = await measureSequence(page, "workspace panel interrupted close-open-close-open", [
    { label: "Close workspace panel" },
    { waitMs: rapidClickDelayMs },
    { label: "Open workspace panel" },
    { waitMs: rapidClickDelayMs },
    { label: "Close workspace panel" },
    { waitMs: rapidClickDelayMs },
    { label: "Open workspace panel" },
  ])
  await waitForReviewSettled(page)

  const sidebar = await measureSequence(page, "sidebar interrupted close-open-close-open", [
    { label: "Pin sidebar" },
    { waitMs: rapidClickDelayMs },
    { label: "Show Sidebar" },
    { waitMs: rapidClickDelayMs },
    { label: "Pin sidebar" },
    { waitMs: rapidClickDelayMs },
    { label: "Show Sidebar" },
  ])

  const final = await sampleShell(page, "final", await page.evaluate(() => performance.now()))
  const screenshot = path.join(RESULT_DIR, "app-shell-motion-final.png")
  await page.screenshot({ path: screenshot })
  const samples = [files, panel, sidebar]
  const reviewStable = [baseline, final, ...samples.flatMap((sample) => sample.snapshots)].every((sample) =>
    sample.reviewRootVisible &&
    !sample.reviewLoading &&
    sample.reviewTextLength > 0 &&
    sample.failedFileToasts === 0
  )
  const workbenchStable = [baseline, final, ...files.snapshots, ...sidebar.snapshots].every((sample) =>
    Math.abs(sample.workbenchX - baseline.workbenchX) <= 1 &&
    Math.abs(sample.workbenchWidth - baseline.workbenchWidth) <= 1
  ) && panel.snapshots.every((sample) => {
    if (!sample.panelOpen) return sample.workbenchWidth >= baseline.workbenchWidth
    return Math.abs(sample.workbenchX - baseline.workbenchX) <= 1 &&
      sample.workbenchWidth <= baseline.workbenchWidth + 1
  })
  const sidebarContentStable = [baseline, final, ...sidebar.snapshots].every((sample) =>
    sample.reviewRootVisible &&
    sample.reviewTextLength > 0 &&
    sample.failedFileToasts === 0
  )
  const noReviewRefetchDuringToggles = samples.every((sample) => sample.reviewFetchDelta === 0)
  const filetreeWarmAfterToggle = (files.snapshots.at(-1)?.fileTreeRowCount ?? 0) > 0 &&
    (files.snapshots.at(-1)?.fileTreeTextLength ?? 0) > 0 &&
    !files.snapshots.at(-1)?.fileTreeLoading
  const frameBudgetPass = samples.every((sample) =>
    sample.microtaskMs <= frameBudgetMs &&
    sample.maxUnexpectedFrameDeltaMs === 0
  )
  const integrityPass = (
    reviewStable &&
    workbenchStable &&
    sidebarContentStable &&
    noReviewRefetchDuringToggles &&
    filetreeWarmAfterToggle &&
    frameBudgetPass &&
    samples.every((sample) => sample.microtaskMs <= 12) &&
    consoleErrors.length === 0 &&
    pageErrors.length === 0
  )
  artifact.baseline = baseline
  artifact.final = final
  artifact.samples = samples
  artifact.reviewStable = reviewStable
  artifact.workbenchStable = workbenchStable
  artifact.sidebarContentStable = sidebarContentStable
  artifact.noReviewRefetchDuringToggles = noReviewRefetchDuringToggles
  artifact.filetreeWarmAfterToggle = filetreeWarmAfterToggle
  artifact.frameBudgetPass = frameBudgetPass
  artifact.integrityPass = integrityPass
  artifact.finalScreenshot = screenshot
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
  artifact.pass = integrityPass
} catch (error) {
  artifact.pass = false
  artifact.error = error instanceof Error ? error.message : String(error)
  artifact.failureUrl = page.url()
  artifact.failureTitle = await page.title().catch(() => "")
  artifact.failureBody = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "")
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
} finally {
  const videoPath = await closeContextAndSaveVideo(context, page)
  artifact.video = videoPath
  await browser.close()
  await Bun.write(path.join(RESULT_DIR, "app-shell-motion-manifest.json"), JSON.stringify(artifact, null, 2) + "\n")
}

if (!artifact.pass) {
  throw new Error(`App shell motion capture failed; see ${path.join(RESULT_DIR, "app-shell-motion-manifest.json")}`)
}

console.log(`App shell motion capture passed: ${path.join(RESULT_DIR, "app-shell-motion-manifest.json")}`)

async function waitForApp(page: Page) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" })
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})
  await page.locator('[data-testid="workbench-column"]').waitFor({ state: "attached", timeout: 20_000 })
  await page.locator('[data-testid="workspace-panel-shell"]').waitFor({ state: "attached", timeout: 20_000 })
}

async function ensureWorkspacePanelOpen(page: Page) {
  const open = await page.locator('[data-testid="workspace-panel-shell"]').getAttribute("data-open")
  if (open !== "true") {
    await clickVisibleButton(page, "Open workspace panel")
    await waitForPanelOpenState(page, true)
  }
  await waitForNavigatorControls(page)
}

async function waitForPanelOpenState(page: Page, open: boolean) {
  await page.waitForFunction((open) =>
    document.querySelector<HTMLElement>('[data-testid="workspace-panel-shell"]')?.dataset.open === String(open),
    open,
    { timeout: 2_000 },
  )
}

async function waitForNavigatorControls(page: Page) {
  await page.waitForFunction(() => {
    const helper = window as unknown as {
      __CLAXEDO_HAS_VISIBLE_BUTTON__: (label: string) => boolean
    }
    return helper.__CLAXEDO_HAS_VISIBLE_BUTTON__("Open Files") ||
      helper.__CLAXEDO_HAS_VISIBLE_BUTTON__("Close Files")
  }, undefined, { timeout: 3_000 })
}

async function waitForReviewSettled(page: Page) {
  await page.locator('[data-testid="review-pane-root"]').waitFor({ state: "visible", timeout: 20_000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid="review-pane-loading"]'), undefined, {
    timeout: 20_000,
  }).catch(() => {})
  await page.waitForTimeout(200)
}

async function ensureNavigatorClosed(page: Page, label: "Files" | "Changes" | "Processes") {
  if (!await hasVisibleButton(page, `Close ${label}`)) return
  await clickVisibleButton(page, `Close ${label}`)
  await page.waitForTimeout(180)
}

async function ensureNavigatorOpen(page: Page, label: "Files" | "Changes" | "Processes") {
  if (await hasVisibleButton(page, `Close ${label}`)) return
  await clickVisibleButton(page, `Open ${label}`)
}

async function waitForFileNavigatorWarm(page: Page) {
  await page.locator('[data-testid="workspace-files-navigator"][data-mode="files"]').waitFor({
    state: "attached",
    timeout: 20_000,
  })
  await page.waitForFunction(() => {
    const overlay = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-navigator-overlay"]'))
      .find((item) => item.dataset.navigator === "files" && item.dataset.open === "true")
    if (!overlay) return false
    if (overlay.querySelector('[data-file-tree-loading]')) return false
    return overlay.querySelectorAll('[data-file-tree-row]').length > 0 &&
      (overlay.querySelector<HTMLElement>('[data-component="filetree"]')?.textContent?.trim().length ?? 0) > 0
  }, undefined, { timeout: 20_000 })
}

async function hasVisibleButton(page: Page, label: string) {
  return await page.evaluate((label) =>
    (window as unknown as { __CLAXEDO_HAS_VISIBLE_BUTTON__: (label: string) => boolean })
      .__CLAXEDO_HAS_VISIBLE_BUTTON__(label),
    label,
  )
}

async function clickVisibleButton(page: Page, label: string) {
  const clicked = await page.evaluate((label) =>
    (window as unknown as { __CLAXEDO_CLICK_VISIBLE_BUTTON__: (label: string) => boolean })
      .__CLAXEDO_CLICK_VISIBLE_BUTTON__(label),
    label,
  )
  if (!clicked) throw new Error(`Visible button not found: ${label}`)
}

async function measureSequence(
  page: Page,
  name: string,
  steps: Array<{ label: string } | { waitMs: number }>,
): Promise<InteractionSample> {
  return await page.evaluate(async ({ name, steps, longFrameBudgetMs }) => {
    const helper = window as unknown as {
      __CLAXEDO_FETCH_LOG__?: FetchLogEntry[]
      __CLAXEDO_REVIEW_LOAD_LOG__?: ReviewLoadLogEntry[]
      __CLAXEDO_CLICK_VISIBLE_BUTTON__: (label: string) => boolean
      __CLAXEDO_READ_SHELL_SNAPSHOT__: (name: string, startAt: number) => ShellSnapshot
    }
    const fetchLog = () => helper.__CLAXEDO_FETCH_LOG__ ?? []
    const reviewLoadLog = () => helper.__CLAXEDO_REVIEW_LOAD_LOG__ ?? []
    const reviewFetches = () => fetchLog().filter((entry) => /vcs|review-vcs|diff/i.test(entry.url))
    const fileListFetches = () => fetchLog().filter((entry) =>
      /file.*list|\/file\/list|file\.list|\/file\?/i.test(entry.url)
    )
    const fileListFetchCount = () => fileListFetches().length
    const startReviewFetchCount = reviewLoadLog().length
    const startFileListFetchCount = fileListFetchCount()
    const snapshots: ShellSnapshot[] = []
    const frameDeltas: number[] = []
    const start = performance.now()
    let previous = start
    let running = true
    let microtaskMs = 0
    const clickTimings: Array<{ label: string; ms: number }> = []
    const frameLoop = new Promise<void>((resolve) => {
      const tick = () => {
        const now = performance.now()
        frameDeltas.push(now - previous)
        previous = now
        if (!running && frameDeltas.length >= 12) {
          resolve()
          return
        }
        if (now - start > 1_200) {
          resolve()
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    for (const step of steps) {
      if ("waitMs" in step) {
        await new Promise((resolve) => setTimeout(resolve, step.waitMs))
        continue
      }
      const clickStart = performance.now()
      if (!helper.__CLAXEDO_CLICK_VISIBLE_BUTTON__(step.label)) throw new Error(`Visible button not found: ${step.label}`)
      await Promise.resolve()
      const ms = performance.now() - clickStart
      clickTimings.push({ label: step.label, ms })
      microtaskMs = Math.max(microtaskMs, ms)
    }
    await new Promise((resolve) => setTimeout(resolve, 260))
    running = false
    await frameLoop
    snapshots.push(helper.__CLAXEDO_READ_SHELL_SNAPSHOT__(`${name} settled`, start))
    const maxFrameDeltaMs = Math.max(0, ...frameDeltas)
    const interruptionBudgetMs = steps.reduce((sum, step) => sum + ("waitMs" in step ? step.waitMs : 0), 0) +
      Math.max(longFrameBudgetMs, 18)
    const unexpectedFrameDeltas = frameDeltas.filter((delta) => delta > interruptionBudgetMs)
    return {
      name,
      interruptionBudgetMs,
      microtaskMs,
      clickTimings,
      frameDeltas,
      maxFrameDeltaMs,
      framesOver120HzBudget: frameDeltas.filter((delta) => delta > 8.33).length,
      framesOver60HzBudget: frameDeltas.filter((delta) => delta > 16.67).length,
      framesOverInterruptionBudget: unexpectedFrameDeltas.length,
      maxUnexpectedFrameDeltaMs: Math.max(0, ...unexpectedFrameDeltas),
      snapshots,
      reviewFetchDelta: reviewLoadLog().length - startReviewFetchCount,
      reviewFetchUrls: reviewFetches().map((entry) => entry.url),
      reviewLoadDetails: reviewLoadLog().slice(startReviewFetchCount).map((entry) => entry.detail),
      fileListFetchDelta: fileListFetchCount() - startFileListFetchCount,
      fileListFetchUrls: fileListFetches().slice(startFileListFetchCount).map((entry) => entry.url),
    }
  }, { name, steps, longFrameBudgetMs })
}

async function sampleShell(page: Page, name: string, startAt: number): Promise<ShellSnapshot> {
  return await page.evaluate(({ name, startAt }) =>
    (window as unknown as { __CLAXEDO_READ_SHELL_SNAPSHOT__: (name: string, startAt: number) => ShellSnapshot })
      .__CLAXEDO_READ_SHELL_SNAPSHOT__(name, startAt),
    { name, startAt },
  )
}

async function closeContextAndSaveVideo(context: BrowserContext, page: Page) {
  const video = page.video()
  await page.close().catch(() => {})
  await context.close().catch(() => {})
  const raw = video ? await video.path().catch(() => undefined) : undefined
  if (!raw) return undefined
  const target = path.join(RESULT_DIR, "app-shell-motion.webm")
  await Bun.$`mv ${raw} ${target}`
  return target
}
