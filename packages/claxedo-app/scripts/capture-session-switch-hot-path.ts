import { chromium, type Page } from "playwright-core"
import path from "node:path"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..")
const RESULT_DIR = path.resolve(
  Bun.env.CLAXEDO_SESSION_SWITCH_HOT_PATH_DIR ?? path.join(PACKAGE_DIR, "test-results/session-switch-hot-path"),
)
const RAW_VIDEO_DIR = path.join(RESULT_DIR, "raw")
const baseURL = Bun.env.CLAXEDO_SESSION_SWITCH_HOT_PATH_URL ??
  `http://localhost:4445/w/${encodeURIComponent(REPO_ROOT)}/session`
const serverURL = (Bun.env.CLAXEDO_SERVER_URL ?? Bun.env.VITE_CLAXEDO_SERVER_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "")
const workspaceDirectory = new URL(baseURL).pathname.match(/^\/w\/([^/]+)/)?.[1]
  ? decodeURIComponent(new URL(baseURL).pathname.match(/^\/w\/([^/]+)/)![1]!)
  : REPO_ROOT
const viewport = { width: 1280, height: 800 }
const firstFoldBudgetMs = 30
const hotPathWindowMs = 30
const prefetchWarmMs = 1_000

type RequestLog = {
  url: string
  atMs: number
}

type SessionRow = {
  sessionId: string
  workspaceDir: string
  active: boolean
  text: string
}

type BackendSession = {
  id: string
  title?: string
}

await Bun.$`mkdir -p ${RESULT_DIR} ${RAW_VIDEO_DIR}`

const seededSessions = await ensureBackendSessionRows()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport,
  recordVideo: { dir: RAW_VIDEO_DIR, size: viewport },
})
await context.addInitScript((useTestAuth) => {
  const w = window as typeof window & {
    __CLAXEDO_TEST_AUTH_TOKEN__?: string
    __CLAXEDO_TEST_AUTH_USER__?: unknown
    __claxedoSessionSwitchRequests?: RequestLog[]
    __claxedoSessionSwitchStart?: number
  }
  if (useTestAuth) {
    w.__CLAXEDO_TEST_AUTH_TOKEN__ = "test-bypass-token"
    w.__CLAXEDO_TEST_AUTH_USER__ = {
      id: "session-switch-hot-path-user",
      primaryEmailAddress: { emailAddress: "session-switch-hot-path@claxedo.test" },
      fullName: "Session Switch Hot Path",
    }
  }
  w.__claxedoSessionSwitchRequests = []
  const originalFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const start = w.__claxedoSessionSwitchStart
    if (start !== undefined) {
      w.__claxedoSessionSwitchRequests?.push({
        url,
        atMs: performance.now() - start,
      })
    }
    return originalFetch(input, init)
  }) as typeof fetch
}, Bun.env.CLAXEDO_SESSION_SWITCH_TEST_AUTH === "1")

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
  firstFoldBudgetMs,
  hotPathWindowMs,
  prefetchWarmMs,
  capturedAt: new Date().toISOString(),
  seededSessions,
}

try {
  await waitForApp(page)
  await ensureSidebarVisible(page)
  const firstRows = await waitForSessionRows(page)
  if (firstRows.length < 2) throw new Error(`Need at least two visible session rows, found ${firstRows.length}`)

  const initialActive = firstRows.find((row) => row.active) ?? firstRows[0]!
  if (
    !initialActive.active ||
    !await hasVisibleSessionContent(page, initialActive.sessionId)
  ) {
    await clickSessionRow(page, initialActive.sessionId)
    await waitForSessionFirstFold(page, initialActive.sessionId)
  }
  await page.waitForTimeout(prefetchWarmMs)

  const rows = await waitForSessionRows(page)
  const visibleSessionId = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="session-content"]'))
      .find((node) => {
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })?.dataset.sessionId)
  const active = rows.find((row) => row.sessionId === visibleSessionId) ?? rows.find((row) => row.active) ?? initialActive
  const target = rows.find((row) => row.workspaceDir === active.workspaceDir && row.sessionId !== active.sessionId)
  if (!target) {
    throw new Error(`Need an inactive same-workspace session row; rows=${JSON.stringify(rows)}`)
  }

  await clickSessionRow(page, target.sessionId)
  await waitForSessionFirstFold(page, target.sessionId)
  await page.waitForTimeout(100)
  await clickSessionRow(page, active.sessionId)
  await waitForSessionFirstFold(page, active.sessionId)
  await page.waitForTimeout(prefetchWarmMs)

  const warmedRows = await waitForSessionRows(page)
  const warmedActive = warmedRows.find((row) => row.sessionId === active.sessionId) ?? active
  const warmedTarget = warmedRows.find((row) => row.sessionId === target.sessionId) ?? target

  const beforeUrl = page.url()
  const result = await measureSessionSwitch(page, warmedTarget.sessionId)
  await page.waitForTimeout(Math.max(0, hotPathWindowMs - result.firstFoldMs) + 20)
  const requests = await page.evaluate(() =>
    (window as typeof window & { __claxedoSessionSwitchRequests?: RequestLog[] }).__claxedoSessionSwitchRequests ?? [])
  const hotPathRequests = requests.filter((request) => request.atMs <= hotPathWindowMs)
  const hotPathApiCalls = hotPathRequests.filter((request) => isHotPathApi(request.url))
  const screenshot = path.join(RESULT_DIR, "session-switch-hot-path-final.png")
  await page.screenshot({ path: screenshot })

  artifact.beforeUrl = beforeUrl
  artifact.afterUrl = page.url()
  artifact.active = warmedActive
  artifact.target = warmedTarget
  artifact.result = result
  artifact.requests = requests
  artifact.hotPathRequests = hotPathRequests
  artifact.hotPathApiCalls = hotPathApiCalls
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
  artifact.finalScreenshot = screenshot
  artifact.pass = (
    result.firstFoldMs <= firstFoldBudgetMs &&
    hotPathApiCalls.length === 0 &&
    consoleErrors.length === 0 &&
    pageErrors.length === 0
  )
} catch (error) {
  artifact.pass = false
  artifact.error = error instanceof Error ? error.message : String(error)
  artifact.failureUrl = page.url()
  artifact.failureBody = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "")
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
} finally {
  const video = page.video()
  await context.close()
  if (video) {
    const target = path.join(RESULT_DIR, "session-switch-hot-path.webm")
    await video.saveAs(target)
    await video.delete().catch(() => undefined)
    artifact.video = target
  }
  await browser.close()
  await cleanupSeededSessions(seededSessions)
  await Bun.write(
    path.join(RESULT_DIR, "session-switch-hot-path-manifest.json"),
    JSON.stringify(artifact, null, 2) + "\n",
  )
}

if (!artifact.pass) {
  throw new Error(`Session switch hot path failed; see ${path.join(RESULT_DIR, "session-switch-hot-path-manifest.json")}`)
}

console.log(`Session switch hot path passed: ${path.join(RESULT_DIR, "session-switch-hot-path-manifest.json")}`)

async function waitForApp(page: Page) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" })
  await page.locator('[data-testid="rail-sidebar"]').waitFor({ state: "visible", timeout: 30_000 })
  await page.locator('[data-testid="workbench-column"]').waitFor({ state: "visible", timeout: 30_000 })
  await waitForSessionRows(page)
}

async function ensureBackendSessionRows() {
  const existing = await listBackendSessions()
  if (existing.length >= 2) return []
  const created: BackendSession[] = []
  for (let i = existing.length; i < 2; i++) {
    created.push(await createBackendSession(`Hot path verifier seed ${i + 1}`))
  }
  return created
}

async function listBackendSessions(): Promise<BackendSession[]> {
  const url = `${serverURL}/session?directory=${encodeURIComponent(workspaceDirectory)}&roots=true&limit=55`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to list backend sessions: ${res.status} ${await res.text().catch(() => "")}`)
  const data = await res.json().catch(() => [])
  return Array.isArray(data)
    ? data.flatMap((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
      ? [{ id: (item as { id: string; title?: string }).id, title: (item as { title?: string }).title }]
      : [])
    : []
}

async function createBackendSession(title: string): Promise<BackendSession> {
  const res = await fetch(`${serverURL}/session?directory=${encodeURIComponent(workspaceDirectory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(`Failed to create backend session: ${res.status} ${await res.text().catch(() => "")}`)
  const data = await res.json()
  if (!data || typeof data.id !== "string") throw new Error(`Session create missing id: ${JSON.stringify(data)}`)
  return { id: data.id, title: typeof data.title === "string" ? data.title : title }
}

async function cleanupSeededSessions(sessions: BackendSession[]) {
  await Promise.all(sessions.map((session) =>
    fetch(`${serverURL}/session/${encodeURIComponent(session.id)}?directory=${encodeURIComponent(workspaceDirectory)}`, {
      method: "DELETE",
    }).catch(() => undefined),
  ))
}

async function ensureSidebarVisible(page: Page) {
  if (await page.locator('[data-testid="rail-sidebar"] [data-testid="rail-sidebar-session-row"]').count()) return
  const show = page.locator('button[aria-label="Show Sidebar"]').first()
  if (await show.count()) await show.click()
  await waitForSessionRows(page)
}

async function waitForSessionRows(page: Page) {
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-testid="rail-sidebar-session-row"]').length >= 2,
    undefined,
    { timeout: 20_000 },
  )
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rail-sidebar-session-row"]'))
      .map((row) => ({
        sessionId: row.dataset.sessionId ?? "",
        workspaceDir: row.dataset.workspaceDir ?? "",
        active: row.dataset.active === "true",
        text: row.innerText.trim(),
      }))
      .filter((row) => row.sessionId && row.workspaceDir))
}

async function clickSessionRow(page: Page, sessionId: string) {
  await page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${cssEscape(sessionId)}"]`).first().click()
}

async function measureSessionSwitch(page: Page, sessionId: string) {
  return await page.evaluate(async ({ sessionId }) => {
    const row = document.querySelector<HTMLElement>(`[data-testid="rail-sidebar-session-row"][data-session-id="${CSS.escape(sessionId)}"]`)
    if (!row) throw new Error(`Missing session row ${sessionId}`)
    const w = window as typeof window & {
      __claxedoSessionSwitchRequests?: RequestLog[]
      __claxedoSessionSwitchStart?: number
    }
    w.__claxedoSessionSwitchRequests = []
    const start = performance.now()
    w.__claxedoSessionSwitchStart = start
    const sessionContentIds = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid="session-content"], [data-testid="session-page-root"]'))
        .map((el) => ({
          testid: el.dataset.testid ?? el.getAttribute("data-testid") ?? "",
          contentId: el.dataset.contentId ?? "",
          sessionId: el.dataset.sessionId ?? "",
          rect: (() => {
            const rect = el.getBoundingClientRect()
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          })(),
          messageCount: el.dataset.sessionMessageCount ?? "",
          messagesReady: el.dataset.sessionMessagesReady ?? "",
        }))
    const beforeClickContent = sessionContentIds()
    row.click()
    const clickHandlerMs = performance.now() - start
    const afterClickContent = sessionContentIds()
    const firstFoldPromise = new Promise<{ firstFoldMs: number; messageRows: number; sessionContent: boolean; composerVisible: boolean }>((resolve, reject) => {
      const deadline = start + 2_000
      const tick = () => {
        const content = document.querySelector<HTMLElement>(`[data-testid="session-content"][data-session-id="${CSS.escape(sessionId)}"]`)
        const messageRows = document.querySelectorAll('[data-slot="session-turn-message-container"]').length
        const contentVisible = !!content && (() => {
          const rect = content.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        })()
        const composerVisible = Array.from(document.querySelectorAll<HTMLElement>("textarea, [contenteditable='true'], input"))
          .some((node) => {
            const rect = node.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          })
        if (contentVisible && (messageRows > 0 || composerVisible || content?.dataset.sessionMessagesReady === "true")) {
          resolve({
            firstFoldMs: performance.now() - start,
            messageRows,
            sessionContent: true,
            composerVisible,
          })
          return
        }
        if (performance.now() > deadline) {
          reject(new Error(`Timed out waiting for first fold for ${sessionId}; messageRows=${messageRows}; content=${!!content}`))
          return
        }
        requestAnimationFrame(tick)
      }
      tick()
    })
    await Promise.resolve()
    const microtaskMs = performance.now() - start
    const afterMicrotaskContent = sessionContentIds()
    const firstFrameMs = await new Promise<number>((resolve) =>
      requestAnimationFrame(() => resolve(performance.now() - start)))
    const afterFirstFrameContent = sessionContentIds()
    const firstFold = await firstFoldPromise
    return {
      ...firstFold,
      clickHandlerMs,
      microtaskMs,
      firstFrameMs,
      selectedRowActive: row.dataset.active === "true",
      beforeClickContent,
      afterClickContent,
      afterMicrotaskContent,
      afterFirstFrameContent,
    }
  }, { sessionId })
}

async function waitForSessionFirstFold(page: Page, sessionId: string) {
  await page.waitForFunction((sessionId) =>
    Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="session-content"][data-session-id="${CSS.escape(sessionId)}"]`))
      .some((node) => {
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }) &&
    (
      document.querySelectorAll('[data-slot="session-turn-message-container"]').length > 0 ||
      Array.from(document.querySelectorAll<HTMLElement>("textarea, [contenteditable='true'], input"))
        .some((node) => {
          const rect = node.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        })
    ),
    sessionId,
    { timeout: 10_000 },
  )
}

async function hasVisibleSessionContent(page: Page, sessionId: string) {
  return await page.evaluate((sessionId) =>
    Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="session-content"][data-session-id="${CSS.escape(sessionId)}"]`))
      .some((node) => {
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }),
  sessionId)
}

function isHotPathApi(url: string) {
  return /(?:\/api\/workspace\/resolve|\/session\/[^/?]+\/(?:message|config|capabilities|todo)|\/api\/claxedo\/process|\/api\/claxedo\/diff\/(?:refs|targets|vcs|vcs\/file)|\/file\?|\/session\/status|\/question\?|\/permission\?|\/api\/claxedo\/runtime-events|\/event|\/health)(?:[/?]|$)/.test(url)
}

function cssEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}
