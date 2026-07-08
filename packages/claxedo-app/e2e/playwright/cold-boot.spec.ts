import { expect, test, type Page, type Route } from "@playwright/test"

// Flow #1 from docs/tech-docs/architecture-direction-flow.md "Real Browser Coverage".
// Boots the shell from a completely empty browser context and asserts that the
// shell paints cleanly with no console errors, unhandled rejections, or failed
// network requests outside the always-noisy Clerk dev origin. Also reuses the
// route-bridge stack-overflow guard from session-route-workbench.spec.ts so we
// catch the ClaxedoLayout regressions the architecture work is hardening.

const DIR = "/tmp/e2e-cold-boot"

type Hits = {
  console: string[]
  failed: string[]
  badResponses: string[]
  requests: string[]
  unhandled: string[]
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

async function clearStorage(page: Page) {
  // A truly cold context: nothing persisted, no runtime globals seeded other
  // than the bare server URL the bootstrap call needs.
  await page.addInitScript(() => {
    try {
      localStorage.clear()
      sessionStorage.clear()
    } catch {
      /* storage may be denied; ignore */
    }
    ;(window as typeof window & {
      __OPENCODE__?: { serverUrl?: string }
    }).__OPENCODE__ = {
      serverUrl: window.location.origin,
    }
  })
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
      // Cold boot: no project history yet. Bootstrap returns the bare provider
      // info so the shell can render without entering an error state.
      await json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: "", directory: "", home: "" },
        project: [],
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
      await json(route, { state: "", config: "", worktree: "", directory: "", home: "" })
      return
    }

    if (url.pathname === "/project" || url.pathname === "/experimental/project") {
      await json(route, [])
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
      await json(route, { workspaceId: "local-cold-boot", directory: DIR, kind: "local", status: "ready" })
      return
    }

    if (url.pathname === "/session" || url.pathname === "/experimental/session") {
      await json(route, [])
      return
    }

    if (url.pathname === "/api/control/sessions" || url.pathname === "/api/control/session-list") {
      await json(route, { sessions: [] })
      return
    }

    if (url.pathname === "/session/status") {
      await json(route, {})
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

test("cold boot from a clean browser context shows shell without errors", async ({ browser }) => {
  // Use an isolated context so prior tests cannot leak persisted state in.
  const context = await browser.newContext()
  const page = await context.newPage()
  const hits: Hits = { console: [], failed: [], badResponses: [], requests: [], unhandled: [] }

  await clearStorage(page)
  await setup(page, hits)

  await page.goto("/", { waitUntil: "domcontentloaded" })

  // Shell paints.
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  // No error screen took over.
  await expect(page.locator("text=/something went wrong/i")).toHaveCount(0)
  await expect(page.locator('[data-testid="error-screen"]')).toHaveCount(0)

  // Storage really was clean before boot — assert localStorage stays small so a
  // future regression that auto-seeds heavy state here would trip the test.
  const persistedKeys = await page.evaluate(() => Object.keys(localStorage))
  expect(persistedKeys.length).toBeLessThan(20)

  // No regressions from the ClaxedoLayout/route-bridge stack-overflow class.
  expectNoRouteStackOverflow(hits)

  // No general console errors / unhandled rejections.
  expect(nonClerkConsole(hits)).toEqual([])

  // No failed network requests (Clerk dev domain is allowed because the build
  // probes it even with auth disabled).
  expect(nonClerkFailures(hits)).toEqual([])

  // Catch-all mock did not have to serve anything unknown.
  expect(hits.unhandled).toEqual([])

  await context.close()
})
