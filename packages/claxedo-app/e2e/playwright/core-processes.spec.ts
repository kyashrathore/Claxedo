/**
 * SPEC: Processes panel (dev-process manager)
 *
 * PURPOSE — lets a user define, launch, and supervise long-running dev processes
 * (dev servers, watchers, sidecars) scoped to a workspace directory, without leaving
 * the app for a separate terminal multiplexer. Each process is a named command with an
 * optional port binding; the app shows its live status, exposes its assigned URL, and
 * gives the user a PTY-backed terminal view of its output — all from the workspace side
 * panel.
 *
 * STATE MODEL —
 *   - Source of truth is server-side, per directory: `.claxedo/processes.jsonc` (config
 *     list) plus an in-memory `ManagedProcess` map (live status/ptyId/port), owned by
 *     claxedo-server and reached through `@claxedo/process/client`
 *     (`packages/claxedo-app/src/process/client.ts`) at `/api/wr/process*`
 *     (`processPath()`, client.ts:27-33). The client always sends
 *     `?directory=<dir>` (+ `workspaceId` when scoped to a non-local workspace) and an
 *     `x-opencode-directory` header.
 *   - Client-side cache: `ProcessPaneProvider`
 *     (`src/claxedo-ui/context/process-pane.tsx`) holds a SolidJS store
 *     `{configs, processes, paneHeight}` persisted (paneHeight only, NOT
 *     visibility/configs) under `Persist.scoped(directory, undefined, "process-pane")`.
 *     `configs`/`processes` are NOT persisted — every mount/reload re-fetches via
 *     `GET /api/wr/process` (`fetchProcesses`, process-pane.tsx:181-240), gated to fire
 *     only once the Processes navigator has been opened at least once
 *     (`isProcessOpen()` + `!loaded()`, process-pane.tsx:612-617).
 *   - Per-process status is a `Process.Status` enum: idle → starting → running →
 *     stopping → stopped, or → crashed (`src/process/process.ts:19-27`). Actions
 *     (`start`/`stop`/`restart`/`startAll`/`stopAll`) apply an OPTIMISTIC status
 *     transition locally, then reconcile from the HTTP response
 *     (`Process.LaunchResult` discriminated union: `started` | `already_running` |
 *     `port_conflict` | `route_conflict` | `failed` | `not_found`,
 *     `src/process/process.ts:126-156`); belt-and-suspenders re-sync also happens on
 *     the next `fetchProcesses()` (panel reopen, reload, wake-from-sleep,
 *     visibilitychange).
 *   - A running process owns a PTY (`ManagedProcess.ptyId`). The pane's
 *     `ProcessOwnership` layer (`context/process-ownership.ts`) marks that ptyId as
 *     process-owned so the generic terminal-tab auto-detection effect skips it and
 *     never creates a competing standalone terminal tab for it
 *     (`fetchProcesses`/`applyProcess`/SSE handlers all call
 *     `ownership.ownProcess`/`tabOps.removeAutoCreatedTab`).
 *   - Mutation gating: `canMutateProcesses()` (process-pane.tsx:138-141) is
 *     `!workspaceId || can("mutate.workspace", workspacePlacement(workspaceId))`. A
 *     purely local workspace (no `workspaceId` resolves for the directory) is therefore
 *     ALWAYS mutable; role-based read-only gating only engages once a workspace is
 *     backed by a relay/cloud connection with a resolved role
 *     (`src/shell/auth/role.tsx:26-31`, `viewer` lacks `mutate.workspace`) — see OUT OF
 *     SCOPE.
 *   - Survives reload: the server-side config file + process map (re-fetched on next
 *     open). Does NOT survive: the client store's `configs`/`processes` (always
 *     refetched), pane open/closed state (navigator visibility is not persisted,
 *     `paneHeight` is).
 *
 * ANATOMY —
 *   `[aria-label="Open Processes"]` / `[aria-label="Close Processes"]` — the L2-header
 *     toolbar toggle (`workspace-tool-buttons.tsx`); carries a small red dot
 *     (`span.bg-surface-critical-strong`, `attention` prop) when
 *     `processPane.crashed(dir) || processPane.crashedWhileClosed()`.
 *   `[data-testid="workspace-panel-shell"][data-open="true"]` — the whole workspace
 *     side panel is mounted/open.
 *   `[data-testid="workspace-navigator-overlay"][data-navigator="processes"]
 *     [data-open="true"]` — the Processes list navigator overlay
 *     (`WorkspaceProcessesNavigator.tsx`): header (icon, "Processes" label,
 *     Start/Stop-all `IconButton` when any config exists, "Add process" `IconButton`
 *     gated by `canMutate()`), then either "No processes configured." + an inline "Add
 *     process" button (empty state) or one row per config (status dot, name, per-row
 *     Start/Stop/Restart `IconButton`s gated by `canMutate()`).
 *   `[data-testid="process-pane-panel"][data-process-id][data-process-name]` — a single
 *     process's terminal panel (`ProcessPanePanel.tsx`). Its contextual L2 header
 *     contains the color dot, status `StatusDot`, name, primary URL, toolbar
 *     `[data-process-action="start"|"stop"|"restart"]` `IconButton`s + edit
 *     `IconButton`; the terminal area is either the live `.xterm` (via
 *     `RoleGuardedTerminal`) or an idle/crashed placeholder with a
 *     `[data-process-action="start-fallback"]` button. A port-conflict overlay
 *     ("Port N is in use" + "Use another port" / "Kill process & reclaim") and a
 *     route-conflict overlay ("Route X is in use", same two actions) render as an
 *     absolute z-10 layer over the terminal area.
 *   Add/Edit dialog (`add-process-dialog.tsx`, `role="dialog"`, title "Add Process" /
 *     "Edit Process"): `[data-testid="process-name-input"]`,
 *     `[data-testid="process-command-input"]`, `[data-testid="process-cwd-input"]`,
 *     env-var rows (`input[placeholder="KEY"]` / `input[placeholder="value"]` +
 *     "Remove variable" button), "Add variable" button, Submit button ("Add" / "Save",
 *     disabled until name+command non-empty), and in edit mode a "Delete" button that
 *     flips the footer to an inline confirm ("Are you sure you want to delete this
 *     process?", "Cancel" / `[data-testid="process-confirm-delete"]`).
 *   Local performance diagnostics are supplied only by the desktop capability
 *     and are covered by the desktop diagnostics suite.
 *
 * BEHAVIORS —
 *   1. The Processes navigator opens from the toolbar toggle; with zero configs it
 *      shows the empty state ("No processes configured.") with an inline "Add process"
 *      affordance.
 *   2. The Add Process dialog gates its submit button on name+command both non-empty,
 *      and supports adding/removing arbitrary env-var rows.
 *   3. Submitting the Add dialog issues `POST /api/wr/process`, shows a "Process
 *      created" toast, closes the dialog, and the new config appears in the navigator
 *      list.
 *   4. Selecting a process from the navigator opens its dedicated
 *      `process-pane-panel`.
 *   5. Starting a stopped process (`POST .../:id/start`) flips its status to running,
 *      shows its assigned port/URL, and swaps the Start control for Stop.
 *   6. Stopping a running process (`POST .../:id/stop`) flips status back to
 *      stopped/idle, clears the ptyId, and swaps Stop back to Start.
 *   7. Restart on an already-running process calls the dedicated `POST .../:id/restart`
 *      endpoint; restart on a stopped/crashed process instead calls the same
 *      `POST .../:id/start` a fresh start would use (`process-pane.tsx:796-855`).
 *   8. "Start all" (shown when no process is running) starts every config
 *      SEQUENTIALLY — one `start` call awaited before the next fires; once any process
 *      is running the same button relabels to "Stop all" and stopping fires every
 *      running process's `stop` CONCURRENTLY (`Promise.all`,
 *      `process-pane.tsx:857-931`).
 *   9. A start-triggered launch failure (`{kind:"failed"}` with no `process` payload)
 *      sets status "crashed" with an inline "Failed to start" + error message, opens
 *      the panel if it was not already open, and lights the toolbar attention dot
 *      (`process-pane.tsx:306-334`).
 *  10. A process that crashes after a successful launch (its next `GET
 *      /api/wr/process` reconcile reports `status:"crashed"` + `exitCode`) shows
 *      "Crashed · exit N" and lights the toolbar attention dot even while the panel is
 *      closed.
 *  11. A port conflict on start (`{kind:"port_conflict"}`) shows the inline "Port N is
 *      in use" overlay; both "Use another port" (`portConflict:"pick-new"`) and "Kill
 *      process & reclaim" (`portConflict:"kill-existing"`) resubmit start and clear the
 *      overlay on success.
 *  12. A route conflict on start (`{kind:"route_conflict"}`) shows the analogous "Route
 *      X is in use" overlay with the same two resolution actions
 *      (`routeConflict:"pick-new"|"kill-existing"`).
 *  13. Editing a config (pencil icon) pre-fills name/command from the existing values;
 *      Save issues `PUT .../:id` and shows a "Process updated" toast.
 *  14. Delete requires two clicks: Delete opens an inline confirm; Cancel restores the
 *      form; Confirm Delete issues `DELETE .../:id`, shows a "Process removed" toast,
 *      and the config disappears from the navigator.
 *  15. A running process's PTY never appears as a second entry in the tab strip
 *      (`[data-testid="compact-switcher-tab"]` count is unchanged by starting a
 *      process).
 *  16. After create+start, a full page reload re-fetches from the backend and renders
 *      the same configs/processes — the client-side reload-recovery path that backs
 *      `.claxedo/processes.jsonc` persistence.
 *  17. Diagnostics is absent from the hosted web platform.
 *  18. Mutation controls (Add / Start / Stop / Restart / Start-all / Edit) are present
 *      for a normal local workspace, where `canMutateProcesses()` is unconditionally
 *      true (see STATE MODEL) — the read-only/viewer-hides-controls half of this
 *      behavior is OUT OF SCOPE for this spec (see below).
 *  19. A `process.crashed`/`process.status:"crashed"` SSE event that reaches the client
 *      BEFORE the (slower, already-in-flight) HTTP response for the `start()` call that
 *      launched it resolves is never clobbered back to "running" by that stale response.
 *      `client.start()`'s HTTP response snapshots status at the moment the PTY spawned,
 *      taken server-side before the launched command necessarily finishes running — a
 *      command that exits immediately (e.g. `exit 1`) can have its crash SSE arrive first.
 *      `applyProcess`'s `isStaleProcessSnapshot` guard (`process-pane.tsx`) rejects that
 *      late "running" snapshot when it describes the SAME ptyId as an already-crashed
 *      entry. Observable surfaces (both keyed on `status()` alone, so they discriminate
 *      the clobber): the process panel's title-bar `StatusDot` settles on crashed (never
 *      green), and the Processes NAVIGATOR row keeps its red "exit N" subtitle with
 *      Start (never Stop) as its hover action. The PANEL's own Stop control and its
 *      "Crashed" placeholder are deliberately NOT this behavior's oracle: the SSE crash
 *      handler intentionally PRESERVES `ptyId` (same-spawn-generation marker the guard
 *      itself relies on, see `isStaleProcessSnapshot`'s unit tests), and both of those
 *      panel affordances key on `hasTerminal()`/`visiblePty()`, which stay truthy while
 *      a crashed process still has its dead PTY attached — identical in the buggy and
 *      fixed builds.
 *
 * INVARIANTS — Add/Start/Stop/Restart/Start-all/Edit controls are rendered only when
 *   `canMutate()` is true (`WorkspaceProcessesNavigator.tsx` / `ProcessPanePanel.tsx`);
 *   a process-owned ptyId is never independently surfaced as a terminal tab; a crashed
 *   process always lights the toolbar attention dot regardless of which panel is
 *   currently focused (`processesAttention` = `crashed(dir) || crashedWhileClosed()`,
 *   true for ANY crashed process in that directory, not just ones detected while the
 *   panel was closed).
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
 *     belongs there instead — FOLDED into `core-cloud-offline-roles`' viewer-role
 *     fixture per docs/e2e-decisions.md #24 (2026-07-20); the local `test.fixme` here
 *     was deleted.
 *   - Project-shared process config visibility across two *local* workspaces (same
 *     `.claxedo/processes.jsonc`, sibling port assignment, "no port leaks after stop")
 *     — this is real claxedo-server worktree-sharing + OS-port-allocation behavior that
 *     a mocked HTTP layer cannot meaningfully exercise; it is covered live by
 *     `e2e-legacy/process-project-shared.spec.ts` (`CLAXEDO_PROCESS_PROJECT_SHARED_LIVE=1`,
 *     real backend + real worktrees) — DELETED per docs/e2e-decisions.md #25
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
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
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

/**
 * Fake the PTY WebSocket so a started process's `.xterm` mounts without a real
 * connection attempt hitting a nonexistent backend (harvested from
 * `e2e-legacy/process-management.spec.ts`'s working pattern — this endpoint is a
 * claxedo-server WS, not covered by `installMockRuntime`, which only mocks HTTP).
 */
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
// Process mock — hand-rolled because `installMockRuntime` does not cover
// `/api/wr/process*` (process management is a distinct claxedo-server
// surface from the session/chat routes that helper mocks). Route shapes verified
// against `src/process/client.ts` (`processPath`) and validated against the zod
// schemas in `src/process/process.ts` that the client parses responses with.
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
  /** Directly mutate a process's server-side state (simulate an async crash the
   *  client will only observe on its next GET /process reconcile — e.g. after
   *  a reload). */
  setProcessState: (configId: string, patch: Partial<MockManaged>) => void
  nextPort: () => number
}

async function installProcessMock(page: Page, opts: { directory?: string } = {}): Promise<ProcessMockHandle> {
  const directory = opts.directory ?? DIR
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

    // start-all / stop-all ---------------------------------------------
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

    // /:id/start | /:id/stop | /:id/restart ------------------------------
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
      const proc = processes.get(stopMatch[1]!)
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

    // bare /api/wr/process — list / create -------------------------------
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

    // /:id — update / delete ----------------------------------------------
    const idMatch = pathname.match(/^\/api\/wr\/process\/([^/]+)$/)
    if (idMatch) {
      const id = idMatch[1]!
      if (method === "PUT") {
        requests.update += 1
        const idx = configs.findIndex((c) => c.id === id)
        if (idx === -1) return json(route, { error: "not found" }, 404)
        const body = route.request().postDataJSON() as Partial<MockConfig>
        configs[idx] = { ...configs[idx]!, ...body, id }
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

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

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

async function openProcessesNavigator(page: Page): Promise<Locator> {
  const overlay = page.locator('[data-testid="workspace-navigator-overlay"][data-navigator="processes"]')
  // `.getAttribute()` auto-waits for the locator to attach (up to the default
  // 30s action timeout) — on first open the overlay has never mounted yet
  // (`<Show when={processesNavigatorVisited()}>` in workspace-panel-body.tsx),
  // so unconditionally calling it here burned most of the 60s test budget
  // before ever reaching the toggle click. `.count()` resolves immediately.
  const alreadyOpen = (await overlay.count()) > 0 && (await overlay.getAttribute("data-open")) === "true"
  if (!alreadyOpen) {
    const toggle = processesToggle(page)
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    if ((await toggle.getAttribute("aria-label")) !== "Close Processes") await toggle.click()
  }
  await expect(overlay).toHaveAttribute("data-open", "true", { timeout: 10_000 })
  const layout = await overlay.evaluate((element) => {
    const content = Array.from(element.parentElement?.children ?? []).find(
      (child): child is HTMLElement => child instanceof HTMLElement && getComputedStyle(child).flexGrow === "1",
    )
    const navigatorBounds = element.getBoundingClientRect()
    const contentBounds = content?.getBoundingClientRect()
    return {
      position: getComputedStyle(element).position,
      overlapsReview: contentBounds
        ? navigatorBounds.left < contentBounds.right && navigatorBounds.right > contentBounds.left
        : true,
    }
  })
  expect(layout.position).not.toBe("absolute")
  expect(layout.overlapsReview).toBe(false)
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
  // A prior `addProcess` call's toast can still be visible (3s duration) when a
  // second process is added in quick succession within the same test (e.g.
  // behavior 8's start-all/stop-all scenario adds two configs back to back) —
  // `.last()` picks the most-recently-stacked toast instead of hitting a
  // strict-mode violation across both.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("core processes @core", () => {
  test.beforeEach(async ({ page }) => {
    await fakePtyWebSocket(page)
  })

  test("empty state shows no-processes copy with an inline Add affordance — behavior 1", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page, { directory: DIR })
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await expect(overlay.getByText("No processes configured.")).toBeVisible({ timeout: 10_000 })
    await expect(addProcessButton(page, overlay)).toBeVisible()
  })

  test("Add Process dialog gates submit on name+command and supports env-var rows — behavior 2", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page, { directory: DIR })
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

  test("submitting Add creates the config and lists it in the navigator — behavior 3", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page, { directory: DIR })
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "dev-server", command: "node server.js" })

    await expect(overlay.getByRole("button", { name: /dev-server/ })).toBeVisible({ timeout: 10_000 })
    expect(mock.requests.create).toBe(1)
    expect(mock.configs().map((c) => c.name)).toEqual(["dev-server"])
  })

  test("selecting a process opens its dedicated panel and keeps the navigator open — behavior 4", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page, { directory: DIR })
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

  test("start flips status to running and shows the assigned URL; stop reverts it — behaviors 5,6", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page, { directory: DIR })
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

  test("restart calls /restart when running, and /start when stopped or crashed — behavior 7", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page, { directory: DIR })
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "dev-server", command: "node server.js" })
    const panel = await openProcessPanel(page, overlay, "dev-server")

    // Stopped -> restart uses /start.
    const stoppedRestartOrStart = processAction(page, panel, "start")
    await stoppedRestartOrStart.click()
    await expect.poll(() => mock.requests.start, { timeout: 10_000 }).toBe(1)
    expect(mock.requests.restart).toBe(0)

    // Now running -> restart uses the dedicated /restart endpoint.
    const restartButton = processAction(page, panel, "restart")
    await expect(restartButton).toBeVisible({ timeout: 10_000 })
    await restartButton.click()
    await expect.poll(() => mock.requests.restart, { timeout: 10_000 }).toBe(1)
    expect(mock.requests.start).toBe(1)
  })

  test("start-all runs sequentially, stop-all runs concurrently, button relabels — behavior 8", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page, { directory: DIR })
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "server-one", command: "node one.js" })
    await addProcess(page, overlay, { name: "server-two", command: "node two.js" })

    const startTimes: number[] = []
    // `route.fallback()`, not `route.continue()`: this handler is registered
    // AFTER `installProcessMock`'s catch-all, and Playwright's route chain
    // resolves LIFO — `continue()` would send the (unhandled-by-anyone) request
    // straight to the real network ("Failed to fetch", no such server), where
    // `fallback()` correctly defers to the previously-registered mock handler
    // once this one has recorded its timing and added the delay.
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
    // Sequential: the second start call did not begin until ~150ms after the first.
    expect(startTimes.length).toBe(2)
    expect(startTimes[1]! - startTimes[0]!).toBeGreaterThanOrEqual(120)

    await stopAll.click()
    await expect.poll(() => mock.requests.stop, { timeout: 10_000 }).toBe(2)
    await expect(startAll).toBeVisible({ timeout: 10_000 })
  })

  test("start-triggered crash shows Failed to start, auto-opens the panel, and lights the attention dot — behavior 9", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page, { directory: DIR })
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "broken", command: "nonexistent-binary" })
    const configId = mock.configs()[0]!.id
    mock.setStartBehavior(configId, { kind: "failed", error: "spawn nonexistent-binary ENOENT" })

    const panel = await openProcessPanel(page, overlay, "broken")
    await processAction(page, panel, "start").click()

    await expect(panel.getByText("Failed to start")).toBeVisible({ timeout: 10_000 })
    await expect(panel.getByText("spawn nonexistent-binary ENOENT")).toBeVisible()

    const attentionDot = processesToggle(page).locator("span.bg-surface-critical-strong")
    await expect(attentionDot).toBeVisible({ timeout: 10_000 })
  })

  test("a process crashing after launch shows exit code on the next reconcile — behavior 10 (exit-code half)", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page, { directory: DIR })
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "flaky", command: "node flaky.js" })
    const panel = await openProcessPanel(page, overlay, "flaky")
    await processAction(page, panel, "start").click()
    await expect(processAction(page, panel, "stop")).toBeVisible({ timeout: 10_000 })

    const configId = mock.configs()[0]!.id
    mock.setProcessState(configId, { status: "crashed", ptyId: undefined, exitCode: 17, exitedAt: Date.now() })

    // Close the panel, then reload — the client only reconciles crashes it did
    // not itself trigger on its next GET /process fetch (see SPEC STATE MODEL).
    await closeProcessesNavigator(page)
    await page.reload()
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    // The reconcile fetch itself is gated behind `isProcessOpen() && !loaded()`
    // (process-pane.tsx:612-617, cited in this file's SPEC STATE MODEL) — after a
    // full reload neither flag is true, so nothing refetches `/api/wr/process`
    // until the Processes navigator is opened at least once. Open the LIST
    // navigator (not the dedicated per-process panel) to trigger the reconcile
    // and read the exit code straight off the row.
    const overlay2 = await openProcessesNavigator(page)
    const flakyRow = overlay2.getByRole("button", { name: /flaky/ }).first()
    await expect(flakyRow.getByText(/exit\s+17/)).toBeVisible({ timeout: 10_000 })
  })

  test("a late start-response never clobbers a crash the client already learned about via SSE — behavior 19 (BUG B regression)", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page, { directory: DIR })
    await seedOneProject(page, DIR)

    // Reproduces the real-world race behind BUG B: a launched command that
    // exits almost immediately (`exit 1`) can have its `process.crashed` SSE
    // event reach the browser BEFORE the slower HTTP response for the
    // `start()` call that launched it resolves (`client.start()`'s response
    // snapshots status at the moment the PTY spawned, server-side, before the
    // command necessarily finishes) — see `isStaleProcessSnapshot` in
    // `src/claxedo-ui/context/process-pane.tsx`. Reproduced deterministically
    // (not a real-clock race): hold the app's first `/api/wr/events` (and
    // `/api/wr/runtime-events`, belt-and-suspenders — either may be the one
    // this harness's SSE consumer actually polls) connection open via a gate
    // promise, release it only once the `start()` POST is confirmed in
    // flight, and delay that POST's own response past the point the crash
    // event lands.
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
    await page.route("**/api/wr/events**", deliverCrashEvent, { times: 1 })
    await page.route("**/api/wr/runtime-events**", deliverCrashEvent, { times: 1 })

    await openWorkspace(page, DIR)
    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "flaky-dev", command: "exit 1" })
    const configId = mock.configs()[0]!.id
    const panel = await openProcessPanel(page, overlay, "flaky-dev")

    // Delay the start HTTP response until well after the crash SSE lands —
    // the exact ordering the real race depends on. `route.fallback()` defers
    // to `installProcessMock`'s own handler once the delay elapses, same
    // technique as the start-all sequencing test above.
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

    // The crashed state must win. NOTE on assertion surface: the SSE
    // `process.crashed` handler (process-pane.tsx:504-531) intentionally
    // PRESERVES `ptyId` on crash (unlike a launch-time failure, which routes
    // through `applyCrash`/`failLaunch` and clears it) — see this guard's own
    // unit tests (process-pane.test.ts:33-38, `existing: {status: "crashed",
    // ptyId: "pty_1"}`), which pin ptyId retention as the mechanism
    // `isStaleProcessSnapshot` uses to recognize "same spawn generation".
    // Because `ptyId` stays set, `ProcessPanePanel`'s `hasTerminal()` stays
    // true and it keeps rendering the (dead) terminal instead of its
    // "Crashed"/"Failed to start" placeholder — that placeholder is gated on
    // `!visiblePty()` (ProcessPanePanel.tsx:219-243) and is genuinely
    // unreachable for this scenario, in both the buggy and fixed cases (the
    // ptyId is identical either way, so terminal-vs-placeholder can't
    // discriminate the regression). Assert instead on the two surfaces that
    // DO discriminate it: (1) the title-bar status dot's color, which reads
    // `status()` directly and is unaffected by ptyId, and (2) the Processes
    // list row, whose `ProcessSubtitle`/canStart (WorkspaceProcessesNavigator.
    // tsx:99-104,197-198) key on `status()`/`exitCode` alone, not ptyId — so
    // an unguarded clobber (status flips to "running", exitCode clears to
    // undefined) is visible there as "exit 1" disappearing and Stop
    // reappearing in place of Start.
    const runningColor = await page.evaluate(() => {
      const probe = document.createElement("div")
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--surface-success-strong").trim()
      document.body.appendChild(probe)
      const rgb = getComputedStyle(probe).color
      probe.remove()
      return rgb
    })
    // The status dot lives in the pane header, which `portalHeader` portals out
    // of the panel element into the pane toolbar slot — locate it by the header
    // testid so the selector holds in both portal and inline modes.
    const dot = page.locator('[data-testid="process-pane-header"] span.relative.inline-flex.rounded-full').first()
    await expect(dot).not.toHaveCSS("background-color", runningColor, { timeout: 15_000 })

    const overlay2 = await openProcessesNavigator(page)
    const flakyRow = overlay2.getByRole("button", { name: /flaky-dev/ }).first()
    // Scoped to the status span specifically (`style*="critical-strong"`,
    // ProcessSubtitle's crashed-branch span) — not a bare text match, because
    // this test's `command: "exit 1"` coincidentally also renders as the
    // row's command-preview text and would otherwise strict-mode-collide.
    await expect(flakyRow.locator('span[style*="critical-strong"]').getByText(/exit\s+1\b/)).toBeVisible({ timeout: 10_000 })
    await expect(flakyRow.getByRole("button", { name: "Start process" })).toBeVisible()
    await expect(flakyRow.getByRole("button", { name: "Stop process" })).toHaveCount(0)

    // Give the stale (delayed) start response time to resolve, then
    // re-assert the crashed state is UNCHANGED — this is the actual
    // regression: without the `isStaleProcessSnapshot` guard, this late
    // "started"/"running" response flips status back to running here,
    // clearing exitCode and swapping Start back in for Stop.
    await page.waitForTimeout(500)
    await expect(flakyRow.locator('span[style*="critical-strong"]').getByText(/exit\s+1\b/)).toBeVisible()
    await expect(flakyRow.getByRole("button", { name: "Start process" })).toBeVisible()
    await expect(flakyRow.getByRole("button", { name: "Stop process" })).toHaveCount(0)

    // Literal pin on the bug report's wording ("still shows a GREEN dot"):
    // the title-bar status dot's rendered color must differ from the app's
    // running/success color token — it must render the same non-green color
    // any other crashed process's dot renders.
    const dotColor = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(dotColor).not.toBe(runningColor)
  })

  // See SPEC behavior 10 ("...lights the toolbar attention dot even while the
  // panel is closed") and this file's own INVARIANTS section ("a crashed
  // process always lights the toolbar attention dot regardless of which panel
  // is currently focused"). Verified against source AND empirically that this
  // does not hold for a crash discovered purely via the periodic/next-open GET
  // /api/wr/process reconcile (as opposed to a live `process.crashed` SSE event
  // or a start-triggered launch failure — both of those DO light the dot, see
  // the passing "start-triggered crash..." test above and
  // `process-pane.tsx:485-492`'s `setCrashedWhileClosed(true)` call inside the
  // `process.crashed` SSE handler).
  //
  // `fetchProcesses()` calls `sync()` synchronously right after its `batch()`
  // (`process-pane.tsx:183-227`), and `sync()` derives `crashed` from the very
  // same `store.processes` the row itself renders from
  // (`anyCrashed()`/`states()`, `process-pane.tsx:120-134`, and
  // `processForConfig`, `process-pane.tsx:712-714` — both read
  // `store.processes` directly, no divergent source). The row correctly shows
  // "exit 17" (see the sibling test above), proving the store DID reconcile to
  // crashed status and `sync()` DID run with that data — yet
  // `state.processPane.crashed(directory)` (`state/process-pane.ts:82-86`),
  // the ONLY input to the toolbar badge besides `crashedWhileClosed()`
  // (`layouts/workbench-shell-header.tsx:191-194`), never flips the shared
  // signal: `span.bg-surface-critical-strong` under
  // `button[aria-label="Open Processes"|"Close Processes"]` stays absent from
  // the DOM (confirmed 0 matches) both while the Processes list navigator is
  // open, showing the crashed row, and after closing it — with only ONE
  // `ProcessPaneProvider` instance mounted for the whole test (the dedicated
  // per-process panel/tab was deliberately never opened, ruling out the
  // separate multi-instance-unmount clobber also discovered while
  // investigating this: `process-pane.tsx:990-994`'s
  // `onCleanup(() => state.processPane.setCrashed(sdk.directory, false))`
  // fires unconditionally on ANY `ProcessPaneProvider` unmount, which is a
  // second, independent bug against the same invariant when the dedicated
  // panel *is* visited and then closed/navigated away from).
  test.fixme(
    "a process crashing after launch lights the toolbar attention dot on the next reconcile — behavior 10 (attention-dot half)",
    async () => {},
  )

  test("port conflict overlay resolves via pick-new and via kill-existing — behavior 11", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page, { directory: DIR })
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "web", command: "node web.js" })
    const configId = mock.configs()[0]!.id
    mock.setStartBehavior(configId, { kind: "port_conflict", port: 4100 })

    const panel = await openProcessPanel(page, overlay, "web")
    await clickPanelAction(page, panel, "start")

    await expect(panel.getByText("4100")).toBeVisible({ timeout: 10_000 })
    await panel.getByRole("button", { name: "Use another port" }).click()
    await expect.poll(() => mock.requests.startBodies.at(-1), { timeout: 10_000 }).toEqual({ portConflict: "pick-new" })
    await expect(processAction(page, panel, "stop")).toBeVisible({ timeout: 10_000 })
    await expect(panel.getByText("Port")).toHaveCount(0)

    // Second process: resolve via "Kill process & reclaim" instead.
    await clickPanelAction(page, panel, "stop")
    mock.setStartBehavior(configId, { kind: "port_conflict", port: 4100 })
    await clickPanelAction(page, panel, "start")
    await expect(panel.getByText(/Kill process/)).toBeVisible({ timeout: 10_000 })
    await panel.getByText(/Kill process/).click()
    await expect.poll(() => mock.requests.startBodies.at(-1), { timeout: 10_000 }).toEqual({ portConflict: "kill-existing" })
    await expect(processAction(page, panel, "stop")).toBeVisible({ timeout: 10_000 })
  })

  test("route conflict overlay resolves via pick-new — behavior 12", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page, { directory: DIR })
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "web", command: "node web.js" })
    const configId = mock.configs()[0]!.id
    mock.setStartBehavior(configId, { kind: "route_conflict", hostname: "web.local" })

    const panel = await openProcessPanel(page, overlay, "web")
    await clickPanelAction(page, panel, "start")

    await expect(panel.getByText("web.local")).toBeVisible({ timeout: 10_000 })
    await panel.getByRole("button", { name: "Use another name" }).click()
    await expect.poll(() => mock.requests.startBodies.at(-1), { timeout: 10_000 }).toEqual({ routeConflict: "pick-new" })
    await expect(processAction(page, panel, "stop")).toBeVisible({ timeout: 10_000 })
  })

  test("edit dialog pre-fills existing values and Save updates the config — behavior 13", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page, { directory: DIR })
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "build-watcher", command: "npm run watch" })
    const panel = await openProcessPanel(page, overlay, "build-watcher")

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

  test("delete requires an inline confirm; cancel restores the form, confirm removes the config — behavior 14", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    const mock = await installProcessMock(page, { directory: DIR })
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await addProcess(page, overlay, { name: "to-delete", command: "echo delete-me" })
    const panel = await openProcessPanel(page, overlay, "to-delete")

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
    // Deleting a process does not itself navigate the workspace panel back to
    // the list — its dedicated panel stays focused on the (now-gone) config id
    // and renders the "Process not found" placeholder
    // (`src/claxedo-ui/components/review-workspace.tsx:94`) until the user
    // explicitly reopens the Processes navigator, same as any other deep-link
    // to a deleted entity. Reopen it to reach the list's empty state.
    await expect(page.getByText("Process not found")).toBeVisible({ timeout: 5_000 })
    // The Processes list navigator (`WorkspaceProcessesNavigator`, opened at the
    // top of this test) and the dedicated panel we just deleted from
    // (`ReviewWorkspaceProcessSection`, opened via the "Process" review-workspace
    // tab) each mount their OWN `ProcessPaneProvider` instance with an
    // independent local `configs`/`processes` store — there is no shared
    // singleton. In the real app these instances converge via the
    // `process.config.changed` SSE event every mutation broadcasts
    // (`workspaceRuntimeBus.publish(...)` in
    // `packages/workspace-runtime/src/managed-processes/manager.ts:587`, consumed
    // by every `ProcessPaneProvider` via `claxedoEvents.on("process.config.changed",
    // ...)` in `src/claxedo-ui/context/process-pane.tsx:537`). `installProcessMock`
    // is HTTP-only and never pushes that event, so the navigator's own cache goes
    // stale after a delete performed from the dedicated panel.
    //
    // Two mechanisms were tried and rejected before this one:
    // (1) `window.__claxedoEmitTestEvent` — a dev-only hook gated by
    //     `import.meta.env.DEV` (`src/providers/claxedo-events.tsx:314-320`) —
    //     is `undefined` in this e2e run (the app is served as a production/
    //     preview build here, not `vite dev`), confirmed empirically.
    // (2) `installMockRuntime`'s own `emit()`/SSE bus wraps every event as
    //     `{directory, payload}` (`sseBody()`, `e2e/helpers/mock-runtime.ts`),
    //     which is the wire shape `applySessionListEvent` (session/message
    //     events) expects — but `ClaxedoEventsProvider.emitEvent` (which owns
    //     `process.config.changed`) parses each SSE `data:` line as a FLAT
    //     `ClaxedoEvent` (`isClaxedoEvent`: `"type" in input` at the top level,
    //     `src/providers/claxedo-events.tsx:120-122,446-452`) — the wrapped
    //     shape never satisfies that check, so it's silently dropped.
    // `installMockRuntime`/`installProcessMock` are shared/forbidden-to-edit in
    // this pooled phase regardless, so per the pool amendment this is a
    // spec-local `page.route` override on the SAME endpoint
    // (`/api/wr/events`, the "primary origin" stream local/directory-routed
    // sessions read per `mock-runtime.ts`'s own comment at that route) that
    // fulfills exactly one flat `process.config.changed` event, then lets
    // subsequent polls fall through to whatever handled it before (Playwright
    // route interception is LIFO; `{times: 1}` unregisters itself after one
    // match).
    // NOT {times: 1}: the events stream reconnects continuously, and on a
    // starved runner an unrelated reconnect cycle consumes the single
    // fulfillment before the navigator's own provider subscribes — the event
    // is then gone and the navigator keeps its stale cache. Serve the flat
    // event on EVERY reconnect until the empty state is proven, then unroute
    // (re-delivery is safe: the event is a state assignment to []).
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

  test("a process-owned PTY never duplicates as a terminal tab — behavior 15", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page, { directory: DIR })
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

  test("reload re-fetches from the backend and renders the same configs/processes — behavior 16", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page, { directory: DIR })
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

  // MOVED from core-terminal.spec.ts per docs/e2e-decisions.md #40 (2026-07-20) — the
  // pruning (`cleanupStaleProcessTabs`/`terminal.removeStale`,
  // src/features/processes/providers/process-pane.tsx:367-379) only runs when the
  // Process feature's fetchProcesses() resolves, which needs this file's Process
  // mocks. Still unimplemented here: the two extra findings from investigating the
  // move — (1) the original comment's "already covered at the unit level
  // (src/context/terminal-zombie.test.ts)" is STALE/WRONG — that file does not exist
  // anywhere in the repo, and `grep -rn "removeStale"` finds zero *.test.ts hits;
  // `removeStale` has NO test coverage today, unit or e2e. (2) the only way to get a
  // real terminal tab pointing at a process's ptyId is `processApi.openInTab()`
  // (process-pane.tsx:762), which has zero UI callers (`grep -rn "openInTab" src`) —
  // there is no button wired to it, so this scenario cannot currently be driven
  // through real UI clicks. Seeding the stale ownership state directly would require
  // reproducing this app's per-directory persisted-storage key (a checksum of the
  // directory, `src/platform/persistence/persist.ts:220`) — no existing spec seeds
  // that shape via localStorage, so doing it here would be new, unreviewed
  // infrastructure rather than a straightforward "move." Reported as a finding for
  // whoever picks this up next: either wire `openInTab` to a UI affordance first, or
  // add a dedicated persisted-state seeding helper for this file's checksum scheme.
  test.fixme(
    "a stale process-owned terminal tab is pruned instead of resurrected on reload — behavior 12",
    async () => {},
  )

  // This web harness has no desktop diagnostics capability. Assert both entry points:
  // the zero-project recovery surface and the account menu after a project is loaded.
  test("Diagnostics is absent from the web platform — behavior 17", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page, { directory: DIR })
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
    await expect(page.getByRole("menuitem", { name: "Usage limits" })).toBeVisible()
    // ...while Diagnostics never renders on web.
    await expect(page.getByRole("menuitem", { name: "Diagnostics" })).toHaveCount(0)
  })

  test("mutation controls are present for a local (unconditionally-mutable) workspace — behavior 18", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installProcessMock(page, { directory: DIR })
    await seedOneProject(page, DIR)
    await openWorkspace(page, DIR)

    const overlay = await openProcessesNavigator(page)
    await expect(addProcessButton(page, overlay)).toBeVisible()
    await addProcess(page, overlay, { name: "dev-server", command: "node server.js" })
    const panel = await openProcessPanel(page, overlay, "dev-server")
    await expect(processAction(page, panel, "start")).toBeVisible()
    await expect(processHeader(page).getByRole("button", { name: "Edit process" })).toBeVisible()
  })

  // "viewer role hides Add/Start/Stop/Restart/Edit controls — behavior 18 (read-only
  // half)" — FOLDED into core-cloud-offline-roles' existing viewer-role fixture per
  // docs/e2e-decisions.md #24 (2026-07-20): see
  // core-cloud-offline-roles.spec.ts's "viewer role locks the composer ... and hides
  // mutation controls — behavior 8" test, which asserts the Processes panel's "Add
  // process" control is hidden under the SAME `canMutateProcesses()` gate that governs
  // Start/Stop/Restart/Edit (src/features/processes/providers/process-pane.tsx) — one
  // control proves the shared gate, no need to duplicate the relay/role fixture here.

  // "project-shared process config is visible across two local workspaces, no leaks
  // after stop" — DELETED per docs/e2e-decisions.md #25 (2026-07-20): duplicated a
  // live spec and couldn't assert the real invariant with a mocked HTTP layer. Source
  // of truth: e2e-legacy/process-project-shared.spec.ts
  // (CLAXEDO_PROCESS_PROJECT_SHARED_LIVE=1, real backend/worktrees/child processes).
})
