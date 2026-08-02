import { chromium, type BrowserContext, type Page } from "playwright-core"
import path from "node:path"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..")
const RESULT_DIR = path.resolve(
  Bun.env.CLAXEDO_WORKSPACE_PANEL_MOTION_DIR ?? path.join(PACKAGE_DIR, "test-results/workspace-panel-motion"),
)
const RAW_VIDEO_DIR = path.join(RESULT_DIR, "raw")
const baseURL = Bun.env.CLAXEDO_WORKSPACE_PANEL_MOTION_URL ??
  `http://localhost:4445/w/${encodeURIComponent(REPO_ROOT)}/session`
const viewport = { width: 1280, height: 800 }
const smoothSampleDelayMs = 75
const rapidClickDelayMs = 20
const longFrameGapBudgetMs = Number(Bun.env.CLAXEDO_WORKSPACE_PANEL_MOTION_LONG_FRAME_MS ?? "80")
const visibleJumpFrameBudgetMs = Number(Bun.env.CLAXEDO_WORKSPACE_PANEL_MOTION_JUMP_FRAME_MS ?? "48")

type PanelSample = {
  name: string
  open: boolean
  x: number
  width: number
  workbenchX: number
  workbenchWidth: number
  opacity: number
  transform: string
  translate: string
  atMs: number
}

type MotionFrame = PanelSample & {
  frame: number
  frameDeltaMs: number
}

type MotionClick = {
  label: "Open workspace panel" | "Close workspace panel"
  sample: PanelSample
  atMs: number
  clicked: boolean
}

type MotionJump = {
  fromFrame: number
  toFrame: number
  fromX: number
  toX: number
  deltaX: number
  frameDeltaMs: number
}

type LongFrameGap = {
  frame: number
  frameDeltaMs: number
  x: number
  atMs: number
}

type RapidReversalTrace = {
  name: string
  frames: MotionFrame[]
  clickEvents: MotionClick[]
  clickIntervalsMs: number[]
  keySamples: {
    closedStart: PanelSample
    openingBeforeClose: PanelSample
    closingBeforeReopen: PanelSample
    finalOpen: PanelSample
  }
  maxFrameDeltaMs: number
  longFrameGaps: LongFrameGap[]
  visibleJumps: MotionJump[]
  visibleJumpBudgetPx: number
  visibleJumpFrameBudgetMs: number
  allClicksAvailable: boolean
  startedOpeningBeforeClose: boolean
  startedClosingBeforeReopen: boolean
  reopenedFromPartialClose: boolean
  finalOpenSettled: boolean
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
    id: "workspace-panel-motion-user",
    primaryEmailAddress: { emailAddress: "workspace-panel-motion@claxedo.test" },
    fullName: "Workspace Panel Motion",
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
  smoothSampleDelayMs,
  rapidClickDelayMs,
  longFrameGapBudgetMs,
  visibleJumpFrameBudgetMs,
  capturedAt: new Date().toISOString(),
}

try {
  await waitForApp(page)
  await closePanelForBaseline(page)

  const startAt = await page.evaluate(() => performance.now())
  const start = await samplePanel(page, "normal closed baseline", startAt)
  const minDelta = Math.max(8, start.width * 0.03)
  await clickWorkspacePanelToggle(page, "Open workspace panel")
  await page.waitForTimeout(smoothSampleDelayMs)
  const opening = await samplePanel(page, "normal opening mid-transition", startAt)
  await waitForPanelRestingPosition(page, true)
  const normalOpen = await samplePanel(page, "normal final open", startAt)
  await clickWorkspacePanelToggle(page, "Close workspace panel")
  await waitForPanelRestingPosition(page, false)
  await page.waitForTimeout(180)
  const closedAgain = await samplePanel(page, "closed before rapid interrupt", startAt)

  const rapid = await measureRapidOpenCloseOpen(page, startAt, closedAgain, minDelta)
  const final = rapid.keySamples.finalOpen
  const screenshot = path.join(RESULT_DIR, "workspace-panel-interrupt-motion-final.png")
  await page.screenshot({ path: screenshot })

  const closedPanelHidden = (sample: PanelSample) =>
    sample.width === 0 || sample.x >= sample.width - Math.max(2, sample.width * 0.01)
  const workbenchSqueezes = (
    opening.workbenchWidth < start.workbenchWidth - minDelta &&
    normalOpen.workbenchWidth < start.workbenchWidth - minDelta &&
    closedAgain.workbenchWidth > normalOpen.workbenchWidth + minDelta &&
    final.workbenchWidth < closedAgain.workbenchWidth - minDelta &&
    [start, opening, normalOpen, closedAgain, rapid.keySamples.openingBeforeClose, rapid.keySamples.closingBeforeReopen, final]
      .every((sample) => Math.abs(sample.workbenchX - start.workbenchX) <= 1)
  )
  artifact.samples = [
    start,
    opening,
    normalOpen,
    closedAgain,
    rapid.keySamples.openingBeforeClose,
    rapid.keySamples.closingBeforeReopen,
    final,
  ]
  artifact.rapidReversal = rapid
  artifact.workbenchSqueezes = workbenchSqueezes
  artifact.finalScreenshot = screenshot
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
  artifact.pass = (
    closedPanelHidden(start) &&
    opening.open &&
    normalOpen.open &&
    normalOpen.x < Math.max(2, start.width * 0.01) &&
    closedPanelHidden(closedAgain) &&
    rapid.allClicksAvailable &&
    rapid.startedOpeningBeforeClose &&
    rapid.startedClosingBeforeReopen &&
    rapid.reopenedFromPartialClose &&
    rapid.finalOpenSettled &&
    rapid.longFrameGaps.length === 0 &&
    rapid.visibleJumps.length === 0 &&
    final.open &&
    final.x < Math.max(2, start.width * 0.01) &&
    workbenchSqueezes &&
    consoleErrors.length === 0 &&
    pageErrors.length === 0
  )
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
  await Bun.write(
    path.join(RESULT_DIR, "workspace-panel-interrupt-motion-manifest.json"),
    JSON.stringify(artifact, null, 2) + "\n",
  )
}

if (!artifact.pass) {
  throw new Error(`Workspace panel interrupt motion failed; see ${path.join(RESULT_DIR, "workspace-panel-interrupt-motion-manifest.json")}`)
}

console.log(`Workspace panel interrupt motion passed: ${path.join(RESULT_DIR, "workspace-panel-interrupt-motion-manifest.json")}`)

async function waitForApp(page: Page) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" })
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})
  await page.locator('[data-testid="workspace-panel-shell"]').waitFor({ state: "attached", timeout: 20_000 })
  await page.locator('[data-testid="workspace-panel-toggle"]').first().waitFor({ state: "attached", timeout: 20_000 })
}

async function closePanelForBaseline(page: Page) {
  const open = await page.locator('[data-testid="workspace-panel-shell"]').getAttribute("data-open")
  if (open !== "true") {
    await clickWorkspacePanelToggle(page, "Open workspace panel")
    await waitForPanelOpenState(page, true)
    await page.waitForTimeout(260)
  }
  await clickWorkspacePanelToggle(page, "Close workspace panel")
  await waitForPanelOpenState(page, false)
  await page.waitForTimeout(220)
}

async function clickWorkspacePanelToggle(page: Page, label: "Open workspace panel" | "Close workspace panel") {
  const result = await page.evaluate((label) => {
    const visible = (item: HTMLElement) => {
      const rect = item.getBoundingClientRect()
      const style = getComputedStyle(item)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.left < window.innerWidth &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none" &&
        Number(style.opacity || "1") > 0.01
    }
    const toggles = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="workspace-panel-toggle"]'))
    const button = toggles
      .filter((item) => item.getAttribute("aria-label") === label)
      .find((item) => {
        if (!visible(item)) return false
        const parentPanel = item.closest<HTMLElement>('[data-testid="workspace-panel-shell"]')
        return !parentPanel || visible(parentPanel)
      })
    const actual = button?.getAttribute("aria-label") ?? null
    if (actual !== label) {
      return {
        clicked: false,
        actual,
        available: toggles.map((item) => {
          const rect = item.getBoundingClientRect()
          return {
            label: item.getAttribute("aria-label"),
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            visible: visible(item),
            parentOpen: item.closest<HTMLElement>('[data-testid="workspace-panel-shell"]')?.dataset.open ?? null,
          }
        }),
      }
    }
    const rect = button.getBoundingClientRect()
    button?.click()
    return { clicked: rect.width > 0 && rect.height > 0, actual }
  }, label)
  if (!result.clicked) throw new Error(`${label} button was not available; actual=${result.actual}; available=${JSON.stringify(result.available)}`)
}

async function waitForPanelOpenState(page: Page, open: boolean) {
  await page.waitForFunction((open) =>
    document.querySelector<HTMLElement>('[data-testid="workspace-panel-shell"]')?.dataset.open === String(open),
    open,
    { timeout: 2_000 },
  )
}

async function waitForPanelRestingPosition(page: Page, open: boolean) {
  await page.waitForFunction((open) => {
    const panel = document.querySelector<HTMLElement>('[data-testid="workspace-panel-shell"]')
    if (!panel) return false
    const rect = panel.getBoundingClientRect()
    const x = Math.max(0, rect.left - (window.innerWidth - rect.width))
    if (open) return x <= Math.max(2, rect.width * 0.01)
    return x >= rect.width - Math.max(2, rect.width * 0.01)
  }, open, { timeout: 2_000 })
}

async function samplePanel(page: Page, name: string, startAt: number): Promise<PanelSample> {
  return await page.evaluate(({ name, startAt }) => {
    const panel = document.querySelector<HTMLElement>('[data-testid="workspace-panel-shell"]')
    if (!panel) throw new Error("Workspace panel shell is missing")
    const workbench = document.querySelector<HTMLElement>('[data-testid="workbench-column"]')
    if (!workbench) throw new Error("Workbench column is missing")
    const style = getComputedStyle(panel)
    const rect = panel.getBoundingClientRect()
    const workbenchRect = workbench.getBoundingClientRect()
    const restingLeft = window.innerWidth - rect.width
    return {
      name,
      open: panel.dataset.open === "true",
      x: Math.max(0, rect.left - restingLeft),
      width: rect.width,
      workbenchX: workbenchRect.left,
      workbenchWidth: workbenchRect.width,
      opacity: Number(style.opacity),
      transform: style.transform,
      translate: style.translate,
      atMs: performance.now() - startAt,
    }
  }, { name, startAt })
}

async function measureRapidOpenCloseOpen(
  page: Page,
  startAt: number,
  closedStart: PanelSample,
  minDelta: number,
): Promise<RapidReversalTrace> {
  const trace = await page.evaluate(async ({ startAt, rapidClickDelayMs }) => {
    const readPanel = (name: string) => {
      const panel = document.querySelector<HTMLElement>('[data-testid="workspace-panel-shell"]')
      if (!panel) throw new Error("Workspace panel shell is missing")
      const workbench = document.querySelector<HTMLElement>('[data-testid="workbench-column"]')
      if (!workbench) throw new Error("Workbench column is missing")
      const style = getComputedStyle(panel)
      const rect = panel.getBoundingClientRect()
      const workbenchRect = workbench.getBoundingClientRect()
      const restingLeft = window.innerWidth - rect.width
      return {
        name,
        open: panel.dataset.open === "true",
        x: Math.max(0, rect.left - restingLeft),
        width: rect.width,
        workbenchX: workbenchRect.left,
        workbenchWidth: workbenchRect.width,
        opacity: Number(style.opacity),
        transform: style.transform,
        translate: style.translate,
        atMs: performance.now() - startAt,
      }
    }
    const visible = (item: HTMLElement) => {
      const itemRect = item.getBoundingClientRect()
      const itemStyle = getComputedStyle(item)
      return itemRect.width > 0 &&
        itemRect.height > 0 &&
        itemRect.right > 0 &&
        itemRect.left < window.innerWidth &&
        itemRect.bottom > 0 &&
        itemRect.top < window.innerHeight &&
        itemStyle.display !== "none" &&
        itemStyle.visibility !== "hidden" &&
        itemStyle.pointerEvents !== "none" &&
        Number(itemStyle.opacity || "1") > 0.01
    }
    const clickToggle = (label: "Open workspace panel" | "Close workspace panel") => {
      const sample = readPanel(`rapid before ${label}`)
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="workspace-panel-toggle"]'))
        .filter((item) => item.getAttribute("aria-label") === label)
        .find((item) => {
          if (!visible(item)) return false
          const parentPanel = item.closest<HTMLElement>('[data-testid="workspace-panel-shell"]')
          return !parentPanel || visible(parentPanel)
        })
      if (!button) throw new Error(`${label} button was not available during rapid open-close-open reversal`)
      button.click()
      return {
        label,
        sample,
        atMs: performance.now() - startAt,
        clicked: !!button,
      }
    }
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const frames: MotionFrame[] = []
    const clickEvents: MotionClick[] = []
    const localStart = performance.now()
    let previous = localStart
    let running = true
    const frameLoop = new Promise<void>((resolve) => {
      const tick = () => {
        const now = performance.now()
        frames.push({
          ...readPanel("rapid frame"),
          frame: frames.length,
          frameDeltaMs: now - previous,
        })
        previous = now
        if (!running && frames.length >= 8) {
          resolve()
          return
        }
        if (now - localStart > 1_500) {
          resolve()
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

    clickEvents.push(clickToggle("Open workspace panel"))
    await delay(rapidClickDelayMs)
    const openingBeforeClose = readPanel("rapid opening before close")
    clickEvents.push(clickToggle("Close workspace panel"))
    await delay(rapidClickDelayMs)
    const closingBeforeReopen = readPanel("rapid closing before reopen")
    clickEvents.push(clickToggle("Open workspace panel"))

    let finalOpen = readPanel("rapid final open")
    await new Promise<void>((resolve) => {
      let stableFrames = 0
      const tick = () => {
        finalOpen = readPanel("rapid final open")
        if (finalOpen.open && finalOpen.x <= Math.max(2, finalOpen.width * 0.01)) stableFrames += 1
        else stableFrames = 0
        if (stableFrames >= 3 || performance.now() - localStart > 1_200) {
          resolve()
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    running = false
    await frameLoop

    return {
      name: "rapid open-close-open reversal",
      frames,
      clickEvents,
      clickIntervalsMs: clickEvents.slice(1).map((event, index) => event.atMs - clickEvents[index]!.atMs),
      keySamples: {
        openingBeforeClose,
        closingBeforeReopen,
        finalOpen,
      },
    }
  }, { startAt, rapidClickDelayMs }) as Omit<RapidReversalTrace,
    | "longFrameGaps"
    | "visibleJumps"
    | "visibleJumpBudgetPx"
    | "maxFrameDeltaMs"
    | "allClicksAvailable"
    | "startedOpeningBeforeClose"
    | "startedClosingBeforeReopen"
    | "reopenedFromPartialClose"
    | "finalOpenSettled"
  >

  const visibleJumpBudgetPx = Math.max(48, closedStart.width * 0.2)
  const isRestingOpen = (frame: Pick<PanelSample, "open" | "x" | "width">) =>
    frame.open && frame.x <= Math.max(2, frame.width * 0.01)
  const longFrameGaps = trace.frames
    .filter((frame, index) => {
      const previous = trace.frames[index - 1]
      return frame.frameDeltaMs > longFrameGapBudgetMs &&
        (!previous || !isRestingOpen(frame) || !isRestingOpen(previous) || Math.abs(frame.x - previous.x) > minDelta)
    })
    .map((frame) => ({
      frame: frame.frame,
      frameDeltaMs: frame.frameDeltaMs,
      x: frame.x,
      atMs: frame.atMs,
    }))
  const visibleJumps = trace.frames.flatMap((frame, index) => {
    const previous = trace.frames[index - 1]
    if (!previous) return []
    const deltaX = frame.x - previous.x
    if (Math.abs(deltaX) <= visibleJumpBudgetPx) return []
    if (frame.frameDeltaMs <= visibleJumpFrameBudgetMs) return []
    return [{
      fromFrame: previous.frame,
      toFrame: frame.frame,
      fromX: previous.x,
      toX: frame.x,
      deltaX,
      frameDeltaMs: frame.frameDeltaMs,
    }]
  })
  const firstReopenAt = trace.clickEvents.findLast((event) => event.label === "Open workspace panel")?.atMs ?? 0
  const closeAt = trace.clickEvents.find((event) => event.label === "Close workspace panel")?.atMs ?? 0
  const closingFrames = trace.frames.filter((frame) => frame.atMs >= closeAt && frame.atMs <= firstReopenAt)
  const startedClosing = closingFrames.some((frame, index) => {
    const previous = closingFrames[index - 1]
    return !!previous && (
      frame.x > previous.x + minDelta ||
      frame.workbenchWidth > previous.workbenchWidth + minDelta
    )
  })
  const startedOpeningBeforeClose = trace.keySamples.openingBeforeClose.open &&
    trace.keySamples.openingBeforeClose.workbenchWidth < closedStart.workbenchWidth - minDelta
  const startedClosingBeforeReopen = !trace.keySamples.closingBeforeReopen.open &&
    (
      startedClosing ||
      trace.keySamples.closingBeforeReopen.x > minDelta ||
      trace.keySamples.closingBeforeReopen.workbenchWidth > trace.keySamples.openingBeforeClose.workbenchWidth + minDelta
    )
  const reopenedFromPartialClose = trace.frames
    .filter((frame) => frame.atMs >= firstReopenAt)
    .some((frame) =>
      frame.open &&
      (
        frame.x < trace.keySamples.closingBeforeReopen.x - minDelta ||
        frame.workbenchWidth < trace.keySamples.closingBeforeReopen.workbenchWidth - minDelta
      ))
  return {
    ...trace,
    keySamples: {
      closedStart,
      ...trace.keySamples,
    },
    maxFrameDeltaMs: Math.max(0, ...trace.frames.map((frame) => frame.frameDeltaMs)),
    longFrameGaps,
    visibleJumps,
    visibleJumpBudgetPx,
    visibleJumpFrameBudgetMs,
    allClicksAvailable: trace.clickEvents.every((event) => event.clicked),
    startedOpeningBeforeClose,
    startedClosingBeforeReopen,
    reopenedFromPartialClose,
    finalOpenSettled: trace.keySamples.finalOpen.open &&
      trace.keySamples.finalOpen.x <= Math.max(2, trace.keySamples.finalOpen.width * 0.01),
  }
}

async function closeContextAndSaveVideo(context: BrowserContext, page: Page) {
  const video = page.video()
  await page.close().catch(() => {})
  await context.close().catch(() => {})
  const raw = video ? await video.path().catch(() => undefined) : undefined
  if (!raw) return undefined
  const target = path.join(RESULT_DIR, "workspace-panel-interrupt-motion.webm")
  await Bun.$`mv ${raw} ${target}`
  return target
}
