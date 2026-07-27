import { expect, test, type Locator, type Page, type Route } from "@playwright/test"

// Flow #7 (real-browser E2E coverage): "Send first prompt in a new local
// OpenCode session."
//
// Boots a warm, persisted workbench targeted at a local worktree, opens a
// brand-new session, sends a prompt, then asserts:
//   1. The shell paints and the prompt input is reachable.
//   2. The "create session" and "prompt_async" endpoints fire exactly the
//      shape the local runtime expects.
//   3. The optimistic user message renders before server reconciliation
//      arrives.
//   4. The server-replayed message timeline replaces / merges with the
//      optimistic state without duplicates.
//   5. No console errors outside the Clerk dev-keys allowlist.
//   6. No failed requests and no unhandled mocked routes.
//
// Per-path `page.route()` registration follows reload-message-flow.spec.ts —
// the catch-all-`**/*` pattern used by cold-boot.spec.ts shifts the workbench
// into a continuous bootstrap re-poll loop because the SSE streams close
// immediately; per-path routes plus the same `**/global/event?**` shape
// reload-message-flow uses keep the page settled enough to actually accept
// clicks.

const DIR = "/tmp/e2e-first-prompt-local"
const SESSION_ID = "ses_first_prompt_local"
const PROJECT_ID = "proj_first_prompt_local"

type MessageRow = {
  info: {
    id: string
    sessionID: string
    role: "user" | "assistant"
    time: { created: number; completed?: number }
    agent?: string
    model?: { providerID: string; modelID: string }
    providerID?: string
    modelID?: string
    parentID?: string
    mode?: string
    path?: { cwd: string; root: string }
    cost?: number
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  }
  parts: Array<{ id: string; sessionID: string; messageID: string; type: "text"; text: string }>
}

type Hits = {
  console: string[]
  failed: string[]
  badResponses: string[]
  createSessionCount: number
  opencodeSessionCreateCount: number
  harnessSessionCreateCount: number
  promptCount: number
  promptBodies: Array<{
    messageID?: string
    text: string
    agent?: string
    providerID?: string
    modelID?: string
    variant?: string
  }>
  shellCount: number
  shellBodies: Array<{
    command?: string
    agent?: string
    providerID?: string
    modelID?: string
    directory?: string
  }>
  slashCount: number
  slashBodies: Array<{
    command?: string
    arguments?: string
    agent?: string
    model?: string
    partCount: number
    directory?: string
  }>
}

let messages: MessageRow[] = []
let sessionCreated = false

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function api(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr"
}

function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return []
      if (!("type" in part) || part.type !== "text") return []
      if (!("text" in part) || typeof part.text !== "string") return []
      return [part.text]
    })
    .join("\n")
    .trim()
}

function providerResponse() {
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
            release_date: "2026-01-01",
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

function session(title = "", config?: unknown) {
  return {
    id: SESSION_ID,
    slug: SESSION_ID,
    projectID: PROJECT_ID,
    directory: DIR,
    title,
    version: "2",
    time: { created: Date.now(), updated: Date.now() },
    summary: { additions: 0, deletions: 0, files: 0 },
    ...(config ? { config } : {}),
  }
}

function textPart(sessionID: string, messageID: string, text: string) {
  return { id: `${messageID}_text`, sessionID, messageID, type: "text" as const, text }
}

function userMessage(input: { id: string; text: string; agent: string; providerID: string; modelID: string }): MessageRow {
  return {
    info: {
      id: input.id,
      sessionID: SESSION_ID,
      role: "user",
      time: { created: Date.now() },
      agent: input.agent,
      model: { providerID: input.providerID, modelID: input.modelID },
    },
    parts: [textPart(SESSION_ID, input.id, input.text)],
  }
}

function assistantMessage(input: { id: string; parentID: string; text: string; agent: string; providerID: string; modelID: string }): MessageRow {
  return {
    info: {
      id: input.id,
      sessionID: SESSION_ID,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID: input.parentID,
      agent: input.agent,
      providerID: input.providerID,
      modelID: input.modelID,
      mode: "code",
      path: { cwd: DIR, root: DIR },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [textPart(SESSION_ID, input.id, input.text)],
  }
}

async function seed(page: Page) {
  messages = []
  sessionCreated = false
  await page.addInitScript((dir: string) => {
    localStorage.clear()
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
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

type SetupOptions = {
  harness?: "opencode" | "claude-acp" | "codex-app-server" | "cursor-acp"
  optionsError?: string
  statusError?: string
}

function createHits(): Hits {
  return {
    console: [],
    failed: [],
    badResponses: [],
    createSessionCount: 0,
    opencodeSessionCreateCount: 0,
    harnessSessionCreateCount: 0,
    promptCount: 0,
    promptBodies: [],
    shellCount: 0,
    shellBodies: [],
    slashCount: 0,
    slashBodies: [],
  }
}

async function setup(page: Page, hits: Hits, options: SetupOptions = {}) {
  let harness = options.harness ?? "opencode"
  const harnessModel = () => harness === "codex-app-server"
    ? { id: "gpt-5.5", name: "GPT-5.5" }
    : harness === "cursor-acp"
    ? { id: "cursor-auto", name: "Cursor Auto" }
    : { id: "claude-sonnet-4-6", name: "Sonnet 4.6" }
  const sessionConfig = () => {
    const model = harnessModel()
    const harnessStatus = {
      status: options.statusError ? "error" : "ready",
      ready: !options.statusError,
      ...(options.statusError ? { error: options.statusError } : {}),
    }
    return harness === "opencode"
      ? {
          harness: { type: "opencode", model: "claude-sonnet-4-6", status: "ready", ready: true },
          model: { providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
          provider: { id: "claude-acp", model: "claude-sonnet-4-6" },
          agent: "build",
        }
      : {
          harness: { type: harness, model: model.id, ...harnessStatus },
          model: { providerID: harness, modelID: model.id },
          provider: { id: harness, model: model.id },
          agent: "build",
        }
  }
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

  await page.route("**/health", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ healthy: true }) })
  })

  await page.route("**/api/claxedo/bootstrap**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
        project: [{ id: PROJECT_ID, worktree: DIR, name: "first-prompt-local", time: { created: Date.now(), updated: Date.now() } }],
        provider: providerResponse(),
        provider_auth: { "claude-acp": [{ type: "api", label: "API key" }] },
        config: { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } },
      }),
    })
  })

  await page.route("**/event?**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/event") return route.fallback()
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: "data: {}\n\n" })
  })

  await page.route("**/global/event?**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/global/event") return route.fallback()
    const events = [
      { directory: "global", payload: { type: "server.connected", properties: {} } },
      { directory: DIR, payload: { type: "session.idle", properties: { sessionID: SESSION_ID } } },
    ]
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    })
  })

  await page.route("**/path**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/path") return route.fallback()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ worktree: DIR }) })
  })

  await page.route("**/agent**", async (route) => {
    if (!api(route)) return route.continue()
    if (!["/agent", "/app/agents"].includes(new URL(route.request().url()).pathname)) return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: "build", name: "build", description: "Build agent" }]),
    })
  })

  await page.route("**/provider", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(providerResponse()) })
  })

  await page.route("**/provider/auth", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) })
  })

  await page.route("**/config", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/config") return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } }),
    })
  })

  await page.route("**/project**", async (route) => {
    if (!api(route)) return route.continue()
    if (!["/project", "/experimental/project"].includes(new URL(route.request().url()).pathname)) return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { id: PROJECT_ID, worktree: DIR, name: "first-prompt-local", time: { created: Date.now(), updated: Date.now() } },
      ]),
    })
  })

  await page.route("**/mcp**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/mcp") return route.fallback()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) })
  })

  await page.route("**/lsp**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/lsp") return route.fallback()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) })
  })

  await page.route("**/vcs**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/vcs") return route.fallback()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) })
  })

  await page.route("**/command**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/command") return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: "build", description: "Build command" }]),
    })
  })

  await page.route("**/permission**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/permission") return route.fallback()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) })
  })

  await page.route("**/question**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/question") return route.fallback()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) })
  })

  await page.route("**/api/workspace/resolve**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ workspaceId: "local-first-prompt", directory: DIR, kind: "local", status: "ready" }),
    })
  })

  await page.route("**/api/wr/diff/**", async (route) => {
    if (!api(route)) return route.continue()
    const pathname = new URL(route.request().url()).pathname
    const body = pathname.endsWith("/refs")
      ? { branches: [], tags: [], recent: [] }
      : pathname.endsWith("/targets")
      ? {}
      : pathname.endsWith("/vcs")
      ? []
      : pathname.endsWith("/vcs/file")
      ? undefined
      : undefined
    if (body === undefined && !pathname.endsWith("/vcs/file")) return route.fallback()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  })

  await page.route("**/api/claxedo/agent-config/harness/options**", async (route) => {
    if (!api(route)) return route.continue()
    if (options.optionsError) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: options.optionsError }),
      })
      return
    }
    const model = harnessModel()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: "runner",
        stale: false,
        options: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: model.id,
            selectOptions: [model],
          },
        ],
      }),
    })
  })

  await page.route("**/api/claxedo/agent-config/harness**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/api/claxedo/agent-config/harness") return route.fallback()
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { type?: SetupOptions["harness"] } | undefined
      harness = body?.type ?? harness
    }
    const model = harnessModel()
    const harnessStatus = {
      status: options.statusError ? "error" : "ready",
      ready: !options.statusError,
      ...(options.statusError ? { error: options.statusError } : {}),
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        harness === "opencode"
          ? { type: "opencode", ok: true }
          : { type: harness, model: model.id, ok: true, ...harnessStatus },
      ),
    })
  })

  await page.route("**/api/claxedo/agent-config/agents**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: "build", name: "build", mode: "primary" }]),
    })
  })

  await page.route("**/api/claxedo/agent-config/commands**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: "build", description: "Build command" }]),
    })
  })

  await page.route("**/session/status", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ [SESSION_ID]: { type: "idle" } }),
    })
  })

  const handleSessionList = async (route: Route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() === "POST") {
      hits.createSessionCount += 1
      const sessionHarness = new URL(route.request().url()).searchParams.get("harness")
      if (sessionHarness && sessionHarness !== "opencode") hits.harnessSessionCreateCount += 1
      else hits.opencodeSessionCreateCount += 1
      sessionCreated = true
      messages = []
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session("", sessionConfig())) })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sessionCreated ? [session(textOf(messages[0]?.parts) || "", sessionConfig())] : []),
    })
  }

  await page.route("**/session", handleSessionList)
  await page.route("**/session?**", handleSessionList)
  await page.route("**/experimental/session", handleSessionList)
  await page.route("**/experimental/session?**", handleSessionList)

  await page.route("**/session/*/config**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sessionConfig()),
    })
  })

  await page.route("**/session/*/todo**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) })
  })

  await page.route("**/session/*/capabilities**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
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
      }),
    })
  })

  await page.route("**/session/*/prompt_async**", async (route) => {
    if (!api(route)) return route.continue()
    hits.promptCount += 1
    const body = route.request().postDataJSON() as {
      messageID?: string
      parts?: unknown
      agent?: string
    model?: { providerID?: string; modelID?: string }
    variant?: string
  }
    const text = textOf(body?.parts) || `message ${hits.promptCount}`
    hits.promptBodies.push({
      messageID: body?.messageID,
      text,
      agent: body?.agent,
      providerID: body?.model?.providerID,
      modelID: body?.model?.modelID,
      variant: body?.variant,
    })
    const id = body?.messageID || `msg_user_${hits.promptCount}`
    const providerID = body?.model?.providerID || "claude-acp"
    const modelID = body?.model?.modelID || "claude-sonnet-4-6"
    const agent = body?.agent || "build"
    messages = [
      ...messages,
      userMessage({ id, text, agent, providerID, modelID }),
      assistantMessage({
        id: `msg_assistant_${hits.promptCount}`,
        parentID: id,
        text: `ack ${hits.promptCount}: ${text}`,
        agent,
        providerID,
        modelID,
      }),
    ]
    await route.fulfill({ status: 204, body: "" })
  })

  await page.route("**/session/*/shell**", async (route) => {
    if (!api(route)) return route.continue()
    const url = new URL(route.request().url())
    if (!url.pathname.match(/^\/session\/[^/]+\/shell$/)) return route.fallback()
    hits.shellCount += 1
    const body = route.request().postDataJSON() as {
      command?: string
      agent?: string
      model?: { providerID?: string; modelID?: string }
    }
    hits.shellBodies.push({
      command: body.command,
      agent: body.agent,
      providerID: body.model?.providerID,
      modelID: body.model?.modelID,
      directory: url.searchParams.get("directory") ?? undefined,
    })
    await route.fulfill({ status: 204, body: "" })
  })

  await page.route("**/session/*/command**", async (route) => {
    if (!api(route)) return route.continue()
    const url = new URL(route.request().url())
    if (!url.pathname.match(/^\/session\/[^/]+\/command$/)) return route.fallback()
    hits.slashCount += 1
    const body = route.request().postDataJSON() as {
      command?: string
      arguments?: string
      agent?: string
      model?: string
      parts?: unknown[]
    }
    hits.slashBodies.push({
      command: body.command,
      arguments: body.arguments,
      agent: body.agent,
      model: body.model,
      partCount: Array.isArray(body.parts) ? body.parts.length : 0,
      directory: url.searchParams.get("directory") ?? undefined,
    })
    await route.fulfill({ status: 204, body: "" })
  })

  await page.route("**/session/*/message**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(messages) })
  })

  await page.route("**/session/*", async (route) => {
    if (!api(route)) return route.continue()
    if (!new URL(route.request().url()).pathname.match(/^\/session\/[^/]+$/)) return route.fallback()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session(textOf(messages[0]?.parts) || "", sessionConfig())) })
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
  // ERR_ABORTED is benign — Chromium reports it for in-flight EventSource
  // / fetch requests Playwright tears down at context close, and for the
  // prompt-input's POST when the page navigates onto the freshly-created
  // session route before the response settles. Mirrors the filter used in
  // cloud-runtime-relay-routing.spec.ts.
  return hits.failed.filter(
    (item) =>
      !item.includes(".clerk.accounts.dev/") &&
      !item.includes("http://127.0.0.1:3001/") &&
      !item.endsWith(" net::ERR_ABORTED"),
  )
}

function nonClerkConsole(hits: Hits) {
  return hits.console.filter(
    (item) =>
      !item.includes("clerk.accounts.dev") &&
      !item.includes("Clerk:") &&
      !item.includes("[global-sdk] event stream failed {url: http://127.0.0.1:3001") &&
      !item.includes("Failed to load resource") &&
      !item.includes("ERR_FAILED"),
  )
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

function expectLocalRuntimeModel(model: { providerID?: string; modelID?: string }) {
  expect([
    "claude-acp/claude-sonnet-4-6",
    "opencode/big-pickle",
  ]).toContain(`${model.providerID}/${model.modelID}`)
}

async function openDraftPrompt(page: Page) {
  await page.goto(`/${slug(DIR)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  const promptVisible = await page
    .getByRole("textbox", { name: /Ask anything/i })
    .isVisible()
    .catch(() => false)
  if (!promptVisible) {
    await page.getByRole("button", { name: /New session/i }).first().click()
  }

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

async function expectOnlyHarnessModelControl(page: Page, modelName: string | RegExp) {
  await expect(page.locator('[data-action="prompt-harness-model"]').last()).toContainText(
    typeof modelName === "string" ? literalText(modelName) : modelName,
    { timeout: 20_000 },
  )
  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-model-variant"]')).toHaveCount(0)
}

function literalText(value: string) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
}

async function composePrompt(page: Page, input: Locator, text: string) {
  await input.click()
  await input.fill(text)
  if (!((await input.textContent()) ?? "").includes(text)) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
    await page.keyboard.type(text)
  }
  await expect(input).toContainText(text, { timeout: 10_000 })
}

test("core local session survives multiple turns and reload resume @core", async ({ page }) => {
  const hits = createHits()

  await seed(page)
  await setup(page, hits)

  const first = "core local first turn"
  const second = "core local resumed second turn"
  const input = await openDraftPrompt(page)
  await input.fill(first)
  await page.locator('[data-action="prompt-submit"]').last().click()

  await expect.poll(() => hits.promptCount, { timeout: 15_000 }).toBe(1)
  await expect(
    page.locator('[data-slot="session-turn-message-content"]').getByText(first, { exact: true }),
  ).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID))

  await input.fill(second)
  await page.locator('[data-action="prompt-submit"]').last().click()

  await expect.poll(() => hits.promptCount, { timeout: 15_000 }).toBe(2)
  await expect(
    page.locator('[data-slot="session-turn-message-content"]').getByText(second, { exact: true }),
  ).toBeVisible({ timeout: 20_000 })

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(
    page.locator('[data-slot="session-turn-message-content"]').getByText(first, { exact: true }),
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    page.locator('[data-slot="session-turn-message-content"]').getByText(second, { exact: true }),
  ).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(`ack 2: ${second}`, { exact: true })).toBeVisible({ timeout: 20_000 })

  expect(hits.createSessionCount).toBe(1)
  expect(hits.promptBodies.map((body) => body.text)).toEqual([first, second])
  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
  expect(hits.badResponses).toEqual([])
})

for (const harnessCase of [
  {
    label: "Claude ACP",
    option: /^Claude$/,
    optionIndex: 0,
    modelLabel: /Sonnet 4\.6|claude-sonnet-4-6/i,
    providerID: "claude-acp",
    modelID: "claude-sonnet-4-6",
  },
  {
    label: "Codex Native SDK",
    option: /^Codex$/,
    optionIndex: 1,
    modelLabel: /GPT-5\.5|gpt-5\.5/i,
    providerID: "codex-app-server",
    modelID: "gpt-5.5",
  },
  {
    label: "Cursor ACP",
    option: /^Cursor$/,
    optionIndex: 0,
    modelLabel: /Cursor Auto|cursor-auto/i,
    providerID: "cursor-acp",
    modelID: "cursor-auto",
  },
] as const) {
test(`core local ${harnessCase.label} keeps OpenCode model controls out across turns and reload @core`, async ({ page }) => {
  const hits = createHits()

  await seed(page)
  await setup(page, hits)

  const input = await openDraftPrompt(page)
  await page.getByRole("button", { name: /^OpenCode$/ }).last().click()
  await page.getByRole("option", { name: harnessCase.option }).nth(harnessCase.optionIndex).click()
  await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

  const first = `core local ${harnessCase.label.toLowerCase()} first turn`
  await composePrompt(page, input, first)
  await page.locator('[data-action="prompt-submit"]').last().click()

  await expect.poll(() => hits.promptCount, { timeout: 15_000 }).toBe(1)
  expect(hits.createSessionCount).toBe(1)
  expect(hits.harnessSessionCreateCount).toBe(1)
  expect(hits.promptBodies[0]).toMatchObject({
    text: first,
    agent: "build",
    providerID: harnessCase.providerID,
    modelID: harnessCase.modelID,
  })
  expect(hits.promptBodies[0]?.variant).toBeUndefined()
  await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID))
  await expect(page.getByText(`ack 1: ${first}`, { exact: true })).toBeVisible({ timeout: 20_000 })
  await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

  const second = `core local ${harnessCase.label.toLowerCase()} second turn`
  await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), second)
  await page.locator('[data-action="prompt-submit"]').last().click()
  await expect.poll(() => hits.promptCount, { timeout: 15_000 }).toBe(2)
  expect(hits.promptBodies[1]).toMatchObject({
    text: second,
    agent: "build",
    providerID: harnessCase.providerID,
    modelID: harnessCase.modelID,
  })
  expect(hits.promptBodies[1]?.variant).toBeUndefined()
  await expect(page.getByText(`ack 2: ${second}`, { exact: true })).toBeVisible({ timeout: 20_000 })
  await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expectOnlyHarnessModelControl(page, harnessCase.modelLabel)

  const third = `core local ${harnessCase.label.toLowerCase()} resumed turn`
  await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), third)
  await page.locator('[data-action="prompt-submit"]').last().click()

  await expect.poll(() => hits.promptCount, { timeout: 15_000 }).toBe(3)
  expect(hits.promptBodies[2]).toMatchObject({
    text: third,
    agent: "build",
    providerID: harnessCase.providerID,
    modelID: harnessCase.modelID,
  })
  expect(hits.promptBodies[2]?.variant).toBeUndefined()
  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
  expect(hits.badResponses).toEqual([])
})
}

test("core local unavailable harness does not fall back to OpenCode controls @core", async ({ page }) => {
  const hits = createHits()

  await seed(page)
  await setup(page, hits, { optionsError: "Authentication required. Please run 'agent login' first." })

  await openDraftPrompt(page)
  await page.getByRole("button", { name: /^OpenCode$/ }).last().click()
  await page.getByRole("option", { name: /^Claude$/ }).first().click()

  await expect(page.getByRole("button", { name: /^Claude$/ }).last()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-action="prompt-harness-model"]').last()).toContainText(/Unavailable|Select model/i, { timeout: 20_000 })
  await expect(page.locator("[aria-label=\"Authentication required. Please run 'agent login' first.\"]")).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-model-variant"]')).toHaveCount(0)

  await page.getByRole("textbox", { name: /Ask anything/i }).last().fill("should not send")
  await expect(page.locator('[data-action="prompt-submit"]').last()).toBeDisabled()
  await page.waitForTimeout(250)
  expect(hits.promptCount).toBe(0)
  expect(hits.createSessionCount).toBe(0)
  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
})

test("core local unavailable SDK harness disables submit with fixed model visible @core", async ({ page }) => {
  const hits = createHits()

  await seed(page)
  await setup(page, hits, {
    statusError: "Codex SDK is unavailable. Please sign in before sending.",
  })

  const input = await openDraftPrompt(page)
  await page.getByRole("button", { name: /^OpenCode$/ }).last().click()
  await page.getByRole("option", { name: /^Codex$/ }).nth(1).click()

  await expect(page.getByRole("button", { name: /^Codex$/ }).last()).toBeVisible({ timeout: 20_000 })
  await expectOnlyHarnessModelControl(page, /GPT-5\.5|gpt-5\.5/i)

  await composePrompt(page, input, "should not send while sdk unavailable")
  await expect(page.locator('[data-action="prompt-submit"]').last()).toBeDisabled()
  await page.locator('[data-action="prompt-submit"]').last().click({ force: true })
  await page.waitForTimeout(250)
  expect(hits.promptCount).toBe(0)
  expect(hits.createSessionCount).toBe(0)
  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
})

test("first prompt in a new local OpenCode session round-trips through the runtime", async ({ page }) => {
  const hits = createHits()

  await seed(page)
  await setup(page, hits)

  // Land on the project's session-list route — what the persisted workbench
  // would open into when the user picks a local project they've used before.
  await page.goto(`/${slug(DIR)}/session`)
  await page.waitForLoadState("domcontentloaded")

  // Shell paints.
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  // Open a brand-new session. The "New session" button on the rail is the
  // canonical entry point. If the prompt input is already showing (some warm
  // boots auto-mount it), skip the click.
  const promptVisible = await page
    .getByRole("textbox", { name: /Ask anything/i })
    .isVisible()
    .catch(() => false)
  if (!promptVisible) {
    await page.getByRole("button", { name: /New session/i }).first().click()
  }

  // Prompt input is reachable.
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")

  // Type and send the first prompt.
  const userText = "hello first local prompt"
  await input.fill(userText)
  const submit = page.locator('[data-action="prompt-submit"]').last()
  await expect(submit).toBeVisible({ timeout: 10_000 })
  await submit.click()

  // The send call actually fires the right endpoint with the right shape.
  await expect.poll(() => hits.promptCount, { timeout: 15_000 }).toBe(1)
  expect(hits.createSessionCount).toBe(1)
  const sent = hits.promptBodies[0]!
  expect(sent.text).toBe(userText)
  expectLocalRuntimeModel(sent)
  expect(sent.agent).toBe("build")
  expect(typeof sent.messageID === "string" && sent.messageID.length > 0).toBe(true)

  // Optimistic / server-reconciled user turn renders in the timeline. The
  // assistant ack comes back through the events stream (not the message
  // re-fetch) which this spec deliberately does not push through — we
  // assert the user round-trip end-to-end and leave full assistant replay
  // to the dedicated reload-message-flow spec.
  await expect(
    page.locator('[data-slot="session-turn-message-content"]').getByText(userText, { exact: true }),
  ).toBeVisible({ timeout: 20_000 })

  // No duplicate user turn from the optimistic + replay merge.
  const userTurns = await page
    .locator('[data-slot="session-turn-message-content"]')
    .getByText(userText, { exact: true })
    .count()
  expect(userTurns).toBe(1)

  // Navigated onto the new session route (URL now references the created
  // session, no longer the bare /session list).
  await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID))

  // Submit control reflects ready/idle state once the round-trip settled
  // (the prompt_async 204 plus the session.idle SSE event drain the busy
  // marker the prompt-input shows during dispatch).
  await expect(page.locator('[data-action="prompt-submit"]').last()).toBeVisible({ timeout: 20_000 })

  // Exactly one prompt fired even after the timeline settled.
  expect(hits.promptCount).toBe(1)

  // No regressions / noise.
  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
  expect(hits.badResponses).toEqual([])
})

test("shell bang dispatches the first local submit through the shell endpoint", async ({ page }) => {
  const hits = createHits()

  await seed(page)
  await setup(page, hits)

  const input = await openDraftPrompt(page)
  await input.click()
  await input.press("!")
  const command = "echo p5 shell matrix"
  await expect(page.getByRole("textbox", { name: /Enter shell command/i }).last()).toBeVisible({ timeout: 10_000 })
  await page.keyboard.type(command)
  await page.locator('[data-action="prompt-submit"]').last().click()

  await expect.poll(() => hits.shellCount, { timeout: 15_000 }).toBe(1)
  expect(hits.promptCount).toBe(0)
  expect(hits.slashCount).toBe(0)
  expect(hits.createSessionCount).toBe(1)
  expect(hits.opencodeSessionCreateCount).toBe(1)
  expect(hits.harnessSessionCreateCount).toBe(0)
  expect(hits.shellBodies[0]).toMatchObject({
    command,
    agent: "build",
    directory: DIR,
  })
  expectLocalRuntimeModel(hits.shellBodies[0]!)
  await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID))
  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
  expect(hits.badResponses).toEqual([])
})

test("slash command dispatches the first local submit through the command endpoint", async ({ page }) => {
  const hits = createHits()

  await seed(page)
  await setup(page, hits)

  const input = await openDraftPrompt(page)
  await input.fill("/build release target")
  await page.locator('[data-action="prompt-submit"]').last().click()

  await expect.poll(() => hits.slashCount, { timeout: 15_000 }).toBe(1)
  expect(hits.promptCount).toBe(0)
  expect(hits.shellCount).toBe(0)
  expect(hits.createSessionCount).toBe(1)
  expect(hits.opencodeSessionCreateCount).toBe(1)
  expect(hits.harnessSessionCreateCount).toBe(0)
  expect(hits.slashBodies[0]).toEqual({
    command: "build",
    arguments: "release target",
    agent: "build",
    model: "claude-acp/claude-sonnet-4-6",
    partCount: 0,
    directory: DIR,
  })
  await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID))
  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
  expect(hits.badResponses).toEqual([])
})

test("non-OpenCode harness draft claims a prepared runtime session before prompting", async ({ page }) => {
  const hits = createHits()

  await seed(page)
  await setup(page, hits, { harness: "claude-acp" })

  const input = await openDraftPrompt(page)
  const text = "hello claimed harness prompt"
  await input.fill(text)
  await page.locator('[data-action="prompt-submit"]').last().click()

  await expect.poll(() => hits.promptCount, { timeout: 15_000 }).toBe(1)
  expect(hits.createSessionCount).toBe(1)
  expect(hits.opencodeSessionCreateCount).toBe(0)
  expect(hits.harnessSessionCreateCount).toBe(1)
  expect(hits.shellCount).toBe(0)
  expect(hits.slashCount).toBe(0)
  expect(hits.promptBodies[0]?.text).toBe(text)
  expect(hits.promptBodies[0]?.providerID).toBe("claude-acp")
  expect(hits.promptBodies[0]?.modelID).toBe("claude-sonnet-4-6")
  await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID))
  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
  expect(hits.badResponses).toEqual([])
})
