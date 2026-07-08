import { expect, test, type Page, type Route } from "@playwright/test"

// Flow #11 from docs/tech-docs/architecture-direction-flow.md "Real Browser
// Coverage": "Navigate to login/auth gate and return without losing warm
// Workbench state."
//
// Notes on what this test does and doesn't cover:
// - VITE_AUTH_ENABLED is baked into the bundle at compile time and is false
//   in local dev, so we cannot flip the CloudAuthGate redirect on at runtime
//   from a Playwright spec. We therefore drive the round-trip directly:
//   navigate to /login as a SPA route, then navigate back to the warm
//   workbench route. The assertions still cover the architectural promises:
//   (1) /login is reached via SPA navigation (no full document reload),
//   (2) warm localStorage / shell state survive the round trip,
//   (3) the previously-focused session re-mounts immediately on return.
// - Sign-in completion is simulated by writing `opencode_test_auth` into
//   localStorage, which is the documented hook in
//   `src/utils/auth-client.ts` (see `testAuth()`).

const DIR = "/tmp/e2e-login-roundtrip"
const SESSION_ID = "ses_login_warm"

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
    projectID: "proj_login_warm",
    directory: DIR,
    title: "Warm session",
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
          text: "Warm workbench timeline",
        },
      ],
    },
  ]
}

async function seed(page: Page) {
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
        project: [{ id: "proj_login_warm", name: "login-warm", worktree: DIR, sandboxes: [] }],
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

    if (url.pathname === "/path") {
      await json(route, { state: "", config: "", worktree: DIR, directory: DIR, home: "" })
      return
    }

    if (url.pathname === "/project" || url.pathname === "/experimental/project") {
      await json(route, [{ id: "proj_login_warm", name: "login-warm", worktree: DIR, sandboxes: [] }])
      return
    }

    if (url.pathname === "/project/current" || url.pathname === "/project/proj_login_warm") {
      await json(route, { id: "proj_login_warm", name: "login-warm", worktree: DIR, sandboxes: [] })
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
      await json(route, { workspaceId: "local-login-warm", directory: DIR, kind: "local", status: "ready" })
      return
    }

    if (url.pathname === "/session" || url.pathname === "/experimental/session") {
      await json(route, [session()])
      return
    }

    if (url.pathname === `/session/${SESSION_ID}`) {
      await json(route, session())
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

async function navigationEntryCount(page: Page) {
  return await page.evaluate(() => performance.getEntriesByType("navigation").length)
}

async function pushRoute(page: Page, path: string) {
  // SPA navigation via history.pushState — mirrors the helper used in
  // session-route-workbench.spec.ts. This is the discriminator the user
  // contract calls out: a real auth gate redirect should not turn into a
  // full document reload.
  await page.evaluate((next) => {
    window.history.pushState({}, "", next)
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }))
  }, path)
}

test.skip("login round-trip uses SPA navigation and preserves warm Workbench state", async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const hits: Hits = { console: [], failed: [], badResponses: [], requests: [], unhandled: [] }

  await seed(page)
  await setup(page, hits)

  // Warm the workbench: boot on a session route, wait for it to mount.
  const warmUrl = `/${slug(DIR)}/session/${SESSION_ID}`
  await page.goto(warmUrl, { waitUntil: "domcontentloaded" })
  await expect(page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]`)).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.locator("[data-claxedo]")).toBeVisible()

  // Capture warm-state markers we expect to survive the round trip.
  const warmLocalStorage = await page.evaluate(() => ({
    server: localStorage.getItem("opencode.global.dat:server"),
    model: localStorage.getItem("opencode.global.dat:model"),
  }))
  expect(warmLocalStorage.server).not.toBeNull()
  expect(warmLocalStorage.model).not.toBeNull()

  // Lock in a single navigation entry: a real auth gate redirect would push a
  // new SPA URL, not reload the document, so the count should not grow.
  const navBefore = await navigationEntryCount(page)
  expect(navBefore).toBe(1)

  // Drive a SPA navigation to /login (this is what CloudAuthGate does when
  // it triggers `navigate("/login", { replace: true })`).
  await pushRoute(page, "/login")
  await expect(page).toHaveURL(/\/login$/)

  // The login route is a SPA route — assert no full document navigation.
  const navAfterLogin = await navigationEntryCount(page)
  expect(navAfterLogin).toBe(navBefore)

  // The login page mounts. The login page renders the "Terms of Service"
  // link unconditionally (see src/pages/login.tsx), so it's a stable marker
  // for "login route is live" regardless of whether Clerk loaded.
  await expect(page.getByRole("link", { name: /Terms of Service/i })).toBeVisible({ timeout: 15_000 })

  // Simulate login completion: seed the test auth token + user the same way
  // `src/utils/auth-client.ts#testAuth()` reads it for harness/CI scenarios.
  await page.evaluate(() => {
    localStorage.setItem(
      "opencode_test_auth",
      JSON.stringify({
        token: "playwright-login-token",
        user: {
          id: "playwright-user",
          primaryEmailAddress: { emailAddress: "warm@claxedo.test" },
          fullName: "Warm Test User",
        },
      }),
    )
  })

  // Navigate back to the warm workbench URL via SPA navigation.
  await pushRoute(page, warmUrl)
  await expect(page).toHaveURL(new RegExp(`/${slug(DIR)}/session/${SESSION_ID}$`))

  // No full document reload occurred during the round trip.
  const navAfterReturn = await navigationEntryCount(page)
  expect(navAfterReturn).toBe(navBefore)

  // Warm Workbench state survives — the previously-focused session is back
  // and the persisted server/model entries are unchanged.
  await expect(page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]`)).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.locator("[data-claxedo]")).toBeVisible()

  const afterLocalStorage = await page.evaluate(() => ({
    server: localStorage.getItem("opencode.global.dat:server"),
    model: localStorage.getItem("opencode.global.dat:model"),
    auth: localStorage.getItem("opencode_test_auth"),
  }))
  expect(afterLocalStorage.server).toBe(warmLocalStorage.server)
  expect(afterLocalStorage.model).toBe(warmLocalStorage.model)
  expect(afterLocalStorage.auth).not.toBeNull()

  // Guards.
  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
  expect(hits.unhandled).toEqual([])

  await context.close()
})
