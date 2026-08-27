import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core"
import { createHash } from "node:crypto"
import path from "node:path"
import sharp from "sharp"
import { workspaceCaptureUrl } from "./workspace-capture-url.mjs"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const RESULT_DIR = path.resolve(Bun.env.CLAXEDO_P4_SURFACE_DIR ?? path.join(PACKAGE_DIR, "test-results/p4-named-surfaces"))
const BASELINE_DIR = path.resolve(
  Bun.env.CLAXEDO_P4_SURFACE_BASELINE_DIR ?? path.join(PACKAGE_DIR, "test-fixtures/p4-named-surfaces/baseline"),
)
const BASELINE_MANIFEST = path.resolve(
  Bun.env.CLAXEDO_P4_SURFACE_BASELINE_MANIFEST ??
    path.join(PACKAGE_DIR, "test-fixtures/p4-named-surfaces/baseline-manifest.json"),
)
const baseURL = Bun.env.CLAXEDO_P4_SURFACE_URL ?? defaultSurfaceURL()
const updateBaseline = Bun.env.CLAXEDO_P4_SURFACE_UPDATE_BASELINE === "1"
const requireBaseline = Bun.env.CLAXEDO_P4_SURFACE_REQUIRE_BASELINE === "1"
const diffThresholds = new Map<string, number>([
  ["rail-sidebar", 0.02],
  ["rail-pinned-session-open", 0.004],
  ["rail-hidden-compact-switcher", 0.005],
  ["workspace-panel-review", 0.01],
  ["workspace-panel-files", 0.01],
  ["workspace-panel-changes", 0.01],
  ["workspace-panel-processes", 0.01],
  ["workspace-panel-full-width", 0.01],
  ["review-panel", 0.025],
  ["mobile-375", 0.045],
])
const surfaceQuality = new Map<string, ScreenshotQuality>([
  ["review-panel", { minBytes: 20_000, minNonMaskRatio: 0.025, minUniqueColors: 64 }],
  ["workspace-panel-review", { minBytes: 4_000, minNonMaskRatio: 0.005, minUniqueColors: 32 }],
  ["workspace-panel-files", { minBytes: 4_000, minNonMaskRatio: 0.005, minUniqueColors: 32 }],
  ["workspace-panel-changes", { minBytes: 4_000, minNonMaskRatio: 0.005, minUniqueColors: 32 }],
  ["workspace-panel-processes", { minBytes: 4_000, minNonMaskRatio: 0.005, minUniqueColors: 32 }],
  ["workspace-panel-full-width", { minBytes: 4_000, minNonMaskRatio: 0.005, minUniqueColors: 32 }],
  ["workbench-header-controls", { minBytes: 1_000, minNonMaskRatio: 0.01, minUniqueColors: 16 }],
])

type ScreenshotDigest = {
  bytes: number
  sha256: string
}

type ScreenshotQuality = {
  minBytes?: number
  minNonMaskRatio?: number
  minUniqueColors?: number
}

type SurfaceResult = {
  name: string
  path?: string
  status: "captured" | "missing"
  note?: string
  bytes?: number
  sha256?: string
  baselinePath?: string
  baselineManifest?: string
  baselineBytes?: number
  baselineSha256?: string
  baselineStatus?: "matched" | "within-threshold" | "mismatched" | "missing" | "updated"
  pixelDiffCount?: number
  pixelDiffRatio?: number
  pixelDiffThreshold?: number
}

type CaptureRuntime = {
  page: Page
  surfaces: SurfaceResult[]
  failures: string[]
  consoleMessages: string[]
  failedRequests: string[]
  badResponses: string[]
}

type WorkspaceNavigatorLabel = "Files" | "Changes" | "Processes"

await Bun.$`mkdir -p ${RESULT_DIR}`
if (updateBaseline) {
  await Bun.$`mkdir -p ${BASELINE_DIR}`
  await Bun.$`mkdir -p ${path.dirname(BASELINE_MANIFEST)}`
}

const expectedBaselines = await readBaselineManifest()
const browser = await chromium.launch({ headless: true })
const desktop = await newRuntime(browser, { width: 1440, height: 1000 })
const mobile = await newRuntime(browser, { width: 375, height: 812, isMobile: true })
const artifact: Record<string, unknown> = {
  evidenceKind: "p4-named-surface-visual",
  comparisonMode: updateBaseline ? "baseline-update" : "baseline-hash-compare",
  baseURL,
  baselineDir: BASELINE_DIR,
  baselineManifest: BASELINE_MANIFEST,
  updateBaseline,
  requireBaseline,
  capturedAt: new Date().toISOString(),
  surfaces: [],
  failures: [],
}

try {
  await waitForShell(desktop.page)
  await capture(desktop, "home-empty-state", desktop.page.locator('[data-testid="workbench-column"]'), {
    note: "Root workbench before activating a session.",
  })
  await capture(desktop, "rail-sidebar", desktop.page.locator('[data-testid="rail-sidebar"]'))
  await capture(desktop, "titlebar-top-strip", desktop.page.locator('[data-testid="workbench-l2-header"]'), {
    note: "Live workbench L2 top strip; the old global Titlebar component is not mounted in this web route.",
    fallbackClip: { x: 260, y: 0, width: 1180, height: 96 },
  })

  await activateFirstSession(desktop)
  await capture(desktop, "rail-pinned-session-open", desktop.page.locator("body"), {
    note: "Full desktop viewport with rail pinned and an active session surface.",
  })
  await assertPinnedRailNavigation(desktop)
  await capture(
    desktop,
    "workbench-header-controls",
    desktop.page.locator('[data-testid="workbench-shell-header"]'),
    {
      note: "Current Claxedo workbench L1 controls: workspace scope actions plus workspace-panel chrome.",
    },
  )

  await openWorkspacePanel(desktop)
  await capture(desktop, "workspace-panel-review", desktop.page.locator('[data-testid="workspace-panel-shell"]'), {
    note: "Workspace panel open with the Review surface.",
    mask: [
      desktop.page.locator('[data-testid="l2-review-toolbar-slot"]'),
      desktop.page.locator("#review-panel"),
    ],
  })
  await capture(desktop, "review-panel", desktop.page.locator("#review-panel"), {
    note: "Review panel chrome with volatile dirty-file diff rows masked.",
    mask: [desktop.page.locator('[data-review-file]')],
  })
  await captureWorkspaceNavigator(desktop, "Files", "workspace-panel-files")
  await captureWorkspaceNavigator(desktop, "Changes", "workspace-panel-changes")
  await captureWorkspaceNavigator(desktop, "Processes", "workspace-panel-processes")
  await closeWorkspaceNavigator(desktop, "Processes")

  await toggleSidebarHidden(desktop)
  await assertHiddenRailCompactSwitcher(desktop)
  await capture(desktop, "rail-hidden-compact-switcher", desktop.page.locator('[data-testid="workbench-column"]'), {
    note: "Workbench with rail hidden and compact switcher visible.",
  })
  await toggleSidebarVisible(desktop)
  await maximizeWorkspacePanel(desktop)
  await capture(desktop, "workspace-panel-full-width", desktop.page.locator('[data-testid="workspace-panel-shell"]'), {
    note: "Workspace panel after activating the full-width control.",
    mask: [
      desktop.page.locator('[data-testid="l2-review-toolbar-slot"]'),
      desktop.page.locator("#review-panel"),
    ],
  })

  await waitForShell(mobile.page)
  await activateFirstSession(mobile)
  await openWorkspacePanel(mobile)
  await capture(mobile, "mobile-375", mobile.page.locator("body"), {
    note: "Mobile 375px viewport with session and workspace panel reachable.",
  })
} finally {
  await desktop.context.close()
  await mobile.context.close()
  await browser.close()
}

for (const runtime of [desktop, mobile]) {
  artifact.surfaces = [...artifact.surfaces as SurfaceResult[], ...runtime.surfaces]
  if (runtime.consoleMessages.length) runtime.failures.push(`console errors: ${runtime.consoleMessages.join(" | ")}`)
  const unexpectedFailedRequests = runtime.failedRequests.filter((item) =>
    !/\/api\/wr\/events\b.*net::ERR_ABORTED/.test(item) &&
    !/\/api\/wr\/runtime-events\b.*net::ERR_ABORTED/.test(item)
  )
  if (unexpectedFailedRequests.length) runtime.failures.push(`failed requests: ${unexpectedFailedRequests.join(" | ")}`)
  if (runtime.badResponses.length) runtime.failures.push(`5xx responses: ${runtime.badResponses.join(" | ")}`)
  for (const surface of runtime.surfaces) {
    if (surface.status === "missing") runtime.failures.push(`${surface.name}: ${surface.note ?? "missing"}`)
    if (surface.baselineStatus === "mismatched") {
      runtime.failures.push(
        `${surface.name}: screenshot differs from baseline ${surface.baselinePath} (${surface.sha256} != ${surface.baselineSha256})`,
      )
    }
    if (surface.baselineStatus === "missing" && requireBaseline) {
      runtime.failures.push(`${surface.name}: missing required screenshot baseline ${surface.baselinePath}`)
    }
  }
  artifact.failures = [...artifact.failures as string[], ...runtime.failures]
}

if (updateBaseline) {
  await writeBaselineManifest(artifact.surfaces as SurfaceResult[])
}

const manifest = path.join(RESULT_DIR, "manifest.json")
await Bun.write(manifest, JSON.stringify(artifact, null, 2) + "\n")

console.log(`p4 surface manifest: ${manifest}`)
for (const surface of artifact.surfaces as SurfaceResult[]) {
  if (surface.path) console.log(`p4 surface screenshot: ${surface.path}`)
}

if ((artifact.failures as string[]).length) {
  console.error((artifact.failures as string[]).join("\n"))
  process.exit(1)
}

async function newRuntime(
  browser: Browser,
  viewport: { width: number; height: number; isMobile?: boolean },
): Promise<CaptureRuntime & { context: BrowserContext }> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.isMobile,
  })
  await context.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__CLAXEDO_TEST_AUTH_TOKEN__ = "test-bypass-token"
    w.__CLAXEDO_TEST_AUTH_USER__ = {
      id: "p4-surface-user",
      primaryEmailAddress: { emailAddress: "p4-surfaces@claxedo.test" },
      fullName: "P4 Surface Capture",
    }
    const injectStyle = () => {
      const style = document.createElement("style")
      style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}"
      document.head.append(style)
    }
    if (document.head) injectStyle()
    else window.addEventListener("DOMContentLoaded", injectStyle, { once: true })
  })
  const page = await context.newPage()
  const runtime = { context, page, surfaces: [], failures: [], consoleMessages: [], failedRequests: [], badResponses: [] }
  page.on("console", (message) => {
    if (message.type() === "error") runtime.consoleMessages.push(message.text())
  })
  page.on("pageerror", (error) => runtime.consoleMessages.push(`pageerror: ${error.message}`))
  page.on("requestfailed", (request) => {
    runtime.failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
  })
  page.on("response", (response) => {
    if (response.status() >= 500) runtime.badResponses.push(`${response.status()} ${response.url()}`)
  })
  return runtime
}

async function waitForShell(page: Page) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" })
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {})
  await page.locator("body").waitFor({ state: "visible", timeout: 20_000 })
  await page.waitForTimeout(750)
}

async function activateFirstSession(runtime: CaptureRuntime) {
  const existingToggle = runtime.page.locator('[data-testid="workspace-panel-toggle"]').first()
  if (await existingToggle.isVisible().catch(() => false)) return

  const row = runtime.page.locator('[data-testid="rail-sidebar-session-row"]').first()
  if (!await row.isVisible().catch(() => false)) {
    runtime.surfaces.push({
      name: "session-activation",
      status: "missing",
      note: "No rail session row was visible to activate before capturing session/review surfaces.",
    })
    return
  }
  await row.click()
  await runtime.page.locator('[data-testid="session-content"]:visible').first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {})
  await runtime.page.locator('[data-testid="workspace-panel-toggle"]').first().waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {
      runtime.surfaces.push({
        name: "session-activation",
        status: "missing",
        note: "Clicked the first visible rail session row, but the active workbench workspace-panel toggle did not become visible.",
      })
    })
}

async function openWorkspacePanel(runtime: CaptureRuntime) {
  const openButton = runtime.page.getByRole("button", { name: "Open workspace panel", exact: true }).first()
  if (await openButton.isVisible().catch(() => false)) await openButton.click()
  await runtime.page.locator('[data-testid="workspace-panel-shell"][data-open="true"]').waitFor({ state: "visible", timeout: 15_000 }).catch(() => {})
  await runtime.page.locator("#review-panel").waitFor({ state: "visible", timeout: 15_000 }).catch(() => {})
  await runtime.page.waitForFunction(() => {
    const panel = document.querySelector("#review-panel")
    if (!panel) return false
    const text = panel.textContent?.trim() ?? ""
    if (/Loading review/i.test(text)) return false
    return !!document.querySelector('[data-testid="review-pane-root"]') && text.length > 20
  }, undefined, { timeout: 20_000 }).catch((error) => {
    runtime.failures.push(`review panel did not settle before capture: ${error instanceof Error ? error.message : String(error)}`)
  })
  await runtime.page.locator('[data-review-file]').first().waitFor({ state: "visible", timeout: 20_000 }).catch((error) => {
    runtime.failures.push(`review diff row did not become visible before capture: ${error instanceof Error ? error.message : String(error)}`)
  })
}

async function captureWorkspaceNavigator(runtime: CaptureRuntime, label: WorkspaceNavigatorLabel, name: string) {
  await openWorkspaceNavigator(runtime, label)
  await capture(runtime, name, runtime.page.locator('[data-testid="workspace-panel-shell"]'), {
    note: `Workspace panel open with the ${label} navigator body.`,
  })
}

async function openWorkspaceNavigator(runtime: CaptureRuntime, label: WorkspaceNavigatorLabel) {
  const page = runtime.page
  const mode = label === "Processes" ? "processes" : label === "Changes" ? "changes" : "files"
  const overlay = page.locator(
    `[data-testid="workspace-navigator-overlay"][data-navigator="${label === "Processes" ? "processes" : "files"}"][data-open="true"]`,
  )
  const body = label === "Processes"
    ? page.locator('[data-testid="workspace-navigator-overlay"][data-navigator="processes"][data-open="true"]')
    : page.locator(`[data-testid="workspace-files-navigator"][data-mode="${mode}"]`)

  if (!await body.isVisible().catch(() => false)) {
    await clickVisibleButton(runtime, `Open ${label}`)
  }
  await overlay.waitFor({ state: "visible", timeout: 10_000 }).catch((error) => {
    runtime.failures.push(`${label} navigator overlay did not open before capture: ${error instanceof Error ? error.message : String(error)}`)
  })
  await body.waitFor({ state: "visible", timeout: 10_000 }).catch((error) => {
    runtime.failures.push(`${label} navigator body did not become visible before capture: ${error instanceof Error ? error.message : String(error)}`)
  })
  await waitForWorkspaceNavigatorBody(runtime, label)
}

async function waitForWorkspaceNavigatorBody(runtime: CaptureRuntime, label: WorkspaceNavigatorLabel) {
  if (label === "Files") {
    await runtime.page.getByPlaceholder("Search files...").waitFor({ state: "visible", timeout: 10_000 }).catch((error) => {
      runtime.failures.push(`Files navigator search input did not become visible: ${error instanceof Error ? error.message : String(error)}`)
    })
    await runtime.page.locator('[data-testid="workspace-files-navigator"][data-file-tree-shell-ready="true"]').waitFor({ state: "visible", timeout: 10_000 }).catch(() => {})
    return
  }

  if (label === "Changes") {
    await runtime.page.getByPlaceholder("Filter changes...").waitFor({ state: "visible", timeout: 10_000 }).catch((error) => {
      runtime.failures.push(`Changes navigator filter input did not become visible: ${error instanceof Error ? error.message : String(error)}`)
    })
    await runtime.page.waitForFunction(() => {
      const list = document.querySelector('[data-testid="workspace-changed-file-list"]')
      if (list) return true
      return (document.body.textContent ?? "").includes("No changed files")
    }, undefined, { timeout: 10_000 }).catch(() => {})
    return
  }

  await runtime.page.getByText("Processes", { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 }).catch((error) => {
    runtime.failures.push(`Processes navigator heading did not become visible: ${error instanceof Error ? error.message : String(error)}`)
  })
  await runtime.page.getByRole("button", { name: "Add process", exact: true }).first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {})
}

async function closeWorkspaceNavigator(runtime: CaptureRuntime, label: WorkspaceNavigatorLabel) {
  await clickVisibleButton(runtime, `Close ${label}`, false)
  await runtime.page.locator("#review-panel").waitFor({ state: "visible", timeout: 10_000 }).catch(() => {})
  await runtime.page.waitForTimeout(180)
}

async function clickVisibleButton(runtime: CaptureRuntime, name: string, required = true) {
  const buttons = runtime.page.getByRole("button", { name, exact: true })
  for (const index of Array.from({ length: await buttons.count().catch(() => 0) }, (_, index) => index)) {
    const button = buttons.nth(index)
    if (await button.isVisible().catch(() => false)) {
      await button.click()
      return
    }
  }
  if (required) runtime.failures.push(`button was not visible: ${name}`)
}

async function toggleSidebarHidden(runtime: CaptureRuntime) {
  const button = runtime.page.getByRole("button", { name: "Pin sidebar", exact: true }).first()
  if (await button.isVisible().catch(() => false)) await button.click()
  await runtime.page.locator('[data-testid="compact-switcher"]').waitFor({ state: "visible", timeout: 10_000 }).catch(() => {})
  await runtime.page.waitForTimeout(180)
}

async function toggleSidebarVisible(runtime: CaptureRuntime) {
  const button = runtime.page.getByRole("button", { name: "Show Sidebar", exact: true }).first()
  if (await button.isVisible().catch(() => false)) await button.click()
  await runtime.page.locator('[data-testid="rail-sidebar"]').waitFor({ state: "visible", timeout: 10_000 }).catch(() => {})
  await runtime.page.waitForTimeout(180)
}

async function assertPinnedRailNavigation(runtime: CaptureRuntime) {
  const result = await runtime.page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('[data-testid="rail-sidebar"]')
    const compact = document.querySelector<HTMLElement>('[data-testid="compact-switcher"]')
    const railRect = rail?.getBoundingClientRect()
    const compactRect = compact?.getBoundingClientRect()
    const railVisible = !!rail && !!railRect && railRect.width > 160 && railRect.height > 200
    const compactVisible = !!compact && !!compactRect && compactRect.width > 0 && compactRect.height > 0 &&
      getComputedStyle(compact).visibility !== "hidden" &&
      getComputedStyle(compact).display !== "none"
    return { railVisible, compactVisible }
  })

  if (!result.railVisible) runtime.failures.push("rail pinned contract failed: pinned rail is not visibly available")
  if (result.compactVisible) {
    runtime.failures.push("rail pinned contract failed: compact switcher should not duplicate pinned rail navigation")
  }
}

async function assertHiddenRailCompactSwitcher(runtime: CaptureRuntime) {
  const result = await runtime.page.evaluate(() => {
    const compact = document.querySelector<HTMLElement>('[data-testid="compact-switcher"]')
    const firstTab = document.querySelector<HTMLElement>('[data-testid="compact-switcher-tab"]')
    const rail = document.querySelector<HTMLElement>('[data-testid="rail-sidebar"]')
    const floatingChrome = document.querySelector<HTMLElement>('[data-testid="workspace-panel-floating-chrome"]')
    const compactRect = compact?.getBoundingClientRect()
    const tabRect = firstTab?.getBoundingClientRect()
    const railRect = rail?.getBoundingClientRect()
    const chromeRect = floatingChrome?.getBoundingClientRect()
    const compactVisible = !!compact && !!compactRect && compactRect.width > 120 && compactRect.height > 20 &&
      getComputedStyle(compact).visibility !== "hidden" &&
      getComputedStyle(compact).display !== "none"
    const tabVisible = !!firstTab && !!tabRect && tabRect.width > 60 && tabRect.height > 20
    const hit = tabRect
      ? document.elementFromPoint(tabRect.left + Math.min(24, tabRect.width / 2), tabRect.top + tabRect.height / 2)
      : null
    const tabHit = !!firstTab && !!hit && (firstTab === hit || firstTab.contains(hit) || hit.contains(firstTab))
    const railVisible = !!rail && !!railRect && railRect.width > 100 && railRect.height > 200 &&
      getComputedStyle(rail).visibility !== "hidden" &&
      getComputedStyle(rail).display !== "none"
    const chromeOverlap = !!compactRect && !!chromeRect &&
      Math.max(0, Math.min(compactRect.right, chromeRect.right) - Math.max(compactRect.left, chromeRect.left)) *
        Math.max(0, Math.min(compactRect.bottom, chromeRect.bottom) - Math.max(compactRect.top, chromeRect.top))
    return { compactVisible, tabVisible, tabHit, railVisible, chromeOverlap }
  })

  if (result.railVisible) runtime.failures.push("hidden rail contract failed: pinned rail remains visible")
  if (!result.compactVisible) runtime.failures.push("hidden rail contract failed: compact switcher is not visible")
  if (!result.tabVisible) runtime.failures.push("hidden rail contract failed: compact switcher has no visible tab")
  if (!result.tabHit) runtime.failures.push("hidden rail contract failed: compact switcher tab is covered at its visible hit target")
  if (result.chromeOverlap > 1) {
    runtime.failures.push("hidden rail contract failed: workspace panel floating chrome overlaps compact switcher")
  }
}

async function maximizeWorkspacePanel(runtime: CaptureRuntime) {
  const button = runtime.page.getByRole("button", { name: "Maximize workspace panel", exact: true }).first()
  if (await button.isVisible().catch(() => false)) {
    await button.click()
  } else {
    await runtime.page.evaluate(() => window.dispatchEvent(new Event("claxedo:workspace-panel-toggle-fullwidth")))
  }
  await runtime.page.waitForTimeout(260)
}

async function capture(
  runtime: CaptureRuntime,
  name: string,
  locator: Locator,
  options?: {
    note?: string
    fallbackClip?: { x: number; y: number; width: number; height: number }
    mask?: Locator[]
  },
) {
  const output = path.join(RESULT_DIR, `${name}.png`)
  await runtime.page.mouse.move(1, runtime.page.viewportSize()?.height ?? 1)
  await runtime.page.waitForTimeout(50)
  if (!await locator.isVisible().catch(() => false)) {
    if (options?.fallbackClip) {
      await runtime.page.screenshot({ path: output, clip: options.fallbackClip })
      await recordCaptured(runtime, name, output, `${options.note ?? ""} Captured by viewport clip fallback.`.trim())
      return
    }
    runtime.surfaces.push({ name, status: "missing", note: options?.note })
    return
  }
  const qualityOutput = options?.mask?.length ? path.join(RESULT_DIR, `${name}.quality.png`) : output
  if (qualityOutput !== output) await locator.screenshot({ path: qualityOutput })
  await locator.screenshot({ path: output, mask: options?.mask, maskColor: "rgba(244, 244, 244, 1)" })
  const qualityFailures = await screenshotQualityFailures(name, qualityOutput)
  if (qualityFailures.length) {
    runtime.surfaces.push({
      name,
      path: output,
      status: "missing",
      note: `${options?.note ? `${options.note} ` : ""}${qualityFailures.join("; ")}`,
    })
    return
  }
  await recordCaptured(runtime, name, output, options?.note)
}

async function recordCaptured(runtime: CaptureRuntime, name: string, output: string, note?: string) {
  const digest = await digestFile(output)
  runtime.surfaces.push({
    name,
    path: output,
    status: "captured",
    note,
    bytes: digest.bytes,
    sha256: digest.sha256,
    ...await compareBaseline(name, output, digest, expectedBaselines.get(name)),
  })
}

async function digestFile(filePath: string): Promise<ScreenshotDigest> {
  const bytes = await Bun.file(filePath).arrayBuffer()
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
  }
}

function defaultSurfaceURL() {
  const origin = (Bun.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4444").replace(/\/+$/, "")
  return workspaceCaptureUrl({ workspaceId: Bun.env.CLAXEDO_WORKSPACE_ID, origin })
}

async function screenshotQualityFailures(name: string, filePath: string) {
  const quality = surfaceQuality.get(name)
  if (!quality) return []

  const failures: string[] = []
  const bytes = (await Bun.file(filePath).arrayBuffer()).byteLength
  if (quality.minBytes !== undefined && bytes < quality.minBytes) {
    failures.push(`screenshot is too small (${bytes} bytes < ${quality.minBytes})`)
  }

  if (quality.minNonMaskRatio === undefined && quality.minUniqueColors === undefined) return failures

  const image = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const channels = image.info.channels
  const pixelCount = image.info.width * image.info.height
  let meaningfulPixels = 0
  const colors = new Set<string>()

  for (let offset = 0; offset < image.data.length; offset += channels) {
    const r = image.data[offset]
    const g = image.data[offset + 1]
    const b = image.data[offset + 2]
    const a = image.data[offset + 3] ?? 255
    const white = r > 248 && g > 248 && b > 248
    const mask = Math.abs(r - 244) <= 1 && Math.abs(g - 244) <= 1 && Math.abs(b - 244) <= 1
    if (!white && !mask && a > 0) meaningfulPixels++
    if (colors.size <= (quality.minUniqueColors ?? 0)) colors.add(`${r},${g},${b},${a}`)
  }

  const nonMaskRatio = meaningfulPixels / pixelCount
  if (quality.minNonMaskRatio !== undefined && nonMaskRatio < quality.minNonMaskRatio) {
    failures.push(`screenshot has too little meaningful content (${nonMaskRatio.toFixed(4)} < ${quality.minNonMaskRatio})`)
  }
  if (quality.minUniqueColors !== undefined && colors.size < quality.minUniqueColors) {
    failures.push(`screenshot has too few unique colors (${colors.size} < ${quality.minUniqueColors})`)
  }
  return failures
}

async function compareBaseline(
  name: string,
  screenshot: string,
  current: ScreenshotDigest,
  expected: ScreenshotDigest | undefined,
) {
  const baselinePath = path.join(BASELINE_DIR, `${name}.png`)
  if (updateBaseline) {
    await Bun.write(baselinePath, await Bun.file(screenshot).arrayBuffer())
    return {
      baselinePath,
      baselineBytes: current.bytes,
      baselineSha256: current.sha256,
      baselineStatus: "updated" as const,
    }
  }
  if (expected) {
    const pixelDiff = await comparePixelDiff(name, baselinePath, screenshot)
    const baselineStatus = expected.bytes === current.bytes && expected.sha256 === current.sha256
      ? "matched" as const
      : pixelDiff && pixelDiff.pixelDiffRatio <= pixelDiff.pixelDiffThreshold
        ? "within-threshold" as const
        : "mismatched" as const
    return {
      baselinePath,
      baselineManifest: BASELINE_MANIFEST,
      baselineBytes: expected.bytes,
      baselineSha256: expected.sha256,
      baselineStatus,
      ...pixelDiff,
    }
  }
  if (!(await Bun.file(baselinePath).exists())) {
    return {
      baselinePath,
      baselineStatus: "missing" as const,
    }
  }
  const baseline = await digestFile(baselinePath)
  const pixelDiff = await comparePixelDiff(name, baselinePath, screenshot)
  const baselineStatus = baseline.bytes === current.bytes && baseline.sha256 === current.sha256
    ? "matched" as const
    : pixelDiff && pixelDiff.pixelDiffRatio <= pixelDiff.pixelDiffThreshold
      ? "within-threshold" as const
      : "mismatched" as const
  return {
    baselinePath,
    baselineBytes: baseline.bytes,
    baselineSha256: baseline.sha256,
    baselineStatus,
    ...pixelDiff,
  }
}

async function comparePixelDiff(name: string, baselinePath: string, screenshot: string) {
  const threshold = diffThresholds.get(name) ?? 0
  if (threshold === 0 || !(await Bun.file(baselinePath).exists())) return undefined
  const [baseline, current] = await Promise.all([
    sharp(baselinePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(screenshot).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ])
  if (
    baseline.info.width !== current.info.width ||
    baseline.info.height !== current.info.height ||
    baseline.info.channels !== current.info.channels
  ) {
    return {
      pixelDiffCount: Number.POSITIVE_INFINITY,
      pixelDiffRatio: 1,
      pixelDiffThreshold: threshold,
    }
  }
  const channels = baseline.info.channels
  const pixelCount = baseline.info.width * baseline.info.height
  let diff = 0
  for (let offset = 0; offset < baseline.data.length; offset += channels) {
    for (let channel = 0; channel < channels; channel++) {
      if (baseline.data[offset + channel] === current.data[offset + channel]) continue
      diff++
      break
    }
  }
  return {
    pixelDiffCount: diff,
    pixelDiffRatio: diff / pixelCount,
    pixelDiffThreshold: threshold,
  }
}

async function readBaselineManifest() {
  const manifest = await readBaselineManifestEntries()
  const names = new Set(manifest.keys())

  for await (const file of new Bun.Glob("*.png").scan({ cwd: BASELINE_DIR })) {
    names.add(path.basename(file, ".png"))
  }

  return new Map(
    await Promise.all(
      [...names].map(async (name) => {
        const baselinePath = path.join(BASELINE_DIR, `${name}.png`)
        if (await Bun.file(baselinePath).exists()) return [name, await digestFile(baselinePath)] as const
        return [name, manifest.get(name)!] as const
      }),
    ),
  )
}

async function readBaselineManifestEntries() {
  if (!(await Bun.file(BASELINE_MANIFEST).exists())) return new Map<string, ScreenshotDigest>()
  const manifest = await Bun.file(BASELINE_MANIFEST).json() as {
    surfaces?: Array<{ name?: string; bytes?: number; sha256?: string }>
  }
  return new Map(
    (manifest.surfaces ?? [])
      .filter((item): item is { name: string; bytes: number; sha256: string } =>
        typeof item.name === "string" &&
        typeof item.bytes === "number" &&
        typeof item.sha256 === "string"
      )
      .map((item) => [item.name, { bytes: item.bytes, sha256: item.sha256 }] as const),
  )
}

async function writeBaselineManifest(surfaces: SurfaceResult[]) {
  await Bun.write(
    BASELINE_MANIFEST,
    JSON.stringify(
      {
        baseURL,
        updatedAt: new Date().toISOString(),
        surfaces: surfaces
          .filter((surface) =>
            surface.status === "captured" &&
            typeof surface.bytes === "number" &&
            typeof surface.sha256 === "string"
          )
          .map((surface) => ({
            name: surface.name,
            bytes: surface.bytes,
            sha256: surface.sha256,
          })),
      },
      null,
      2,
    ) + "\n",
  )
}
