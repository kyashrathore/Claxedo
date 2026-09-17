/**
 * The terminal panel: workbench tabs backed by a server-owned PTY, covering creation from
 * the terminal creator, input/output over the socket, refit on split, exit cleanup, agent
 * status dots, auto-rename, and reattach across reload.
 *
 * A terminal lives in two independent pieces of state. The context store
 * (`src/context/terminal.tsx`) holds the per-directory PTY list and xterm snapshots under a
 * `terminal.v2` localStorage key; the workbench tab is `state.meta`, persisted with the rest
 * of the layout. The sidebar rows derive from `state.meta` alone and never consult the
 * store. Opening a terminal creates a pending content id first, then swaps in the real PTY
 * id in both `state.meta` and the URL once `terminal.new()` resolves.
 *
 * The displayed status is derived, not stored: "permission", "working", "done" only when
 * idle and previously seen, otherwise no dot at all. `useClearAttentionOnFocus` runs on
 * every render of the focused tab and demotes its own "permission" back to "working", so
 * status is only observable on a backgrounded terminal — these tests keep a second terminal
 * focused throughout.
 *
 * `content.title` is the source of truth and is mirrored into the store. Lifecycle
 * auto-rename rewrites only generic titles (`Terminal`, `Terminal N`, `<Provider>`,
 * `<Provider> N`); anything the user typed is left alone forever. The launcher roster comes
 * from `localStorage["claxedo.terminalCommands"]`, read fresh on every render.
 *
 * No PTY backend is needed: PTY REST is a hand-rolled `page.route` mock, the PTY socket is a
 * fake `window.WebSocket`, and Claxedo events are injected at the route level. Every route
 * here navigates to `/<slug>/session`, which is neither `/s/`- nor `/w/`-prefixed, so
 * `ConnectionGate` refuses to reveal the app until `GET /api/claxedo/health` resolves —
 * hence `installAppBootMock`. That mock's origin is `127.0.0.1:3001`, a different origin
 * from the app, so every response needs CORS headers.
 */

import { workspaceResolveRoute } from "../helpers/contracts/workspace-resolve"
import { expectActiveTerminalSurfaceParity } from "../helpers/surface-parity"
import { expect, test, type Page, type Route } from "@playwright/test"
import sharp from "sharp"

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

// ─── Workspace event bus (route-level `wr/events` SSE injection) ───────────
//
// Events queue in a persistent per-reader slot rather than an ephemeral per-request
// channel: `route.fulfill()` cannot drip a body over time, making every reconnect a fresh
// HTTP request, and a channel torn down between the reader's own reconnects would drop
// anything emitted in the gap. `drain()` claims whichever slot is idle, so a slot's backlog
// survives its reader's reconnects.
type ClaxedoTestEvent = Record<string, unknown>

type ClaxedoEventSlot = { pending: ClaxedoTestEvent[]; waiters: Array<() => void>; busy: boolean }

const emptySlot = (): ClaxedoEventSlot => ({ pending: [], waiters: [], busy: false })

/**
 * The reader's slot is created up front rather than on its first `drain()`. `emit()` only
 * reaches slots that already exist and there is no replay, so a lazily-created slot misses
 * every event emitted before the reader first connected — and `emitClaxedoEvent` can fire
 * before the provider's workspace connection is up.
 */
const CLAXEDO_BUS_READERS = 1

class ClaxedoEventBus {
  private slots: ClaxedoEventSlot[] = Array.from({ length: CLAXEDO_BUS_READERS }, emptySlot)
  private terminalSessions = new Map<string, Record<string, unknown>>()

  emit(payload: ClaxedoTestEvent) {
    if (payload.type === "agent.lifecycle" && typeof payload.terminalId === "string") {
      this.terminalSessions.set(payload.terminalId, {
        terminalId: payload.terminalId,
        ...(typeof payload.tabId === "string" ? { tabId: payload.tabId } : {}),
        ...(typeof payload.workspaceId === "string" ? { workspaceId: payload.workspaceId } : {}),
        ...(typeof payload.provider === "string" ? { provider: payload.provider } : {}),
        ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
        ...(typeof payload.eventType === "string" ? { eventType: payload.eventType } : {}),
        updatedAt: Date.now(),
      })
    }
    for (const slot of this.slots) {
      slot.pending.push(payload)
      const waiters = slot.waiters
      slot.waiters = []
      for (const resolve of waiters) resolve()
    }
  }

  terminalSession(terminalId: string) {
    return this.terminalSessions.get(terminalId)
  }

  async drain(idleTimeoutMs: number) {
    const slot = this.slots.find((s) => !s.busy) ?? (() => {
      const created = emptySlot()
      this.slots.push(created)
      return created
    })()
    slot.busy = true
    try {
      if (slot.pending.length === 0) {
        await Promise.race([
          new Promise<void>((resolve) => slot.waiters.push(resolve)),
          new Promise<void>((resolve) => setTimeout(resolve, idleTimeoutMs)),
        ])
      }
      const batch = slot.pending
      slot.pending = []
      return batch
    } finally {
      slot.busy = false
    }
  }
}

/** `wr/events` writes every frame as `{ directory, payload }`. */
function claxedoSseBody(directory: string, batch: ClaxedoTestEvent[]) {
  if (batch.length === 0) return ": heartbeat\n\n"
  return batch.map((payload) => `data: ${JSON.stringify({ directory, payload })}\n\n`).join("")
}

const claxedoEventBuses = new WeakMap<Page, ClaxedoEventBus>()

/**
 * Everything `ConnectionGate` and the OpenCode SDK need to get past the startup health gate
 * and paint `[data-claxedo]`. Every response carries CORS headers: `getClaxedoServerUrl()`
 * resolves to `http://127.0.0.1:3001`, a different origin from the app, and a `res.json()`
 * read on a cross-origin `mode:"cors"` fetch rejects without them.
 */
async function installAppBootMock(page: Page, dir: string, projectId = "proj_core_terminal") {
  const headers = corsHeaders()
  const api = (route: Route) => {
    const type = route.request().resourceType()
    return type === "fetch" || type === "xhr"
  }
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) })

  await page.route("**/health", (r) => (api(r) ? json(r, { healthy: true }) : r.continue()))
  await page.route("**/api/claxedo/bootstrap**", (r) =>
    api(r)
      ? json(r, {
          healthy: true,
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: dir, directory: dir, home: "/tmp" },
          project: [{
            id: projectId,
            worktree: dir,
            name: "core-terminal",
            workspaces: { [dir]: { workspaceId: projectId, kind: "local", directory: dir, available: true } },
            time: { created: Date.now(), updated: Date.now() },
          }],
          provider: { all: [{ id: "opencode", name: "opencode", env: [], models: {} }], default: {}, connected: ["opencode"] },
          provider_auth: {},
          config: { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } },
        })
      : r.continue(),
  )
  await page.route("**/path**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/path") return r.fallback()
    return json(r, { worktree: dir })
  })
  await page.route("**/project**", (r) => {
    if (!api(r)) return r.continue()
    if (!["/project", "/experimental/project"].includes(new URL(r.request().url()).pathname)) return r.fallback()
    return json(r, [{
      id: projectId,
      worktree: dir,
      name: "core-terminal",
      workspaces: { [dir]: { workspaceId: projectId, kind: "local", directory: dir, available: true } },
      time: { created: Date.now(), updated: Date.now() },
    }])
  })
  await page.route("**/provider", (r) => (api(r) ? json(r, { all: [], default: {}, connected: [] }) : r.continue()))
  await page.route("**/provider/auth", (r) => (api(r) ? json(r, {}) : r.continue()))
  await page.route("**/config", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/config") return r.fallback()
    return json(r, { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } })
  })
  await page.route("**/agent**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/agent") return r.fallback()
    return json(r, [{ id: "build", name: "build", mode: "primary" }])
  })
  await page.route("**/command**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/command") return r.fallback()
    return json(r, [])
  })
  await page.route("**/permission**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/permission") return r.fallback()
    return json(r, [])
  })
  await page.route("**/question**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/question") return r.fallback()
    return json(r, [])
  })
  await page.route("**/mcp**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/mcp") return r.fallback()
    return json(r, {})
  })
  await page.route("**/vcs**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/vcs") return r.fallback()
    return json(r, {})
  })
  await page.route("**/session/status", (r) => (api(r) ? json(r, {}) : r.continue()))
  await page.route("**/session**", (r) => {
    if (!api(r)) return r.continue()
    const pathname = new URL(r.request().url()).pathname
    if (!["/session", "/experimental/session"].includes(pathname)) return r.fallback()
    return json(r, [])
  })
  await page.route(workspaceResolveRoute, (r) =>
    api(r) ? json(r, { workspaceId: projectId, directory: dir, kind: "local", status: "ready" }) : r.continue(),
  )
  await page.route("**/api/wr/diff/**", (r) => {
    if (!api(r)) return r.continue()
    const pathname = new URL(r.request().url()).pathname
    const body = pathname.endsWith("/refs")
      ? { branches: [], tags: [], recent: [] }
      : pathname.endsWith("/targets")
      ? {}
      : pathname.endsWith("/vcs")
      ? []
      : undefined
    if (body === undefined) return r.fallback()
    return json(r, body)
  })
  await page.route("**/api/claxedo/agent-config/**", (r) => (api(r) ? json(r, { options: [], source: "empty", stale: false }) : r.continue()))

  // An unsigned loopback surface reads the control plane's notices over a
  // WebSocket. Nothing this spec drives rides it, so it is held open quietly;
  // left unrouted, the reader would retry forever against the dev server.
  await page.routeWebSocket("**/api/cp/events**", (socket) => {
    socket.send('id: 0\ndata: {"type":"heartbeat"}\n\n')
  })

  // The pty frames this spec injects are workspace control frames, read off the
  // workspace's own `/api/wr/events`.
  //
  // The provider's `window.__claxedoEmitTestEvent` hook is not usable instead: it is
  // `import.meta.env.DEV`-gated and this suite's default target is a statically-served
  // build. Each "connection" blocks until an event is pending and fulfills once, since
  // `route.fulfill()` cannot drip a body; the reader reconnects and picks up the next batch.
  const claxedoEventBus = new ClaxedoEventBus()
  claxedoEventBuses.set(page, claxedoEventBus)
  await page.route("**/api/wr/events**", async (route: Route) => {
    if (!api(route)) return route.continue()
    const url = new URL(route.request().url())
    if (url.searchParams.get("directory") !== dir) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", headers, body: ": heartbeat\n\n" }).catch(() => {})
      return
    }
    const batch = await claxedoEventBus.drain(4000)
    await route.fulfill({ status: 200, contentType: "text/event-stream", headers, body: claxedoSseBody(dir, batch) }).catch(() => {})
  })
}

async function seedProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    localStorage.setItem(
      "claxedo.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: d, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, dir)
}

async function seedTerminalCommands(
  page: Page,
  commands: { claude?: string; codex?: string; custom?: Array<{ id: string; name: string; command: string }> },
) {
  await page.addInitScript((input) => {
    const current = (() => {
      try {
        return JSON.parse(localStorage.getItem("claxedo.terminalCommands") ?? "null")
      } catch {
        return null
      }
    })()
    localStorage.setItem(
      "claxedo.terminalCommands",
      JSON.stringify({
        claude: input.claude ?? current?.claude ?? "claude --dangerously-skip-permissions",
        codex: input.codex ?? current?.codex ?? 'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access',
        custom: input.custom ?? current?.custom ?? [],
      }),
    )
  }, commands)
}

/**
 * Overrides `window.WebSocket` so PTY connect sockets (`/api/wr/pty/:id/connect`) never
 * hit a real backend. When `echo` is true, whatever the terminal sends is bounced back as
 * a "message" event after a short tick (simulating a shell echoing typed input); every
 * fake socket also emits one banner line on open so a freshly-connected pane always
 * paints something. Non-PTY WebSocket users (Vite HMR, etc.) fall through untouched.
 */
async function installFakeTerminalSocket(page: Page, options: { echo?: boolean } = {}) {
  await page.addInitScript((echo: boolean) => {
    const w = window as typeof window & {
      __e2eTerminalSockets?: number
      __e2eTerminalSends?: Record<string, string[]>
    }
    w.__e2eTerminalSockets = 0
    w.__e2eTerminalSends = {}
    const OriginalWebSocket = window.WebSocket
    const FakeWebSocket = new Proxy(OriginalWebSocket, {
      construct(_target, args: [string | URL, (string | string[])?]) {
        const url = String(args[0])
        if (!url.includes("/api/wr/pty/") || !url.includes("/connect")) {
          return Reflect.construct(OriginalWebSocket, args)
        }
        w.__e2eTerminalSockets = (w.__e2eTerminalSockets ?? 0) + 1
        const idMatch = /\/pty\/([^/]+)\/connect/.exec(url)
        const ptyId = idMatch ? decodeURIComponent(idMatch[1]) : "unknown"
        w.__e2eTerminalSends![ptyId] = w.__e2eTerminalSends![ptyId] ?? []

        const target = new EventTarget() as EventTarget & {
          url: string
          readyState: number
          send: (data: string) => void
          close: () => void
          onopen: ((ev: Event) => void) | null
          onclose: ((ev: CloseEvent) => void) | null
          onerror: ((ev: Event) => void) | null
          onmessage: ((ev: MessageEvent) => void) | null
        }
        target.url = url
        target.readyState = 0
        target.onopen = null
        target.onclose = null
        target.onerror = null
        target.onmessage = null
        target.send = (data: string) => {
          w.__e2eTerminalSends![ptyId].push(data)
          if (!echo) return
          setTimeout(() => {
            if (target.readyState !== 1) return
            const message = new MessageEvent("message", { data })
            target.onmessage?.(message)
            target.dispatchEvent(message)
          }, 15)
        }
        target.close = () => {
          target.readyState = 3
        }
        setTimeout(() => {
          target.readyState = 1
          const open = new Event("open")
          target.onopen?.(open)
          target.dispatchEvent(open)
          const banner = new MessageEvent("message", { data: "\x1b[36m~ $ \x1b[0m" })
          target.onmessage?.(banner)
          target.dispatchEvent(banner)
        }, 10)
        return target
      },
    })
    Object.defineProperty(window, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket })
  }, options.echo ?? true)
}

type PtyCreateBody = {
  title?: string
  command?: string
  args?: string[]
  initialCommand?: string
  cwd?: string
  env?: Record<string, string>
}

type PtyApi = {
  creates: PtyCreateBody[]
  createdIds: string[]
}

/** What `GET /pty/agents` reports when a test does not name its own set. */
const INSTALLED_AGENTS = ["claude", "codex", "cursor-agent", "gemini"]

/** Hand-rolled PTY REST mock — mock-runtime.ts does not cover `/api/wr/pty`. */
async function installPtyApi(page: Page, dir: string, installedAgents = INSTALLED_AGENTS): Promise<PtyApi> {
  const api: PtyApi = { creates: [], createdIds: [] }
  const all: Array<{ id: string; title: string; cwd: string }> = []
  let nextId = 1
  const headers = corsHeaders()

  await page.route("**/api/wr/pty**", async (route: Route) => {
    const req = route.request()
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers })
    const type = req.resourceType()
    if (type !== "fetch" && type !== "xhr") return route.continue()
    const url = new URL(req.url())
    if (url.pathname === "/api/wr/pty") {
      if (req.method() === "POST") {
        let body: PtyCreateBody = {}
        try {
          body = req.postDataJSON() as PtyCreateBody
        } catch {
          body = {}
        }
        const id = `pty_${nextId++}`
        api.creates.push(body)
        api.createdIds.push(id)
        const record = { id, title: body.title ?? "Terminal", cwd: body.cwd ?? dir }
        all.push(record)
        return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(record) })
      }
      if (req.method() === "GET") {
        return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(all) })
      }
      return route.fallback()
    }
    if (url.pathname === "/api/wr/pty/agents") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers,
        body: JSON.stringify({ installed: installedAgents }),
      })
    }
    if (/^\/api\/wr\/pty\/[^/]+$/.test(url.pathname)) {
      if (req.method() === "PUT" || req.method() === "DELETE") {
        return route.fulfill({ status: 200, contentType: "application/json", headers, body: "{}" })
      }
      return route.fallback()
    }
    return route.fallback()
  })

  await page.route("**/api/wr/hook/terminal-session**", (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers })
    const terminalId = new URL(route.request().url()).searchParams.get("terminalId") ?? ""
    const session = claxedoEventBuses.get(page)?.terminalSession(terminalId) ?? null
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers,
      body: JSON.stringify({
        success: true,
        source: session ? "memory" : "none",
        terminalId,
        session,
      }),
    })
  })
  await page.route("**/api/wr/process/logs**", (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers })
    return route.fulfill({ status: 200, contentType: "application/json", headers, body: "[]" })
  })
  // `/api/wr/events` is deliberately not mounted here: `installAppBootMock` already owns it,
  // and `page.route` is LIFO, so a handler here would shadow the event bus and drop every
  // frame `emitClaxedoEvent` sends.

  return api
}

async function openWorkspaceRoute(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

function sidebarTerminalRow(page: Page, ptyId: string) {
  return page.locator(`[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${ptyId}"]`)
}

function terminalPane(page: Page, ptyId: string) {
  return page.locator(`[data-testid="terminal-pane"][data-terminal-id="${ptyId}"]`)
}

async function waitForTerminalMounted(page: Page, ptyId: string) {
  await expect(terminalPane(page, ptyId)).toBeVisible({ timeout: 15_000 })
  await expect(sidebarTerminalRow(page, ptyId)).toBeVisible({ timeout: 15_000 })
}

async function launchFromCreator(page: Page, api: PtyApi, launcher: { id?: string; name?: string }) {
  const before = api.createdIds.length
  await page.locator('[data-testid="workspace-scope-new-terminal"]').click()
  const launchers = page.locator('[data-component="terminal-new-launchers"]')
  await expect(launchers).toBeVisible({ timeout: 15_000 })
  const tile = launcher.id
    ? launchers.locator(`[data-slot="terminal-launcher"][data-launcher-id="${launcher.id}"]`)
    : launchers.locator('[data-slot="terminal-launcher"]').filter({ hasText: launcher.name! })
  await tile.first().click()
  await expect.poll(() => api.createdIds.length, { timeout: 15_000 }).toBe(before + 1)
  const id = api.createdIds[before]
  await waitForTerminalMounted(page, id)
  return id
}

async function createPlainTerminal(page: Page, api: PtyApi) {
  return launchFromCreator(page, api, { id: "shell" })
}

async function createPresetTerminal(page: Page, api: PtyApi, preset: "claude" | "codex") {
  return launchFromCreator(page, api, { id: preset })
}

/**
 * Custom commands get a generated `custom:<id>` launcher id, so match on the name typed in
 * Settings -> Terminals instead.
 */
async function createCustomTerminal(page: Page, api: PtyApi, name: string) {
  return launchFromCreator(page, api, { name })
}

async function terminalPaintSummary(page: Page, ptyId: string) {
  const xterm = terminalPane(page, ptyId).locator(".xterm").first()
  const box = await xterm.boundingBox()
  if (!box || box.width === 0 || box.height === 0) return { visible: false, chromaPixels: 0 }
  const image = await sharp(await xterm.screenshot()).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let chromaPixels = 0
  for (let i = 0; i < image.data.length; i += 4) {
    if ((image.data[i + 3] ?? 0) === 0) continue
    const r = image.data[i] ?? 0
    const g = image.data[i + 1] ?? 0
    const b = image.data[i + 2] ?? 0
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (max - min > 20 || max > 60) chromaPixels += 1
  }
  return { visible: box.width > 50 && box.height > 30, chromaPixels }
}

async function emitClaxedoEvent(page: Page, event: Record<string, unknown>) {
  const bus = claxedoEventBuses.get(page)
  expect(bus, "installAppBootMock must run before emitClaxedoEvent").toBeTruthy()
  bus!.emit(event)
}

async function splitTerminalPaneWith(page: Page, hostPtyId: string, sourcePtyId: string) {
  // The workbench drag engine is pointer-driven and listens for no native HTML5 DragEvents,
  // so a synthetic `DragEvent` drop is a silent no-op. Drag the source terminal's sidebar
  // row with real pointer input onto the host pane's right edge instead.
  const target = terminalPane(page, hostPtyId)
  const box = await target.boundingBox()
  if (!box) throw new Error("host terminal pane has no bounding box")
  await sidebarTerminalRow(page, sourcePtyId).dragTo(target, {
    targetPosition: { x: Math.max(1, box.width - 6), y: box.height / 2 },
  })
  // The divider appearing is the split signal. `visiblePaneCount` counts every
  // `[data-pane-id]` content slot, including hidden background tabs, so it reads > 1 with
  // no split at all.
  await expect(page.locator('[data-testid="workbench-divider"]')).toBeVisible({ timeout: 10_000 })
}

function contentIdFor(page: Page, ptyId: string) {
  return terminalPane(page, ptyId).evaluate(
    (node) => node.closest("[data-workbench-content]")?.getAttribute("data-workbench-content") ?? "",
  )
}

test.describe("core terminal panel @core", () => {
  test("the creator's Shell tile creates a plain terminal with a default numbered title", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-plain"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page)
    const api = await installPtyApi(page, DIR)
    await seedProject(page, DIR)
    await openWorkspaceRoute(page, DIR)

    const id = await createPlainTerminal(page, api)

    expect(api.creates[0]?.title).toMatch(/^Terminal \d+$/)
    expect(api.creates[0]?.command).toBeUndefined()
    expect(api.creates[0]?.initialCommand).toBeUndefined()
    await expect(sidebarTerminalRow(page, id)).toContainText(/Terminal/)
  })

  test("the creator's Claude tile uses the Settings -> Terminals Claude command", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-claude-preset"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page)
    const api = await installPtyApi(page, DIR)
    await seedProject(page, DIR)
    await openWorkspaceRoute(page, DIR)

    const id = await createPresetTerminal(page, api, "claude")

    const body = api.creates[0]
    expect(body?.command).toBe("claude")
    expect(body?.args).toEqual(["--dangerously-skip-permissions"])
    expect(body?.title).toMatch(/^Claude \d+$/)
    await expect(sidebarTerminalRow(page, id)).toContainText(/Claude/)
  })

  test("the creator's Codex tile uses the Settings -> Terminals Codex command", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-codex-preset"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page)
    const api = await installPtyApi(page, DIR)
    await seedProject(page, DIR)
    await openWorkspaceRoute(page, DIR)

    const id = await createPresetTerminal(page, api, "codex")

    const body = api.creates[0]
    expect(body?.command).toBe("codex")
    expect(body?.args).toEqual(["-c", "model_reasoning_effort=high", "--ask-for-approval", "never", "--sandbox", "danger-full-access"])
    expect(body?.title).toMatch(/^Codex \d+$/)
    await expect(sidebarTerminalRow(page, id)).toContainText(/Codex/)
  })

  /**
   * The tile set is the machine's answer, not the profile's: the commands are
   * configured per browser profile, but a workspace whose machine has no
   * `gemini` cannot start one, and offering the tile there only fails at spawn.
   */
  test("the creator offers only the agents the machine reports as installed", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-installed"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page)
    await installPtyApi(page, DIR, ["codex"])
    await seedProject(page, DIR)
    await openWorkspaceRoute(page, DIR)

    await page.locator('[data-testid="workspace-scope-new-terminal"]').click()
    const launchers = page.locator('[data-component="terminal-new-launchers"]')
    await expect(launchers).toBeVisible({ timeout: 15_000 })
    await expect(launchers.locator('[data-launcher-id="codex"]')).toBeVisible()
    await expect(launchers.locator('[data-launcher-id="shell"]')).toBeVisible()
    await expect(launchers.locator('[data-launcher-id="claude"]')).toHaveCount(0)
    await expect(launchers.locator('[data-launcher-id="gemini"]')).toHaveCount(0)
    await expect(launchers.locator('[data-launcher-id="cursor"]')).toHaveCount(0)
  })

  test("a custom command configured in Settings -> Terminals launches with that exact command", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-custom"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page)
    const api = await installPtyApi(page, DIR)
    await seedProject(page, DIR)
    await openWorkspaceRoute(page, DIR)

    // Configured through the real Settings UI rather than seeded into localStorage, so the
    // save path is part of what this proves.
    await page.locator('[data-testid="rail-account-trigger"]').click()
    await page.getByRole("menuitem", { name: "Settings" }).click()
    await page.getByRole("tab", { name: "Terminals" }).click()
    await page.getByRole("button", { name: "Add", exact: true }).click()
    await page.getByPlaceholder("Command name (e.g., Aider)").fill("Aider")
    await page.getByPlaceholder("Command to run (e.g., aider --model gpt-4)").fill("aider --model gpt-4")
    await page.getByRole("button", { name: "Save Changes" }).click()
    await expect(page.getByText("Terminal commands saved")).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press("Escape")
    await expect(page.getByRole("tab", { name: "Terminals" })).toHaveCount(0, { timeout: 10_000 })

    const id = await createCustomTerminal(page, api, "Aider")

    const body = api.creates[0]
    // `aider` is not a catalog agent, so it stays an initialCommand for the
    // shell rather than being split into command + args.
    expect(body?.command).toBeUndefined()
    expect(body?.initialCommand).toBe("aider --model gpt-4")
    expect(body?.title).toMatch(/^Aider( \d+)?$/)
    await expect(sidebarTerminalRow(page, id)).toContainText(/Aider/)
  })

  test("typing into a focused terminal sends input over the PTY socket and paints output", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-type-output"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page, { echo: true })
    const api = await installPtyApi(page, DIR)
    await seedProject(page, DIR)
    await openWorkspaceRoute(page, DIR)

    const id = await createPlainTerminal(page, api)
    await expect.poll(async () => (await terminalPaintSummary(page, id)).visible, { timeout: 15_000 }).toBe(true)
    const baseline = await terminalPaintSummary(page, id)
    // `chromaPixels` counts non-dark pixels across nearly the whole canvas, and the opening
    // banner already fills most of it, so cursor blink and antialiasing swing the count by
    // hundreds between frames — it can even fall after typing. Asserting a floor rather than
    // growth, paired with the sent-log check below, is what actually separates "input
    // reached the PTY and the canvas is still rendering" from "collapsed or blank".
    expect(baseline.chromaPixels).toBeGreaterThan(100)

    await terminalPane(page, id).click()
    const marker = "echo e2e-terminal-type-output-marker"
    await page.keyboard.type(marker, { delay: 15 })

    await expect
      .poll(
        () =>
          page.evaluate((ptyId) => {
            const w = window as typeof window & { __e2eTerminalSends?: Record<string, string[]> }
            return (w.__e2eTerminalSends?.[ptyId] ?? []).join("")
          }, id),
        { timeout: 10_000 },
      )
      .toContain(marker)

    await expect
      .poll(async () => (await terminalPaintSummary(page, id)).chromaPixels, { timeout: 10_000 })
      .toBeGreaterThan(baseline.chromaPixels / 2)
  })

  test("splitting the pane refits the terminal to its new size without clipping", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-split-refit"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page)
    const api = await installPtyApi(page, DIR)
    await seedProject(page, DIR)
    await openWorkspaceRoute(page, DIR)

    const id1 = await createPlainTerminal(page, api)
    const beforeBox = await terminalPane(page, id1).locator(".xterm").first().boundingBox()
    expect(beforeBox, "terminal 1 has no bounding box before the split").not.toBeNull()

    const id2 = await createPlainTerminal(page, api)
    expect(await contentIdFor(page, id2)).not.toBe("")

    await sidebarTerminalRow(page, id1).click()
    await expect(terminalPane(page, id1)).toBeVisible({ timeout: 10_000 })
    await splitTerminalPaneWith(page, id1, id2)

    await expect(terminalPane(page, id1)).toBeVisible({ timeout: 10_000 })
    await expect(terminalPane(page, id2)).toBeVisible({ timeout: 10_000 })

    const pane1 = await terminalPane(page, id1).evaluate(
      (node) => node.closest("[data-workbench-content]")?.getAttribute("data-pane-id") ?? "",
    )
    const paneRect = await page.locator(`[data-testid="pane-${pane1}"]`).boundingBox()
    expect(paneRect, "split-off pane 1 has no bounding box").not.toBeNull()

    await expect
      .poll(async () => {
        const box = await terminalPane(page, id1).locator(".xterm").first().boundingBox()
        return box?.width ?? -1
      }, { timeout: 10_000 })
      .toBeLessThan(beforeBox!.width)

    const afterBox = await terminalPane(page, id1).locator(".xterm").first().boundingBox()
    expect(afterBox, "terminal 1 has no bounding box after the split").not.toBeNull()
    expect(afterBox!.width).toBeGreaterThan(0)
    expect(afterBox!.height).toBeGreaterThan(0)
    expect(afterBox!.x).toBeGreaterThanOrEqual(paneRect!.x - 1)
    expect(afterBox!.y).toBeGreaterThanOrEqual(paneRect!.y - 1)
    expect(afterBox!.x + afterBox!.width).toBeLessThanOrEqual(paneRect!.x + paneRect!.width + 1)
    expect(afterBox!.y + afterBox!.height).toBeLessThanOrEqual(paneRect!.y + paneRect!.height + 1)
  })

  // `reconcilePtyExit` has to clear the `seen` flag alongside the status; leaving it set
  // would strand a "done" dot on a terminal whose PTY is gone.
  test("an externally exited PTY clears its tracked agent status", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-external-exit"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page)
    const api = await installPtyApi(page, DIR)
    await seedProject(page, DIR)
    await openWorkspaceRoute(page, DIR)

    const id1 = await createPlainTerminal(page, api)
    // id2 is created only to take focus: `useClearAttentionOnFocus` in
    // agent-status-listener.ts clears the status dot of whichever tab is
    // focused, so id1 must be backgrounded for the dot assertions below to
    // mean anything. Deleting id2 makes them pass vacuously.
    const id2 = await createPlainTerminal(page, api)
    const dot1 = sidebarTerminalRow(page, id1).locator("[data-sidebar-status]")

    // The exit cleanup only acts on a PTY that has had a status set at least once, so give
    // terminal 1 one first — a never-tracked terminal's exit is a no-op by design.
    await emitClaxedoEvent(page, { type: "agent.lifecycle", tabId: id1, terminalId: id1, eventType: "Busy" })
    await expect(dot1).toHaveAttribute("data-sidebar-status", "working", { timeout: 10_000 })

    await emitClaxedoEvent(page, { type: "pty.exited", id: id1, exitCode: 0 })

    // The dot disappearing is the durable proof. The store's own removal from `terminal.all()`
    // is not: `pty.exited` never removes the workbench tab, so the still-mounted content
    // renderer can resurrect the entry through `terminal.ensure()` on any later re-render.
    await expect(dot1).toHaveCount(0, { timeout: 10_000 })

    void id2
  })

  test("the sidebar status dot mirrors agent.lifecycle Busy/UserActionRequired/Idle", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-status-dot"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page)
    const api = await installPtyApi(page, DIR)
    await seedProject(page, DIR)
    await openWorkspaceRoute(page, DIR)

    // A second terminal is created and left focused so the first is backgrounded:
    // `useClearAttentionOnFocus` demotes the focused tab's "permission" back to "working" on
    // every render, so that dot is unobservable on the active tab.
    const id = await createPlainTerminal(page, api)
    const foregroundId = await createPlainTerminal(page, api)
    // Creation does not guarantee focus transfer once the creator closes, so pin which
    // terminal is foreground explicitly.
    await sidebarTerminalRow(page, foregroundId).click()
    const dot = sidebarTerminalRow(page, id).locator("[data-sidebar-status]")

    await expect(dot).toHaveCount(0)

    await emitClaxedoEvent(page, { type: "agent.lifecycle", tabId: id, terminalId: id, eventType: "Busy" })
    await expect(dot).toHaveAttribute("data-sidebar-status", "working", { timeout: 10_000 })

    await emitClaxedoEvent(page, { type: "agent.lifecycle", tabId: id, terminalId: id, eventType: "UserActionRequired" })
    await expect(dot).toHaveAttribute("data-sidebar-status", "permission", { timeout: 10_000 })

    await emitClaxedoEvent(page, { type: "agent.lifecycle", tabId: id, terminalId: id, eventType: "Idle" })
    await expect(dot).toHaveAttribute("data-sidebar-status", "done", { timeout: 10_000 })
  })

  test("working status survives reload in both sidebar and compact tabs", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-status-reload"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page)
    const api = await installPtyApi(page, DIR)
    await seedProject(page, DIR)
    await openWorkspaceRoute(page, DIR)

    const id = await createPlainTerminal(page, api)
    await emitClaxedoEvent(page, {
      type: "agent.lifecycle",
      tabId: id,
      terminalId: id,
      eventType: "Busy",
    })
    await expectActiveTerminalSurfaceParity({ page, terminalId: id, expected: "working" })

    // No lifecycle frame is emitted after navigation and `seedProject` clears persistence on
    // every load, so the terminal-session snapshot is the only thing that can restore this.
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await waitForTerminalMounted(page, id)
    await expectActiveTerminalSurfaceParity({ page, terminalId: id, expected: "working" })
  })

  test("focusing a done terminal clears its status dot", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-clear-on-focus"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page)
    const api = await installPtyApi(page, DIR)
    await seedProject(page, DIR)
    await openWorkspaceRoute(page, DIR)

    const id1 = await createPlainTerminal(page, api)
    // id2 is created only to take focus: `useClearAttentionOnFocus` in
    // agent-status-listener.ts clears the status dot of whichever tab is
    // focused, so id1 must be backgrounded for the dot assertions below to
    // mean anything. Deleting id2 makes them pass vacuously.
    const id2 = await createPlainTerminal(page, api)

    await emitClaxedoEvent(page, { type: "agent.lifecycle", tabId: id1, terminalId: id1, eventType: "Busy" })
    await emitClaxedoEvent(page, { type: "agent.lifecycle", tabId: id1, terminalId: id1, eventType: "Idle" })

    const dot1 = sidebarTerminalRow(page, id1).locator("[data-sidebar-status]")
    await expect(dot1).toHaveAttribute("data-sidebar-status", "done", { timeout: 10_000 })

    await sidebarTerminalRow(page, id1).click()
    await expect(terminalPane(page, id1)).toBeVisible({ timeout: 10_000 })
    await expect(dot1).toHaveCount(0, { timeout: 10_000 })

    void id2
  })

  test("lifecycle auto-rename updates a generic title but never a user-set title", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-lifecycle-rename"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page)
    const api = await installPtyApi(page, DIR)
    // `seedProject`'s init script calls `localStorage.clear()` on every navigation and init
    // scripts run in registration order, so it has to be registered before
    // `seedTerminalCommands` or the clear wipes what that just wrote.
    await seedProject(page, DIR)
    await seedTerminalCommands(page, { custom: [{ id: "aider", name: "Aider", command: "aider --model gpt-4" }] })
    await openWorkspaceRoute(page, DIR)

    const genericId = await createPlainTerminal(page, api)
    await emitClaxedoEvent(page, {
      type: "agent.lifecycle",
      tabId: genericId,
      terminalId: genericId,
      eventType: "Busy",
      provider: "claude",
      refName: "@fix-typecheck-errors-2f31",
    })
    await expect(sidebarTerminalRow(page, genericId)).toContainText("Claude: Fix Typecheck Errors", { timeout: 10_000 })

    const customId = await createCustomTerminal(page, api, "Aider")
    const customRow = sidebarTerminalRow(page, customId)
    await expect(customRow).toContainText("Aider", { timeout: 10_000 })
    await emitClaxedoEvent(page, {
      type: "agent.lifecycle",
      tabId: customId,
      terminalId: customId,
      eventType: "Busy",
      provider: "claude",
      refName: "@some-other-ref-name",
    })
    await page.waitForTimeout(500)
    await expect(customRow).toContainText("Aider", { timeout: 10_000 })
    await expect(customRow).not.toContainText("Claude:")
  })

  test("reload reattaches the terminal to its persisted PTY without a new create", async ({ page }) => {
    const DIR = "/tmp/e2e-core-terminal-reattach"
    await installAppBootMock(page, DIR)
    await installFakeTerminalSocket(page)
    const api = await installPtyApi(page, DIR)
    await seedProject(page, DIR)
    await openWorkspaceRoute(page, DIR)

    const id = await createPlainTerminal(page, api)
    const createCountBeforeReload = api.creates.length

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    await waitForTerminalMounted(page, id)
    // The fake-socket init script re-runs on every navigation and resets its counter, so the
    // only sound post-reload check is that a socket reopened for the same pty id.
    await expect
      .poll(
        () =>
          page.evaluate(() => (window as typeof window & { __e2eTerminalSockets?: number }).__e2eTerminalSockets ?? 0),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(1)

    expect(api.creates.length, "reload must not create a brand-new PTY").toBe(createCountBeforeReload)
  })

})
