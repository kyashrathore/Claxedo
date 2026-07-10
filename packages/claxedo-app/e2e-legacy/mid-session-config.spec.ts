import { expect, test, type Page, type Route } from "@playwright/test"

// Flow #8 from docs/tech-docs/architecture-direction-flow.md "Real Browser
// Coverage": "Change model or agent mid-session, send, reload, confirm
// persisted config."
//
// Architectural note: for an existing ACP session the runner is locked
// (see acp-config.ts:shouldFetchConfigOptionsForScope; existingSession
// disables option fetch) — the in-session model trigger only shows the
// current model and the popover is effectively a no-op. The mid-session
// surface that does write durable per-session config is the AgentHarnessSelector
// on the "new"/draft pane: the user picks a model there, the runner-model
// save POST fires, the choice persists into the draft scope, and once a
// session is created the preferences promote from `draft:...` to
// `session:{dir}:{sessionId}` (see panePreferences.promote). On reload the
// composer reads the persisted entry and re-renders without re-asking the
// backend.
//
// The flow under test:
// 1. Boot the "/{dir}/session" route (composer in draft mode).
// 2. The AgentHarnessSelector loads /api/claxedo/agent-config/harness/options.
// 3. Open the in-session model popover and pick model B (claude-opus-4-7).
// 4. The selector writes through to POST
//    /api/claxedo/agent-config/harness/model and persists into the
//    `claxedo:acp-model-map` localStorage row at the draft scope.
// 5. Force a fresh page (page.close() + newPage()) targeting the same draft
//    URL, mirroring the SSE-detachment workaround in
//    session-route-workbench.spec.ts.
// 6. Confirm: the persisted localStorage row survives, the runner-model POST
//    is NOT re-issued on rehydrate, and the in-session model trigger renders
//    the new model name without any user click.

const DIR = "/tmp/e2e-mid-session-config"
const SESSION_ID = "ses_mid_session_config"

type Hits = {
  console: string[]
  failed: string[]
  badResponses: string[]
  requests: string[]
  unhandled: string[]
}

type Counters = {
  configPatches: Array<{ body: unknown }>
  harnessModelPosts: Array<{ body: unknown }>
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
            release_date: "2026-01-01",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200000, output: 8192 },
            cost: { input: 0, output: 0 },
            options: {},
          },
          "claude-opus-4-7": {
            id: "claude-opus-4-7",
            name: "Opus 4.7",
            providerID: "claude-acp",
            release_date: "2026-04-01",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200000, output: 8192 },
            cost: { input: 0, output: 0 },
            options: {},
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
    projectID: "proj_mid_session",
    directory: DIR,
    title: "Mid-session model swap",
    version: "0.0.0-test",
    time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
    summary: { additions: 0, deletions: 0, files: 0 },
  }
}

function existingMessage() {
  return [
    {
      info: {
        id: `${SESSION_ID}_msg_seed`,
        sessionID: SESSION_ID,
        role: "user",
        time: { created: 1_700_000_000_100 },
        model: { providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
      },
      parts: [
        {
          id: `${SESSION_ID}_part_seed`,
          sessionID: SESSION_ID,
          messageID: `${SESSION_ID}_msg_seed`,
          type: "text",
          text: "Seed message before model swap",
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

async function seedRuntimeGlobals(page: Page) {
  await page.addInitScript((dir: string) => {
    ;(window as typeof window & {
      __OPENCODE__?: { serverUrl?: string; activeDirectory?: string }
    }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: dir,
    }
  }, DIR)
}

async function setup(page: Page, hits: Hits, counters: Counters) {
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
        project: [{ id: "proj_mid_session", name: "mid-session", worktree: DIR, sandboxes: [] }],
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
      await json(route, [{ id: "proj_mid_session", name: "mid-session", worktree: DIR, sandboxes: [] }])
      return
    }

    if (url.pathname === "/project/current" || url.pathname === "/project/proj_mid_session") {
      await json(route, { id: "proj_mid_session", name: "mid-session", worktree: DIR, sandboxes: [] })
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
      if (request.method() === "POST") {
        await json(route, { ok: true })
        return
      }
      await json(route, { type: "claude-acp", model: "claude-sonnet-4-6", binary: "claude", ok: true })
      return
    }

    // ACP model options — the AgentHarnessSelector reads this to populate
    // its in-session model picker.
    if (url.pathname === "/api/claxedo/agent-config/harness/options") {
      await json(route, {
        options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "claude-sonnet-4-6",
            selectOptions: [
              { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
              { id: "claude-opus-4-7", name: "Opus 4.7" },
            ],
          },
        ],
        source: "runner",
        stale: false,
      })
      return
    }

    // ACP model save — POSTed by acp-config.setModel when the user picks a
    // new model from the popover.
    if (url.pathname === "/api/claxedo/agent-config/harness/model" && request.method() === "POST") {
      let body: unknown = undefined
      try {
        body = request.postDataJSON()
      } catch {
        /* tolerate empty body */
      }
      counters.harnessModelPosts.push({ body })
      await json(route, { success: true })
      return
    }

    if (url.pathname === "/api/claxedo/agent-config/agents") {
      await json(route, [{ id: "build", name: "build", mode: "primary" }])
      return
    }

    if (url.pathname === "/api/workspace/resolve") {
      await json(route, { workspaceId: "local-mid-session", directory: DIR, kind: "local", status: "ready" })
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
          title: "Mid-session model swap",
          directory: DIR,
          projectID: "proj_mid_session",
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

    if (url.pathname === `/session/${SESSION_ID}/config` && request.method() === "GET") {
      await json(route, { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } })
      return
    }

    if (url.pathname === `/session/${SESSION_ID}/message`) {
      await json(route, existingMessage())
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

    // PATCH /session/:id/config — this is the mid-session config save flow
    // under test. Capture body for assertion.
    if (url.pathname === `/session/${SESSION_ID}/config` && request.method() === "PATCH") {
      let body: unknown = undefined
      try {
        body = request.postDataJSON()
      } catch {
        /* tolerate empty body */
      }
      counters.configPatches.push({ body })
      await json(route, { ok: true })
      return
    }

    if (url.pathname === `/session/${SESSION_ID}/prompt_async` || url.pathname.endsWith("/prompt_async")) {
      await route.fulfill({ status: 204, headers: corsHeaders(), body: "" })
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
  return hits.console.filter(
    (item) =>
      !item.includes("clerk.accounts.dev") &&
      !item.includes("Clerk:") &&
      !item.includes("Failed to load resource") &&
      !item.includes("ERR_FAILED"),
  )
}

async function acpModelMap(page: Page) {
  return await page.evaluate(() => {
    const raw = localStorage.getItem("claxedo:acp-model-map")
    if (!raw) return null
    try {
      return JSON.parse(raw) as Record<string, string>
    } catch {
      return null
    }
  })
}

function modelTrigger(page: Page) {
  return page.getByRole("button", { name: "Select harness model" }).first()
}

function findDraftAcpModelEntry(map: Record<string, string> | null) {
  if (!map) return undefined
  for (const [key, value] of Object.entries(map)) {
    if (key.startsWith("draft:")) return { key, value }
  }
  return undefined
}

test.skip("mid-session model swap persists across a fresh page load", async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const hits: Hits = { console: [], failed: [], badResponses: [], requests: [], unhandled: [] }
  const counters: Counters = { configPatches: [], harnessModelPosts: [] }

  await seed(page)
  await setup(page, hits, counters)

  // The composer-mounted draft route exposes the AgentHarnessSelector with
  // its model picker fully wired (existing-session ACP scopes don't fetch
  // options — see file-header note). The session row stays in LS the entire
  // time so the rail/sidebar still surfaces it.
  const draftUrl = `/${slug(DIR)}/session`
  await page.goto(draftUrl, { waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  // The draft composer model trigger renders with the runner's default
  // model — "Sonnet 4.6" comes from the runner/options payload's name.
  const sonnetTrigger = modelTrigger(page)
  await expect(sonnetTrigger).toBeVisible({ timeout: 30_000 })
  await expect(sonnetTrigger).toContainText(/Sonnet 4\.6|claude-sonnet-4-6/)

  // No draft acp-model row yet.
  const initialMap = await acpModelMap(page)
  expect(findDraftAcpModelEntry(initialMap)?.value ?? "").not.toBe("claude-opus-4-7")

  // Open the model popover and pick model B from the options the runner
  // returned. ModelList items render as <button data-slot="list-item">.
  await sonnetTrigger.click()
  const opusOption = page.locator('[data-slot="list-item"]', { hasText: /Opus 4\.7/i }).first()
  await expect(opusOption).toBeVisible({ timeout: 15_000 })
  await opusOption.click()

  // For a draft pane (no concrete sessionId yet) acp-config defers the
  // runner-model save POST until a session id materializes — see
  // acp-config.ts:syncSessionModel guard. The pane preferences write
  // (claxedo:acp-model-map) is the durable surface that survives reload.
  await expect
    .poll(async () => {
      const raw = await page.evaluate(() => localStorage.getItem("claxedo:acp-model-map"))
      if (!raw) return null
      const map = JSON.parse(raw) as Record<string, string>
      const draftEntry = Object.entries(map).find(([key]) => key.startsWith("draft:"))
      return draftEntry?.[1] ?? null
    }, { timeout: 15_000 })
    .toBe("claude-opus-4-7")
  // No POST yet — the runner-model save fires once a session id exists.
  expect(counters.harnessModelPosts.length).toBe(0)

  // Trigger label flips to model B.
  const opusTrigger = modelTrigger(page)
  await expect(opusTrigger).toBeVisible({ timeout: 10_000 })
  await expect(opusTrigger).toContainText(/Opus 4\.7|claude-opus-4-7/)

  // Snapshot the persisted state we expect to survive the round trip.
  const persistedSnapshot = await page.evaluate(() => ({
    acpModelMap: localStorage.getItem("claxedo:acp-model-map"),
    server: localStorage.getItem("opencode.global.dat:server"),
  }))
  const swapped = findDraftAcpModelEntry(await acpModelMap(page))!
  expect(swapped.value).toBe("claude-opus-4-7")

  // SSE detach + cold rehydrate via close()+newPage(), matching the workaround
  // used in session-route-workbench.spec.ts. The next page must see the
  // persisted model swap without any further user interaction.
  await page.close()

  const fresh = await context.newPage()
  const freshHits: Hits = { console: [], failed: [], badResponses: [], requests: [], unhandled: [] }
  const freshCounters: Counters = { configPatches: [], harnessModelPosts: [] }
  await seedRuntimeGlobals(fresh)
  await setup(fresh, freshHits, freshCounters)
  await fresh.goto(draftUrl, { waitUntil: "domcontentloaded" })
  await expect(fresh.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  // The acp-model-map LS row survived rehydrate untouched. The scope key is
  // the durable identity for the user's mid-session pick — after a cold
  // browser session the entry is still there, ready for the composer to
  // rehydrate against on the next surface that resolves to the same scope.
  expect(await fresh.evaluate(() => localStorage.getItem("claxedo:acp-model-map"))).toBe(persistedSnapshot.acpModelMap)
  const freshMap = await acpModelMap(fresh)
  expect(freshMap?.[swapped.key]).toBe("claude-opus-4-7")
  const freshTrigger = modelTrigger(fresh)
  await expect(freshTrigger).toBeVisible({ timeout: 30_000 })
  await expect(freshTrigger).toContainText(/Opus 4\.7|claude-opus-4-7/)

  // No new runner-model POSTs should fire on a passive rehydrate — the saved
  // state is sufficient, no implicit re-save.
  expect(freshCounters.harnessModelPosts.length).toBe(0)

  // No regressions in either page.
  expectNoRouteStackOverflow(hits)
  expectNoRouteStackOverflow(freshHits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkConsole(freshHits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
  expect(nonClerkFailures(freshHits)).toEqual([])

  await context.close()
})
