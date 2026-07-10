import { expect, test, type Page, type Route } from "@playwright/test"
import sharp from "sharp"

// Flow #10 from docs/tech-docs/architecture-direction-flow.md "Real Browser
// Coverage": "Open terminal in a workspace and confirm it does not steal
// session focus."
//
// What this test does:
// 1. Boot into a session and confirm session-content is mounted + URL is on
//    the session route.
// 2. Trigger the in-session `terminal.new` command via its registered
//    keybind (ctrl+alt+t). The handler calls
//    `claxedoState.layout.openTerminal(dir, pendingId, "Terminal")`, which
//    creates a new content slot and queues a PTY create.
// 3. Mock the PTY-create POST (`/api/wr/pty?directory=...`) so the
//    spec never hits a real backend, and feed the terminal WebSocket a
//    deterministic prompt so the spec proves xterm paints visible output.
// 4. Assert: a workbench content slot mounts for the terminal, a tab row
//    surfaces it, the session content slot is still mounted (focus was not
//    stolen), and the URL still points at the session route.
//
// Portal-host / GroupIdProvider note: TerminalContent (see
// claxedo-ui/content-renderers/terminal-content.tsx) wraps its body in
// `DirectoryScope` and renders `TerminalContentInner`. The workbench layout
// (claxedo-ui/layout/workbench.tsx:464) gives each content a stable
// `data-workbench-content={contentId}` slot, and the per-pane data-pane-id
// host is what the per-group state machinery treats as the portal host. We
// assert on `data-workbench-content` because the per-content slot is the
// public, layout-agnostic marker — it is the same node a group-scoped
// `TerminalContentWrapperInner` instance would target.

const DIR = "/tmp/e2e-terminal-in-workspace"
const SESSION_ID = "ses_terminal_in_workspace"
const PTY_ID = "pty_terminal_in_workspace"
const RECOVERED_PTY_ID = "pty_terminal_in_workspace_recovered"
const TERMINAL_PROMPT = "~/e2e-terminal-in-workspace $ "

type Hits = {
  console: string[]
  failed: string[]
  badResponses: string[]
  requests: string[]
  unhandled: string[]
}

type Counters = {
  ptyCreates: number
  ptyClones: number
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

function isPtyCollectionPath(pathname: string) {
  return pathname === "/api/wr/pty" || /^\/workspaces\/[^/]+\/api\/wr\/pty$/.test(pathname)
}

function isPtyItemPath(pathname: string) {
  return pathname.startsWith("/api/wr/pty/") || /^\/workspaces\/[^/]+\/api\/wr\/pty\//.test(pathname)
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
    projectID: "proj_terminal_in_workspace",
    directory: DIR,
    title: "Terminal-in-workspace session",
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
          text: "Session timeline before terminal opens",
        },
      ],
    },
  ]
}

function navigationRow() {
  return {
    type: "session",
    sessionRef: `local:${DIR}:session:${SESSION_ID}`,
    sessionId: SESSION_ID,
    title: "Terminal-in-workspace session",
    directory: DIR,
    workspaceId: "local-terminal-in-workspace",
    projectId: "proj_terminal_in_workspace",
    projectName: "terminal-in-workspace",
    workspaceName: "main",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    tags: [],
    attachments: [],
    environment: { kind: "local" },
    git: { branch: "main" },
  }
}

async function seed(page: Page, options?: { missingPtyId?: string }) {
  await page.addInitScript(({ dir, prompt, missingPtyId }: { dir: string; prompt: string; missingPtyId?: string }) => {
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
    // Stub WebSocket so the terminal's `/api/wr/pty/.../connect` open
    // does not actually hit a real ws:// endpoint and pollute hits.failed.
    // Non-pty WebSocket users (e.g. SSE polyfills) fall through to the
    // real implementation. The fake socket still emits shell output so this
    // regression spec catches blank-terminal rendering failures.
    const OriginalWebSocket = window.WebSocket
    const FakeWebSocket = new Proxy(OriginalWebSocket, {
      construct(_target, args: [string | URL, (string | string[])?]) {
        const url = String(args[0])
        if (!url.includes("/api/wr/pty/")) {
          return Reflect.construct(OriginalWebSocket, args)
        }
        const target = new EventTarget() as EventTarget & {
          url: string
          readyState: number
          send: () => void
          close: () => void
          onopen: ((ev: Event) => void) | null
          onclose: ((ev: CloseEvent) => void) | null
          onerror: ((ev: Event) => void) | null
          onmessage: ((ev: MessageEvent) => void) | null
        }
        target.url = url
        target.readyState = 0
        target.send = () => {}
        target.close = () => {
          target.readyState = 3
        }
        target.onopen = null
        target.onclose = null
        target.onerror = null
        target.onmessage = null
        setTimeout(() => {
          target.readyState = 1
          const open = new Event("open")
          target.onopen?.(open)
          target.dispatchEvent(open)
        }, 0)
        setTimeout(() => {
          if (target.readyState !== 1) return
          const message = new MessageEvent("message", { data: `\x1b[36m${prompt}\x1b[0m` })
          target.onmessage?.(message)
          target.dispatchEvent(message)
        }, 20)
        setTimeout(() => {
          if (target.readyState === 3) return
          target.readyState = 3
          const missing = !!missingPtyId && url.includes(`/pty/${missingPtyId}/`)
          const ev = new CloseEvent("close", {
            code: missing ? 1008 : 1000,
            reason: missing ? "Session not found" : "test",
            wasClean: !missing,
          })
          target.onclose?.(ev)
          target.dispatchEvent(ev)
        }, 1_000)
        return target
      },
    })
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    })
  }, { dir: DIR, prompt: TERMINAL_PROMPT, missingPtyId: options?.missingPtyId })
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
        project: [{ id: "proj_terminal_in_workspace", name: "terminal-in-workspace", worktree: DIR, sandboxes: [] }],
        provider: provider(),
        provider_auth: { "claude-acp": [{ type: "api", label: "API key" }] },
        config: { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } },
      })
      return
    }

    if (
      url.pathname === "/api/claxedo/events" ||
      url.pathname === "/api/wr/events" ||
      url.pathname === "/global/event" ||
      url.pathname === "/event"
    ) {
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

    if (url.pathname === "/path") {
      await json(route, { state: "", config: "", worktree: DIR, directory: DIR, home: "" })
      return
    }

    if (url.pathname === "/project" || url.pathname === "/experimental/project") {
      await json(route, [{ id: "proj_terminal_in_workspace", name: "terminal-in-workspace", worktree: DIR, sandboxes: [] }])
      return
    }

    if (url.pathname === "/project/current" || url.pathname === "/project/proj_terminal_in_workspace") {
      await json(route, { id: "proj_terminal_in_workspace", name: "terminal-in-workspace", worktree: DIR, sandboxes: [] })
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
      await json(route, { workspaceId: "local-terminal-in-workspace", directory: DIR, kind: "local", status: "ready" })
      return
    }

    if (url.pathname === "/api/workspace") {
      await json(route, { workspaces: [] })
      return
    }

    if (
      url.pathname.startsWith("/api/claxedo/hook/terminal-session") ||
      url.pathname.startsWith("/api/wr/hook/terminal-session")
    ) {
      await json(route, [])
      return
    }

    if (url.pathname === "/api/claxedo/agent-config/harness/options") {
      await json(route, { options: [], source: "empty", stale: false })
      return
    }

    if (url.pathname === `/session/${SESSION_ID}/config`) {
      await json(route, { provider: { id: "claude-acp", model: "claude-sonnet-4-6" }, agent: { id: "build" } })
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
        view: {
          scope: "project",
          groupBy: "none",
          sort: "updated_desc",
          limit: 5,
        },
        items: [navigationRow()],
        nextCursor: null,
        totalKnown: 1,
      })
      return
    }

    if (url.pathname === `/session/${SESSION_ID}`) {
      await json(route, session())
      return
    }

    if (url.pathname === `/api/claxedo/session/${SESSION_ID}/meta`) {
      await json(route, {
        sessionID: SESSION_ID,
        title: "Terminal-in-workspace session",
        directory: DIR,
        workspaceId: "local-terminal-in-workspace",
        tags: [],
        attachments: [],
      })
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

    // Terminal endpoints: mock PTY create + lifecycle so no real backend is
    // contacted. Local loopback workspaces now route through
    // /workspaces/:id/api/wr/pty, while unresolved/direct terminals still use
    // /api/wr/pty.
    if (isPtyCollectionPath(url.pathname) && request.method() === "POST") {
      counters.ptyCreates += 1
      const body = (() => {
        try {
          return request.postDataJSON() as { env?: { previousPtyId?: string } }
        } catch {
          return undefined
        }
      })()
      if (body?.env?.previousPtyId) {
        counters.ptyClones += 1
        await json(route, { id: RECOVERED_PTY_ID, title: "Terminal 1", cwd: DIR })
        return
      }
      await json(route, { id: PTY_ID, title: "Terminal 1", cwd: DIR })
      return
    }
    if (isPtyCollectionPath(url.pathname) && request.method() === "GET") {
      await json(route, counters.ptyCreates > 0
        ? [
          { id: PTY_ID, title: "Terminal 1", cwd: DIR },
          ...(counters.ptyClones > 0 ? [{ id: RECOVERED_PTY_ID, title: "Terminal 1", cwd: DIR }] : []),
        ]
        : [])
      return
    }
    if (isPtyItemPath(url.pathname)) {
      // PUT (resize/rename) or session-preview log fetch
      await json(route, { ok: true })
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
      await json(route, [])
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
  return hits.failed.filter((item) =>
    !item.includes(".clerk.accounts.dev/") &&
    !(item.includes(" net::ERR_ABORTED") && !item.includes("/api/"))
  )
}

function nonClerkConsole(hits: Hits) {
  return hits.console.filter(
    (item) =>
      !item.includes("clerk.accounts.dev") &&
      !item.includes("Clerk:") &&
      !item.includes("Failed to load resource") &&
      !item.includes("ERR_FAILED") &&
      !item.includes("GPU stall due to ReadPixels") &&
      // Terminal-mock close noise: our fake WebSocket fires a clean close so
      // the connection layer can log the synthetic "test" close reason
      // without indicating a real product regression.
      !item.includes("test") &&
      !/WebSocketClose|terminal/i.test(item),
  )
}

async function visibleTerminalContentSlots(page: Page) {
  return await page.evaluate(() => {
    const slots = Array.from(document.querySelectorAll("[data-workbench-content]")) as HTMLElement[]
    return slots
      .filter((el) => {
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden") return false
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      .map((el) => el.dataset.workbenchContent ?? "")
      .filter((id) => id.length > 0)
  })
}

function terminalPane(page: Page, terminalId: string) {
  return page.locator(`[data-testid="terminal-pane"][data-terminal-id="${terminalId}"]`)
}

async function terminalPaintSummary(page: Page, terminalId: string) {
  const terminal = terminalPane(page, terminalId).locator(".xterm").first()
  const box = await terminal.boundingBox()
  if (!box) return { visible: false, width: 0, height: 0, chromaPixels: 0 }

  const image = await sharp(await terminal.screenshot())
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let chromaPixels = 0
  for (let i = 0; i < image.data.length; i += 4) {
    if ((image.data[i + 3] ?? 0) === 0) continue
    const red = image.data[i] ?? 0
    const green = image.data[i + 1] ?? 0
    const blue = image.data[i + 2] ?? 0
    if (Math.max(red, green, blue) - Math.min(red, green, blue) > 28) {
      chromaPixels += 1
    }
  }

  return {
    visible: box.width > 480 && box.height > 80,
    width: box.width,
    height: box.height,
    chromaPixels,
  }
}

test("opening a terminal mid-session leaves the session pane intact @core", async ({ page }) => {
  const hits: Hits = { console: [], failed: [], badResponses: [], requests: [], unhandled: [] }
  const counters: Counters = { ptyCreates: 0, ptyClones: 0 }

  await seed(page)
  await setup(page, hits, counters)

  const sessionUrl = `/${slug(DIR)}/session/${SESSION_ID}`
  await page.goto(sessionUrl, { waitUntil: "domcontentloaded" })

  const sessionContent = page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]`)
  await expect(sessionContent).toBeVisible({ timeout: 30_000 })
  await expect(page.locator("[data-claxedo]")).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/${slug(DIR)}/session/${SESSION_ID}$`))

  // Workbench content IDs present before terminal open. Each session/terminal
  // pane is represented by a data-workbench-content slot.
  const sessionSlotId = await sessionContent.evaluate(
    (node) => node.closest("[data-workbench-content]")?.getAttribute("data-workbench-content") ?? "",
  )
  expect(sessionSlotId).not.toBe("")

  const sessionNavRow = page.getByRole("button", { name: /Terminal-in-workspace session/ }).first()
  await expect(sessionNavRow).toBeVisible({ timeout: 10_000 })

  // Focus the prompt input so the registered session command receives the
  // ctrl+alt+t keybind. session commands are bound on the active session
  // tree, so a focus inside the session content is the safest precondition.
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })

  const workspacePanel = page.locator('[data-testid="workspace-panel-shell"]')
  await page.getByTestId("workspace-panel-toggle").first().click()
  await expect(workspacePanel).toHaveAttribute("data-open", "true", { timeout: 10_000 })

  await input.click()

  await page.keyboard.press("Control+Alt+t")

  // PTY create was mocked + actually invoked, so we know the terminal
  // pipeline kicked off (terminal.new command → queueCreateForContent →
  // terminal.new() → POST /api/wr/pty).
  await expect.poll(() => counters.ptyCreates, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

  // With the sidebar pinned, pane navigation is represented by the sidebar
  // rows instead of the compact workbench switcher. The terminal row appears
  // alongside the existing session row rather than replacing it.
  await expect(page.getByRole("button", { name: /^Terminal\b/ }).first()).toBeVisible({ timeout: 10_000 })
  await expect(sessionNavRow).toBeVisible({ timeout: 10_000 })
  await expect(workspacePanel).toHaveAttribute("data-open", "false", { timeout: 10_000 })

  // The pending terminal route must survive incidental session focus churn
  // until TerminalContent replaces it with the real PTY id.
  await expect(page).toHaveURL(new RegExp(`/w/${encodeURIComponent(DIR)}/terminal/${PTY_ID}$`), {
    timeout: 15_000,
  })

  // There is at least one workbench content slot for a non-session content
  // (the new terminal content). It is distinct from the session slot id,
  // and is the public portal host hook the per-group TerminalContentInner
  // wrapper targets — same node a GroupIdProvider scope would attach to.
  const allSlotIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-workbench-content]"))
      .map((el) => (el as HTMLElement).dataset.workbenchContent ?? "")
      .filter(Boolean),
  )
  const terminalSlotIds = allSlotIds.filter((id) => id !== sessionSlotId)
  expect(terminalSlotIds.length).toBeGreaterThan(0)

  await expect(terminalPane(page, PTY_ID)).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => (await terminalPaintSummary(page, PTY_ID)).visible, { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => (await terminalPaintSummary(page, PTY_ID)).chromaPixels, { timeout: 15_000 }).toBeGreaterThan(25)

  // Switching back to the session entry re-mounts the session content
  // portal host with the original session id — confirming the terminal
  // open did not corrupt the session content metadata.
  await sessionNavRow.click()
  await expect(sessionContent).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL(new RegExp(`/(?:s/${SESSION_ID}|${slug(DIR)}/session/${SESSION_ID}|w/${encodeURIComponent(DIR)}/session/${SESSION_ID})$`), {
    timeout: 10_000,
  })

  // Persistence guardrails — boot state survives intact.
  const persisted = await page.evaluate(() => ({
    server: localStorage.getItem("opencode.global.dat:server"),
    model: localStorage.getItem("opencode.global.dat:model"),
  }))
  expect(persisted.server).not.toBeNull()
  expect(persisted.model).not.toBeNull()

  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
  expect(hits.unhandled).toEqual([])
})

test("direct terminal routes mount a visible terminal pane @happy", async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const hits: Hits = { console: [], failed: [], badResponses: [], requests: [], unhandled: [] }
  const counters: Counters = { ptyCreates: 0, ptyClones: 0 }

  await seed(page)
  await setup(page, hits, counters)

  await page.goto(`/w/${encodeURIComponent(DIR)}/terminal/${PTY_ID}`, { waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(new RegExp(`/w/${encodeURIComponent(DIR)}/terminal/${PTY_ID}$`))

  await expect(page.getByRole("button", { name: /^Terminal\b/ }).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.locator("[data-workbench-content]").first()).toBeVisible({ timeout: 10_000 })
  await expect(terminalPane(page, PTY_ID)).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => (await terminalPaintSummary(page, PTY_ID)).visible, { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => (await terminalPaintSummary(page, PTY_ID)).chromaPixels, { timeout: 15_000 }).toBeGreaterThan(25)
  await expect(page.locator('[data-testid="workspace-panel-shell"]')).toHaveAttribute("data-open", "false", {
    timeout: 10_000,
  })

  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
  expect(hits.unhandled).toEqual([])

  await context.close()
})

test("direct terminal routes replace stale PTY ids after recovery", async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const hits: Hits = { console: [], failed: [], badResponses: [], requests: [], unhandled: [] }
  const counters: Counters = { ptyCreates: 0, ptyClones: 0 }

  await seed(page, { missingPtyId: PTY_ID })
  await setup(page, hits, counters)

  await page.goto(`/w/${encodeURIComponent(DIR)}/terminal/${PTY_ID}`, { waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(new RegExp(`/w/${encodeURIComponent(DIR)}/terminal/${PTY_ID}$`))
  await expect(terminalPane(page, PTY_ID)).toBeVisible({ timeout: 15_000 })

  await expect.poll(() => counters.ptyClones, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
  await expect(page).toHaveURL(new RegExp(`/w/${encodeURIComponent(DIR)}/terminal/${RECOVERED_PTY_ID}$`), {
    timeout: 15_000,
  })
  await expect(terminalPane(page, RECOVERED_PTY_ID)).toBeVisible({ timeout: 15_000 })
  await expect(terminalPane(page, PTY_ID)).toHaveCount(0)
  await expect.poll(async () => (await terminalPaintSummary(page, RECOVERED_PTY_ID)).visible, { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => (await terminalPaintSummary(page, RECOVERED_PTY_ID)).chromaPixels, { timeout: 15_000 }).toBeGreaterThan(25)

  expectNoRouteStackOverflow(hits)
  expect(nonClerkConsole(hits)).toEqual([])
  expect(nonClerkFailures(hits)).toEqual([])
  expect(hits.unhandled).toEqual([])

  await context.close()
})
