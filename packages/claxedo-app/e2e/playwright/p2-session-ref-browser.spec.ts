import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test"

const LOCAL_DIR = "/tmp/e2e-p2-session-ref-local"
const LOCAL_SESSION_ID = "ses_p2_local"
const LOCAL_FILE_PATH = "local-mode-proof.txt"
const LOCAL_DIFF_PATH = "diff-proof.txt"
const CLOUD_WORKSPACE_ID = "ws_p2_cloud"
const CLOUD_SESSION_ID = "ses_p2_cloud"

type SessionKind = "local" | "cloud"

type Hits = {
  unhandled: string[]
  failed: string[]
  console: string[]
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization,content-type,accept",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: corsHeaders(),
    body: JSON.stringify(body),
  })
}

function provider() {
  return {
    all: [
      {
        id: "claude-acp",
        name: "Claude",
        env: [],
        models: {
          "claude-sonnet-4-6": {
            id: "claude-sonnet-4-6",
            name: "Sonnet 4.6",
            providerID: "claude-acp",
          },
        },
      },
    ],
    default: { "claude-acp": "claude-sonnet-4-6" },
    connected: ["claude-acp"],
  }
}

function session(kind: SessionKind) {
  const cloud = kind === "cloud"
  const id = cloud ? CLOUD_SESSION_ID : LOCAL_SESSION_ID
  return {
    id,
    sessionID: id,
    projectID: cloud ? "proj_p2_cloud" : "proj_p2_local",
    directory: cloud ? "/workspace" : LOCAL_DIR,
    workspaceId: cloud ? CLOUD_WORKSPACE_ID : undefined,
    title: cloud ? "P2 Cloud Session" : "P2 Local Session",
    environment: cloud ? { kind: "cloud" } : { kind: "local" },
    version: "0.0.0-test",
    time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
    summary: { additions: 1, deletions: 0, files: 1 },
  }
}

function message(kind: SessionKind) {
  const id = kind === "cloud" ? CLOUD_SESSION_ID : LOCAL_SESSION_ID
  return [
    {
      info: {
        id: `${id}_msg_1`,
        sessionID: id,
        role: "user",
        time: { created: 1_700_000_000_100 },
        model: { providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
      },
      parts: [
        {
          id: `${id}_part_1`,
          sessionID: id,
          messageID: `${id}_msg_1`,
          type: "text",
          text: kind === "cloud" ? "Cloud route session content" : "Local route session content",
        },
      ],
    },
  ]
}

async function seed(context: BrowserContext) {
  await context.addInitScript((dir: string) => {
    localStorage.clear()
    sessionStorage.clear()
    ;(window as typeof window & {
      __CLAXEDO_TEST_AUTH_TOKEN__?: string
      __CLAXEDO_TEST_AUTH_USER__?: { id: string }
      __OPENCODE__?: { serverUrl?: string; activeDirectory?: string }
    }).__CLAXEDO_TEST_AUTH_TOKEN__ = "test-bypass-token"
    ;(window as typeof window & {
      __CLAXEDO_TEST_AUTH_USER__?: { id: string }
    }).__CLAXEDO_TEST_AUTH_USER__ = { id: "p2-browser-user" }
    ;(window as typeof window & {
      __OPENCODE__?: { serverUrl?: string; activeDirectory?: string }
    }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: dir,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: dir, expanded: true }] },
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
  }, LOCAL_DIR)
}

async function setup(page: Page, hits: Hits) {
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") hits.console.push(`${message.type()}: ${message.text()}`)
  })
  page.on("pageerror", (error) => {
    hits.console.push(`pageerror: ${error.message}`)
  })
  page.on("requestfailed", (request) => {
    hits.failed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
  })

  await page.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const type = request.resourceType()
    if (url.hostname.endsWith(".clerk.accounts.dev")) {
      await json(route, {})
      return
    }
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }
    if (type !== "fetch" && type !== "xhr" && type !== "eventsource") {
      await route.continue()
      return
    }

    if (url.pathname === "/health" || url.pathname === "/global/health" || url.pathname === "/api/claxedo/health") {
      await json(route, { healthy: true, version: "1.0.0-test" })
      return
    }
    if (url.pathname === "/api/claxedo/bootstrap") {
      await json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: LOCAL_DIR, directory: LOCAL_DIR, home: "" },
        project: [
          { id: "proj_p2_local", name: "p2-local", worktree: LOCAL_DIR, sandboxes: [] },
          {
            id: "proj_p2_cloud",
            name: "p2-cloud",
            worktree: "/workspace",
            sandboxes: [],
            workspaces: {
              [CLOUD_WORKSPACE_ID]: { kind: "cloud", directory: "/workspace" },
            },
          },
        ],
        provider: provider(),
        provider_auth: { "claude-acp": [{ type: "api", label: "API key" }] },
        config: { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } },
      })
      return
    }
    if (url.pathname === "/api/claxedo/events" || url.pathname === "/global/event" || url.pathname === "/event") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: `data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n`,
      })
      return
    }
    if (url.pathname === "/api/wr/events" || url.pathname === "/api/wr/runtime-events") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: `data: ${JSON.stringify({ type: "workspace.connected" })}\n\n`,
      })
      return
    }
    if (url.pathname === "/path") {
      await json(route, { state: "", config: "", worktree: LOCAL_DIR, directory: LOCAL_DIR, home: "" })
      return
    }
    if (url.pathname === "/project" || url.pathname === "/experimental/project") {
      await json(route, [
        { id: "proj_p2_local", name: "p2-local", worktree: LOCAL_DIR, sandboxes: [] },
        { id: "proj_p2_cloud", name: "p2-cloud", worktree: "/workspace", sandboxes: [] },
      ])
      return
    }
    if (url.pathname === "/project/current" || url.pathname.startsWith("/project/")) {
      await json(route, { id: "proj_p2_local", name: "p2-local", worktree: LOCAL_DIR, sandboxes: [] })
      return
    }
    if (url.pathname === "/api/workspace") {
      await json(route, {
        workspaces: [{
          workspace_id: CLOUD_WORKSPACE_ID,
          name: "p2-cloud",
          remote_directory: "/workspace",
          directory: "/workspace",
          access: "cloud",
          backing: "cloud-vm",
          role: "editor",
        }],
      })
      return
    }
    if (url.pathname === "/provider") {
      await json(route, provider())
      return
    }
    if (url.pathname === `/workspaces/${CLOUD_WORKSPACE_ID}/provider`) {
      await json(route, provider())
      return
    }
    if (url.pathname === "/provider/auth") {
      await json(route, { "claude-acp": [{ type: "api", label: "API key" }] })
      return
    }
    if (url.pathname === "/config") {
      await json(route, { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } })
      return
    }
    if (url.pathname === "/agent" || url.pathname === "/app/agents" || url.pathname === "/api/claxedo/agent-config/agents") {
      await json(route, [{ id: "build", name: "build", mode: "primary" }])
      return
    }
    if (url.pathname === `/workspaces/${CLOUD_WORKSPACE_ID}/agent`) {
      await json(route, [{ id: "build", name: "build", mode: "primary" }])
      return
    }
    if (url.pathname === "/command" || url.pathname === "/api/claxedo/agent-config/commands") {
      await json(route, [])
      return
    }
    if (url.pathname === `/workspaces/${CLOUD_WORKSPACE_ID}/command`) {
      await json(route, [])
      return
    }
    if (url.pathname === "/api/claxedo/agent-config/harness") {
      await json(route, { type: "claude-acp", model: "claude-sonnet-4-6", ok: true })
      return
    }
    if (url.pathname === "/api/claxedo/agent-config/harness/options") {
      await json(route, {
        options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "claude-sonnet-4-6",
            selectOptions: [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }],
          },
        ],
        source: "runner",
        stale: false,
      })
      return
    }
    if (url.pathname === `/api/workspace/${CLOUD_WORKSPACE_ID}/connection` || url.pathname === `/api/workspace/${CLOUD_WORKSPACE_ID}/connection/refresh`) {
      await json(route, {
        access: "cloud",
        backing: "cloud-vm",
        runtimeKind: "cloud",
        workspaceId: CLOUD_WORKSPACE_ID,
        role: "editor",
        relayUrl: "http://127.0.0.1:3001",
        runtimeAccessToken: "rat_p2_cloud",
        tokenExpiresAt: Date.now() + 120_000,
      })
      return
    }
    if (url.pathname === "/api/workspace/resolve") {
      const workspaceId = url.searchParams.get("workspaceId")
      await json(route, workspaceId === CLOUD_WORKSPACE_ID
        ? { workspaceId: CLOUD_WORKSPACE_ID, directory: "/workspace", kind: "cloud", access: "cloud", backing: "cloud-vm", role: "editor", status: "ready" }
        : { workspaceId: "local-p2", directory: LOCAL_DIR, kind: "local", access: "local", status: "ready" })
      return
    }
    if (url.pathname === "/session" || url.pathname === "/experimental/session") {
      await json(route, [session("local"), session("cloud")])
      return
    }
    if (url.pathname === "/api/control/sessions") {
      const workspaceId = url.searchParams.get("workspaceId")
      await json(route, {
        sessions: workspaceId === CLOUD_WORKSPACE_ID
          ? [{
              id: CLOUD_SESSION_ID,
              title: "P2 Cloud Session",
              created_at: 1_700_000_000_000,
              updated_at: 1_700_000_001_000,
            }]
          : [{
              id: LOCAL_SESSION_ID,
              title: "P2 Local Session",
              directory: LOCAL_DIR,
              projectID: "proj_p2_local",
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_001_000,
            }],
      })
      return
    }
    if (url.pathname === `/api/control/sessions/${CLOUD_SESSION_ID}/messages`) {
      await json(route, { messages: message("cloud") })
      return
    }
    if (url.pathname === "/api/control/session-list") {
      await json(route, { sessions: [session("local")] })
      return
    }
    if (url.pathname === `/api/claxedo/session/${LOCAL_SESSION_ID}/meta` || url.pathname === `/api/claxedo/session/${CLOUD_SESSION_ID}/meta`) {
      await json(route, { session: session(url.pathname.includes(CLOUD_SESSION_ID) ? "cloud" : "local") })
      return
    }
    if (
      url.pathname === `/session/${LOCAL_SESSION_ID}` ||
      url.pathname === `/session/${CLOUD_SESSION_ID}` ||
      url.pathname === `/workspaces/${CLOUD_WORKSPACE_ID}/session/${CLOUD_SESSION_ID}`
    ) {
      await json(route, session(url.pathname.includes(CLOUD_SESSION_ID) ? "cloud" : "local"))
      return
    }
    if (
      url.pathname === `/session/${LOCAL_SESSION_ID}/message` ||
      url.pathname === `/session/${CLOUD_SESSION_ID}/message` ||
      url.pathname === `/workspaces/${CLOUD_WORKSPACE_ID}/session/${CLOUD_SESSION_ID}/message`
    ) {
      await json(route, message(url.pathname.includes(CLOUD_SESSION_ID) ? "cloud" : "local"))
      return
    }
    if (url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff") || url.pathname.endsWith("/capabilities")) {
      await json(route, url.pathname.endsWith("/capabilities")
        ? { transport: "claude-acp", abort: true, reconnect: true, replay: true, permissions: true, questions: true, todos: true, commands: true, fork: true, revert: true, unrevert: true, configOptions: true }
        : [])
      return
    }
    if (url.pathname === "/session/status") {
      await json(route, { [LOCAL_SESSION_ID]: { type: "idle" }, [CLOUD_SESSION_ID]: { type: "idle" } })
      return
    }
    if (
      url.pathname === `/session/${LOCAL_SESSION_ID}/config` ||
      url.pathname === `/session/${CLOUD_SESSION_ID}/config` ||
      url.pathname === `/workspaces/${CLOUD_WORKSPACE_ID}/session/${CLOUD_SESSION_ID}/config`
    ) {
      await json(route, { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } })
      return
    }
    if (url.pathname === `/workspaces/${CLOUD_WORKSPACE_ID}/api/wr/runtime-events`) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: `data: ${JSON.stringify({ type: "workspace.connected" })}\n\n`,
      })
      return
    }
    if (url.pathname === "/permission" || url.pathname === "/question" || url.pathname === "/mcp") {
      await json(route, url.pathname === "/mcp" ? {} : [])
      return
    }
    if (url.pathname === "/vcs" || url.pathname === `/workspaces/${CLOUD_WORKSPACE_ID}/vcs` || url.pathname.endsWith("/api/claxedo/diff/vcs")) {
      await json(route, { branch: "main", default_branch: "main", defaultRef: "origin/dev", candidates: ["origin/dev"] })
      return
    }
    if (url.pathname === "/api/wr/diff/refs" || url.pathname === `/workspaces/${CLOUD_WORKSPACE_ID}/api/wr/diff/refs`) {
      await json(route, { branches: ["main"], tags: [], recent: [] })
      return
    }
    if (url.pathname === "/api/wr/diff/targets" || url.pathname === `/workspaces/${CLOUD_WORKSPACE_ID}/api/wr/diff/targets`) {
      await json(route, { defaultRef: "origin/dev", candidates: ["origin/dev"] })
      return
    }
    if (url.pathname === "/api/wr/diff/vcs" || url.pathname === `/workspaces/${CLOUD_WORKSPACE_ID}/api/wr/diff/vcs`) {
      await json(route, [{
        file: LOCAL_DIFF_PATH,
        status: "modified",
        additions: 1,
        deletions: 1,
        before: "before via SessionRef cwd\n",
        after: "after via SessionRef cwd\n",
        patch: `diff --git a/${LOCAL_DIFF_PATH} b/${LOCAL_DIFF_PATH}
--- a/${LOCAL_DIFF_PATH}
+++ b/${LOCAL_DIFF_PATH}
@@ -1 +1 @@
-before via SessionRef cwd
+after via SessionRef cwd
`,
      }])
      return
    }
    if (url.pathname === "/api/wr/diff/vcs/file" || url.pathname === `/workspaces/${CLOUD_WORKSPACE_ID}/api/wr/diff/vcs/file`) {
      await json(route, {
        file: url.searchParams.get("file") ?? LOCAL_DIFF_PATH,
        before: "before via SessionRef cwd\n",
        after: "after via SessionRef cwd\n",
        patch: `diff --git a/${LOCAL_DIFF_PATH} b/${LOCAL_DIFF_PATH}
--- a/${LOCAL_DIFF_PATH}
+++ b/${LOCAL_DIFF_PATH}
@@ -1 +1 @@
-before via SessionRef cwd
+after via SessionRef cwd
`,
      })
      return
    }
    if (url.pathname === "/file/status") {
      await json(route, [{ path: LOCAL_DIFF_PATH, status: "modified" }])
      return
    }
    if (url.pathname === "/file") {
      await json(route, [
        { name: LOCAL_FILE_PATH, path: LOCAL_FILE_PATH, absolute: `${LOCAL_DIR}/${LOCAL_FILE_PATH}`, type: "file", ignored: false },
        { name: LOCAL_DIFF_PATH, path: LOCAL_DIFF_PATH, absolute: `${LOCAL_DIR}/${LOCAL_DIFF_PATH}`, type: "file", ignored: false },
      ])
      return
    }
    if (url.pathname === "/file/content") {
      const target = url.searchParams.get("path") ?? LOCAL_FILE_PATH
      await json(route, {
        type: "text",
        path: target,
        content: target === LOCAL_DIFF_PATH
          ? "after via SessionRef cwd\n"
          : "hello through local SessionRef cwd\n",
      })
      return
    }
    if (url.pathname.startsWith("/find")) {
      await json(route, [LOCAL_FILE_PATH, LOCAL_DIFF_PATH])
      return
    }

    hits.unhandled.push(`${request.method()} ${request.url()}`)
    await json(route, {})
  })
}

function usableConsole(hits: Hits) {
  return hits.console.filter((item) =>
    !item.includes("clerk.accounts.dev") &&
    !item.includes("Clerk:") &&
    !item.includes("[QueriesObserver]: Duplicate Queries found") &&
    !item.includes("Failed to load resource") &&
    !item.includes("ERR_FAILED")
  )
}

function actionableFailures(hits: Hits) {
  return hits.failed.filter((item) =>
    !item.includes(".clerk.accounts.dev/") &&
    !item.includes("sprite.svg net::ERR_ABORTED")
  )
}

async function openSessionRoute(page: Page, sessionId: string) {
  await page.goto(`/s/${sessionId}`, { waitUntil: "domcontentloaded" })
  await expect(page.locator(`[data-testid="session-content"][data-session-id="${sessionId}"]`)).toBeVisible({
    timeout: 30_000,
  })
}

async function expectOneSessionSurface(page: Page, sessionId: string) {
  await expect(page.locator(`[data-testid="session-content"][data-session-id="${sessionId}"]`)).toHaveCount(1)
}

async function expectWorkspaceTools(page: Page, options: { expectChanges?: boolean } = {}) {
  await expect(page.getByRole("button", { name: "New Claude Terminal", exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole("button", { name: "Open workspace panel", exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: "Open workspace panel", exact: true }).first().click()
  await expect(page.getByRole("button", { name: "Open Files", exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole("button", { name: "Open Processes", exact: true }).first()).toBeVisible({ timeout: 10_000 })
  if (options.expectChanges) {
    await expect(page.getByRole("button", { name: "Open Changes", exact: true }).first()).toBeVisible({ timeout: 10_000 })
  }
}

async function expectLocalFilesAndChanges(page: Page) {
  await page.getByRole("button", { name: "Open Files", exact: true }).first().click()
  const filesNavigator = page.locator('[data-testid="workspace-files-navigator"][data-mode="files"]').first()
  await expect(filesNavigator).toHaveAttribute("data-file-tree-data-ready", "true", { timeout: 15_000 })
  await expect(filesNavigator.locator(`[data-file-tree-path="${LOCAL_FILE_PATH}"]`)).toBeVisible()

  await filesNavigator.locator(`[data-file-tree-path="${LOCAL_FILE_PATH}"]`).click()
  await expect(page.getByText("hello through local SessionRef cwd")).toBeVisible({ timeout: 10_000 })

  await page.locator('[data-workspace-tab-kind="review"] button').first().click()
  await expect(page.getByRole("button", { name: "Open Changes", exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: "Open Changes", exact: true }).first().click()
  const changesNavigator = page.locator('[data-testid="workspace-files-navigator"][data-mode="changes"]').first()
  await expect(changesNavigator.locator('[data-testid="workspace-changed-file-list"]')).toBeVisible({ timeout: 15_000 })
  await expect(changesNavigator.locator(`[data-file-tree-path="${LOCAL_DIFF_PATH}"]`)).toBeVisible()

  await changesNavigator.locator(`[data-file-tree-path="${LOCAL_DIFF_PATH}"]`).click()
  await expect(page.locator('[data-testid="review-pane-root"]')).toContainText(LOCAL_DIFF_PATH, { timeout: 15_000 })
  await expect(page.locator('[data-testid="review-pane-root"]')).toContainText("after via SessionRef cwd", { timeout: 15_000 })
}

async function withPage(browser: Parameters<Parameters<typeof test>[1]>[0]["browser"]) {
  const context = await browser.newContext()
  await seed(context)
  const page = await context.newPage()
  const hits: Hits = { unhandled: [], failed: [], console: [] }
  await setup(page, hits)
  return { context, page, hits }
}

test.describe("P2 SessionRef browser proof", () => {
  test("local /s session cold boot opens one backed pane with workspace tools and survives reload", async ({ browser }) => {
    const { context, page, hits } = await withPage(browser)
    await openSessionRoute(page, LOCAL_SESSION_ID)
    await expectOneSessionSurface(page, LOCAL_SESSION_ID)
    await expect(page).toHaveURL(sessionUrlPattern(LOCAL_SESSION_ID))
    await expectWorkspaceTools(page, { expectChanges: true })
    await expectLocalFilesAndChanges(page)

    await page.reload({ waitUntil: "domcontentloaded" })
    await expectOneSessionSurface(page, LOCAL_SESSION_ID)

    expect(usableConsole(hits)).toEqual([])
    expect(actionableFailures(hits)).toEqual([])
    expect(hits.unhandled).toEqual([])
    await context.close()
  })

  test("cloud /s session cold boot opens one workspace-backed pane with workspace tools", async ({ browser }) => {
    const { context, page, hits } = await withPage(browser)
    await page.goto(`/s/${CLOUD_SESSION_ID}`, { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(sessionUrlPattern(CLOUD_SESSION_ID))
    await expectWorkspaceTools(page)

    expect(usableConsole(hits)).toEqual([])
    expect(actionableFailures(hits)).toEqual([])
    expect(hits.unhandled).toEqual([])
    await context.close()
  })

  test("legacy directory route redirects to the typed workspace browse route", async ({ browser }) => {
    const { context, page, hits } = await withPage(browser)
    await page.goto(`/${slug(LOCAL_DIR)}`, { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/w\/local-p2\/?$/)

    expect(usableConsole(hits)).toEqual([])
    expect(actionableFailures(hits)).toEqual([])
    expect(hits.unhandled).toEqual([])
    await context.close()
  })
})
