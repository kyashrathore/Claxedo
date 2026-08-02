import { chromium, type BrowserContext, type Page, type Route } from "playwright-core"
import path from "node:path"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const RESULT_DIR = path.resolve(
  Bun.env.CLAXEDO_P4_REVIEW_RECONNECT_MOTION_DIR ?? path.join(PACKAGE_DIR, "test-results/workspace-panel-motion"),
)
const RAW_VIDEO_DIR = path.join(Bun.env.TMPDIR ?? "/tmp", `claxedo-p4-review-reconnect-motion-raw-${Date.now()}`)
const WORKSPACE_ID = Bun.env.CLAXEDO_P4_REVIEW_RECONNECT_WORKSPACE_ID ?? "ws_p4_review_reconnect_motion"
const baseURL = Bun.env.CLAXEDO_P4_REVIEW_RECONNECT_MOTION_URL ?? `http://localhost:4445/w/${WORKSPACE_ID}/session`
const viewport = { width: 1280, height: 800 }
const REVIEW_FILE = "src/app/controls/link.tsx"
const REVIEW_DIFFS = [{
  file: REVIEW_FILE,
  before: "export function Button() {\n  return <button>Click me</button>\n}\n",
  after: "export function Button(props: { label: string }) {\n  return <button>{props.label}</button>\n}\n",
  additions: 1,
  deletions: 1,
  status: "modified",
}]

type Snapshot = {
  name: string
  atMs: number
  connectionStatus?: string
  panelOpen: boolean
  panelStateOpen?: string
  panelStateMode?: string
  panelWorkspaceDir?: string
  reviewReady?: string
  reviewVisible: boolean
  reviewLoading: boolean
  pendingVisible: boolean
  pendingText: string
  reviewTextLength: number
  reviewLoads: number
  failedMessages: number
}

await Bun.$`mkdir -p ${RESULT_DIR} ${RAW_VIDEO_DIR}`

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport,
  recordVideo: { dir: RAW_VIDEO_DIR, size: viewport },
})
await context.addInitScript((args: { workspaceId: string }) => {
  const appWindow = window as typeof window & {
    __OPENCODE__?: { serverUrl?: string; activeDirectory?: string }
    __CLAXEDO_TEST_AUTH_TOKEN__?: string
    __CLAXEDO_TEST_AUTH_USER__?: unknown
    __CLAXEDO_REVIEW_LOAD_LOG__?: unknown[]
    __CLAXEDO_RECONNECT_MOTION_SNAPSHOT__?: (name: string, startAt: number) => Snapshot
    __claxedoConnections?: { snapshot?: () => Record<string, { status?: string }> }
  }
  localStorage.clear()
  appWindow.__OPENCODE__ = {
    serverUrl: window.location.origin,
    activeDirectory: args.workspaceId,
  }
  localStorage.setItem(
    "opencode.global.dat:server",
    JSON.stringify({
      list: [],
      projects: {
        local: [{ worktree: args.workspaceId, expanded: true }],
      },
      lastProject: {},
      workspaceServer: {},
      closedProjects: {},
    }),
  )
  localStorage.setItem(
    "opencode.global.dat:model",
    JSON.stringify({
      recent: [{ providerID: "claude-acp", modelID: "claude-sonnet-4-6" }],
      user: [],
      variant: {},
    }),
  )
  appWindow.__CLAXEDO_TEST_AUTH_TOKEN__ = "test-bypass-token"
  appWindow.__CLAXEDO_TEST_AUTH_USER__ = {
    id: "review-reconnect-motion-user",
    primaryEmailAddress: { emailAddress: "review-reconnect-motion@claxedo.test" },
    fullName: "Review Reconnect Motion",
  }
  appWindow.__CLAXEDO_REVIEW_LOAD_LOG__ = []
  window.addEventListener("claxedo:review-vcs-load", (event) => {
    appWindow.__CLAXEDO_REVIEW_LOAD_LOG__?.push(event instanceof CustomEvent ? event.detail : undefined)
  })
  const visible = (element: HTMLElement | null) => {
    if (!element) return false
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
      Number(style.opacity || "1") > 0.01
  }
  appWindow.__CLAXEDO_RECONNECT_MOTION_SNAPSHOT__ = (name: string, startAt: number) => {
    const panel = document.querySelector<HTMLElement>('[data-testid="workspace-panel-shell"]')
    const review = document.querySelector<HTMLElement>('[data-testid="review-pane-root"]')
    const pending = document.querySelector<HTMLElement>('[data-testid="workspace-review-pending"]')
    const reviewRegion = document.querySelector<HTMLElement>("[data-review-workspace-id]")
    const connections = appWindow.__claxedoConnections?.snapshot?.() as Record<string, { status?: string }> | undefined
    const text = document.body.textContent ?? ""
    return {
      name,
      atMs: performance.now() - startAt,
      connectionStatus: connections?.[args.workspaceId]?.status,
      panelOpen: panel?.dataset.open === "true",
      panelStateOpen: panel?.dataset.stateOpen,
      panelStateMode: panel?.dataset.stateMode,
      panelWorkspaceDir: panel?.dataset.stateWorkspaceDir,
      reviewReady: reviewRegion?.dataset.reviewWorkspaceReady,
      reviewVisible: visible(review),
      reviewLoading: !!document.querySelector('[data-testid="review-pane-loading"]'),
      pendingVisible: visible(pending),
      pendingText: pending?.textContent?.trim() ?? "",
      reviewTextLength: review?.textContent?.trim().length ?? 0,
      reviewLoads: appWindow.__CLAXEDO_REVIEW_LOAD_LOG__?.length ?? 0,
      failedMessages: (text.match(/Failed to load|CancelledError|Something went wrong|uncaught error/gi) ?? []).length,
    }
  }
}, { workspaceId: WORKSPACE_ID })

const page = await context.newPage()
const consoleErrors: string[] = []
const pageErrors: string[] = []
const failedRequests: string[] = []
const badResponses: string[] = []
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
    consoleErrors.push(message.text())
  }
})
page.on("pageerror", (error) => pageErrors.push(error.message))
page.on("requestfailed", (request) => {
  failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
})
page.on("response", (response) => {
  if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`)
})
await mockWorkspaceShell(page)

const artifact: Record<string, unknown> = {
  baseURL,
  workspaceId: WORKSPACE_ID,
  viewport,
  capturedAt: new Date().toISOString(),
}

try {
  await waitForApp(page)
  await openSessionSurface(page)
  await ensureWorkspacePanelOpen(page)
  await waitForReviewSettled(page)

  const startAt = await page.evaluate(() => performance.now())
  const baseline = await snapshot(page, "baseline", startAt)
  const startingLoads = baseline.reviewLoads

  await page.waitForTimeout(240)
  await markWorkspaceReconnecting(page)
  await waitForConnectionStatus(page, "reconnecting")
  const reconnecting = await snapshot(page, "reconnecting", startAt)
  await page.waitForTimeout(650)
  const reconnectingHeld = await snapshot(page, "reconnecting-held", startAt)

  await markWorkspaceReconnected(page)
  await waitForConnectionStatus(page, "ready")
  await waitForReviewSettled(page)
  await page.waitForTimeout(300)
  const recovered = await snapshot(page, "recovered", startAt)

  const screenshot = path.join(RESULT_DIR, "p4-review-reconnect-motion-final.png")
  await page.screenshot({ path: screenshot })
  const samples = [baseline, reconnecting, reconnectingHeld, recovered]
  const panelStayedOpen = samples.every((sample) =>
    sample.panelOpen &&
    sample.panelStateOpen === "true" &&
    sample.panelStateMode === "review" &&
    sample.panelWorkspaceDir === WORKSPACE_ID
  )
  const pendingCoversReconnect = [reconnecting, reconnectingHeld].every((sample) =>
    sample.connectionStatus === "reconnecting" &&
    sample.reviewReady === "false" &&
    sample.pendingVisible &&
    sample.pendingText.includes("Connecting to workspace") &&
    !sample.reviewVisible
  )
  const reviewReturnsWarm = baseline.reviewVisible &&
    recovered.reviewVisible &&
    !baseline.reviewLoading &&
    !recovered.reviewLoading &&
    baseline.reviewTextLength > 0 &&
    recovered.reviewTextLength > 0
  const noReviewRefetchDuringReconnect = samples.every((sample) => sample.reviewLoads === startingLoads)
  const integrityPass = panelStayedOpen &&
    pendingCoversReconnect &&
    reviewReturnsWarm &&
    noReviewRefetchDuringReconnect &&
    samples.every((sample) => sample.failedMessages === 0) &&
    consoleErrors.length === 0 &&
    pageErrors.length === 0 &&
    failedRequests.length === 0 &&
    badResponses.length === 0

  artifact.samples = samples
  artifact.panelStayedOpen = panelStayedOpen
  artifact.pendingCoversReconnect = pendingCoversReconnect
  artifact.reviewReturnsWarm = reviewReturnsWarm
  artifact.noReviewRefetchDuringReconnect = noReviewRefetchDuringReconnect
  artifact.integrityPass = integrityPass
  artifact.finalScreenshot = screenshot
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
  artifact.failedRequests = failedRequests
  artifact.badResponses = badResponses
  artifact.pass = integrityPass
} catch (error) {
  artifact.pass = false
  artifact.error = error instanceof Error ? error.message : String(error)
  artifact.failureUrl = page.url()
  artifact.failureTitle = await page.title().catch(() => "")
  artifact.failureBody = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "")
  artifact.consoleErrors = consoleErrors
  artifact.pageErrors = pageErrors
  artifact.failedRequests = failedRequests
  artifact.badResponses = badResponses
} finally {
  const videoPath = await closeContextAndSaveVideo(context, page)
  artifact.video = videoPath
  await browser.close()
  await Bun.write(path.join(RESULT_DIR, "p4-review-reconnect-motion-manifest.json"), JSON.stringify(artifact, null, 2) + "\n")
}

if (!artifact.pass) {
  throw new Error(`P4 review reconnect motion capture failed; see ${path.join(RESULT_DIR, "p4-review-reconnect-motion-manifest.json")}`)
}

console.log(`P4 review reconnect motion capture passed: ${path.join(RESULT_DIR, "p4-review-reconnect-motion-manifest.json")}`)

async function mockWorkspaceShell(page: Page) {
  let pty = 1
  const configs = [{
    id: "cfg-dev",
    name: "dev-server",
    command: "echo dev",
    args: [],
    cwd: "",
    env: {},
    autoStart: false,
    restartPolicy: "never",
    maxRestarts: 3,
    color: "#3b82f6",
  }]
  const project = {
    id: "proj_review_reconnect_motion",
    name: "review-reconnect-motion",
    worktree: WORKSPACE_ID,
    sandboxes: [],
    workspaces: {
      [WORKSPACE_ID]: {
        id: WORKSPACE_ID,
        workspaceId: WORKSPACE_ID,
        kind: "user-hosted",
        directory: WORKSPACE_ID,
      },
    },
  }
  const provider = {
    all: [{
      id: "claude-acp",
      name: "Claude",
      models: {
        "claude-sonnet-4-6": {
          id: "claude-sonnet-4-6",
          name: "Sonnet 4.6",
          providerID: "claude-acp",
        },
      },
    }],
    default: { "claude-acp": "claude-sonnet-4-6" },
    connected: [],
  }
  const config = {
    provider: { id: "claude-acp", model: "claude-sonnet-4-6" },
    agent: { id: "build" },
  }
  const json = async (route: Route, body: unknown) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  }
  const api = (route: Route, url: URL) => {
    const type = route.request().resourceType()
    if (type === "fetch" || type === "xhr" || type === "eventsource") return true
    return url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/workspaces/") ||
      ["/project", "/experimental/project", "/project/current", "/global/config", "/config", "/app/agents", "/agent",
        "/command", "/file/status", "/file", "/find/file", "/health", "/path", "/session", "/session/vcs-diff",
        "/provider", "/provider/auth", "/global/event", "/event"].includes(url.pathname) ||
      /\/process\/?$/.test(url.pathname)
  }

  await page.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "authorization,content-type,accept",
          "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        },
      })
      return
    }
    if (!api(route, url)) {
      await route.continue()
      return
    }
    if (url.pathname === "/api/claxedo/bootstrap") {
      await json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: WORKSPACE_ID, directory: WORKSPACE_ID, home: "" },
        project: [project],
        provider,
        provider_auth: { "claude-acp": [{ type: "api", label: "API key" }] },
        config,
      })
      return
    }
    if (url.pathname === "/api/workspace/resolve") {
      await json(route, {
        workspaceId: WORKSPACE_ID,
        projectId: project.id,
        directory: WORKSPACE_ID,
        kind: "user-hosted",
        access: "user-hosted",
        status: "ready",
        backing: { kind: "workspace-runtime" },
      })
      return
    }
    if (url.pathname === `/api/workspace/${WORKSPACE_ID}/connection`) {
      await json(route, {
        access: "user-hosted",
        backing: "local-worktree",
        runtimeKind: "user-hosted",
        workspaceId: WORKSPACE_ID,
        relayUrl: url.origin,
        runtimeAccessToken: "runtime-access-token",
        tokenExpiresAt: Date.now() + 60_000,
        role: "owner",
      })
      return
    }
    if (url.pathname === `/api/workspace/${WORKSPACE_ID}/connection/refresh`) {
      await json(route, {
        access: "user-hosted",
        backing: "local-worktree",
        runtimeKind: "user-hosted",
        workspaceId: WORKSPACE_ID,
        relayUrl: url.origin,
        runtimeAccessToken: "runtime-access-token",
        tokenExpiresAt: Date.now() + 60_000,
        role: "owner",
      })
      return
    }
    const runtimePath = url.pathname.startsWith(`/workspaces/${WORKSPACE_ID}/`)
      ? url.pathname.slice(`/workspaces/${WORKSPACE_ID}`.length)
      : undefined
    if (runtimePath === "/agent") {
      await json(route, [{ id: "build", name: "build", mode: "primary" }])
      return
    }
    if (runtimePath === "/command") {
      await json(route, [])
      return
    }
    if (runtimePath === "/provider") {
      await json(route, provider)
      return
    }
    if (runtimePath === "/vcs") {
      await json(route, { branch: "main", default_branch: "main" })
      return
    }
    if (runtimePath === "/api/wr/diff/refs") {
      await json(route, { branches: ["main"], tags: [], recent: [] })
      return
    }
    if (runtimePath === "/api/wr/diff/targets") {
      await json(route, { defaultRef: "main", candidates: ["main", "HEAD~1"] })
      return
    }
    if (url.pathname === "/api/control/sessions" || url.pathname === "/api/control/session-list") {
      await json(route, { sessions: [], nextCursor: null })
      return
    }
    if (
      url.pathname === "/api/claxedo/events" ||
      url.pathname === "/api/wr/events" ||
      url.pathname === "/api/wr/runtime-events" ||
      url.pathname === "/global/event" ||
      url.pathname === "/event" ||
      url.pathname.endsWith("/api/wr/events") ||
      url.pathname.endsWith("/api/wr/runtime-events")
    ) {
      if (url.pathname.startsWith(`/workspaces/${WORKSPACE_ID}/`)) {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify({ type: "workspace.connected", properties: { workspaceId: WORKSPACE_ID } })}\n\n`,
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n`,
      })
      return
    }
    if (url.pathname === "/project" || url.pathname === "/experimental/project") {
      await json(route, [project])
      return
    }
    if (url.pathname === "/project/current" || url.pathname === `/project/${project.id}`) {
      await json(route, project)
      return
    }
    if (url.pathname === "/global/config" || url.pathname === "/config") {
      await json(route, config)
      return
    }
    if (url.pathname === "/app/agents" || url.pathname === "/agent") {
      await json(route, [{ id: "build", name: "build", mode: "primary" }])
      return
    }
    if (url.pathname === "/command" || url.pathname === "/api/claxedo/agent-config/commands") {
      await json(route, [])
      return
    }
    if (url.pathname.endsWith("/api/wr/diff/vcs") || url.pathname === "/api/claxedo/diff/vcs") {
      await json(route, REVIEW_DIFFS)
      return
    }
    if (url.pathname === "/file/status") {
      await json(route, [{ path: REVIEW_FILE, status: "modified" }])
      return
    }
    if (url.pathname === "/file") {
      await json(route, [{
        name: "button.tsx",
        path: REVIEW_FILE,
        absolute: `${WORKSPACE_ID}/${REVIEW_FILE}`,
        type: "file",
        ignored: false,
      }])
      return
    }
    if (url.pathname === "/find/file") {
      await json(route, [REVIEW_FILE])
      return
    }
    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      await json(route, { healthy: true, version: "1.0.0-test" })
      return
    }
    if (url.pathname === "/path") {
      await json(route, { worktree: WORKSPACE_ID })
      return
    }
    if (url.pathname === "/session") {
      await json(route, [])
      return
    }
    if (url.pathname === `/workspaces/${WORKSPACE_ID}/session`) {
      await json(route, [])
      return
    }
    if (url.pathname === "/session/vcs-diff") {
      await json(route, REVIEW_DIFFS)
      return
    }
    if (/\/process\/?$/.test(url.pathname)) {
      await json(route, { configs, processes: [] })
      return
    }
    if (url.pathname === "/provider") {
      await json(route, provider)
      return
    }
    if (url.pathname === "/provider/auth") {
      await json(route, { "claude-acp": [{ type: "api", label: "API key" }] })
      return
    }
    if (url.pathname === "/api/claxedo/agent-config/harness") {
      await json(route, { type: "claude-acp", ok: true })
      return
    }
    if (url.pathname === "/api/claxedo/pty") {
      const body = route.request().postDataJSON() as { title?: string; cwd?: string } | undefined
      const id = `pty-${pty++}`
      await json(route, { id, title: body?.title ?? `Terminal ${pty}`, cwd: body?.cwd ?? WORKSPACE_ID })
      return
    }
    if (url.pathname.startsWith("/api/claxedo/pty/")) {
      await json(route, true)
      return
    }
    await route.continue()
  })
}

async function waitForApp(page: Page) {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" })
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})
  await page.locator("[data-claxedo]").waitFor({ state: "visible", timeout: 30_000 })
}

async function openSessionSurface(page: Page) {
  if (await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false)) return
  await page.getByRole("button", { name: "New Session", exact: true }).first().click()
  await page.getByRole("textbox", { name: /Ask anything/i }).waitFor({ state: "visible", timeout: 10_000 })
}

async function ensureWorkspacePanelOpen(page: Page) {
  if (await page.locator('[data-testid="workspace-panel-shell"][data-open="true"]').isVisible().catch(() => false)) return
  await page.getByRole("button", { name: "Open workspace panel", exact: true }).first().click()
  await page.waitForFunction(() =>
    document.querySelector<HTMLElement>('[data-testid="workspace-panel-shell"]')?.dataset.open === "true",
    undefined,
    { timeout: 10_000 },
  )
}

async function waitForReviewSettled(page: Page) {
  await page.locator('[data-testid="review-pane-root"]').waitFor({ state: "visible", timeout: 20_000 })
  await page.locator(`[data-review-file="${REVIEW_FILE}"]`).first().waitFor({ state: "visible", timeout: 20_000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid="review-pane-loading"]'), undefined, {
    timeout: 20_000,
  }).catch(() => {})
}

async function snapshot(page: Page, name: string, startAt: number) {
  return await page.evaluate(({ name, startAt }) =>
    (window as typeof window & {
      __CLAXEDO_RECONNECT_MOTION_SNAPSHOT__: (name: string, startAt: number) => Snapshot
    }).__CLAXEDO_RECONNECT_MOTION_SNAPSHOT__(name, startAt),
    { name, startAt },
  )
}

async function markWorkspaceReconnecting(page: Page) {
  await page.evaluate((workspaceId) => {
    const hook = (window as typeof window & {
      __claxedoConnections?: { markReconnecting?: (workspaceId: string) => void }
    }).__claxedoConnections?.markReconnecting
    if (typeof hook !== "function") throw new Error("Workspace reconnect hook missing")
    hook(workspaceId)
  }, WORKSPACE_ID)
}

async function markWorkspaceReconnected(page: Page) {
  await page.evaluate((workspaceId) => {
    const hook = (window as typeof window & {
      __claxedoConnections?: { markReconnected?: (workspaceId: string) => void }
    }).__claxedoConnections?.markReconnected
    if (typeof hook !== "function") throw new Error("Workspace reconnected hook missing")
    hook(workspaceId)
  }, WORKSPACE_ID)
}

async function waitForConnectionStatus(page: Page, status: string) {
  await page.waitForFunction(
    ({ workspaceId, status }) =>
      (window as typeof window & {
        __claxedoConnections?: { snapshot?: () => Record<string, { status?: string }> }
      }).__claxedoConnections?.snapshot?.()[workspaceId]?.status === status,
    { workspaceId: WORKSPACE_ID, status },
    { timeout: 10_000 },
  )
}

async function closeContextAndSaveVideo(context: BrowserContext, page: Page) {
  const video = page.video()
  await page.close().catch(() => {})
  await context.close().catch(() => {})
  const raw = video ? await video.path().catch(() => undefined) : undefined
  if (!raw) return undefined
  const target = path.join(RESULT_DIR, "p4-review-reconnect-motion.webm")
  await Bun.$`mv ${raw} ${target}`
  return target
}
