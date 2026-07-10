import { expect, test, type Page, type Route } from "@playwright/test"

const DIR = "/tmp/e2e-session-capabilities-ui"
const SESSION_ID = "acp_capability_session"

type Transport = "opencode" | "claude-acp" | "codex-acp" | "cursor-acp" | "codex-app-server"

type Capabilities = {
  transport: Transport
  abort: boolean
  reconnect: boolean
  replay: boolean
  permissions: boolean
  questions: boolean
  todos: boolean
  commands: boolean
  fork: boolean
  revert: boolean
  unrevert: boolean
  configOptions: boolean
}

type Hits = {
  aborts: string[]
  capabilities: string[]
  events: string[]
  unhandled: string[]
  failed: string[]
}

type SetupOptions = {
  status?: "idle" | "busy"
  transport?: Transport
  liveEvents?: boolean
}

const transports: Array<{ transport: Transport; providerName: string; modelID: string; modelName: string }> = [
  { transport: "opencode", providerName: "OpenCode", modelID: "test-model", modelName: "Test Model" },
  { transport: "claude-acp", providerName: "Claude", modelID: "claude-sonnet-4-6", modelName: "Sonnet 4.6" },
  { transport: "codex-acp", providerName: "Codex", modelID: "gpt-5.2-codex", modelName: "GPT-5.2 Codex" },
  { transport: "cursor-acp", providerName: "Cursor", modelID: "cursor-default", modelName: "Cursor Default" },
  { transport: "codex-app-server", providerName: "Codex App Server", modelID: "default", modelName: "Default" },
]

function transportConfig(transport: Transport) {
  return transports.find((item) => item.transport === transport) ?? transports[1]
}

function providerList() {
  return transports.map((item) => ({
    id: item.transport,
    name: item.providerName,
    models: {
      [item.modelID]: {
        id: item.modelID,
        name: item.modelName,
        providerID: item.transport,
      },
    },
  }))
}

function providerDefaults() {
  return Object.fromEntries(transports.map((item) => [item.transport, item.modelID]))
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

function sseEvent(body: unknown) {
  return `data: ${JSON.stringify(body)}\n\n`
}

function nonAbortFailures(hits: Hits) {
  return hits.failed.filter((item) => !item.endsWith(" net::ERR_ABORTED"))
}

function session() {
  return {
    id: SESSION_ID,
    title: "ACP capability session",
    time: {
      created: 1_700_000_000_000,
      updated: 1_700_000_001_000,
    },
    version: "0.0.0-test",
  }
}

function rows(transport: Transport = "claude-acp") {
  const config = transportConfig(transport)
  return [
    {
      info: {
        id: "msg_1",
        sessionID: SESSION_ID,
        role: "user",
        time: { created: 1_700_000_000_100 },
        model: {
          providerID: config.transport,
          modelID: config.modelID,
        },
      },
      parts: [
        {
          id: "part_msg_1_text",
          sessionID: SESSION_ID,
          messageID: "msg_1",
          type: "text",
          text: "Check capability-gated actions",
        },
      ],
    },
  ]
}

const unsupportedCapabilities: Capabilities = {
  transport: "claude-acp",
  abort: true,
  reconnect: true,
  replay: true,
  permissions: false,
  questions: false,
  todos: true,
  commands: false,
  fork: false,
  revert: false,
  unrevert: false,
  configOptions: true,
}

const supportedCapabilities: Capabilities = {
  ...unsupportedCapabilities,
  permissions: true,
  questions: true,
  commands: true,
  fork: true,
  revert: true,
  unrevert: true,
}

async function seed(page: Page, transport: Transport = "claude-acp") {
  await page.addInitScript((input: { dir: string; transport: Transport; modelID: string }) => {
    localStorage.clear()
    ;(window as typeof window & {
      __OPENCODE__?: {
        serverUrl?: string
        activeDirectory?: string
      }
    }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: input.dir,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: {
          local: [{ worktree: input.dir, expanded: true }],
        },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:model",
      JSON.stringify({
        recent: [{ providerID: input.transport, modelID: input.modelID }],
        user: [],
        variant: {},
      }),
    )
  }, { dir: DIR, transport, modelID: transportConfig(transport).modelID })
}

async function setup(page: Page, hits: Hits, capabilities: Capabilities, options: SetupOptions = {}) {
  const transport = options.transport ?? capabilities.transport
  const provider = transportConfig(transport)
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).hostname.endsWith(".clerk.accounts.dev")) return
    hits.failed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
  })

  await page.route("**/*", async (route) => {
    const request = route.request()
    const type = request.resourceType()
    if (type !== "fetch" && type !== "xhr" && type !== "eventsource" && request.method() !== "OPTIONS") {
      await route.continue()
      return
    }

    const url = new URL(request.url())

    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }

    if (url.hostname.endsWith(".clerk.accounts.dev")) {
      await json(route, {})
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
        project: [{ id: "proj_capabilities", name: "capabilities", worktree: DIR, sandboxes: [] }],
        provider: {
          all: providerList(),
          default: providerDefaults(),
          connected: [],
        },
        provider_auth: { "claude-acp": [{ type: "api", label: "API key" }] },
        config: { share: "disabled" },
      })
      return
    }

    if (url.pathname === "/api/claxedo/events" || url.pathname === "/global/event" || url.pathname === "/api/wr/events") {
      hits.events.push(request.url())
      const replayed = rows(provider.transport)[0]!
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: [
          sseEvent({ directory: "global", payload: { type: "server.connected", properties: {} } }),
          ...(options.status === "busy" ? [
            sseEvent({
              directory: DIR,
              payload: {
                type: "session.status",
                properties: { sessionID: SESSION_ID, status: { type: "busy" } },
              },
            }),
          ] : []),
          ...(options.liveEvents ? [
            sseEvent({
              directory: DIR,
              payload: {
                type: "message.updated",
                properties: { info: replayed.info },
              },
            }),
            sseEvent({
              directory: DIR,
              payload: {
                type: "message.part.updated",
                properties: { part: replayed.parts[0] },
              },
            }),
            sseEvent({
              directory: DIR,
              payload: {
                type: "message.part.updated",
                properties: { part: replayed.parts[0] },
              },
            }),
          ] : []),
        ].join(""),
      })
      return
    }

    if (url.pathname === "/api/claxedo/runtime-events" || url.pathname === "/api/wr/runtime-events") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: sseEvent({ type: "heartbeat" }),
      })
      return
    }

    if (url.pathname === "/path") {
      await json(route, { state: "", config: "", worktree: DIR, directory: DIR, home: "" })
      return
    }

    if (url.pathname === "/project/current") {
      await json(route, { id: "proj_capabilities", name: "capabilities", worktree: DIR })
      return
    }

    if (url.pathname === "/project/proj_capabilities" && request.method() === "PATCH") {
      await json(route, { id: "proj_capabilities", name: "capabilities", worktree: DIR })
      return
    }

    if (url.pathname === "/project") {
      await json(route, [{ id: "proj_capabilities", name: "capabilities", worktree: DIR, sandboxes: [] }])
      return
    }

    if (url.pathname === "/config") {
      await json(route, { share: "disabled" })
      return
    }

    if (url.pathname === "/provider") {
      await json(route, {
        all: providerList(),
        default: providerDefaults(),
        connected: [],
      })
      return
    }

    if (url.pathname === "/provider/auth") {
      await json(route, { "claude-acp": [{ type: "api", label: "API key" }] })
      return
    }

    if (url.pathname === "/app/agents" || url.pathname === "/agent") {
      await json(route, [{ name: "build", mode: "primary" }])
      return
    }

    if (url.pathname === "/command" || url.pathname === "/api/claxedo/agent-config/commands") {
      await json(route, [])
      return
    }

    if (url.pathname === "/api/workspace/resolve") {
      await json(route, {
        workspaceId: "local-capabilities",
        directory: DIR,
        kind: "local",
        status: "ready",
      })
      return
    }

    if (url.pathname === "/api/control/sessions/acp_capability_session/gateway") {
      await json(route, {
        sessionId: SESSION_ID,
        sessionID: SESSION_ID,
        workspaceId: "local-capabilities",
        directory: DIR,
      })
      return
    }

    if (url.pathname === "/api/claxedo/agent-config/harness") {
      await json(route, { type: provider.transport, model: provider.modelID, ok: true })
      return
    }

    if (url.pathname === "/api/claxedo/agent-config/agents") {
      await json(route, [{ name: "build", mode: "primary" }])
      return
    }

    if (url.pathname === "/session") {
      await json(route, [{ ...session(), sessionID: SESSION_ID, directory: DIR }])
      return
    }

    if (url.pathname === "/experimental/session") {
      await json(route, [{ ...session(), sessionID: SESSION_ID, directory: DIR }])
      return
    }

    if (url.pathname === "/api/control/sessions") {
      await json(route, { sessions: [{ ...session(), sessionID: SESSION_ID, directory: DIR }] })
      return
    }

    if (url.pathname === "/api/control/session-list") {
      await json(route, {
        sessions: [{
          id: SESSION_ID,
          title: "ACP capability session",
          directory: DIR,
          projectID: "proj_capabilities",
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

    if (url.pathname === `/session/${SESSION_ID}/message`) {
      await json(route, rows(provider.transport))
      return
    }

    if (url.pathname === `/session/${SESSION_ID}/config`) {
      if (request.method() === "GET") {
        await json(route, {
          runner: { type: provider.transport, model: provider.modelID },
          model: { providerID: provider.transport, modelID: provider.modelID },
        })
        return
      }
      await json(route, { ok: true })
      return
    }

    if (url.pathname === `/session/${SESSION_ID}/todo`) {
      await json(route, [])
      return
    }

    if (url.pathname === `/session/${SESSION_ID}/capabilities`) {
      hits.capabilities.push(request.url())
      await json(route, capabilities)
      return
    }

    if (url.pathname === `/session/${SESSION_ID}/abort` && request.method() === "POST") {
      hits.aborts.push(request.url())
      await json(route, { ok: true, status: "cancelled" })
      return
    }

    if (url.pathname === "/session/status") {
      await json(route, { [SESSION_ID]: { type: options.status ?? "idle" } })
      return
    }

    if (url.pathname === "/permission" || url.pathname === "/question") {
      await json(route, [])
      return
    }

    if (url.pathname === "/mcp") {
      await json(route, {})
      return
    }

    if (url.pathname === "/lsp") {
      await json(route, [])
      return
    }

    if (url.pathname === "/vcs") {
      await json(route, { branch: "main", default_branch: "main" })
      return
    }

    if (url.pathname === "/file/status" || url.pathname.startsWith("/file")) {
      await json(route, [])
      return
    }

    if (url.pathname.startsWith("/find")) {
      await json(route, [])
      return
    }

    hits.unhandled.push(`${request.method()} ${request.url()}`)
    await json(route, {})
  })
}

async function ready(page: Page, hits: Hits) {
  await page.goto(`/${slug(DIR)}/session/${SESSION_ID}`)
  await page.waitForLoadState("domcontentloaded")
  try {
    await expect(page.locator("#message-msg_1")).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => hits.capabilities.length).toBeGreaterThan(0)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}

Unhandled API requests:
${hits.unhandled.join("\n") || "(none)"}

Failed requests:
${nonAbortFailures(hits).join("\n") || "(none)"}`)
  }
}

async function searchPalette(page: Page, text: string) {
  const search = page.getByPlaceholder("Search files, commands, and sessions")
  if (!await search.isVisible().catch(() => false)) {
    await page.keyboard.press("Meta+Shift+P")
  }
  if (!await search.isVisible().catch(() => false)) {
    await page.keyboard.press("Control+Shift+P")
  }
  await expect(search).toBeVisible()
  await search.fill(text)
}

test.describe("session capability browser UI", () => {
  test("unsupported ACP capabilities hide command palette and message actions", async ({ page }) => {
    const hits: Hits = { aborts: [], capabilities: [], events: [], unhandled: [], failed: [] }
    await seed(page)
    await setup(page, hits, unsupportedCapabilities)
    await ready(page, hits)

    await expect(page.getByRole("button", { name: "Revert message" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Copy message" })).toBeVisible()

    await searchPalette(page, "fork")
    await expect(page.getByRole("button", { name: /Fork from message/ })).toHaveCount(0)

    await searchPalette(page, "compact")
    await expect(page.getByRole("button", { name: /Compact session/ })).toHaveCount(0)

    await searchPalette(page, "undo")
    await expect(page.getByRole("button", { name: /Undo/ })).toHaveCount(0)

    expect(hits.unhandled).toEqual([])
    expect(nonAbortFailures(hits)).toEqual([])
  })

  test("supported capabilities expose the same visible actions", async ({ page }) => {
    const hits: Hits = { aborts: [], capabilities: [], events: [], unhandled: [], failed: [] }
    await seed(page)
    await setup(page, hits, supportedCapabilities)
    await ready(page, hits)

    await expect(page.getByRole("button", { name: "Revert message" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Copy message" })).toBeVisible()

    await searchPalette(page, "fork")
    await expect(page.getByRole("button", { name: /Fork from message/ })).toBeVisible()

    await searchPalette(page, "compact")
    await expect(page.getByRole("button", { name: /Compact session/ })).toBeVisible()

    await searchPalette(page, "undo")
    await expect(page.getByRole("button", { name: /Undo/ })).toBeVisible()

    expect(hits.unhandled).toEqual([])
    expect(nonAbortFailures(hits)).toEqual([])
  })

  for (const item of transports) {
    test(`${item.providerName} replay plus live duplicate events reconnect without duplicate render`, async ({ page }) => {
      const hits: Hits = { aborts: [], capabilities: [], events: [], unhandled: [], failed: [] }
      await seed(page, item.transport)
      await setup(page, hits, { ...supportedCapabilities, transport: item.transport }, {
        liveEvents: true,
        transport: item.transport,
      })
      await ready(page, hits)

      await expect(page.getByText("Check capability-gated actions")).toHaveCount(1)
      await expect.poll(() => hits.events.length).toBeGreaterThan(0)

      await page.reload()
      await expect(page.locator("#message-msg_1")).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText("Check capability-gated actions")).toHaveCount(1)
      await expect.poll(() => hits.events.length).toBeGreaterThan(1)

      expect(hits.unhandled).toEqual([])
      expect(nonAbortFailures(hits)).toEqual([])
    })
  }
})
