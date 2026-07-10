import { expect, test, type Page, type Route } from "@playwright/test"

const DIR = "/tmp/e2e-reload-message-flow"
const SESSION_ID = "ses_reload_flow"

type SessionRow = {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  version: string
  time: { created: number; updated: number }
  summary: { additions: number; deletions: number; files: number }
  config?: unknown
}

type MessageRow = {
  info: {
    id: string
    sessionID: string
    role: "user" | "assistant"
    time: Record<string, number>
    agent: string
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

type QuestionRow = {
  id: string
  sessionID: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    custom: boolean
    multiple?: boolean
  }>
}

type PermissionRow = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
}

let sessions: SessionRow[]
let messages: Record<string, MessageRow[]>
let pendingQuestion: QuestionRow | undefined
let pendingPermission: PermissionRow | undefined
let pendingPermissionReplyEvent: boolean
let createCount: number
let promptCount: number
let questionReplyCount: number
let permissionReplyCount: number

type SetupOptions = {
  delayedIdleStatusEvent?: boolean
  statusRouteMode?: "idle" | "busy"
  durableQuestionOnFirstPrompt?: boolean
  durablePermissionOnFirstPrompt?: boolean
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function api(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr"
}

function textOf(parts: unknown) {
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

function session(title = ""): SessionRow {
  return {
    id: SESSION_ID,
    slug: SESSION_ID,
    projectID: "proj_reload_flow",
    directory: DIR,
    title,
    version: "2",
    time: { created: Date.now(), updated: Date.now() },
    summary: { additions: 0, deletions: 0, files: 0 },
    config: sessionConfig(),
  }
}

function sessionConfig() {
  return {
    harness: { id: "claude-acp", type: "claude-acp", access: "native" },
    model: { providerID: "claude-acp", modelID: "claude-sonnet-4-6" },
    agent: "build",
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
  sessions = []
  messages = {}
  pendingQuestion = undefined
  pendingPermission = undefined
  pendingPermissionReplyEvent = false
  createCount = 0
  promptCount = 0
  questionReplyCount = 0
  permissionReplyCount = 0

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

async function setup(page: Page, options: SetupOptions = {}) {
  let releaseIdleStatusEvent: (() => void) | undefined
  const globalEvents = () => {
    const events = options.delayedIdleStatusEvent
      ? [
          { directory: "global", payload: { type: "server.connected", properties: {} } },
          {
            directory: DIR,
            payload: { type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "idle" } } },
          },
        ]
      : [
          { directory: "global", payload: { type: "server.connected", properties: {} } },
          { directory: DIR, payload: { type: "session.idle", properties: { sessionID: SESSION_ID } } },
        ]
    if (pendingPermissionReplyEvent) {
      pendingPermissionReplyEvent = false
      events.push({
        directory: DIR,
        payload: {
          type: "permission.replied",
          properties: { sessionID: SESSION_ID, requestID: "durable-permission-1" },
        },
      })
    }
    return events
  }

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
        project: [{ id: "proj_reload_flow", worktree: DIR, name: "reload-flow", time: { created: Date.now(), updated: Date.now() } }],
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
    if (options.delayedIdleStatusEvent) {
      await new Promise<void>((resolve) => {
        releaseIdleStatusEvent = resolve
      })
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: globalEvents().map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    })
  })

  await page.route("**/api/wr/events**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/api/wr/events") return route.fallback()
    if (options.delayedIdleStatusEvent) {
      await new Promise<void>((resolve) => {
        releaseIdleStatusEvent = resolve
      })
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: globalEvents().map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    })
  })

  await page.route("**/api/wr/runtime-events**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/api/wr/runtime-events") return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "",
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
      body: JSON.stringify(sessionConfig()),
    })
  })

  await page.route("**/project**", async (route) => {
    if (!api(route)) return route.continue()
    if (!["/project", "/experimental/project"].includes(new URL(route.request().url()).pathname)) return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: "proj_reload_flow", worktree: DIR, name: "reload-flow", time: { created: Date.now(), updated: Date.now() } }]),
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
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) })
  })

  await page.route("**/permission**", async (route) => {
    if (!api(route)) return route.continue()
    const pathname = new URL(route.request().url()).pathname
    if (pathname === "/permission") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(pendingPermission ? [pendingPermission] : []),
      })
      return
    }
    if (pathname === "/permission/durable-permission-1" && route.request().method() === "POST") {
      permissionReplyCount += 1
      pendingPermission = undefined
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
      return
    }
    return route.fallback()
  })

  await page.route("**/session/*/permissions/*", async (route) => {
    if (!api(route)) return route.continue()
    const pathname = new URL(route.request().url()).pathname
    if (pathname !== `/session/${SESSION_ID}/permissions/durable-permission-1` || route.request().method() !== "POST") {
      return route.fallback()
    }

    expect(route.request().postDataJSON()).toEqual({ response: "once" })
    permissionReplyCount += 1
    pendingPermission = undefined
    pendingPermissionReplyEvent = true
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
  })

  await page.route("**/question**", async (route) => {
    if (!api(route)) return route.continue()
    const pathname = new URL(route.request().url()).pathname
    if (pathname === "/question") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(pendingQuestion ? [pendingQuestion] : []),
      })
      return
    }
    if (pathname === "/question/durable-question-1/reply" && route.request().method() === "POST") {
      questionReplyCount += 1
      const body = route.request().postDataJSON() as { answers?: string[][] }
      const answer = body.answers?.[0]?.[0] ?? "unknown"
      pendingQuestion = undefined
      messages[SESSION_ID] = [
        ...(messages[SESSION_ID] ?? []),
        assistantMessage({
          id: "msg_assistant_after_question",
          parentID: "msg_assistant_1",
          text: `coordination accepted: ${answer}`,
          agent: "build",
          providerID: "claude-acp",
          modelID: "claude-sonnet-4-6",
        }),
      ]
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
      return
    }
    if (pathname === "/question/durable-question-1/reject" && route.request().method() === "POST") {
      pendingQuestion = undefined
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
      return
    }
    return route.fallback()
  })

  await page.route("**/api/workspace/resolve**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ workspaceId: "local-reload-flow", directory: DIR, kind: "local", status: "ready" }),
    })
  })

  await page.route("**/api/workspace/local-reload-flow/connection**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access: "local",
        backing: "local-worktree",
        runtimeKind: "local",
        workspaceId: "local-reload-flow",
        role: "editor",
        relayUrl: "http://127.0.0.1:3001",
        runtimeAccessToken: "rat_reload_flow",
        tokenExpiresAt: Date.now() + 120_000,
      }),
    })
  })

  await page.route("**/api/claxedo/agent-config/harness/options**", async (route) => {
    if (!api(route)) return route.continue()
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
            currentValue: "claude-sonnet-4-6",
            selectOptions: [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }],
          },
        ],
      }),
    })
  })

  await page.route("**/api/claxedo/agent-config/harness**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/api/claxedo/agent-config/harness") return route.fallback()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ type: "claude-acp", model: "claude-sonnet-4-6", ok: true }),
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
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) })
  })

  await page.route("**/session/status", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ [SESSION_ID]: { type: options.statusRouteMode ?? "idle" } }),
    })
  })

  const handleSessionList = async (route: Route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() === "POST") {
      createCount += 1
      sessions = [session()]
      messages[SESSION_ID] = []
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessions[0]) })
      return
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessions) })
  }

  await page.route("**/session", handleSessionList)
  await page.route("**/session?**", handleSessionList)

  await page.route("**/session/*/config**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } }),
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
    promptCount += 1
    const body = route.request().postDataJSON() as {
      messageID?: string
      parts?: unknown
      agent?: string
      model?: { providerID?: string; modelID?: string }
    }
    const id = body.messageID || `msg_user_${promptCount}`
    const text = textOf(body.parts) || `message ${promptCount}`
    const providerID = body.model?.providerID || "claude-acp"
    const modelID = body.model?.modelID || "claude-sonnet-4-6"
    const agent = body.agent || "build"
    messages[SESSION_ID] = [
      ...(messages[SESSION_ID] ?? []),
      userMessage({ id, text, agent, providerID, modelID }),
      assistantMessage({
        id: `msg_assistant_${promptCount}`,
        parentID: id,
        text: `ack ${promptCount}: ${text}`,
        agent,
        providerID,
        modelID,
      }),
    ]
    if (options.durableQuestionOnFirstPrompt && promptCount === 1) {
      pendingQuestion = {
        id: "durable-question-1",
        sessionID: SESSION_ID,
        questions: [{
          question: "Durable coordination: choose how to continue after reload.",
          header: "Durable coordination",
          options: [
            { label: "Proceed", description: "Continue the same chat after reload" },
            { label: "Stop", description: "Do not continue" },
          ],
          custom: false,
        }],
      }
    }
    if (options.durablePermissionOnFirstPrompt && promptCount === 1) {
      pendingPermission = {
        id: "durable-permission-1",
        sessionID: SESSION_ID,
        permission: "edit",
        patterns: ["src/**/*.ts"],
        metadata: {},
        always: [],
      }
    }
    sessions = [session(text)]
    releaseIdleStatusEvent?.()
    releaseIdleStatusEvent = undefined
    await route.fulfill({ status: 204, body: "" })
  })

  await page.route("**/session/*/message**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(messages[SESSION_ID] ?? []) })
  })

  await page.route("**/session/*", async (route) => {
    if (!api(route)) return route.continue()
    if (!new URL(route.request().url()).pathname.match(/^\/session\/[^/]+$/)) return route.fallback()
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessions[0] ?? session()) })
  })
}

async function ready(page: Page) {
  await page.goto(`/${slug(DIR)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

async function openNewSession(page: Page) {
  if (!(await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /New session/i }).first().click()
  }
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 20_000 })
}

async function send(page: Page, text: string) {
  const before = promptCount
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  await input.fill(text)
  await page.locator('[data-action="prompt-submit"]').last().click()
  await expect.poll(() => promptCount, { timeout: 15_000 }).toBe(before + 1)
}

async function expectTimelineMessage(page: Page, text: string) {
  await expect(page.locator('[data-slot="session-turn-message-content"]').getByText(text, { exact: true })).toBeVisible({
    timeout: 20_000,
  })
}

async function expectReadyToSend(page: Page) {
  await expect(page.locator('[data-action="prompt-submit"][aria-label="Send"]').last()).toBeVisible({ timeout: 20_000 })
}

test.skip("can send after reloading a session with existing messages", async ({ page }) => {
  await seed(page)
  await setup(page)
  await ready(page)

  await openNewSession(page)
  await send(page, "first reload-flow message")
  await expectTimelineMessage(page, "first reload-flow message")
  await send(page, "second reload-flow message")
  expect(createCount).toBe(1)
  await expectTimelineMessage(page, "second reload-flow message")
  await expect.poll(() => createCount).toBe(1)
  await expect.poll(() => promptCount).toBe(2)

  await page.reload()
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expectTimelineMessage(page, "first reload-flow message")
  await expectTimelineMessage(page, "second reload-flow message")

  await send(page, "third message after reload")
  await expectTimelineMessage(page, "third message after reload")
  await send(page, "fourth message after reload")
  await expectTimelineMessage(page, "fourth message after reload")

  await expect.poll(() => promptCount).toBe(4)
  expect(messages[SESSION_ID].filter((message) => message.info.role === "user").map((message) => message.parts[0]?.text)).toEqual([
    "first reload-flow message",
    "second reload-flow message",
    "third message after reload",
    "fourth message after reload",
  ])
})

test.skip("can approve durable pending permission and continue the chat", async ({ page }) => {
  await seed(page)
  await setup(page, { durablePermissionOnFirstPrompt: true })

  await ready(page)
  await openNewSession(page)
  await send(page, "first message needs a permission")
  await expectTimelineMessage(page, "first message needs a permission")
  await expect(page.getByText("Permission required")).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText("src/**/*.ts")).toBeVisible()

  await page.getByRole("button", { name: "Allow once" }).click()
  await expect.poll(() => permissionReplyCount, { timeout: 10_000 }).toBe(1)
  await expect(page.getByText("Permission required")).toBeHidden({ timeout: 20_000 })

  await send(page, "second message after permission")
  await expectTimelineMessage(page, "second message after permission")
  expect(messages[SESSION_ID].filter((message) => message.info.role === "user").map((message) => message.parts[0]?.text))
    .toEqual([
      "first message needs a permission",
      "second message after permission",
    ])
})

test.skip("session.status stream completion clears busy without polling idle fallback", async ({ page }) => {
  await seed(page)
  await setup(page, { delayedIdleStatusEvent: true, statusRouteMode: "busy" })
  await ready(page)

  await openNewSession(page)
  await send(page, "stream status clears busy")
  await expectTimelineMessage(page, "stream status clears busy")
  await expectReadyToSend(page)

  await send(page, "second send after stream idle")
  await expectTimelineMessage(page, "second send after stream idle")
  await expect.poll(() => promptCount).toBe(2)
})

test.skip("can answer durable pending question after reload and continue the chat", async ({ page }) => {
  await seed(page)
  await setup(page, { durableQuestionOnFirstPrompt: true })
  await ready(page)

  await openNewSession(page)
  await send(page, "first message creates durable coordination")
  await expectTimelineMessage(page, "first message creates durable coordination")
  await expect(page.getByText("Durable coordination: choose how to continue after reload.")).toBeVisible({
    timeout: 20_000,
  })

  await page.reload()
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expectTimelineMessage(page, "first message creates durable coordination")
  await expect(page.getByText("Durable coordination: choose how to continue after reload.")).toBeVisible({
    timeout: 20_000,
  })

  await page.getByRole("radio", { name: /Proceed/i }).click()
  await page.getByRole("button", { name: "Submit", exact: true }).click()
  await expect.poll(() => questionReplyCount, { timeout: 10_000 }).toBe(1)
  await expect(page.getByText("Durable coordination: choose how to continue after reload.")).toBeHidden({
    timeout: 20_000,
  })

  await send(page, "second message after durable question")
  await expectTimelineMessage(page, "second message after durable question")
  expect(messages[SESSION_ID].filter((message) => message.info.role === "user").map((message) => message.parts[0]?.text))
    .toEqual([
      "first message creates durable coordination",
      "second message after durable question",
    ])
})
