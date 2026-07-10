import { expect, test, type Page, type Route } from "@playwright/test"

const DIR = "/tmp/e2e-session-route-workbench"
const SESSION_A = "route_a"
const SESSION_B = "route_b"
const SESSION_C = "route_c"
const SESSION_D = "route_d"
const SESSION_E = "route_e"
const SESSION_F = "route_f"
const WORKBENCH_DRAG_MIME = "application/x-workbench-content"

type SessionID = typeof SESSION_A | typeof SESSION_B | typeof SESSION_C | typeof SESSION_D | typeof SESSION_E | typeof SESSION_F

type Hits = {
  console: string[]
  failed: string[]
  badResponses: string[]
  requests: string[]
  unhandled: string[]
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization,content-type,accept",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  }
}

async function json(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { ...corsHeaders(), ...headers },
    body: JSON.stringify(body),
  })
}

function session(id: SessionID) {
  return {
    id,
    sessionID: id,
    slug: id,
    projectID: "proj_route_workbench",
    directory: DIR,
    title: sessionTitle(id),
    version: "0.0.0-test",
    time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 - sessionRank(id) },
    summary: { additions: 0, deletions: 0, files: 0 },
  }
}

function sessionRank(id: SessionID) {
  return ALL_SESSIONS.indexOf(id)
}

function sessionTitle(id: SessionID) {
  return `Route ${String.fromCharCode(65 + sessionRank(id))}`
}

function message(id: SessionID) {
  const text = `${sessionTitle(id)} timeline`
  return [{
    info: {
      id: `${id}_msg_1`,
      sessionID: id,
      role: "user",
      time: { created: 1_700_000_000_100 },
      model: { providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
    },
    parts: [{
      id: `${id}_part_1`,
      sessionID: id,
      messageID: `${id}_msg_1`,
      type: "text",
      text,
    }],
  }]
}

const ALL_SESSIONS = [SESSION_A, SESSION_B, SESSION_C, SESSION_D, SESSION_E, SESSION_F] as const
const FIRST_PAGE_SESSIONS = [SESSION_A, SESSION_B, SESSION_C, SESSION_D, SESSION_E] as const

function navigationRow(id: SessionID) {
  const row = session(id)
  return {
    type: "session",
    sessionRef: `local:${DIR}:session:${id}`,
    sessionId: id,
    title: row.title,
    directory: DIR,
    projectId: row.projectID,
    createdAt: row.time.created,
    updatedAt: row.time.updated,
    tags: [],
    attachments: [],
  }
}

function provider() {
  return {
    all: [{
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
    }],
    default: { "claude-acp": "claude-sonnet-4-6" },
    connected: ["claude-acp"],
  }
}

async function seed(page: Page) {
  await page.addInitScript((dir: string) => {
    localStorage.clear()
    ;(window as typeof window & {
      __OPENCODE__?: {
        serverUrl?: string
        activeDirectory?: string
      }
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
  }, DIR)
}

async function seedRuntimeGlobals(page: Page) {
  await page.addInitScript((dir: string) => {
    ;(window as typeof window & {
      __OPENCODE__?: {
        serverUrl?: string
        activeDirectory?: string
      }
    }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: dir,
    }
  }, DIR)
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
  page.on("response", (response) => {
    const request = response.request()
    if (response.status() >= 400) {
      hits.badResponses.push(`${response.status()} ${request.resourceType()} ${request.method()} ${response.url()}`)
    }
  })
  page.on("request", (request) => {
    const type = request.resourceType()
    if (type === "fetch" || type === "xhr" || type === "eventsource") {
      hits.requests.push(`${request.method()} ${request.url()}`)
    }
  })

  await page.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.hostname.endsWith(".clerk.accounts.dev")) {
      await json(route, {})
      return
    }

    const type = request.resourceType()
    if (type !== "fetch" && type !== "xhr" && type !== "eventsource" && request.method() !== "OPTIONS") {
      await route.continue()
      return
    }

    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() })
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
        path: { state: "", config: "", worktree: DIR, directory: DIR, home: "" },
        project: [{ id: "proj_route_workbench", name: "route-workbench", worktree: DIR, sandboxes: [] }],
        provider: provider(),
        provider_auth: { "claude-acp": [{ type: "api", label: "API key" }] },
        config: { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } },
      })
      return
    }

    if (url.pathname === "/api/claxedo/events" || url.pathname === "/global/event" || url.pathname === "/event" || url.pathname === "/api/wr/events") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: `data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n`,
      })
      return
    }

    if (url.pathname === "/api/wr/runtime-events") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: "",
      })
      return
    }

    if (url.pathname === "/api/control/sessions") {
      await json(route, [])
      return
    }

    if (url.pathname === "/path") {
      await json(route, { state: "", config: "", worktree: DIR, directory: DIR, home: "" })
      return
    }

    if (url.pathname === "/project" || url.pathname === "/experimental/project") {
      await json(route, [{ id: "proj_route_workbench", name: "route-workbench", worktree: DIR, sandboxes: [] }])
      return
    }

    if (url.pathname === "/project/current" || url.pathname === "/project/proj_route_workbench") {
      await json(route, { id: "proj_route_workbench", name: "route-workbench", worktree: DIR, sandboxes: [] })
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

    if (url.pathname === "/config") {
      await json(route, { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } })
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

    if (url.pathname === "/api/claxedo/agent-config/harness") {
      await json(route, { type: "claude-acp", model: "claude-sonnet-4-6", ok: true })
      return
    }

    if (url.pathname === "/api/claxedo/agent-config/agents") {
      await json(route, [{ id: "build", name: "build", mode: "primary" }])
      return
    }

    if (url.pathname === "/api/workspace/resolve") {
      await json(route, {
        workspaceId: "local-route-workbench",
        directory: DIR,
        kind: "local",
        status: "ready",
      })
      return
    }

    if (url.pathname === "/api/control/session-list") {
      const cursor = url.searchParams.get("cursor")
      const ids = cursor ? [SESSION_F] : FIRST_PAGE_SESSIONS
      await json(route, {
        view: {
          scope: url.searchParams.get("scope") ?? "workspace",
          groupBy: url.searchParams.get("groupBy") ?? "none",
          sort: "updated_desc",
          limit: Number(url.searchParams.get("limit") ?? 50),
        },
        items: ids.map(navigationRow),
        nextCursor: cursor ? undefined : "cursor_after_route_e",
        totalKnown: ALL_SESSIONS.length,
      })
      return
    }

    if (url.pathname === "/session" || url.pathname === "/experimental/session") {
      await json(route, ALL_SESSIONS.map(session))
      return
    }

    const sessionID = ALL_SESSIONS.find((id) => url.pathname === `/session/${id}`)
    if (sessionID) {
      await json(route, session(sessionID))
      return
    }

    const messageSessionID = ALL_SESSIONS.find((id) => url.pathname === `/session/${id}/message`)
    if (messageSessionID) {
      await json(route, message(messageSessionID))
      return
    }

    if (ALL_SESSIONS.some((id) => url.pathname === `/session/${id}/todo`)) {
      await json(route, [])
      return
    }

    if (ALL_SESSIONS.some((id) => url.pathname === `/session/${id}/config`)) {
      await json(route, { ok: true })
      return
    }

    if (ALL_SESSIONS.some((id) => url.pathname === `/session/${id}/capabilities`)) {
      await json(route, {
        transport: "claude-acp",
        abort: true,
        reconnect: true,
        replay: true,
        permissions: true,
        questions: true,
        todos: true,
        commands: true,
        fork: true,
        revert: true,
        unrevert: true,
        configOptions: true,
      })
      return
    }

    if (url.pathname === "/session/status") {
      await json(route, Object.fromEntries(ALL_SESSIONS.map((id) => [id, { type: "idle" }])))
      return
    }

    if (url.pathname === "/permission" || url.pathname === "/question" || url.pathname === "/mcp") {
      await json(route, url.pathname === "/mcp" ? {} : [])
      return
    }

    if (url.pathname === "/lsp" || url.pathname === "/file/status" || url.pathname.startsWith("/file") || url.pathname.startsWith("/find")) {
      await json(route, [])
      return
    }

    if (url.pathname === "/vcs") {
      await json(route, { branch: "main", default_branch: "main" })
      return
    }

    hits.unhandled.push(`${request.method()} ${request.url()}`)
    await json(route, {})
  })
}

async function expectSession(page: Page, hits: Hits, id: SessionID) {
  try {
    await expect(page.locator(`[data-testid="session-content"][data-session-id="${id}"]`)).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(new RegExp(`/${slug(DIR)}/session/${id}$`))
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}

Console:
${hits.console.join("\n") || "(none)"}

Requests:
${hits.requests.join("\n") || "(none)"}

Unhandled API requests:
${hits.unhandled.join("\n") || "(none)"}

Failed requests:
${hits.failed.join("\n") || "(none)"}

Bad responses / scripts:
${hits.badResponses.join("\n") || "(none)"}

Body:
${await page.locator("body").innerText().catch(() => "(unavailable)")}`)
  }
}

async function expectShortSessionRoute(page: Page, hits: Hits, id: SessionID) {
  try {
    await expect(page.locator(`[data-testid="session-content"][data-session-id="${id}"]`)).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(new RegExp(`(?:${escapeRegExp(`/s/${id}`)}|${escapeRegExp(`/w/${encodeURIComponent(DIR)}/session/${id}`)})$`))
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}

Console:
${hits.console.join("\n") || "(none)"}

Requests:
${hits.requests.join("\n") || "(none)"}

Unhandled API requests:
${hits.unhandled.join("\n") || "(none)"}

Failed requests:
${hits.failed.join("\n") || "(none)"}

Bad responses / scripts:
${hits.badResponses.join("\n") || "(none)"}

Body:
${await page.locator("body").innerText().catch(() => "(unavailable)")}`)
  }
}

function expectNoRouteStackOverflow(hits: Hits) {
  expect(
    hits.console.filter((item) =>
      /Maximum call stack size exceeded|RangeError|open-surface-actions-ui|ClaxedoLayout/.test(item),
    ),
  ).toEqual([])
}

function nonClerkFailures(hits: Hits) {
  return hits.failed.filter((item) =>
    !item.includes(".clerk.accounts.dev/") &&
    !item.includes(" net::ERR_ABORTED"),
  )
}

async function pushRoute(page: Page, path: string) {
  await page.evaluate((next) => {
    window.history.pushState({}, "", next)
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }))
  }, path)
}

async function visiblePaneCount(page: Page) {
  return page.locator("[data-pane-id]").evaluateAll((nodes) =>
    new Set(nodes
      .filter((node) => {
        const el = node as HTMLElement
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
      })
      .map((node) => (node as HTMLElement).dataset.paneId)
      .filter(Boolean)).size,
  )
}

async function expectCompactSwitcherTopTarget(page: Page, label: string) {
  await expect(page.locator('[data-testid="compact-switcher"]')).toBeVisible({ timeout: 10_000 })
  const result = await page.evaluate((tabLabel) => {
    const compact = document.querySelector<HTMLElement>('[data-testid="compact-switcher"]')
    const tab = [...document.querySelectorAll<HTMLElement>('[data-testid="compact-switcher-tab"]')]
      .find((node) => node.textContent?.includes(tabLabel))
    const compactRect = compact?.getBoundingClientRect()
    const tabRect = tab?.getBoundingClientRect()
    const compactVisible = !!compact && !!compactRect && compactRect.width > 120 && compactRect.height > 20 &&
      getComputedStyle(compact).visibility !== "hidden" &&
      getComputedStyle(compact).display !== "none"
    const tabVisible = !!tab && !!tabRect && tabRect.width > 60 && tabRect.height > 20
    const hit = tabRect
      ? document.elementFromPoint(tabRect.left + Math.min(28, tabRect.width / 2), tabRect.top + tabRect.height / 2)
      : null
    const tabHit = !!tab && !!hit && (tab === hit || tab.contains(hit) || hit.contains(tab))
    return { compactVisible, tabVisible, tabHit, text: tab?.textContent ?? "" }
  }, label)
  expect(result).toMatchObject({ compactVisible: true, tabVisible: true, tabHit: true })
}

async function toggleSidebarFromKeyboard(page: Page) {
  const modifier = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform) ? "Meta" : "Control")
  await page.keyboard.press(`${modifier}+b`)
}

async function contentIdForSession(page: Page, id: SessionID) {
  return await page.locator(`[data-testid="session-content"][data-session-id="${id}"]`).evaluate((node) =>
    node.closest("[data-workbench-content]")?.getAttribute("data-workbench-content") ?? "",
  )
}

async function splitContentIntoSessionPane(page: Page, contentId: string, targetSessionId: SessionID) {
  expect(contentId).not.toBe("")
  await page.locator(`[data-testid="session-content"][data-session-id="${targetSessionId}"]`).evaluate((node, input) => {
    const slot = node.closest("[data-workbench-content]") as HTMLElement | null
    const paneId = slot?.dataset.paneId
    const pane = paneId ? document.querySelector(`[data-testid="pane-${paneId}"]`) : undefined
    if (!pane) throw new Error("focused pane not found")
    const rect = pane.getBoundingClientRect()
    const data = new DataTransfer()
    data.setData(input.mime, input.contentId)
    pane.dispatchEvent(new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientX: rect.right - 4,
      clientY: rect.top + rect.height / 2,
      dataTransfer: data,
    }))
    pane.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      clientX: rect.right - 4,
      clientY: rect.top + rect.height / 2,
      dataTransfer: data,
    }))
  }, { contentId, mime: WORKBENCH_DRAG_MIME })
  await expect.poll(() => visiblePaneCount(page), { timeout: 10_000 }).toBeGreaterThan(1)
}

test("session deep links focus Workbench panes across split and history @happy", async ({ page }) => {
  const hits: Hits = { console: [], failed: [], badResponses: [], requests: [], unhandled: [] }
  await seed(page)
  await setup(page, hits)

  await page.goto(`/${slug(DIR)}/session/${SESSION_A}`, { waitUntil: "domcontentloaded" })
  await expectSession(page, hits, SESSION_A)
  const sessionAContentId = await contentIdForSession(page, SESSION_A)

  await pushRoute(page, `/${slug(DIR)}/session/${SESSION_B}`)
  await expectSession(page, hits, SESSION_B)
  await splitContentIntoSessionPane(page, sessionAContentId, SESSION_B)
  await expect(page.locator(`[data-testid="session-content"][data-session-id="${SESSION_A}"]`)).toBeVisible()
  await expect(page.locator(`[data-testid="session-content"][data-session-id="${SESSION_B}"]`)).toBeVisible()
  await expect.poll(() => visiblePaneCount(page)).toBeGreaterThan(1)

  await pushRoute(page, `/${slug(DIR)}/session/${SESSION_A}`)
  await expectSession(page, hits, SESSION_A)
  await pushRoute(page, `/${slug(DIR)}/session/${SESSION_B}`)
  await expectSession(page, hits, SESSION_B)

  await page.goBack()
  await expectSession(page, hits, SESSION_A)
  await expect.poll(() => visiblePaneCount(page)).toBeGreaterThan(1)

  await page.goForward()
  await expectSession(page, hits, SESSION_B)

  const reloadUrl = new URL(page.url()).pathname
  await page.close()
  const fresh = await page.context().newPage()
  await seedRuntimeGlobals(fresh)
  await setup(fresh, hits)
  await fresh.goto(reloadUrl, { waitUntil: "domcontentloaded" })
  await expectSession(fresh, hits, SESSION_B)
  await expect.poll(() => visiblePaneCount(fresh), { timeout: 10_000 }).toBe(1)
  expectNoRouteStackOverflow(hits)
  expect(hits.unhandled).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
})

test("hidden rail compact switcher remains clickable and routes session focus", async ({ page }) => {
  const hits: Hits = { console: [], failed: [], badResponses: [], requests: [], unhandled: [] }
  await seed(page)
  await setup(page, hits)

  await page.goto(`/${slug(DIR)}/session/${SESSION_A}`, { waitUntil: "domcontentloaded" })
  await expectSession(page, hits, SESSION_A)
  await pushRoute(page, `/${slug(DIR)}/session/${SESSION_B}`)
  await expectSession(page, hits, SESSION_B)

  await expect(page.getByRole("navigation", { name: "Projects and sessions" })).toBeVisible({ timeout: 30_000 })
  await toggleSidebarFromKeyboard(page)
  await expect(page.locator('[data-testid="rail-sidebar"]')).toHaveAttribute("data-open", "false", { timeout: 10_000 })

  await expectCompactSwitcherTopTarget(page, "Route A")
  const routeATab = page.locator('[data-testid="compact-switcher-tab"]').filter({ hasText: "Route A" })
  await expect(routeATab).toHaveCount(1)
  await routeATab.click()
  await expectShortSessionRoute(page, hits, SESSION_A)

  await toggleSidebarFromKeyboard(page)
  await expect(page.locator('[data-testid="rail-sidebar"]')).toHaveAttribute("data-open", "true", { timeout: 10_000 })

  expectNoRouteStackOverflow(hits)
  expect(hits.unhandled).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
})

test("sidebar inventory switches between session rows", async ({ page }) => {
  const hits: Hits = { console: [], failed: [], badResponses: [], requests: [], unhandled: [] }
  await seed(page)
  await setup(page, hits)

  await page.goto(`/${slug(DIR)}/session/${SESSION_A}`, { waitUntil: "domcontentloaded" })
  await expectSession(page, hits, SESSION_A)

  const sidebar = page.getByRole("navigation", { name: "Projects and sessions" })
  await expect(sidebar).toBeVisible({ timeout: 30_000 })
  await expect(sidebar.getByText("Route A", { exact: true })).toBeVisible()
  await expect(sidebar.getByText("Route B", { exact: true })).toBeVisible()

  await sidebar.locator('[data-testid="rail-sidebar-session-row"][data-session-id="route_b"]').click()
  await expectShortSessionRoute(page, hits, SESSION_B)

  await sidebar.locator('[data-testid="rail-sidebar-session-row"][data-session-id="route_a"]').click()
  await expectShortSessionRoute(page, hits, SESSION_A)

  expectNoRouteStackOverflow(hits)
  expect(hits.unhandled).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
})

test("sidebar load more keeps appended rows after selecting a loaded session", async ({ page }) => {
  const hits: Hits = { console: [], failed: [], badResponses: [], requests: [], unhandled: [] }
  await seed(page)
  await setup(page, hits)

  await page.goto(`/${slug(DIR)}/session/${SESSION_A}`, { waitUntil: "domcontentloaded" })
  await expectSession(page, hits, SESSION_A)

  const sidebar = page.getByRole("navigation", { name: "Projects and sessions" })
  await expect(sidebar).toBeVisible({ timeout: 30_000 })
  await expect(sidebar.getByText("Route E", { exact: true })).toBeVisible()
  await expect(sidebar.getByText("Route F", { exact: true })).toHaveCount(0)

  await sidebar.getByRole("button", { name: "Load more" }).click()
  await expect(sidebar.getByText("Route F", { exact: true })).toBeVisible({ timeout: 10_000 })

  await sidebar.locator('[data-testid="rail-sidebar-session-row"][data-session-id="route_f"]').click()
  await expectShortSessionRoute(page, hits, SESSION_F)

  await expect(sidebar.getByText("Route A", { exact: true })).toBeVisible()
  await expect(sidebar.getByText("Route E", { exact: true })).toBeVisible()
  await expect(sidebar.getByText("Route F", { exact: true })).toBeVisible()
  await expect(sidebar.locator('[data-testid="rail-sidebar-session-row"]')).toHaveCount(6)

  expectNoRouteStackOverflow(hits)
  expect(hits.unhandled).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
})
