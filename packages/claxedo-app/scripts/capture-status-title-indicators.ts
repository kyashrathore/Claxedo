import { chromium, type Page } from "playwright-core"
import path from "node:path"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..")
const RESULT_DIR = path.resolve(
  Bun.env.CLAXEDO_STATUS_TITLE_INDICATORS_DIR ?? path.join(PACKAGE_DIR, "test-results/status-title-indicators"),
)
const RAW_VIDEO_DIR = path.join(RESULT_DIR, "raw")
const baseURL = Bun.env.CLAXEDO_STATUS_TITLE_INDICATORS_URL ??
  `http://localhost:4445/w/${encodeURIComponent(REPO_ROOT)}/session`
const viewport = { width: 1440, height: 900 }

type CapturedEvent = {
  type: "agent.lifecycle"
  tabId: string
  terminalId: string
  provider: string
  prompt: string
  lastAssistantMessage?: string
  eventType: "Busy" | "Idle" | "UserActionRequired"
}

type Snapshot = {
  label: string
  rowText: string
  status: string | null
  dotColor: string
  active: string | null
  screenshot: string
}

await Bun.$`mkdir -p ${RESULT_DIR} ${RAW_VIDEO_DIR}`

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport,
  recordVideo: { dir: RAW_VIDEO_DIR, size: viewport },
})

await context.addInitScript(() => {
  type DemoWindow = typeof window & {
    __CLAXEDO_TEST_AUTH_TOKEN__?: string
    __CLAXEDO_TEST_AUTH_USER__?: unknown
    __claxedoStatusDemoEvents?: Record<string, unknown>[]
  }

  const w = window as DemoWindow
  w.__CLAXEDO_TEST_AUTH_TOKEN__ = "test-bypass-token"
  w.__CLAXEDO_TEST_AUTH_USER__ = {
    id: "status-title-indicators-user",
    primaryEmailAddress: { emailAddress: "status-title-indicators@claxedo.test" },
    fullName: "Status Title Indicators",
  }
  w.__claxedoStatusDemoEvents = []
})

const page = await context.newPage()
const consoleErrors: string[] = []
const pageErrors: string[] = []
const failedResponses: Array<{ url: string; status: number }> = []
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text())
})
page.on("pageerror", (error) => pageErrors.push(error.message))
page.on("response", (response) => {
  if (response.status() >= 400) failedResponses.push({ url: response.url(), status: response.status() })
})

const artifact: Record<string, unknown> = {
  baseURL,
  viewport,
  capturedAt: new Date().toISOString(),
}

try {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" })
  await page.locator('[data-testid="rail-sidebar"]').waitFor({ state: "visible", timeout: 30_000 })
  await ensureSidebarExpanded(page)
  const terminalId = await ensureTerminalRow(page)
  await emitLifecycle(page, terminalId, "Busy")
  const busy = await waitForSnapshot(page, terminalId, "busy", "working")

  await focusSessionRow(page)
  await emitLifecycle(page, terminalId, "Idle")
  const done = await waitForSnapshot(page, terminalId, "done", "done")

  await emitLifecycle(page, terminalId, "UserActionRequired")
  const waiting = await waitForSnapshot(page, terminalId, "waiting", "permission")

  artifact.terminalId = terminalId
  artifact.snapshots = { busy, done, waiting }
  artifact.emittedEvents = await page.evaluate(() =>
    (window as typeof window & { __claxedoStatusDemoEvents?: unknown[] }).__claxedoStatusDemoEvents ?? [])
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
  artifact.failedResponses = failedResponses
  artifact.pass = (
    rowHas(busy, "working") &&
    rowHas(done, "done") &&
    rowHas(waiting, "needs input") &&
    busy.status === "working" &&
    done.status === "done" &&
    waiting.status === "permission" &&
    done.active === "false" &&
    consoleErrors.length === 0 &&
    pageErrors.length === 0 &&
    failedResponses.length === 0
  )
} catch (error) {
  artifact.pass = false
  artifact.error = error instanceof Error ? error.message : String(error)
  artifact.failureUrl = page.url()
  artifact.failureBody = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "")
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
  artifact.failedResponses = failedResponses
} finally {
  const video = page.video()
  await context.close()
  if (video) {
    const target = path.join(RESULT_DIR, "status-title-indicators.webm")
    await video.saveAs(target)
    await video.delete().catch(() => undefined)
    artifact.video = target
  }
  await browser.close()
  await Bun.write(
    path.join(RESULT_DIR, "manifest.json"),
    JSON.stringify(artifact, null, 2) + "\n",
  )
}

if (!artifact.pass) {
  throw new Error(`Status title indicator capture failed; see ${path.join(RESULT_DIR, "manifest.json")}`)
}

console.log(`Status title indicator capture passed: ${path.join(RESULT_DIR, "manifest.json")}`)

async function ensureSidebarExpanded(page: Page) {
  if (
    await page.locator('[data-testid="rail-sidebar-session-row"]').count() ||
    await page.locator('[data-testid="session-content"]').count()
  ) return
  const show = page.locator('button[aria-label="Show Sidebar"]').first()
  if (await show.count()) await show.click()
  await page.locator('[data-testid="rail-sidebar"]').waitFor({ state: "visible", timeout: 30_000 })
}

async function ensureTerminalRow(page: Page) {
  const existing = page.locator('[data-testid="rail-sidebar-terminal-row"]').first()
  if (await existing.count()) return await terminalId(existing)

  const create = page.locator('button[aria-label^="New Codex terminal in "]').first()
  await create.waitFor({ state: "visible", timeout: 30_000 })
  await create.click({ force: true })
  await page.locator('[data-testid="rail-sidebar-terminal-row"]').first().waitFor({ state: "visible", timeout: 30_000 })
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rail-sidebar-terminal-row"]'))
      .some((row) => {
        const id = row.dataset.terminalId
        return id && !id.startsWith("pending-")
      }),
  undefined, { timeout: 30_000 }).catch(() => undefined)
  const id = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rail-sidebar-terminal-row"]'))
    return rows.find((row) => row.dataset.terminalId && !row.dataset.terminalId.startsWith("pending-"))?.dataset.terminalId ??
      rows[0]?.dataset.terminalId
  })
  if (!id) throw new Error("Terminal row is missing data-terminal-id")
  return id
}

async function terminalId(row: ReturnType<Page["locator"]>) {
  const id = await row.getAttribute("data-terminal-id")
  if (!id) throw new Error("Terminal row is missing data-terminal-id")
  return id
}

async function emitLifecycle(page: Page, terminalId: string, eventType: CapturedEvent["eventType"]) {
  const event: CapturedEvent = {
    type: "agent.lifecycle",
    tabId: terminalId,
    terminalId,
    provider: "codex",
    prompt: "status verification turn",
    lastAssistantMessage: "status indicator visible",
    eventType,
  }
  await page.evaluate((payload) => {
    const target = window as typeof window & {
      __claxedoEmitTestEvent?: (event: Record<string, unknown>) => void
      __claxedoStatusDemoEvents?: Record<string, unknown>[]
    }
    const emit = target.__claxedoEmitTestEvent
    if (!emit) throw new Error("Status demo event emitter is unavailable")
    target.__claxedoStatusDemoEvents?.push(payload)
    emit(payload)
  }, event)
}

async function focusSessionRow(page: Page) {
  const row = page.locator('[data-testid="rail-sidebar-session-row"]').first()
  if (await row.count()) {
    await row.click()
    await page.waitForTimeout(250)
    return
  }
  const session = page.locator('[data-testid="session-content"]').first()
  if (await session.isVisible().catch(() => false)) {
    await session.click({ position: { x: 40, y: 40 }, force: true })
    await page.waitForTimeout(250)
    return
  }
  const createSession = page.locator('button[aria-label^="New session in "]').first()
  await createSession.waitFor({ state: "visible", timeout: 30_000 })
  await createSession.click({ force: true })
  await page.locator('[data-testid="session-content"]').first().waitFor({ state: "visible", timeout: 30_000 })
  await page.waitForTimeout(250)
}

async function waitForSnapshot(page: Page, terminalId: string, label: string, status: string): Promise<Snapshot> {
  const row = page.locator(`[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${terminalId}"]`).first()
  await row.waitFor({ state: "visible", timeout: 30_000 })
  await page.waitForFunction(
    ({ terminalId, status }) => {
      const row = document.querySelector<HTMLElement>(
        `[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${terminalId}"]`,
      )
      const dot = row?.querySelector<HTMLElement>("[data-sidebar-status]")
      return dot?.dataset.sidebarStatus === status
    },
    { terminalId, status },
    { timeout: 10_000 },
  )
  await row.scrollIntoViewIfNeeded()
  await page.waitForTimeout(150)
  const screenshot = path.join(RESULT_DIR, `${label}.png`)
  await page.screenshot({ path: screenshot })
  return await row.evaluate((node, input) => {
    const dot = node.querySelector<HTMLElement>("[data-sidebar-status]")
    return {
      label: input.label,
      rowText: node.innerText,
      status: dot?.dataset.sidebarStatus ?? null,
      dotColor: dot ? getComputedStyle(dot).backgroundColor : "",
      active: node.dataset.active ?? null,
      screenshot: input.screenshot,
    }
  }, { label, screenshot })
}

function rowHas(snapshot: Snapshot, text: string) {
  return snapshot.rowText.toLowerCase().includes(text.toLowerCase())
}
