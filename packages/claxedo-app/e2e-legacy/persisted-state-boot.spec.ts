import { expect, test, type Page, type Route } from "@playwright/test"

// Flow #2 (real-browser E2E coverage). Seeds the same realistic localStorage state the existing
// session-route-workbench spec uses, then reloads and confirms the focused
// session re-opens directly (no flicker / blank state / double-load).

const DIR = "/tmp/e2e-persisted-state-boot"
const SESSION_ID = "ses_persisted_focus"

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

function session() {
  return {
    id: SESSION_ID,
    sessionID: SESSION_ID,
    slug: SESSION_ID,
    projectID: "proj_persisted",
    directory: DIR,
    title: "Persisted Focus",
    version: "0.0.0-test",
    time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
    summary: { additions: 0, deletions: 0, files: 0 },
  }
}

function message() {
  return [
    {
      info: {
        id: `${SESSION_ID}_msg_1`,
        sessionID: SESSION_ID,
        role: "user",
        time: { created: 1_700_000_000_100 },
        model: { providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
      },
      parts: [
        {
          id: `${SESSION_ID}_part_1`,
          sessionID: SESSION_ID,
          messageID: `${SESSION_ID}_msg_1`,
          type: "text",
          text: "Persisted timeline content",
        },
      ],
    },
  ]
}

async function seed(page: Page) {
  // Mirrors the seed() helper in session-route-workbench.spec.ts but also
  // primes the project list with our directory + a server entry so the
  // sidebar surfaces a persisted project row on boot.
  await page.addInitScript((dir: string) => {
    localStorage.clear()
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
  }, DIR)
}

async function setup(page: Page, hits: Hits) {
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
  page.on("response", (response) => {
    const request = response.request()
    if (response.status() >= 400) {
      hits.badResponses.push(
        `${response.status()} ${request.resourceType()} ${request.method()} ${response.url()}`,
      )
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

    if (
      url.pathname === "/health" ||
      url.pathname === "/global/health" ||
      url.pathname === "/api/claxedo/health"
    ) {
      await json(route, { healthy: true, version: "1.0.0-test" })
      return
    }

    if (url.pathname === "/api/claxedo/bootstrap") {
      await json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: DIR, directory: DIR, home: "" },
        project: [{ id: "proj_persisted", name: "persisted", worktree: DIR, sandboxes: [] }],
        provider: provider(),
        provider_auth: { "claude-acp": [{ type: "api", label: "API key" }] },
        config: { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } },
      })
      return
    }

    if (
      url.pathname === "/api/claxedo/events" ||
      url.pathname === "/global/event" ||
      url.pathname === "/event" ||
      url.pathname === "/api/wr/events" ||
      url.pathname === "/api/wr/runtime-events"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: `data: ${JSON.stringify(url.pathname.startsWith("/api/wr/")
          ? { type: "workspace.connected" }
          : { directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n`,
      })
      return
    }

    if (url.pathname === "/path") {
      await json(route, { state: "", config: "", worktree: DIR, directory: DIR, home: "" })
      return
    }

    if (url.pathname === "/project" || url.pathname === "/experimental/project") {
      await json(route, [{ id: "proj_persisted", name: "persisted", worktree: DIR, sandboxes: [] }])
      return
    }

    if (url.pathname === "/project/current" || url.pathname === "/project/proj_persisted") {
      await json(route, { id: "proj_persisted", name: "persisted", worktree: DIR, sandboxes: [] })
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
      await json(route, { workspaceId: "local-persisted", directory: DIR, kind: "local", status: "ready" })
      return
    }

    if (url.pathname === "/session" || url.pathname === "/experimental/session") {
      await json(route, [session()])
      return
    }

    if (url.pathname === "/api/control/sessions") {
      await json(route, { sessions: [session()] })
      return
    }

    if (url.pathname === "/api/control/session-list") {
      await json(route, {
        sessions: [{
          id: SESSION_ID,
          title: "Persisted Focus",
          directory: DIR,
          projectID: "proj_persisted",
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_001_000,
        }],
      })
      return
    }

    if (url.pathname === `/session/${SESSION_ID}`) {
      await json(route, session())
      return
    }

    if (url.pathname === `/session/${SESSION_ID}/config`) {
      await json(route, { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } })
      return
    }

    if (url.pathname === `/session/${SESSION_ID}/message`) {
      await json(route, message())
      return
    }

    if (url.pathname === `/session/${SESSION_ID}/todo`) {
      await json(route, [])
      return
    }

    if (url.pathname === `/session/${SESSION_ID}/capabilities`) {
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
      await json(route, { [SESSION_ID]: { type: "idle" } })
      return
    }

    if (url.pathname === "/permission" || url.pathname === "/question" || url.pathname === "/mcp") {
      await json(route, url.pathname === "/mcp" ? {} : [])
      return
    }

    if (
      url.pathname === "/lsp" ||
      url.pathname === "/file/status" ||
      url.pathname.startsWith("/file") ||
      url.pathname.startsWith("/find")
    ) {
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

function expectNoRouteStackOverflow(hits: Hits) {
  expect(
    hits.console.filter((item) =>
      /Maximum call stack size exceeded|RangeError|open-surface-actions-ui|ClaxedoLayout/.test(item),
    ),
  ).toEqual([])
}

function nonClerkFailures(hits: Hits) {
  return hits.failed.filter((item) => !item.includes(".clerk.accounts.dev/"))
}

function nonClerkConsole(hits: Hits) {
  // Clerk's dev keys emit a "loaded with development keys" warning and the
  // CORS-with-credentials request to its dev environment endpoint fails in
  // the local dev server with ERR_FAILED / "Failed to load resource" entries
  // (the URL isn't included in the console string Playwright surfaces, but
  // the failures themselves are tracked separately on `hits.failed`).
  return hits.console.filter(
    (item) =>
      !item.includes("clerk.accounts.dev") &&
      !item.includes("Clerk:") &&
      !item.includes("Failed to load resource") &&
      !item.includes("ERR_FAILED"),
  )
}

test("persisted state boot restores previously-focused session without flicker", async ({ browser }) => {
  // Fresh isolated context so leftover persisted state from earlier tests
  // cannot leak into the seed and skew the assertions below.
  const context = await browser.newContext()
  const page = await context.newPage()
  const hits: Hits = { console: [], failed: [], badResponses: [], requests: [], unhandled: [] }

  await seed(page)
  await setup(page, hits)

  const sessionUrl = `/${slug(DIR)}/session/${SESSION_ID}`

  // This IS the persisted-state-boot scenario: addInitScript runs before any
  // page script and primes localStorage with realistic server/model state.
  // From the app's perspective the user just opened the page on a previously
  // focused session URL while their LS already had a project and recent model.
  await page.goto(sessionUrl, { waitUntil: "domcontentloaded" })

  // No flicker: poll specifically for the previously-focused session content
  // showing up. If the route bridge dropped focus on hydrate, this would
  // either never appear or appear after a long blank state.
  await expect(page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]`)).toBeVisible({
    timeout: 30_000,
  })
  await expect(page).toHaveURL(new RegExp(`/${slug(DIR)}/session/${SESSION_ID}$`))

  // Persisted sidebar entry: the seeded project surfaces in the rail/sidebar.
  await expect(page.locator("[data-claxedo]")).toBeVisible()
  await expect(page.locator("body")).toContainText("persisted", { timeout: 15_000 })

  // Persisted state survived hydration — both keys we seeded are still there.
  const persisted = await page.evaluate(() => ({
    keys: Object.keys(localStorage).sort(),
    server: localStorage.getItem("opencode.global.dat:server"),
    model: localStorage.getItem("opencode.global.dat:model"),
  }))
  expect(persisted.server).not.toBeNull()
  expect(persisted.model).not.toBeNull()
  expect(persisted.keys).toContain("opencode.global.dat:server")
  expect(persisted.keys).toContain("opencode.global.dat:model")

  // No double loading: the bootstrap endpoint should fire at most a small
  // bounded number of times during boot. If the route bridge regressed into
  // a re-mount loop we'd see many more.
  const bootstrapHits = hits.requests.filter((r) => r.includes("/api/claxedo/bootstrap"))
  expect(bootstrapHits.length).toBeGreaterThanOrEqual(1)
  expect(bootstrapHits.length).toBeLessThanOrEqual(3)

  // Stack-overflow / console / network guards.
  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
  expect(hits.unhandled).toEqual([])

  await context.close()
})
