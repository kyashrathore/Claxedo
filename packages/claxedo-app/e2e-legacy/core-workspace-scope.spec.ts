import { expect, test, type Page, type Request, type Route } from "@playwright/test"

type WorkspaceFixture = {
  dir: string
  id: string
  projectID: string
  name: string
  file: string
  processName: string
}

type CoreHealth = {
  console: string[]
  failed: string[]
  badResponses: string[]
  requests: string[]
}

const WORKSPACES: [WorkspaceFixture, WorkspaceFixture] = [
  {
    dir: "/tmp/e2e-core-workspace-alpha",
    id: "local-core-alpha",
    projectID: "proj_core_alpha",
    name: "core-alpha",
    file: "src/alpha-panel.tsx",
    processName: "alpha-dev",
  },
  {
    dir: "/tmp/e2e-core-workspace-beta",
    id: "local-core-beta",
    projectID: "proj_core_beta",
    name: "core-beta",
    file: "src/beta-panel.tsx",
    processName: "beta-dev",
  },
]

function project(workspace: WorkspaceFixture) {
  return {
    id: workspace.projectID,
    name: workspace.name,
    worktree: workspace.dir,
    sandboxes: [],
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}

function provider() {
  return {
    all: [
      {
        id: "claude-acp",
        name: "Claude",
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

function api(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr" || type === "eventsource" || route.request().method() === "OPTIONS"
}

function workspaceFromPath(pathname: string) {
  const workspaceRoute = /^\/w\/([^/]+)/.exec(pathname)
  if (!workspaceRoute) return undefined
  return decodeURIComponent(workspaceRoute[1] ?? "")
}

function workspaceFromRequest(request: Request) {
  const url = new URL(request.url())
  const directory = url.searchParams.get("directory")
  if (directory) return directory
  const routeWorkspace = workspaceFromPath(url.pathname)
  if (routeWorkspace) return routeWorkspace
  const referer = request.headers().referer
  if (!referer) return WORKSPACES[0].dir
  return workspaceFromPath(new URL(referer).pathname) ?? WORKSPACES[0].dir
}

function fixtureFor(directory: string) {
  return WORKSPACES.find((workspace) => workspace.dir === directory) ?? WORKSPACES[0]
}

async function seed(page: Page) {
  await page.addInitScript((workspaces: WorkspaceFixture[]) => {
    localStorage.clear()
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: workspaces[0]?.dir,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: workspaces.map((workspace) => ({ worktree: workspace.dir, expanded: true })) },
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
    const appWindow = window as typeof window & {
      __CLAXEDO_CORE_PERF__?: { longTasks: number[]; maxFrameGap: number }
    }
    appWindow.__CLAXEDO_CORE_PERF__ = { longTasks: [], maxFrameGap: 0 }
    if ("PerformanceObserver" in window) {
      try {
        const observer = new PerformanceObserver((list) => {
          appWindow.__CLAXEDO_CORE_PERF__?.longTasks.push(...list.getEntries().map((entry) => Math.round(entry.duration)))
        })
        observer.observe({ type: "longtask", buffered: true })
      } catch {
        // Older browsers can lack longtask support; the RAF gap still catches freezes.
      }
    }
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      const perf = appWindow.__CLAXEDO_CORE_PERF__
      if (perf) perf.maxFrameGap = Math.max(perf.maxFrameGap, now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, WORKSPACES)
}

function watchHealth(page: Page) {
  const health: CoreHealth = { console: [], failed: [], badResponses: [], requests: [] }
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      health.console.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on("pageerror", (error) => {
    health.console.push(`pageerror: ${error.message}`)
  })
  page.on("request", (request) => {
    const type = request.resourceType()
    if (type !== "fetch" && type !== "xhr" && type !== "eventsource") return
    const url = new URL(request.url())
    health.requests.push(`${request.method()} ${url.pathname}${url.search}`)
  })
  page.on("requestfailed", (request) => {
    health.failed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
  })
  page.on("response", (response) => {
    if (response.status() < 400) return
    const request = response.request()
    health.badResponses.push(`${response.status()} ${request.resourceType()} ${request.method()} ${response.url()}`)
  })
  return health
}

async function setup(page: Page) {
  await page.route("**/*", async (route) => {
    if (!api(route)) return route.continue()

    const request = route.request()
    const url = new URL(request.url())
    const workspace = fixtureFor(workspaceFromRequest(request))

    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }

    if (url.hostname.endsWith(".clerk.accounts.dev")) {
      await json(route, {})
      return
    }

    if (url.pathname === "/health" || url.pathname === "/api/claxedo/health") {
      await json(route, { healthy: true, version: "1.0.0-test" })
      return
    }

    if (url.pathname === "/api/claxedo/bootstrap") {
      await json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: workspace.dir, directory: workspace.dir, home: "" },
        project: WORKSPACES.map(project),
        provider: provider(),
        provider_auth: { "claude-acp": [{ type: "api", label: "API key" }] },
        config: { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } },
      })
      return
    }

    if (url.pathname === "/api/workspace/resolve") {
      await json(route, {
        workspaceId: workspace.id,
        projectId: workspace.projectID,
        directory: workspace.dir,
        kind: "local",
        access: "local",
        status: "ready",
        backing: { kind: "local-worktree" },
      })
      return
    }

    if (url.pathname === "/api/claxedo/events" || url.pathname === "/api/wr/events" || url.pathname === "/global/event" || url.pathname === "/event") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: `data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n`,
      })
      return
    }

    if (url.pathname === "/project" || url.pathname === "/experimental/project") {
      await json(route, WORKSPACES.map(project))
      return
    }

    if (url.pathname === "/project/current" || url.pathname === `/project/${workspace.projectID}`) {
      await json(route, project(workspace))
      return
    }

    if (url.pathname === "/global/config" || url.pathname === "/config") {
      await json(route, { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } })
      return
    }

    if (url.pathname === "/provider") {
      await json(route, provider())
      return
    }

    if (url.pathname === "/provider/auth") {
      await json(route, { "claude-acp": [{ type: "api", label: "API key" }] })
      return
    }

    if (url.pathname === "/app/agents" || url.pathname === "/agent" || url.pathname === "/api/claxedo/agent-config/agents") {
      await json(route, [{ id: "build", name: "build", mode: "primary" }])
      return
    }

    if (url.pathname === "/api/claxedo/agent-config/harness") {
      await json(route, { type: "claude-acp", model: "claude-sonnet-4-6", ok: true, ready: true })
      return
    }

    if (url.pathname === "/command" || url.pathname === "/api/claxedo/agent-config/commands") {
      await json(route, [])
      return
    }

    if (url.pathname === "/api/claxedo/agent-config/harness/options") {
      await json(route, { source: "runner", stale: false, options: [] })
      return
    }

    if (url.pathname === "/session" || url.pathname === "/experimental/session") {
      await json(route, [])
      return
    }

    if (url.pathname === "/session/status") {
      await json(route, {})
      return
    }

    if (url.pathname.startsWith("/session/")) {
      await json(route, url.pathname.endsWith("/todo") || url.pathname.endsWith("/message") ? [] : {})
      return
    }

    if (url.pathname === "/permission" || url.pathname === "/question" || url.pathname === "/mcp" || url.pathname === "/lsp") {
      await json(route, url.pathname === "/mcp" ? {} : [])
      return
    }

    if (url.pathname === "/vcs") {
      await json(route, { branch: "main", default_branch: "main" })
      return
    }

    if (url.pathname.endsWith("/api/wr/diff/refs") || url.pathname.endsWith("/api/claxedo/diff/refs")) {
      await json(route, { branches: ["main"], tags: [], recent: [] })
      return
    }

    if (url.pathname.endsWith("/api/wr/diff/targets") || url.pathname.endsWith("/api/claxedo/diff/targets")) {
      await json(route, { defaultRef: "origin/dev", candidates: ["origin/dev"] })
      return
    }

    if (url.pathname.endsWith("/api/wr/diff/vcs") || url.pathname.endsWith("/api/claxedo/diff/vcs")) {
      await json(route, [{
        file: workspace.file,
        before: "export const value = 1\n",
        after: "export const value = 2\n",
        additions: 1,
        deletions: 1,
        status: "modified",
      }])
      return
    }

    if (url.pathname.endsWith("/api/wr/diff/vcs/file") || url.pathname.endsWith("/api/claxedo/diff/vcs/file")) {
      await json(route, {
        file: workspace.file,
        before: "export const value = 1\n",
        after: "export const value = 2\n",
        additions: 1,
        deletions: 1,
        status: "modified",
      })
      return
    }

    if (url.pathname === "/file/status") {
      await json(route, [{ path: workspace.file, status: "modified" }])
      return
    }

    if (url.pathname === "/file") {
      await json(route, [{
        name: workspace.file.split("/").at(-1),
        path: workspace.file,
        absolute: `${workspace.dir}/${workspace.file}`,
        type: "file",
        ignored: false,
      }])
      return
    }

    if (url.pathname === "/find/file") {
      await json(route, [workspace.file])
      return
    }

    if (url.pathname === "/api/claxedo/process" || url.pathname === "/api/wr/process" || url.pathname === "/process") {
      await json(route, {
        configs: [{
          id: `cfg-${workspace.id}`,
          name: workspace.processName,
          command: `echo ${workspace.name}`,
          args: [],
          cwd: "",
          env: {},
          autoStart: false,
          restartPolicy: "never",
          maxRestarts: 3,
          color: "#3b82f6",
        }],
        processes: [],
      })
      return
    }

    await json(route, {})
  })
}

async function openWorkspace(page: Page, workspace: WorkspaceFixture) {
  await page.goto(`/w/${encodeURIComponent(workspace.dir)}/session`, { waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  if (await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false)) return
  await page.getByRole("button", { name: "New Session", exact: true }).first().click()
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
}

async function openWorkspacePanel(page: Page) {
  const panel = page.locator('[data-testid="workspace-panel-shell"]')
  if (await panel.getAttribute("data-open").catch(() => "false") === "true") return
  await page.getByRole("button", { name: "Open workspace panel", exact: true }).first().click()
  await expect(panel).toHaveAttribute("data-open", "true", { timeout: 10_000 })
}

async function expectScopedPanel(page: Page, workspace: WorkspaceFixture, other: WorkspaceFixture) {
  await openWorkspacePanel(page)
  await expect(page.locator('[data-testid="workspace-panel-shell"]')).toHaveAttribute("data-state-workspace-dir", workspace.dir)
  await expect(page.locator('[data-testid="review-pane-root"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator(`[data-review-file="${workspace.file}"]`).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.locator(`[data-review-file="${other.file}"]`)).toHaveCount(0)
}

function expectNoLoop(health: CoreHealth) {
  const normalized = health.requests.map((item) => {
    const [method, raw] = item.split(" ")
    const url = new URL(raw ?? "/", "http://local.test")
    return `${method} ${url.pathname}`
  })
  const counts = normalized.reduce((acc, item) => acc.set(item, (acc.get(item) ?? 0) + 1), new Map<string, number>())
  const max = Math.max(0, ...counts.values())
  expect(health.requests.length).toBeLessThan(180)
  expect(max).toBeLessThan(30)
}

test("core workspace switching scopes panel data and stays responsive @core", async ({ page }) => {
  const health = watchHealth(page)
  await seed(page)
  await setup(page)

  await openWorkspace(page, WORKSPACES[0])
  await expectScopedPanel(page, WORKSPACES[0], WORKSPACES[1])

  await openWorkspace(page, WORKSPACES[1])
  await expectScopedPanel(page, WORKSPACES[1], WORKSPACES[0])

  await openWorkspace(page, WORKSPACES[0])
  await expectScopedPanel(page, WORKSPACES[0], WORKSPACES[1])

  const perf = await page.evaluate(() =>
    (window as typeof window & { __CLAXEDO_CORE_PERF__?: { longTasks: number[]; maxFrameGap: number } }).__CLAXEDO_CORE_PERF__
  )
  expect(perf?.longTasks.filter((duration) => duration > 500)).toEqual([])
  expect(perf?.maxFrameGap ?? 0).toBeLessThan(1_000)
  expect(health.console.filter((item) => /Maximum call stack size exceeded|RangeError|pageerror:|uncaught/i.test(item))).toEqual([])
  expect(health.failed.filter((item) => !item.endsWith(" net::ERR_ABORTED"))).toEqual([])
  expect(health.badResponses).toEqual([])
  expectNoLoop(health)
})
