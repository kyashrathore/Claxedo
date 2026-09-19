/**
 * The Processes panel: per-workspace dev processes (servers, watchers, sidecars) defined
 * in `.claxedo/processes.jsonc`, launched server-side, and surfaced with a live status,
 * an assigned URL, and a PTY-backed terminal.
 *
 * The server is the store. `@claxedo/process/client` talks to `/api/wr/process*` with a
 * `?directory=` query and an `x-claxedo-directory` header; the browser keeps
 * `{configs, processes}` unpersisted in `ProcessPaneProvider` and refetches on mount.
 * That refetch is gated on `isProcessOpen() && !loaded()`, so a fresh load fetches
 * nothing until the Processes navigator has been opened at least once — the usual reason
 * an assertion after a reload finds an empty list.
 *
 * Actions apply an optimistic status locally, then reconcile against the response's
 * `Process.LaunchResult` union (`started | already_running | port_conflict |
 * route_conflict | failed | not_found`), and again on the next list fetch.
 *
 * A running process owns a ptyId that `ProcessOwnership` marks as process-owned, so the
 * generic terminal-tab auto-detection never mints a second tab for it.
 *
 * `canMutateProcesses()` is `!workspaceId || can("mutate.workspace", ...)`, so a purely
 * local workspace is always mutable and this file can only prove the controls render.
 * The viewer-role half of that gate lives in core-cloud-offline-roles.spec.ts.
 *
 * Two traps around a crash that arrives by SSE while the `start()` POST is still in
 * flight. That POST's response snapshots status at spawn time, so a command that exits
 * immediately can have its response land after the crash and still describe the process
 * as running; `isStaleProcessSnapshot` rejects it when the ptyId matches an
 * already-crashed entry. And the SSE crash handler deliberately keeps `ptyId`, which is
 * the marker that guard relies on — so `hasTerminal()`/`visiblePty()` stay truthy and the
 * panel keeps its live terminal and its Stop control rather than the "Crashed"
 * placeholder, identically whether or not the guard works. Only surfaces keyed on
 * `status()` alone discriminate it: the title-bar status dot, and the navigator row's
 * subtitle and hover action.
 *
 * HARNESS NOTES — none; the Processes feature is harness-independent (it lives beside
 *   the session/harness surface, not inside it).
 *
 * OUT OF SCOPE (documented, not silently dropped) —
 *   - Read-only/viewer role HIDING mutation controls: `canMutateProcesses()` only
 *     engages role gating once `sdk.workspace?.(directory)?.workspaceId` resolves AND
 *     `workspacePlacement(workspaceId)` returns a role — which requires a live
 *     `WorkspaceGate`-mounted relay/cloud connection with a minted access-token role
 *     (`src/shell/workspace/workspace-connection.ts:393-453`,
 *     `src/shell/workspace/workspace-gate.tsx:112-124`). Reproducing that end-to-end
 *     for a purely local Tier-M mock would mean re-building spec 13
 *     (`core-cloud-offline-roles`)'s full relay/role fixture inside this file; it
 *     belongs in `core-cloud-offline-roles`' viewer-role fixture.
 *   - Project-shared process config visibility across two *local* workspaces (same
 *     `.claxedo/processes.jsonc`, sibling port assignment, "no port leaks after stop")
 *     — this is real claxedo-server worktree-sharing + OS-port-allocation behavior that
 *     a mocked HTTP layer cannot meaningfully exercise; it is covered live by
 *     `e2e-legacy/process-project-shared.spec.ts` (`CLAXEDO_PROCESS_PROJECT_SHARED_LIVE=1`,
 *     real backend + real worktrees) — DELETED per e2e/e2e-decisions.md #25
 *     (2026-07-20); the mocked duplicate here can't assert the real invariant.
 *   - Real `.claxedo/processes.jsonc` file writes/reads — Tier L concern; behavior 16
 *     above only proves the CLIENT's reload-recovery contract against the mocked
 *     backend, not the file itself.
 *   - Deep xterm PTY output painting/resize — that is `core-terminal`'s (spec 19)
 *     territory; this spec only asserts the process's status/URL/controls, plus that a
 *     `.xterm` node mounts, not its rendered content.
 *   - No scenario here sends a chat prompt, so the shared turn-oracle
 *     (`e2e/helpers/turn-oracle.ts`) is not used in this file.
 */
import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-core-processes"
const SESSION_ID = "ses_core_processes"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function seedOneProject(page: Page, dir: string) {
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

/** Fake the PTY WebSocket so a started process's `.xterm` mounts; `installMockRuntime` mocks HTTP only. */
async function fakePtyWebSocket(page: Page) {
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket
    const FakeWebSocket = new Proxy(OriginalWebSocket, {
      construct(_target, wsArgs: [string | URL, (string | string[])?]) {
        const url = String(wsArgs[0])
        if (!url.includes("/pty/")) {
          return Reflect.construct(OriginalWebSocket, wsArgs)
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
        return target
      },
    })
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    })
  })
}

// ---------------------------------------------------------------------------
// Process mock. Route shapes follow `processPath()` in `src/process/client.ts`;
// response bodies have to satisfy the zod schemas in `src/process/process.ts`
// that the client parses them with.
// ---------------------------------------------------------------------------

type MockConfig = {
  id: string
  name: string
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  autoStart: boolean
  restartPolicy: "never" | "on-failure" | "always"
  maxRestarts: number
  color?: string
  port?: { name: string; inject: string; preferred?: number; onConflict?: "pick-new" | "kill-existing" }
}

type MockManaged = {
  configId: string
  ptyId?: string
  status: "idle" | "starting" | "running" | "stopping" | "stopped" | "crashed" | "restarting"
  restartCount: number
  exitCode?: number
  startedAt?: number
  exitedAt?: number
  assignedPort?: number
  conflict?: { type: "port-conflict"; port: number; pid?: number; command?: string }
  routeConflict?: { type: "route-conflict"; hostname: string; pid: number; command?: string }
  launchError?: string
}

type StartBehavior =
  | { kind: "success" }
  | { kind: "failed"; error: string }
  | { kind: "port_conflict"; port: number }
  | { kind: "route_conflict"; hostname: string }

type ProcessMockHandle = {
  requests: {
    create: number
    update: number
    delete: number
    start: number
    stop: number
    restart: number
    startBodies: Array<Record<string, unknown> | undefined>
  }
  configs: () => MockConfig[]
  process: (configId: string) => MockManaged | undefined
  /** Script the NEXT start/restart call for this configId. Consumed once. */
  setStartBehavior: (configId: string, behavior: StartBehavior) => void
  /** Mutate server-side state directly; the client only sees it on its next list fetch. */
  setProcessState: (configId: string, patch: Partial<MockManaged>) => void
  nextPort: () => number
}

async function installProcessMock(page: Page): Promise<ProcessMockHandle> {
  let nextId = 1
  let portCounter = 4100
  const configs: MockConfig[] = []
  const processes = new Map<string, MockManaged>()
  const startBehaviors = new Map<string, StartBehavior>()
  const requests: ProcessMockHandle["requests"] = {
    create: 0,
    update: 0,
    delete: 0,
    start: 0,
    stop: 0,
    restart: 0,
    startBodies: [],
  }

  function isApi(route: Route) {
    const type = route.request().resourceType()
    return type === "fetch" || type === "xhr"
  }
  function json(route: Route, body: unknown, status = 200) {
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
  }
  function ensureProcess(configId: string): MockManaged {
    let proc = processes.get(configId)
    if (!proc) {
      proc = { configId, status: "idle", restartCount: 0 }
      processes.set(configId, proc)
    }
    return proc
  }
  function launchSuccess(config: MockConfig, proc: MockManaged) {
    proc.status = "running"
    proc.ptyId = `pty_${config.id}`
    proc.startedAt = Date.now()
    proc.exitedAt = undefined
    proc.exitCode = undefined
    proc.conflict = undefined
    proc.routeConflict = undefined
    proc.launchError = undefined
    proc.assignedPort = config.port ? config.port.preferred ?? portCounter++ : proc.assignedPort
    return { kind: "started" as const, process: { ...proc } }
  }
  function runStart(config: MockConfig, body: Record<string, unknown> | undefined) {
    const proc = ensureProcess(config.id)
    const resolving = !!(body?.portConflict || body?.routeConflict)
    const scripted = startBehaviors.get(config.id)
    if (scripted && !resolving) {
      startBehaviors.delete(config.id)
      if (scripted.kind === "failed") {
        return { kind: "failed" as const, error: scripted.error }
      }
      if (scripted.kind === "port_conflict") {
        return {
          kind: "port_conflict" as const,
          conflict: { type: "port-conflict" as const, port: scripted.port, pid: 55123, command: "other-process" },
        }
      }
      if (scripted.kind === "route_conflict") {
        return {
          kind: "route_conflict" as const,
          conflict: { type: "route-conflict" as const, hostname: scripted.hostname, pid: 55124, command: "other-process" },
        }
      }
    }
    if (resolving && body?.portConflict) {
      proc.conflict = undefined
      if (body.portConflict === "pick-new") config.port = config.port ? { ...config.port, preferred: portCounter } : config.port
    }
    if (resolving && body?.routeConflict) {
      proc.routeConflict = undefined
    }
    return launchSuccess(config, proc)
  }

  const handler = async (route: Route) => {
    if (!isApi(route)) return route.continue()
    const url = new URL(route.request().url())
    const pathname = url.pathname
    const method = route.request().method()
    if (!pathname.startsWith("/api/wr/process")) return route.fallback()

    if (pathname === "/api/wr/process/start-all" && method === "POST") {
      for (const config of configs) launchSuccess(config, ensureProcess(config.id))
      return json(route, true)
    }
    if (pathname === "/api/wr/process/stop-all" && method === "POST") {
      for (const proc of processes.values()) {
        proc.status = "stopped"
        proc.ptyId = undefined
        proc.exitCode = 0
        proc.exitedAt = Date.now()
      }
      return json(route, true)
    }

    const startMatch = pathname.match(/^\/api\/wr\/process\/([^/]+)\/start$/)
    if (startMatch && method === "POST") {
      requests.start += 1
      const config = configs.find((c) => c.id === startMatch[1])
      let body: Record<string, unknown> | undefined
      try {
        body = route.request().postDataJSON()
      } catch {
        body = undefined
      }
      requests.startBodies.push(body)
      if (!config) return json(route, { kind: "not_found", error: "no such process" }, 404)
      return json(route, runStart(config, body))
    }
    const stopMatch = pathname.match(/^\/api\/wr\/process\/([^/]+)\/stop$/)
    if (stopMatch && method === "POST") {
      requests.stop += 1
      const proc = processes.get(stopMatch[1])
      if (proc) {
        proc.status = "stopped"
        proc.ptyId = undefined
        proc.exitCode = 0
        proc.exitedAt = Date.now()
      }
      return json(route, true)
    }
    const restartMatch = pathname.match(/^\/api\/wr\/process\/([^/]+)\/restart$/)
    if (restartMatch && method === "POST") {
      requests.restart += 1
      const config = configs.find((c) => c.id === restartMatch[1])
      if (!config) return json(route, { kind: "not_found", error: "no such process" }, 404)
      return json(route, runStart(config, undefined))
    }

    if (pathname === "/api/wr/process") {
      if (method === "GET") {
        return json(route, { configs, processes: [...processes.values()] })
      }
      if (method === "POST") {
        requests.create += 1
        const body = route.request().postDataJSON() as Partial<MockConfig>
        const config: MockConfig = {
          id: `proc_${nextId++}`,
          name: body.name ?? "",
          command: body.command ?? "",
          args: [],
          cwd: body.cwd,
          env: body.env,
          autoStart: body.autoStart ?? false,
          restartPolicy: body.restartPolicy ?? "never",
          maxRestarts: body.maxRestarts ?? 3,
          color: body.color,
          port: body.port,
        }
        configs.push(config)
        ensureProcess(config.id)
        return json(route, config, 201)
      }
    }

    const idMatch = pathname.match(/^\/api\/wr\/process\/([^/]+)$/)
    if (idMatch) {
      const id = idMatch[1]
      if (method === "PUT") {
        requests.update += 1
        const idx = configs.findIndex((c) => c.id === id)
        if (idx === -1) return json(route, { error: "not found" }, 404)
        const body = route.request().postDataJSON() as Partial<MockConfig>
        configs[idx] = { ...configs[idx], ...body, id }
        return json(route, configs[idx])
      }
      if (method === "DELETE") {
        requests.delete += 1
        const idx = configs.findIndex((c) => c.id === id)
        if (idx === -1) return json(route, { error: "not found" }, 404)
        configs.splice(idx, 1)
        processes.delete(id)
        return json(route, true)
      }
    }

    return route.fallback()
  }

  await page.route("**/api/wr/process**", handler)

  return {
    requests,
    configs: () => configs,
    process: (configId: string) => processes.get(configId),
    setStartBehavior: (configId, behavior) => startBehaviors.set(configId, behavior),
    setProcessState: (configId, patch) => {
      const proc = ensureProcess(configId)
      Object.assign(proc, patch)
    },
    nextPort: () => portCounter,
  }
}

async function openWorkspace(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  if (!(await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "New Session" }).first().click()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
  }
}

function processesToggle(page: Page) {
  return page.locator('button[aria-label="Open Processes"], button[aria-label="Close Processes"]').first()
}

/** Open the workspace panel column if it is closed. */
async function ensureWorkspacePanelOpen(page: Page) {
  const panelToggle = page.locator('[data-testid="workspace-panel-toggle"]').first()
  await expect(panelToggle).toBeVisible({ timeout: 10_000 })
  if ((await panelToggle.getAttribute("aria-label")) === "Open workspace panel") await panelToggle.click()
}

async function openProcessesNavigator(page: Page): Promise<Locator> {
  const overlay = page.locator('[data-testid="workspace-navigator-overlay"][data-navigator="processes"]')
  // The overlay is `<Show when={processesNavigatorVisited()}>`, so before the first
  // open it does not exist and `.getAttribute()` would auto-wait out the full action
  // timeout. `.count()` answers immediately.
  const alreadyOpen = (await overlay.count()) > 0 && (await overlay.getAttribute("data-open")) === "true"
  if (!alreadyOpen) {
    await ensureWorkspacePanelOpen(page)
    const toggle = processesToggle(page)
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    if ((await toggle.getAttribute("aria-label")) !== "Close Processes") await toggle.click()
  }
  await expect(overlay).toHaveAttribute("data-open", "true", { timeout: 10_000 })
  const readLayout = () => overlay.evaluate((element) => {
    // Measure the named Review surface rather than the first flex-growing sibling:
    // during a reload a retained or pending panel body can satisfy that structural
    // guess.
    const content = element.parentElement?.querySelector<HTMLElement>('[data-testid="review-pane-root"]')
    const navigatorBounds = element.getBoundingClientRect()
    const contentBounds = content?.getBoundingClientRect()
    return {
      position: getComputedStyle(element).position,
      overlapsReview: contentBounds
        ? navigatorBounds.left < contentBounds.right && navigatorBounds.right > contentBounds.left
        : true,
    }
  })
  await expect.poll(async () => (await readLayout()).position).not.toBe("absolute")
  await expect.poll(async () => (await readLayout()).overlapsReview).toBe(false)
  return overlay
}

async function closeProcessesNavigator(page: Page) {
  const toggle = page.locator('button[aria-label="Close Processes"]').first()
  if (await toggle.isVisible().catch(() => false)) await toggle.click()
}

async function clickPanelAction(page: Page, panel: Locator, action: "start" | "stop" | "restart" | "start-fallback") {
  await processAction(page, panel, action).click()
}

function processHeader(page: Page) {
  return page.locator('[data-testid="process-pane-header"]:visible').first()
}

function processAction(page: Page, panel: Locator, action: "start" | "stop" | "restart" | "start-fallback") {
  if (action === "start" || action === "start-fallback") {
    return panel.locator('[data-process-action="start-fallback"]')
  }
  return processHeader(page).locator(`[data-process-action="${action}"]`)
}

function addProcessButton(page: Page, overlay: Locator) {
  return overlay.getByRole("button", { name: "Add process" }).first()
}

async function addProcess(page: Page, overlay: Locator, input: { name: string; command: string }) {
  await addProcessButton(page, overlay).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByTestId("process-name-input").fill(input.name)
  await dialog.getByTestId("process-command-input").fill(input.command)
  const submit = dialog.getByRole("button", { name: "Add", exact: true })
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(dialog).toBeHidden({ timeout: 5_000 })
  // A previous add's toast can still be on screen when a test adds two configs back
  // to back; `.last()` takes the newest instead of colliding on strict mode.
  await expect(page.getByText("Process created").last()).toBeVisible({ timeout: 3_000 })
}

function processPanel(page: Page, name: string) {
  return page.locator(`[data-testid="process-pane-panel"][data-process-name="${name}"]`)
}

async function openProcessPanel(page: Page, overlay: Locator, name: string): Promise<Locator> {
  const panel = processPanel(page, name)
  if (await panel.isVisible().catch(() => false)) return panel
  await overlay.getByRole("button", { name: new RegExp(escapeRegExp(name)) }).first().click()
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(overlay).toHaveAttribute("data-open", "true")
  await expect(overlay).toBeVisible()
  return panel
}

test.describe("core processes @core", () => {
  test.beforeEach(async ({ page }) => {
    await fakePtyWebSocket(page)
  })

  test("empty state shows no-processes copy with an inline Add affordance", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await expect(overlay.getByText("No processes configured.")).toBeVisible({ timeout: 10_000 })
    await expect(addProcessButton(page, overlay)).toBeVisible()
  })

  test("Add Process dialog gates submit on name+command and supports env-var rows", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcessButton(page, overlay).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    const submit = dialog.getByRole("button", { name: "Add", exact: true })
    await expect(submit).toBeDisabled()

    await dialog.getByTestId("process-name-input").fill("dev-server")
    await expect(submit).toBeDisabled()
    await dialog.getByTestId("process-command-input").fill("node server.js")
    await expect(submit).toBeEnabled()
    await dialog.getByTestId("process-name-input").clear()
    await expect(submit).toBeDisabled()
    await dialog.getByTestId("process-name-input").fill("dev-server")

    await dialog.getByText("Add variable").click()
    const keyInputs = dialog.locator('input[placeholder="KEY"]')
    const valueInputs = dialog.locator('input[placeholder="value"]')
    await expect(keyInputs).toHaveCount(1)
    await keyInputs.first().fill("NODE_ENV")
    await valueInputs.first().fill("development")

    await dialog.getByText("Add variable").click()
    await expect(keyInputs).toHaveCount(2)
    await dialog.getByRole("button", { name: "Remove variable" }).first().click()
    await expect(keyInputs).toHaveCount(1)

    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden({ timeout: 3_000 })
  })

  test("submitting Add creates the config and lists it in the navigator", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "dev-server", command: "node server.js" })

    await expect(overlay.getByRole("button", { name: /dev-server/ })).toBeVisible({ timeout: 10_000 })
    expect(mock.requests.create).toBe(1)
    expect(mock.configs().map((c) => c.name)).toEqual(["dev-server"])
  })

  test("selecting a process opens its dedicated panel and keeps the navigator open", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "dev-server", command: "node server.js" })
    const panel = await openProcessPanel(page, overlay, "dev-server")

    await expect(panel).toHaveAttribute("data-process-name", "dev-server")
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-testid="process-pane-header"]')).toHaveCount(0)
    await expect(processHeader(page)).toContainText("dev-server")
    await expect(processHeader(page).locator('[data-process-action="start"]')).toHaveCount(0)
    const editBounds = await processHeader(page).getByRole("button", { name: "Edit process" }).boundingBox()
    const filesBounds = await page
      .locator('button[aria-label="Open Files"], button[aria-label="Close Files"]')
      .first()
      .boundingBox()
    expect(editBounds?.x).toBeLessThan(filesBounds?.x ?? 0)
  })

  test("start flips status to running and shows the assigned URL; stop reverts it", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "dev-server", command: "node server.js" })
    const panel = await openProcessPanel(page, overlay, "dev-server")

    const startButton = processAction(page, panel, "start")
    await expect(startButton).toBeVisible()
    await clickPanelAction(page, panel, "start")
    await expect.poll(() => mock.requests.start, { timeout: 10_000 }).toBe(1)

    const stopButton = processAction(page, panel, "stop")
    await expect(stopButton).toBeVisible({ timeout: 10_000 })
    await expect(panel.locator(".xterm")).toBeVisible({ timeout: 10_000 })

    await clickPanelAction(page, panel, "stop")
    await expect.poll(() => mock.requests.stop, { timeout: 10_000 }).toBe(1)
    await expect(processAction(page, panel, "start")).toBeVisible({ timeout: 10_000 })
    await expect(stopButton).toHaveCount(0)
  })

  test("restart calls /restart when running, and /start when stopped or crashed", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "dev-server", command: "node server.js" })
    const panel = await openProcessPanel(page, overlay, "dev-server")

    const stoppedRestartOrStart = processAction(page, panel, "start")
    await stoppedRestartOrStart.click()
    await expect.poll(() => mock.requests.start, { timeout: 10_000 }).toBe(1)
    expect(mock.requests.restart).toBe(0)

    const restartButton = processAction(page, panel, "restart")
    await expect(restartButton).toBeVisible({ timeout: 10_000 })
    await restartButton.click()
    await expect.poll(() => mock.requests.restart, { timeout: 10_000 }).toBe(1)
    expect(mock.requests.start).toBe(1)
  })

  test("start-all runs sequentially, stop-all runs concurrently, button relabels", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "server-one", command: "node one.js" })
    await addProcess(page, overlay, { name: "server-two", command: "node two.js" })

    const startTimes: number[] = []
    // `route.fallback()`, not `route.continue()`: Playwright resolves routes
    // last-registered-first, so `continue()` would send this to the real network
    // where no server exists. `fallback()` defers to `installProcessMock` once this
    // handler has recorded its timing and added its delay.
    await page.route("**/api/wr/process/*/start**", async (route) => {
      startTimes.push(Date.now())
      await new Promise((r) => setTimeout(r, 150))
      await route.fallback()
    }, { times: 2 })

    const startAll = overlay.getByRole("button", { name: "Start all processes" })
    await expect(startAll).toBeVisible({ timeout: 10_000 })
    await startAll.click()

    const stopAll = overlay.getByRole("button", { name: "Stop all processes" })
    await expect(stopAll).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => mock.requests.start, { timeout: 10_000 }).toBe(2)
    expect(startTimes.length).toBe(2)
    expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(120)

    await stopAll.click()
    await expect.poll(() => mock.requests.stop, { timeout: 10_000 }).toBe(2)
    await expect(startAll).toBeVisible({ timeout: 10_000 })
  })

  test("start-triggered crash shows Failed to start, auto-opens the panel, and lights the attention dot", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "broken", command: "nonexistent-binary" })
    const configId = mock.configs()[0].id
    mock.setStartBehavior(configId, { kind: "failed", error: "spawn nonexistent-binary ENOENT" })

    const panel = await openProcessPanel(page, overlay, "broken")
    await processAction(page, panel, "start").click()

    await expect(panel.getByText("Failed to start")).toBeVisible({ timeout: 10_000 })
    await expect(panel.getByText("spawn nonexistent-binary ENOENT")).toBeVisible()

    const attentionDot = processesToggle(page).locator("span.bg-surface-critical-strong")
    await expect(attentionDot).toBeVisible({ timeout: 10_000 })
  })

  test("a reconciled process crash shows its exit code and lights the toolbar attention dot", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "flaky", command: "node flaky.js" })
    const panel = await openProcessPanel(page, overlay, "flaky")
    await processAction(page, panel, "start").click()
    await expect(processAction(page, panel, "stop")).toBeVisible({ timeout: 10_000 })

    const configId = mock.configs()[0].id
    mock.setProcessState(configId, { status: "crashed", ptyId: undefined, exitCode: 17, exitedAt: Date.now() })

    // Close the panel, then reload: a crash the client did not itself trigger is
    // only picked up by the next list fetch.
    await closeProcessesNavigator(page)
    await page.reload()
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    // Nothing refetches `/api/wr/process` until the Processes navigator has been
    // opened once after the reload. Open the list navigator — not the per-process
    // panel — so the fetch fires and the exit code can be read off the row.
    const overlay2 = await openProcessesNavigator(page)
    const flakyRow = overlay2.getByRole("button", { name: /flaky/ }).first()
    await expect(flakyRow.getByText(/exit\s+17/)).toBeVisible({ timeout: 10_000 })
    await closeProcessesNavigator(page)
    await expect(page.locator(
      'button[aria-label="Open Processes"]:visible span.bg-surface-critical-strong',
    )).toBeVisible({ timeout: 10_000 })
  })

  test("a late start-response never clobbers a crash the client already learned about via SSE", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page)
    await seedOneProject(page, DIR)

    // Ordered deterministically rather than raced: hold the daemon's
    // `/api/wr/events` connection open behind a gate promise, release it only once
    // the `start()` POST is in flight, and delay that POST's response past the point
    // the crash event lands. Process events are workspace-runtime frames —
    // `cp/events` is a different authority, not an injection shortcut.
    let releaseCrashEvent: (() => void) | undefined
    const crashEventGate = new Promise<void>((resolve) => {
      releaseCrashEvent = resolve
    })
    let startInFlightResolve: (() => void) | undefined
    const startInFlight = new Promise<void>((resolve) => {
      startInFlightResolve = resolve
    })

    const deliverCrashEvent = async (route: Route) => {
      await Promise.race([crashEventGate, new Promise((r) => setTimeout(r, 15_000))])
      const configId = mock.configs()[0]?.id
      if (!configId) {
        await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" }).catch(() => {})
        return
      }
      const ptyId = `pty_${configId}`
      mock.setProcessState(configId, { status: "crashed", ptyId, exitCode: 1, exitedAt: Date.now() })
      const events = [
        { type: "process.crashed", directory: DIR, configId, exitCode: 1, restartCount: 0, ptyId },
        { type: "process.status", directory: DIR, configId, status: "crashed" },
      ]
      await route
        .fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        })
        .catch(() => {})
    }
    // `process.crashed` is a workspace control frame: `ProcessPaneProvider`
    // reads it off `useClaxedoEvents`, whose workspace stream is `/api/wr/events`.
    await page.route("**/api/wr/events**", deliverCrashEvent, { times: 1 })

    await openWorkspace(page, DIR)
    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "flaky-dev", command: "exit 1" })
    const configId = mock.configs()[0].id
    const panel = await openProcessPanel(page, overlay, "flaky-dev")

    await page.route(
      `**/api/wr/process/${configId}/start**`,
      async (route) => {
        startInFlightResolve?.()
        await new Promise((r) => setTimeout(r, 300))
        await route.fallback()
      },
      { times: 1 },
    )

    await clickPanelAction(page, panel, "start")
    await startInFlight
    releaseCrashEvent?.()

    // The crashed state has to win. The crash handler keeps `ptyId`, so
    // `hasTerminal()`/`visiblePty()` stay true and the panel renders the dead
    // terminal rather than its "Crashed" placeholder — identical whether or not the
    // guard works, so neither can discriminate a clobber. Assert on the two surfaces
    // reading `status()`/`exitCode` alone: the title-bar status dot's color, and the
    // navigator row, where a clobber shows up as "exit 1" vanishing and Stop
    // replacing Start.
    const runningColor = await page.evaluate(() => {
      const probe = document.createElement("div")
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--surface-success-strong").trim()
      document.body.appendChild(probe)
      const rgb = getComputedStyle(probe).color
      probe.remove()
      return rgb
    })
    // `portalHeader` moves the pane header out of the panel element and into the pane
    // toolbar slot, so locate the dot by the header testid to hold in either mode.
    const dot = page.locator('[data-testid="process-pane-header"] span.relative.inline-flex.rounded-full').first()
    await expect(dot).not.toHaveCSS("background-color", runningColor, { timeout: 15_000 })

    const overlay2 = await openProcessesNavigator(page)
    const flakyRow = overlay2.getByRole("button", { name: /flaky-dev/ }).first()
    // Scoped to ProcessSubtitle's crashed span rather than matched by text: the
    // command here is also `exit 1`, and its preview in the row would collide.
    await expect(flakyRow.locator('span[style*="critical-strong"]').getByText(/exit\s+1\b/)).toBeVisible({ timeout: 10_000 })
    await expect(flakyRow.getByRole("button", { name: "Start process" })).toBeVisible()
    await expect(flakyRow.getByRole("button", { name: "Stop process" })).toHaveCount(0)

    // Let the delayed start response resolve, then re-assert the crashed state is
    // unchanged: unguarded, that late "running" snapshot flips the status back,
    // clears exitCode, and swaps Start out for Stop.
    await page.waitForTimeout(500)
    await expect(flakyRow.locator('span[style*="critical-strong"]').getByText(/exit\s+1\b/)).toBeVisible()
    await expect(flakyRow.getByRole("button", { name: "Start process" })).toBeVisible()
    await expect(flakyRow.getByRole("button", { name: "Stop process" })).toHaveCount(0)

    const dotColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(dotColor).not.toBe(runningColor)
  })

  test("port conflict overlay resolves via pick-new and via kill-existing", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "web", command: "node web.js" })
    const configId = mock.configs()[0].id
    mock.setStartBehavior(configId, { kind: "port_conflict", port: 4100 })

    const panel = await openProcessPanel(page, overlay, "web")
    await clickPanelAction(page, panel, "start")

    await expect(panel.getByText("4100")).toBeVisible({ timeout: 10_000 })
    await panel.getByRole("button", { name: "Use another port" }).click()
    await expect.poll(() => mock.requests.startBodies.at(-1), { timeout: 10_000 }).toEqual({ portConflict: "pick-new" })
    await expect(processAction(page, panel, "stop")).toBeVisible({ timeout: 10_000 })
    await expect(panel.getByText("Port")).toHaveCount(0)

    await clickPanelAction(page, panel, "stop")
    mock.setStartBehavior(configId, { kind: "port_conflict", port: 4100 })
    await clickPanelAction(page, panel, "start")
    await expect(panel.getByText(/Kill process/)).toBeVisible({ timeout: 10_000 })
    await panel.getByText(/Kill process/).click()
    await expect.poll(() => mock.requests.startBodies.at(-1), { timeout: 10_000 }).toEqual({ portConflict: "kill-existing" })
    await expect(processAction(page, panel, "stop")).toBeVisible({ timeout: 10_000 })
  })

  test("route conflict overlay resolves via pick-new", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "web", command: "node web.js" })
    const configId = mock.configs()[0].id
    mock.setStartBehavior(configId, { kind: "route_conflict", hostname: "web.local" })

    const panel = await openProcessPanel(page, overlay, "web")
    await clickPanelAction(page, panel, "start")

    await expect(panel.getByText("web.local")).toBeVisible({ timeout: 10_000 })
    await panel.getByRole("button", { name: "Use another name" }).click()
    await expect.poll(() => mock.requests.startBodies.at(-1), { timeout: 10_000 }).toEqual({ routeConflict: "pick-new" })
    await expect(processAction(page, panel, "stop")).toBeVisible({ timeout: 10_000 })
  })

  test("edit dialog pre-fills existing values and Save updates the config", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "build-watcher", command: "npm run watch" })
    await openProcessPanel(page, overlay, "build-watcher")

    await processHeader(page).getByRole("button", { name: "Edit process" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Edit Process")).toBeVisible()
    await expect(dialog.getByTestId("process-name-input")).toHaveValue("build-watcher")
    await expect(dialog.getByTestId("process-command-input")).toHaveValue("npm run watch")

    await dialog.getByTestId("process-command-input").fill("npm run watch:fast")
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog).toBeHidden({ timeout: 5_000 })
    await expect(page.getByText("Process updated")).toBeVisible({ timeout: 3_000 })

    expect(mock.requests.update).toBe(1)
    expect(mock.configs()[0]?.command).toBe("npm run watch:fast")
  })

  test("delete requires an inline confirm; cancel restores the form, confirm removes the config", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "to-delete", command: "echo delete-me" })
    await openProcessPanel(page, overlay, "to-delete")

    await processHeader(page).getByRole("button", { name: "Edit process" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()

    await dialog.getByRole("button", { name: "Delete" }).click()
    await expect(dialog.getByText("Are you sure you want to delete this process?")).toBeVisible()
    await dialog.getByRole("button", { name: "Cancel" }).first().click()
    await expect(dialog.getByText("Are you sure you want to delete this process?")).toBeHidden()
    await expect(dialog.getByTestId("process-name-input")).toHaveValue("to-delete")

    await dialog.getByRole("button", { name: "Delete" }).click()
    await expect(dialog.getByText("Are you sure you want to delete this process?")).toBeVisible()
    await dialog.getByTestId("process-confirm-delete").click()
    await expect(dialog).toBeHidden({ timeout: 5_000 })
    await expect(page.getByText("Process removed")).toBeVisible({ timeout: 3_000 })

    expect(mock.requests.delete).toBe(1)
    expect(mock.configs()).toHaveLength(0)
    // Deleting does not navigate the panel back to the list: it stays focused on the
    // gone config id and renders "Process not found", like any deep link to a deleted
    // entity. Reopen the navigator to reach the empty state.
    await expect(page.getByText("Process not found")).toBeVisible({ timeout: 5_000 })
    // The navigator and the dedicated panel each mount their own `ProcessPaneProvider`
    // with an independent `configs`/`processes` store; in the real app they converge on
    // the `process.config.changed` event every mutation broadcasts. `installProcessMock`
    // is HTTP-only and never pushes it, so the navigator's cache goes stale after a
    // delete performed from the panel. Serve that one event here, as a flat
    // `ClaxedoEvent` — `ClaxedoEventsProvider` requires `"type"` at the top level and
    // silently drops the `{directory, payload}` wrapper `mock-runtime` uses for session
    // events.
    //
    // Not `{times: 1}`: the stream reconnects continuously, and an unrelated reconnect
    // can consume a single fulfillment before the navigator's provider subscribes.
    // Serve it on every reconnect until the empty state is proven, then unroute —
    // re-delivery is safe, the event assigns a list.
    const emptyConfigsEvents = async (route: import("@playwright/test").Route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ type: "process.config.changed", directory: DIR, configs: [] })}\n\n`,
      })
    }
    await page.route("**/api/wr/events**", emptyConfigsEvents)
    try {
      const overlayAfterDelete = await openProcessesNavigator(page)
      await expect(overlayAfterDelete.getByText("No processes configured.")).toBeVisible({ timeout: 10_000 })
    } finally {
      await page.unroute("**/api/wr/events**", emptyConfigsEvents)
    }
  })

  test("a process-owned PTY never duplicates as a terminal tab", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const tabsBefore = await page.locator('[data-testid="compact-switcher-tab"]').count()

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "dev-server", command: "node server.js" })
    const panel = await openProcessPanel(page, overlay, "dev-server")
    await processAction(page, panel, "start").click()
    await expect(processAction(page, panel, "stop")).toBeVisible({ timeout: 10_000 })

    // Give the terminal-tab auto-detection effect a beat to (not) fire.
    await page.waitForTimeout(500)
    await expect(page.locator('[data-testid="compact-switcher-tab"]')).toHaveCount(tabsBefore, { timeout: 5_000 })
  })

  test("reload re-fetches from the backend and renders the same configs/processes", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "dev-server", command: "node server.js" })
    const panel = await openProcessPanel(page, overlay, "dev-server")
    await processAction(page, panel, "start").click()
    await expect(processAction(page, panel, "stop")).toBeVisible({ timeout: 10_000 })

    await page.reload()
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    const overlay2 = await openProcessesNavigator(page)
    await expect(overlay2.getByRole("button", { name: /dev-server/ })).toBeVisible({ timeout: 10_000 })
    const panel2 = await openProcessPanel(page, overlay2, "dev-server")
    await expect(processAction(page, panel2, "stop")).toBeVisible({ timeout: 10_000 })
  })

  // This web harness has no desktop diagnostics capability. Assert both entry points:
  // the zero-project recovery surface and the account menu after a project is loaded.
  test("Diagnostics is absent from the web platform", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page)
    await page.addInitScript(() => localStorage.clear())
    await page.goto("/")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId("empty-diagnostics-trigger")).toHaveCount(0)

    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    await page.getByTestId("rail-account-trigger").click()
    await expect(page.getByRole("menu")).toBeVisible()
    // The always-present items confirm the menu actually opened...
    await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "Usage", exact: true })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "Diagnostics" })).toHaveCount(0)
  })

  test("mutation controls are present for a local (unconditionally-mutable) workspace", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page)
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await expect(addProcessButton(page, overlay)).toBeVisible()
    await addProcess(page, overlay, { name: "dev-server", command: "node server.js" })
    const panel = await openProcessPanel(page, overlay, "dev-server")
    await expect(processAction(page, panel, "start")).toBeVisible()
    await expect(processHeader(page).getByRole("button", { name: "Edit process" })).toBeVisible()
  })
})
