import { test, expect, type Page, type Route } from "@playwright/test"

const DIR = "/tmp/e2e-workspace-shell-test"
const REMOTE_WORKSPACE_ID = "ws_shell_reconnect"
const REVIEW_FILE = "src/components/button.tsx"
const REVIEW_DIFFS = [{
  file: REVIEW_FILE,
  before: "export function Button() {\n  return <button>Click me</button>\n}\n",
  after: "export function Button(props: { label: string }) {\n  return <button>{props.label}</button>\n}\n",
  additions: 1,
  deletions: 1,
  status: "modified" as const,
}]

let pty = 1
let configs: Array<Record<string, unknown>>

type ShellHealth = {
  console: string[]
  failed: string[]
}

const shellHealth = new WeakMap<Page, ShellHealth>()

type WorkspaceShellFixture = {
  directory: string
  route: string
  workspaceId?: string
  workspaceKind?: "local" | "user-hosted"
}

const localFixture: WorkspaceShellFixture = {
  directory: DIR,
  route: `/w/${encodeURIComponent(DIR)}/session`,
}

const reconnectFixture: WorkspaceShellFixture = {
  directory: REMOTE_WORKSPACE_ID,
  route: `/w/${REMOTE_WORKSPACE_ID}/session`,
  workspaceId: REMOTE_WORKSPACE_ID,
  workspaceKind: "user-hosted",
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seed(page: Page, fixture = localFixture) {
  await page.addInitScript((args: { directory: string }) => {
    localStorage.clear()
    ;(window as typeof window & {
      __OPENCODE__?: {
        serverUrl?: string
        activeDirectory?: string
      }
    }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: args.directory,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: {
          local: [{ worktree: args.directory, expanded: true }],
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
    const appWindow = window as typeof window & {
      __CLAXEDO_REVIEW_LOAD_LOG__?: unknown[]
    }
    appWindow.__CLAXEDO_REVIEW_LOAD_LOG__ = []
    window.addEventListener("claxedo:review-vcs-load", (event) => {
      appWindow.__CLAXEDO_REVIEW_LOAD_LOG__?.push(event instanceof CustomEvent ? event.detail : undefined)
    })
  }, { directory: fixture.directory })
}

function watchShellHealth(page: Page) {
  const hits: ShellHealth = { console: [], failed: [] }
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      hits.console.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on("pageerror", (error) => {
    hits.console.push(`pageerror: ${error.message}`)
  })
  page.on("requestfailed", (request) => {
    hits.failed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
  })
  shellHealth.set(page, hits)
  return hits
}

function shellHealthProblems(page: Page) {
  const hits = shellHealth.get(page) ?? { console: [], failed: [] }
  return {
    console: hits.console.filter((item) =>
      /Maximum call stack size exceeded|RangeError|pageerror:|uncaught|ClaxedoLayout|open-surface-actions-ui/i.test(item),
    ),
    failed: hits.failed.filter((item) =>
      !item.includes(" net::ERR_ABORTED") &&
      !item.includes(".clerk.accounts.dev/") &&
      !/GET http:\/\/127\.0\.0\.1:3001\/(?:api\/control\/sessions|api\/control\/session-list|session|provider|vcs|api\/claxedo\/agent-config\/agents)/.test(item),
    ),
  }
}

async function setup(page: Page, fixture = localFixture) {
  pty = 1
  configs = [
    {
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
    },
  ]

  await page.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const type = request.resourceType()
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
    if (type !== "fetch" && type !== "xhr" && type !== "eventsource") {
      await route.continue()
      return
    }
    const json = async (body: unknown) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      })
    }
    const project = {
      id: "proj_workspace_shell",
      name: "workspace-shell",
      worktree: fixture.directory,
      sandboxes: [],
      ...(fixture.workspaceId
        ? {
            workspaces: {
              [fixture.workspaceId]: {
                id: fixture.workspaceId,
                workspaceId: fixture.workspaceId,
                kind: fixture.workspaceKind ?? "user-hosted",
                directory: fixture.directory,
              },
            },
          }
        : {}),
    }
    const provider = {
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
      connected: [],
    }
    const config = {
      provider: { id: "claude-acp", model: "claude-sonnet-4-6" },
      agent: { id: "build" },
    }

    if (url.pathname === "/api/claxedo/bootstrap") {
      await json({
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: fixture.directory, directory: fixture.directory, home: "" },
        project: [project],
        provider,
        provider_auth: { "claude-acp": [{ type: "api", label: "API key" }] },
        config,
      })
      return
    }

    if (url.pathname === "/api/workspace/resolve") {
      await json({
        workspaceId: fixture.workspaceId ?? fixture.directory,
        projectId: project.id,
        directory: fixture.directory,
        kind: fixture.workspaceKind ?? "local",
        access: fixture.workspaceId ? "user-hosted" : "local",
        status: "ready",
        backing: { kind: fixture.workspaceId ? "workspace-runtime" : "local-worktree" },
      })
      return
    }

    if (url.pathname === `/api/workspace/${fixture.workspaceId}/connection`) {
      await json({
        access: "user-hosted",
        backing: "local-worktree",
        runtimeKind: "user-hosted",
        workspaceId: fixture.workspaceId,
        relayUrl: url.origin,
        runtimeAccessToken: "runtime-access-token",
        tokenExpiresAt: Date.now() + 60_000,
        role: "owner",
      })
      return
    }

    if (
      url.pathname === "/api/claxedo/events" ||
      url.pathname === "/api/wr/events" ||
      url.pathname === "/global/event" ||
      url.pathname === "/event" ||
      url.pathname.endsWith("/api/wr/events")
    ) {
      if (fixture.workspaceId && url.pathname.startsWith(`/workspaces/${fixture.workspaceId}/`)) {
        await route.abort("failed")
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
      await json([project])
      return
    }

    if (url.pathname === "/project/current" || url.pathname === `/project/${project.id}`) {
      await json(project)
      return
    }

    if (url.pathname === "/global/config" || url.pathname === "/config") {
      await json(config)
      return
    }

    if (url.pathname === "/app/agents" || url.pathname === "/agent") {
      await json([{ id: "build", name: "build", mode: "primary" }])
      return
    }

    if (url.pathname === "/command" || url.pathname === "/api/claxedo/agent-config/commands") {
      await json([])
      return
    }

    if (url.pathname.endsWith("/api/wr/diff/vcs") || url.pathname === "/api/claxedo/diff/vcs") {
      await json(REVIEW_DIFFS)
      return
    }

    if (url.pathname === "/file/status") {
      await json([{ path: REVIEW_FILE, status: "modified" }])
      return
    }

    if (url.pathname === "/file") {
      await json([
        {
          name: "button.tsx",
          path: REVIEW_FILE,
          absolute: `${fixture.directory}/${REVIEW_FILE}`,
          type: "file",
          ignored: false,
        },
      ])
      return
    }

    if (url.pathname === "/find/file") {
      await json([REVIEW_FILE])
      return
    }

    await route.continue()
  })

  const api = (route: Route) => {
    const type = route.request().resourceType()
    return type === "fetch" || type === "xhr"
  }

  await page.route("**/health", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ healthy: true, version: "1.0.0-test" }),
    })
  })

  await page.route("**/event?**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "data: {}\n\n",
    })
  })

  await page.route("**/path**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ worktree: DIR }),
    })
  })

  await page.route("**/session", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  })

  await page.route("**/session/**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    })
  })

  await page.route("**/session/vcs-diff**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(REVIEW_DIFFS),
    })
  })

  await page.route(/\/process\/?(?:\?.*)?$/, async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configs, processes: [] }),
    })
  })

  await page.route("**/provider", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
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
        connected: [],
      }),
    })
  })

  await page.route("**/provider/auth", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ "claude-acp": [{ type: "api", label: "API key" }] }),
    })
  })

  await page.route("**/api/claxedo/agent-config/harness**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ type: "claude-acp", ok: true }),
    })
  })

  await page.route("**/api/claxedo/pty", async (route) => {
    if (!api(route)) return route.continue()
    const body = route.request().postDataJSON() as { title?: string; cwd?: string } | undefined
    const id = `pty-${pty++}`
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id, title: body?.title ?? `Terminal ${pty}`, cwd: body?.cwd ?? DIR }),
    })
  })

  await page.route("**/api/claxedo/pty/*", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(true),
    })
  })
}

async function ready(page: Page, fixture = localFixture) {
  await page.goto(fixture.route)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

function root(page: Page, scope = "") {
  return scope ? page.locator(scope).first() : page.locator("body")
}

async function terminal(page: Page, scope = "") {
  await root(page, scope).getByRole("button", { name: "New Claude Terminal" }).first().click({ force: !!scope })
}

function visibleTerminalClose(page: Page) {
  return page.getByRole("button", { name: "Close terminal: Claude", exact: true }).filter({ visible: true })
}

async function openSessionSurface(page: Page) {
  if (await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false)) return
  await page.getByRole("button", { name: "New Session", exact: true }).first().click()
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
}

async function toggleSidepanel(page: Page) {
  await openSessionSurface(page)
  if (await page.locator('[data-testid="workspace-panel-shell"][data-open="true"]').isVisible().catch(() => false)) return
  if (await page.locator('[data-testid="review-pane-root"]').isVisible().catch(() => false)) return
  await page.getByRole("button", { name: "Open workspace panel", exact: true }).first().click()
}

async function waitForReviewSettled(page: Page) {
  await expect(page.locator('[data-testid="review-pane-root"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator(`[data-review-file="${REVIEW_FILE}"]`).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-testid="review-pane-loading"]')).toHaveCount(0, { timeout: 10_000 })
}

async function reviewLoadCount(page: Page) {
  return await page.evaluate(() =>
    ((window as typeof window & { __CLAXEDO_REVIEW_LOAD_LOG__?: unknown[] }).__CLAXEDO_REVIEW_LOAD_LOG__ ?? []).length
  )
}

async function reviewLoadLog(page: Page) {
  return await page.evaluate(() =>
    (window as typeof window & { __CLAXEDO_REVIEW_LOAD_LOG__?: unknown[] }).__CLAXEDO_REVIEW_LOAD_LOG__ ?? []
  )
}

async function connectionStatus(page: Page, workspaceId: string) {
  return await page.evaluate((workspaceId) => {
    const connections = (window as typeof window & {
      __claxedoConnections?: { snapshot?: () => Record<string, { status?: unknown }> }
    }).__claxedoConnections?.snapshot?.()
    return connections?.[workspaceId]?.status
  }, workspaceId)
}

async function markWorkspaceReconnecting(page: Page, workspaceId: string) {
  return await page.evaluate((workspaceId) => {
    const hook = (window as typeof window & {
      __claxedoConnections?: { markReconnecting?: (workspaceId: string) => void }
    }).__claxedoConnections?.markReconnecting
    hook?.(workspaceId)
    return typeof hook === "function"
  }, workspaceId)
}

async function markWorkspaceReconnected(page: Page, workspaceId: string) {
  return await page.evaluate((workspaceId) => {
    const hook = (window as typeof window & {
      __claxedoConnections?: { markReconnected?: (workspaceId: string) => void }
    }).__claxedoConnections?.markReconnected
    hook?.(workspaceId)
    return typeof hook === "function"
  }, workspaceId)
}

async function clickVisibleButton(page: Page, label: string) {
  const clicked = await page.evaluate((label) => {
    const visible = (item: HTMLElement) => {
      const rect = item.getBoundingClientRect()
      const style = getComputedStyle(item)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        style.pointerEvents !== "none" &&
        Number(style.opacity || "1") > 0.01
    }
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((item) => item.getAttribute("aria-label") === label && visible(item))
    button?.click()
    return !!button
  }, label)
  expect(clicked, `visible button ${label}`).toBe(true)
}

async function toggleNavigator(page: Page, label: "Files" | "Changes" | "Processes") {
  await clickVisibleButton(page, `Open ${label}`)
  if (label === "Files") {
    const files = page.locator('[data-testid="workspace-files-navigator"][data-mode="files"]')
    await expect(files).toBeVisible({
      timeout: 10_000,
    })
    await expect(files.getByPlaceholder("Search files...")).toBeVisible()
    await expect(files.locator('[data-file-tree-path="src/components/button.tsx"]').first()).toBeVisible({
      timeout: 10_000,
    })
    await expect(files.getByText("button.tsx").first()).toBeVisible()
  }
  if (label === "Changes") {
    const changes = page.locator('[data-testid="workspace-files-navigator"][data-mode="changes"]')
    await expect(changes).toBeVisible({
      timeout: 10_000,
    })
    await expect(changes.getByPlaceholder("Filter changes...")).toBeVisible()
    await expect(changes.locator('[data-testid="workspace-changed-file-list"]')).toBeVisible({ timeout: 10_000 })
    await expect(changes.locator('[data-file-tree-path="src/components/button.tsx"]').first()).toBeVisible()
    await expect(changes.getByText("button.tsx").first()).toBeVisible()
    await expect(changes.locator("span", { hasText: "1" }).first()).toBeVisible()
  }
  if (label === "Processes") {
    const processes = page.locator('[data-testid="workspace-navigator-overlay"][data-navigator="processes"]')
    await expect(processes).toBeVisible({
      timeout: 10_000,
    })
    await expect(processes.getByText("Processes", { exact: true })).toBeVisible()
    await expect(processes.getByRole("button", { name: "Add process", exact: true })).toBeVisible()
    await expect(processes.getByRole("button", { name: /dev-server/ })).toBeVisible({ timeout: 10_000 })
    await expect(processes.getByText("echo dev")).toBeVisible()
  }
  await clickVisibleButton(page, `Close ${label}`)
  await expect(page.locator('[data-testid="workspace-navigator-overlay"][data-open="true"]')).toHaveCount(0, {
    timeout: 10_000,
  })
  await waitForReviewSettled(page)
}

async function expectReviewLoadCount(page: Page, expected: number, label: string) {
  expect(await reviewLoadCount(page), `${label}: ${JSON.stringify(await reviewLoadLog(page))}`).toBe(expected)
}

test.describe("Claxedo workspace shell", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const fixture = testInfo.title.includes("workspace reconnect") ? reconnectFixture : localFixture
    watchShellHealth(page)
    await seed(page, fixture)
    await setup(page, fixture)
    await ready(page, fixture)
  })

  test("boots the Claxedo layout with workspace controls @happy", async ({ page }) => {
    await expect(page.locator("[data-claxedo]")).toBeVisible()
    await expect(page.locator("[data-component='workspace-more-menu']").first()).toBeVisible()
    await expect(page.getByRole("button", { name: "New Session", exact: true }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "New Claude Terminal", exact: true }).first()).toBeVisible()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText("Select a session or create a new one")).toHaveCount(0)
  })

  test("creates, closes, and creates another terminal surface", async ({ page }) => {
    await openSessionSurface(page)
    await terminal(page)
    await expect(visibleTerminalClose(page)).toHaveCount(1, { timeout: 10_000 })

    await visibleTerminalClose(page).click()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })

    await terminal(page)
    await expect(visibleTerminalClose(page)).toHaveCount(1, { timeout: 10_000 })
  })

  test("opens, switches, hides, and restores the workspace sidepanel @happy", async ({ page }) => {
    await openSessionSurface(page)
    await toggleSidepanel(page)
    await expect(page.locator('[data-testid="review-pane-root"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole("button", { name: "Review", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Open Changes", exact: true })).toBeVisible()
    await expect(page.locator(`[data-review-file="${REVIEW_FILE}"]`).first()).toBeVisible()

    await page.getByRole("button", { name: "Close workspace panel", exact: true }).first().click()
    await expect(page.locator('[data-testid="review-pane-root"]')).toBeHidden()

    await toggleSidepanel(page)
    await expect(page.locator('[data-testid="review-pane-root"]')).toBeVisible({ timeout: 10_000 })
  })

  test("keeps populated review settled without reloading across shell toggles", async ({ page }) => {
    await openSessionSurface(page)
    await toggleSidepanel(page)
    await waitForReviewSettled(page)

    const before = await page.locator('[data-testid="workbench-column"]').boundingBox()
    const startingLoads = await reviewLoadCount(page)

    await toggleNavigator(page, "Files")
    await expectReviewLoadCount(page, startingLoads, "Files navigator should not reload review")
    await toggleNavigator(page, "Changes")
    await expectReviewLoadCount(page, startingLoads, "Changes navigator should not reload review")
    await toggleNavigator(page, "Processes")
    await expectReviewLoadCount(page, startingLoads, "Processes navigator should not reload review")

    await clickVisibleButton(page, "Close workspace panel")
    await expect(page.locator('[data-testid="workspace-panel-shell"]')).toHaveAttribute("data-open", "false", {
      timeout: 10_000,
    })
    await clickVisibleButton(page, "Open workspace panel")
    await expect(page.locator('[data-testid="workspace-panel-shell"]')).toHaveAttribute("data-open", "true", {
      timeout: 10_000,
    })
    await waitForReviewSettled(page)
    await expectReviewLoadCount(page, startingLoads, "Workspace panel close/open should not reload review")
    const afterPanelToggle = await page.locator('[data-testid="workbench-column"]').boundingBox()
    expect(Math.round(afterPanelToggle?.x ?? 0)).toBe(Math.round(before?.x ?? 0))
    expect(Math.abs((afterPanelToggle?.width ?? 0) - (before?.width ?? 0))).toBeLessThanOrEqual(8)

    await clickVisibleButton(page, "Pin sidebar")
    await clickVisibleButton(page, "Show Sidebar")
    await waitForReviewSettled(page)
    await expectReviewLoadCount(page, startingLoads, "Sidebar toggle should not reload review")
  })

  test("keeps populated review mounted through workspace reconnect", async ({ page }) => {
    await openSessionSurface(page)
    await toggleSidepanel(page)
    await waitForReviewSettled(page)

    const startingLoads = await reviewLoadCount(page)
    await expect.poll(() => connectionStatus(page, REMOTE_WORKSPACE_ID), {
      message: "remote workspace connection should be ready before reconnect simulation",
    }).toBe("ready")

    expect(await markWorkspaceReconnecting(page, REMOTE_WORKSPACE_ID)).toBe(true)
    await expect.poll(() => connectionStatus(page, REMOTE_WORKSPACE_ID), {
      message: "remote workspace connection should enter reconnecting",
    }).toBe("reconnecting")
    await expect(page.locator('[data-testid="workspace-panel-shell"]')).toHaveAttribute("data-state-open", "true")
    await expect(page.locator('[data-testid="workspace-panel-shell"]')).toHaveAttribute("data-state-mode", "review")
    await expect(page.locator('[data-testid="workspace-panel-shell"]')).toHaveAttribute(
      "data-state-workspace-dir",
      REMOTE_WORKSPACE_ID,
    )
    await expect(page.locator('[data-testid="workspace-panel-shell"]')).toHaveAttribute("data-open", "true")
    await expect(page.locator("[data-review-workspace-id]")).toHaveAttribute(
      "data-review-workspace-id",
      REMOTE_WORKSPACE_ID,
    )
    await expect(page.locator("[data-review-workspace-id]")).toHaveAttribute("data-review-workspace-ready", "false")
    await expect(page.locator('[data-testid="workspace-review-pending"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="workspace-review-pending"]')).toContainText("Connecting to workspace")
    await expect(page.locator('[data-testid="review-pane-root"]')).toBeHidden()
    await expectReviewLoadCount(page, startingLoads, "Entering reconnecting should not reload review")

    expect(await markWorkspaceReconnected(page, REMOTE_WORKSPACE_ID)).toBe(true)
    await expect.poll(() => connectionStatus(page, REMOTE_WORKSPACE_ID), {
      message: "remote workspace connection should recover",
    }).toBe("ready")
    await expect(page.locator('[data-testid="workspace-review-pending"]')).toHaveCount(0, { timeout: 10_000 })
    await waitForReviewSettled(page)
    await expectReviewLoadCount(page, startingLoads, "Recovering from reconnect should not reload review")
  })

  test("toggles sidebar and keeps the shell usable after reload", async ({ page }) => {
    await openSessionSurface(page)
    await expect(page.getByRole("navigation", { name: "Projects and sessions" })).toBeVisible()

    await page.reload()
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.locator("[data-component='workspace-more-menu']").first()).toBeVisible()
    await openSessionSurface(page)
    expect(shellHealthProblems(page)).toEqual({ console: [], failed: [] })
  })

  test("renders the runner selector without the old duplicated selector pattern", async ({ page }) => {
    await openSessionSurface(page)
    await expect(page.getByRole("button", { name: "Claude", exact: true }).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator("body")).not.toContainText(/something went wrong|uncaught error|crash/i)
    const count = await page.locator("text=OpenCode").count()
    expect(count).toBeLessThan(10)
  })
})
