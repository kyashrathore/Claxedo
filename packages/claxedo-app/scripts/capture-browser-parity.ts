import { chromium, type Page } from "playwright-core"
import path from "node:path"
import { createHash } from "node:crypto"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const RESULT_DIR = path.resolve(Bun.env.CLAXEDO_BROWSER_PARITY_DIR ?? path.join(PACKAGE_DIR, "test-results/browser-parity"))
const BASELINE_DIR = path.resolve(
  Bun.env.CLAXEDO_BROWSER_PARITY_BASELINE_DIR ?? path.join(RESULT_DIR, "baseline"),
)
const BASELINE_MANIFEST = path.resolve(
  Bun.env.CLAXEDO_BROWSER_PARITY_BASELINE_MANIFEST ??
    path.join(PACKAGE_DIR, "test-fixtures/browser-parity/baseline-manifest.json"),
)
const baseURL = Bun.env.CLAXEDO_BROWSER_PARITY_URL ?? Bun.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4444"
const updateBaseline = Bun.env.CLAXEDO_BROWSER_PARITY_UPDATE_BASELINE === "1"
const requireBaseline = Bun.env.CLAXEDO_BROWSER_PARITY_REQUIRE_BASELINE === "1"

type Viewport = {
  name: string
  width: number
  height: number
  isMobile?: boolean
}

const viewports: Viewport[] = [
  { name: "desktop-with-server", width: 1440, height: 1000 },
  { name: "mobile-with-server", width: 390, height: 844, isMobile: true },
]

type ScreenshotDigest = {
  bytes: number
  sha256: string
}

type BaselineResult = {
  baselinePath: string
  baselineManifest?: string
  baselineBytes?: number
  baselineSha256?: string
  baselineStatus: "matched" | "mismatched" | "missing" | "updated"
}

async function waitForShell(page: Page) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" })
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {})
  await page.locator("body").waitFor({ state: "visible", timeout: 20_000 })
  await page.waitForTimeout(500)
}

async function inspect(page: Page) {
  return await page.evaluate(() => {
    const text = document.body.innerText
    const buttons = Array.from(document.querySelectorAll("button")).map((item) => item.textContent?.trim()).filter(Boolean)
    const promptEditors = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'))
    const submit = document.querySelector('[data-component="session-new-composer"] [data-action="prompt-submit"], [data-component="session-composer"] [data-action="prompt-submit"]')
    const submitRect = submit?.getBoundingClientRect()
    const composerControlOverlaps = submitRect
      ? Array.from(document.querySelectorAll('[data-component="session-new-composer"] [data-action^="prompt-"], [data-component="session-composer"] [data-action^="prompt-"]'))
        .filter((item) => item !== submit)
        .map((item) => {
          const rect = item.getBoundingClientRect()
          const overlapX = Math.max(0, Math.min(submitRect.right, rect.right) - Math.max(submitRect.left, rect.left))
          const overlapY = Math.max(0, Math.min(submitRect.bottom, rect.bottom) - Math.max(submitRect.top, rect.top))
          return {
            action: item.getAttribute("data-action") ?? item.getAttribute("aria-label") ?? item.textContent?.trim() ?? "unknown",
            overlapX,
            overlapY,
          }
        })
        .filter((item) => item.overlapX > 1 && item.overlapY > 1)
      : []
    const visibleEmptyStateText = text.match(
      /Select a session|Start a new session|Opening session|Preparing workspace|Model unavailable|Select agent/i,
    )?.[0]
    const rect = document.body.getBoundingClientRect()
    return {
      title: document.title,
      text,
      bodyWidth: Math.round(rect.width),
      bodyHeight: Math.round(rect.height),
      buttons,
      hasComposerProvider: /OpenCode/.test(text),
      hasPromptComposer: promptEditors.some((item) =>
        /Ask anything/i.test(item.getAttribute("aria-label") ?? item.getAttribute("placeholder") ?? ""),
      ),
      composerControlOverlaps,
      visibleEmptyStateText: visibleEmptyStateText ?? null,
    }
  })
}

await Bun.$`mkdir -p ${RESULT_DIR}`
if (updateBaseline) {
  await Bun.$`mkdir -p ${BASELINE_DIR}`
  await Bun.$`mkdir -p ${path.dirname(BASELINE_MANIFEST)}`
}

const browser = await chromium.launch({ headless: true })
const failures: string[] = []
const expectedBaselines = await readBaselineManifest()
const artifact: Record<string, unknown> = {
  baseURL,
  baselineDir: BASELINE_DIR,
  baselineManifest: BASELINE_MANIFEST,
  requireBaseline,
  updateBaseline,
  capturedAt: new Date().toISOString(),
  viewports: [],
}

for (const viewport of viewports) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.isMobile,
  })
  await context.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__CLAXEDO_TEST_AUTH_TOKEN__ = "test-bypass-token"
    w.__CLAXEDO_TEST_AUTH_USER__ = {
      id: "browser-parity-user",
      primaryEmailAddress: { emailAddress: "parity@claxedo.test" },
      fullName: "Browser Parity",
    }
  })
  const page = await context.newPage()
  const consoleMessages: string[] = []
  const failedRequests: string[] = []
  const badResponses: string[] = []

  page.on("console", (message) => {
    if (message.type() === "error") consoleMessages.push(message.text())
  })
  page.on("pageerror", (error) => {
    consoleMessages.push(`pageerror: ${error.message}`)
  })
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
  })
  page.on("response", (response) => {
    if (response.status() >= 500) badResponses.push(`${response.status()} ${response.url()}`)
  })

  try {
    await waitForShell(page)
    const snapshot = await inspect(page)
    const screenshot = path.join(RESULT_DIR, `${viewport.name}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    const comparisonScreenshot = path.join(RESULT_DIR, `${viewport.name}-stable.png`)
    await page.screenshot({
      path: comparisonScreenshot,
      clip: stableClip(viewport),
      mask: browserParityMasks(page),
      maskColor: "rgba(244, 244, 244, 1)",
    })
    const screenshotDigest = await digestFile(screenshot)
    const comparisonDigest = await digestFile(comparisonScreenshot)
    const baseline = await compareBaseline(
      viewport.name,
      comparisonScreenshot,
      comparisonDigest,
      expectedBaselines.get(viewport.name),
    )
    ;(artifact.viewports as unknown[]).push({
      ...viewport,
      screenshot,
      comparisonScreenshot,
      bytes: screenshotDigest.bytes,
      sha256: screenshotDigest.sha256,
      comparisonBytes: comparisonDigest.bytes,
      comparisonSha256: comparisonDigest.sha256,
      ...baseline,
      consoleMessages,
      failedRequests,
      badResponses,
      title: snapshot.title,
      bodyWidth: snapshot.bodyWidth,
      bodyHeight: snapshot.bodyHeight,
      hasComposerProvider: snapshot.hasComposerProvider,
      hasPromptComposer: snapshot.hasPromptComposer,
      composerControlOverlaps: snapshot.composerControlOverlaps,
      visibleEmptyStateText: snapshot.visibleEmptyStateText,
      textSample: snapshot.text.slice(0, 500),
      buttons: snapshot.buttons.slice(0, 20),
    })

    if (snapshot.bodyWidth < viewport.width * 0.8 || snapshot.bodyHeight < viewport.height * 0.6) {
      failures.push(`${viewport.name}: body rendered too small (${snapshot.bodyWidth}x${snapshot.bodyHeight})`)
    }
    if (/login|sign in/i.test(snapshot.text)) failures.push(`${viewport.name}: rendered auth/login surface`)
    if (/error|failed to load/i.test(snapshot.text)) failures.push(`${viewport.name}: rendered error text`)
    if (!snapshot.hasComposerProvider) failures.push(`${viewport.name}: missing composer provider picker`)
    if (!snapshot.hasPromptComposer) failures.push(`${viewport.name}: missing prompt composer`)
    if (snapshot.composerControlOverlaps.length) {
      failures.push(`${viewport.name}: composer controls overlap submit button: ${JSON.stringify(snapshot.composerControlOverlaps)}`)
    }
    if (snapshot.visibleEmptyStateText) {
      failures.push(`${viewport.name}: rendered empty/loading state instead of composer (${snapshot.visibleEmptyStateText})`)
    }
    if (consoleMessages.some((item) => !/Clerk has been loaded with development keys/.test(item))) {
      failures.push(`${viewport.name}: console errors: ${consoleMessages.join(" | ")}`)
    }
    if (badResponses.length) failures.push(`${viewport.name}: 5xx responses: ${badResponses.join(" | ")}`)
    if (baseline.baselineStatus === "mismatched") {
      failures.push(
        `${viewport.name}: stable screenshot differs from baseline ${baseline.baselinePath} (${comparisonDigest.sha256} != ${baseline.baselineSha256})`,
      )
    }
    if (baseline.baselineStatus === "missing" && requireBaseline) {
      failures.push(`${viewport.name}: missing required screenshot baseline ${baseline.baselinePath}`)
    }
  } catch (error) {
    failures.push(`${viewport.name}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await context.close()
  }
}

await browser.close()
if (updateBaseline) {
  await writeBaselineManifest(
    artifact.viewports as Array<{
      name: string
      width: number
      height: number
      comparisonBytes: number
      comparisonSha256: string
    }>,
  )
}

const manifest = path.join(RESULT_DIR, "manifest.json")
await Bun.write(manifest, JSON.stringify({ ...artifact, failures }, null, 2))
console.log(`browser parity manifest: ${manifest}`)
for (const viewport of artifact.viewports as Array<{ screenshot?: string }>) {
  if (viewport.screenshot) console.log(`browser parity screenshot: ${viewport.screenshot}`)
}

if (failures.length) {
  console.error(failures.join("\n"))
  process.exit(1)
}

async function digestFile(filePath: string): Promise<ScreenshotDigest> {
  const bytes = await Bun.file(filePath).arrayBuffer()
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
  }
}

function stableClip(viewport: Viewport) {
  const sidebarWidth = viewport.width >= 900 ? 260 : 0
  return {
    x: sidebarWidth,
    y: 0,
    width: viewport.width - sidebarWidth,
    height: viewport.height,
  }
}

function browserParityMasks(page: Page) {
  return [
    page.locator(
      [
        '[data-component="session-new-composer"] [data-component="button"]',
        '[data-component="session-composer"] [data-component="button"]',
      ].join(", "),
    ),
  ]
}

async function compareBaseline(
  name: string,
  screenshot: string,
  current: ScreenshotDigest,
  expected: ScreenshotDigest | undefined,
): Promise<BaselineResult> {
  const baselinePath = path.join(BASELINE_DIR, `${name}.png`)
  if (updateBaseline) {
    await Bun.write(baselinePath, await Bun.file(screenshot).arrayBuffer())
    return {
      baselinePath,
      baselineBytes: current.bytes,
      baselineSha256: current.sha256,
      baselineStatus: "updated",
    }
  }
  if (expected) {
    return {
      baselinePath,
      baselineManifest: BASELINE_MANIFEST,
      baselineBytes: expected.bytes,
      baselineSha256: expected.sha256,
      baselineStatus: expected.bytes === current.bytes && expected.sha256 === current.sha256 ? "matched" : "mismatched",
    }
  }
  if (!(await Bun.file(baselinePath).exists())) {
    return {
      baselinePath,
      baselineStatus: "missing",
    }
  }
  const baseline = await digestFile(baselinePath)
  return {
    baselinePath,
    baselineBytes: baseline.bytes,
    baselineSha256: baseline.sha256,
    baselineStatus: baseline.bytes === current.bytes && baseline.sha256 === current.sha256 ? "matched" : "mismatched",
  }
}

async function readBaselineManifest() {
  if (!(await Bun.file(BASELINE_MANIFEST).exists())) return new Map<string, ScreenshotDigest>()
  const manifest = await Bun.file(BASELINE_MANIFEST).json() as {
    viewports?: Array<{ name?: string; bytes?: number; sha256?: string }>
  }
  return new Map(
    (manifest.viewports ?? [])
      .filter((item): item is { name: string; bytes: number; sha256: string } =>
        typeof item.name === "string" &&
        typeof item.bytes === "number" &&
        typeof item.sha256 === "string"
      )
      .map((item) => [item.name, { bytes: item.bytes, sha256: item.sha256 }] as const),
  )
}

async function writeBaselineManifest(
  viewports: Array<{
    name: string
    width: number
    height: number
    comparisonBytes: number
    comparisonSha256: string
  }>,
) {
  await Bun.write(
    BASELINE_MANIFEST,
    JSON.stringify(
      {
        baseURL,
        updatedAt: new Date().toISOString(),
        viewports: viewports.map((viewport) => ({
          name: viewport.name,
          width: viewport.width,
          height: viewport.height,
          bytes: viewport.comparisonBytes,
          sha256: viewport.comparisonSha256,
        })),
      },
      null,
      2,
    ),
  )
}
