/**
 * Workspace connection authority off the happy path: the offline and access-denied
 * surfaces, silent reconnect, the panel-local readiness overlay, and viewer-role
 * composer gating.
 *
 * Two structural facts the assertions below lean on:
 *   - `WorkspaceGate` renders `CloudStartupView` for BOTH `connecting` and
 *     `reconnecting`, so a reconnect swaps the whole main session pane out for the
 *     startup spinner. "Silent" recovery here means no error toast, not an undisturbed
 *     main pane.
 *   - `WorkspacePanelBody` deliberately bypasses that gate (`SessionPaneScope
 *     suppressConnectionGate`) and renders its own `workspace-review-pending` overlay
 *     off the same connection store, so the panel and the main pane can show different
 *     chrome for one workspace at one instant.
 *
 * Every workspace here is `cloud` or `user-hosted`; a `local` workspace is synthesized
 * ready immediately and exercises none of this.
 */
import { isWorkspaceResolvePath } from "../helpers/contracts/workspace-resolve"
import {
  isWorkspaceListPath,
  workspaceListResponse,
  type ControlPlaneWorkspaceRow,
} from "../helpers/contracts/workspace-list"
import { isSessionListPath } from "../helpers/contracts/session-list"
import { expect, test, type Page, type Route } from "@playwright/test"
import { stampTestAuth } from "../playwright-global-setup"

const RELAY_ORIGIN = "https://relay.core13.e2e.test"
const WORKSPACE_ID = "ws_core13_cloud"
const UH_WORKSPACE_ID = "ws_core13_uh"
const DIR = WORKSPACE_ID
const UH_DIR = `${DIR}/.claxedo/user-hosted/workspaces/${UH_WORKSPACE_ID}`
const PROJECT_ID = "proj_core13"

// Contention-tolerant ceiling for the reactive (re)connect state transitions —
// composer-ready, the startup overlay, and `data-review-workspace-ready`. These
// are driven synchronously by the `__claxedoConnections` escape hatch (no real
// reconnect backoff is waited on), so the ceiling never gates the happy path; it
// only absorbs reactive-update lag on a starved runner. Each assertion still
// awaits the actual state transition, so a genuinely broken transition still
// fails — the wider ceiling just outlasts the 10s expect default that a loaded
// box was blowing under runner contention.
const RECONNECT_STATE_TIMEOUT = 30_000

type RelayRole = "owner" | "admin" | "editor" | "viewer"

type MintResponse = { status: number; role?: RelayRole; tokenExpiresAt?: number }

type HarnessState = {
  cloudMint: MintResponse
  uhMint: MintResponse
  uhHealth: { status: number; body?: unknown }
  cloudRefreshRole?: RelayRole
  mintHits: string[]
  refreshHits: string[]
  promptAsyncHits: string[]
  console: string[]
  failed: string[]
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

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", headers: corsHeaders(), body: JSON.stringify(body) })
}

function sseEvent(input: unknown) {
  return `data: ${JSON.stringify(input)}\n\n`
}

function api(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr" || type === "eventsource" || route.request().method() === "OPTIONS"
}

function defaultHarnessState(): HarnessState {
  return {
    cloudMint: { status: 200, role: "owner" },
    uhMint: { status: 200, role: "owner" },
    uhHealth: { status: 200 },
    mintHits: [],
    refreshHits: [],
    promptAsyncHits: [],
    console: [],
    failed: [],
    unhandled: [],
  }
}

async function seed(page: Page) {
  await stampTestAuth(page.context())
  await page.addInitScript(
    (input: { directory: string; uhDirectory: string }) => {
      localStorage.clear()
      ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
        serverUrl: window.location.origin,
        activeDirectory: input.directory,
      }
      localStorage.setItem(
        "claxedo.global.dat:server",
        JSON.stringify({
          list: [],
          projects: { local: [{ worktree: input.directory, expanded: true }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    },
    { directory: DIR, uhDirectory: UH_DIR },
  )
}

/**
 * The two workspaces above, as the CONTROL PLANE lists them — the same workspaces
 * `bootstrapBody().project` declares, seen from the other side. `workspaceCatalogQuery`
 * folds the central's `/project` inventory together with `/api/workspace?access=...`,
 * and the shared `workspace_id` is what makes `mergeWorkspaceCatalog` recognise the two
 * sources as ONE workspace instead of listing each twice; `remote_directory` is the
 * host's own path and addresses nothing.
 */
function controlPlaneWorkspaceRows(): ControlPlaneWorkspaceRow[] {
  return [
    {
      workspace_id: WORKSPACE_ID,
      org_id: "org_core13",
      project_id: PROJECT_ID,
      display_name: "cloud",
      backing: "cloud-vm",
      placement: { directory: DIR },
      remote_directory: DIR,
      role: "owner",
    },
    {
      workspace_id: UH_WORKSPACE_ID,
      org_id: "org_core13",
      project_id: PROJECT_ID,
      display_name: "shared",
      backing: "local-worktree",
      placement: { host_enrollment_id: "enr_core13_host", directory: UH_DIR },
      remote_directory: UH_DIR,
      role: "owner",
      // Listing is not reachability: the host goes offline through the health probe.
      host_online: true,
    },
  ]
}

function bootstrapBody() {
  return {
    healthy: true,
    events: { hostAggregate: true },
    version: "1.0.0-test",
    path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
    project: [
      {
        id: PROJECT_ID,
        name: "core13",
        worktree: DIR,
        sandboxes: [DIR, UH_DIR],
        workspaces: {
          [DIR]: { id: WORKSPACE_ID, kind: "cloud", workspace_name: "cloud", directory: DIR },
          [UH_DIR]: { id: UH_WORKSPACE_ID, kind: "user-hosted", workspace_name: "shared", directory: UH_DIR },
        },
      },
    ],
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          env: [],
          models: {
            "big-pickle": {
              id: "big-pickle",
              name: "Big Pickle",
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
      default: { opencode: "big-pickle" },
      connected: ["opencode"],
    },
    provider_auth: { opencode: [{ type: "api", label: "API key" }] },
    config: { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } },
  }
}

function providerCatalog() {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        env: [],
        models: { "big-pickle": { id: "big-pickle", name: "Big Pickle", providerID: "opencode" } },
      },
    ],
    connected: ["opencode"],
    default: { opencode: "big-pickle" },
  }
}

function mintBody(workspaceId: string, kind: "cloud" | "user-hosted", mint: MintResponse) {
  return {
    backing: kind === "cloud" ? "cloud-vm" : "local-worktree",
    // A cloud sandbox delegates session authority to the control plane; the owner's
    // own daemon does not.
    sessionAuthority: kind === "cloud" ? "managed-private" : "local",
    workspaceId,
    role: mint.role ?? "owner",
    relayUrl: RELAY_ORIGIN,
    runtimeAccessToken: `rat_test_${mint.role ?? "owner"}`,
    tokenExpiresAt: mint.tokenExpiresAt ?? Date.now() + 120_000,
  }
}

/**
 * Every route reads the returned `state` live rather than snapshotting it at install
 * time, so mutating `state` between actions changes what the NEXT mint/refresh/health
 * call answers.
 */
async function installWorkspaceHarness(page: Page): Promise<HarnessState> {
  const state = defaultHarnessState()

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      state.console.push(`${message.type()}: ${message.text()}`)
  })
  page.on("pageerror", (error) => state.console.push(`pageerror: ${error.message}`))
  page.on("requestfailed", (request) => {
    state.failed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
  })
  // Every prompt_async request, whether or not a route answers it.
  page.on("request", (request) => {
    if (request.url().includes("prompt_async")) state.promptAsyncHits.push(request.url())
  })

  await page.route("**/*", async (route) => {
    if (!api(route)) return route.continue()
    const request = route.request()
    const url = new URL(request.url())

    // PostHog is outside this surface; the catch-all must not 598 it.
    if (url.hostname.endsWith("posthog.com")) {
      return route.continue()
    }

    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }

    // The icon sprite is fetch()ed but is a static asset; let the web server answer it.
    if (/sprite[^/]*\.svg$/.test(url.pathname)) return route.continue()

    if (url.pathname === "/api/claxedo/bootstrap") return json(route, bootstrapBody())
    // Unanswered, `client.project.list()` throws on this file's 598 sentinel and the
    // WHOLE sidebar catalog query fails, which leaves every pane without a resolved
    // workspace — no offline view, no access-denied view, no composer.
    if (url.pathname === "/project" || url.pathname === "/experimental/project") {
      return json(route, bootstrapBody().project)
    }
    if (url.pathname === "/project/current") return json(route, bootstrapBody().project[0])
    if (isWorkspaceListPath(url.pathname)) {
      return json(route, workspaceListResponse({
        access: url.searchParams.get("access"),
        workspaces: controlPlaneWorkspaceRows(),
      }))
    }
    // Boot-time central calls the app tolerates failing; answering them keeps the
    // unhandled ledger clean.
    if (url.pathname === "/api/claxedo/session") return json(route, { sessions: [] })
    if (url.pathname === "/api/claxedo/usage/sync")
      return json(route, { attempted: 0, delivered: 0, conflicts: 0, pending: 0 })
    // The app boot's `ConnectionGate` (src/app.tsx) polls `GET /api/claxedo/health`
    // (src/utils/server-health.ts's `checkServerHealth` -> `claxedoHealthUrl`), NOT
    // `/health` — a bare `/health`/`/global/health` match here left that request
    // unhandled (598), which `checkServerHealth` reads as unhealthy, which flips the
    // whole app into its permanent "Could not reach <server>" `ConnectionError`
    // screen (`[data-claxedo]` never renders).
    if (url.pathname === "/health" || url.pathname === "/global/health" || url.pathname === "/api/claxedo/health") {
      return json(route, { healthy: true, ok: true, version: "1.0.0-test" })
    }
    if (url.pathname === "/path") return json(route, { worktree: DIR })
    if (url.pathname === "/api/claxedo/agent-config/harness") {
      return json(route, { type: "opencode", model: "big-pickle", status: "ready", ready: true })
    }
    if (url.pathname.startsWith("/api/claxedo/agent-config/harness/")) return json(route, [])
    if (url.pathname === "/api/claxedo/agent-config/agents")
      return json(route, [{ id: "build", name: "build", mode: "primary" }])
    if (url.pathname === "/api/claxedo/agent-config/commands") return json(route, [])
    // The control plane's notice stream, opened on every signed page.
    if (url.pathname === "/api/cp/events") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: sseEvent({ type: "heartbeat" }),
      })
    }

    if (url.pathname === `/api/workspace/${WORKSPACE_ID}/connection`) {
      state.mintHits.push(WORKSPACE_ID)
      if (state.cloudMint.status !== 200) return json(route, { error: "mint failed" }, state.cloudMint.status)
      return json(route, mintBody(WORKSPACE_ID, "cloud", state.cloudMint))
    }
    if (url.pathname === `/api/workspace/${WORKSPACE_ID}/connection/refresh`) {
      state.refreshHits.push(WORKSPACE_ID)
      const role = state.cloudRefreshRole ?? state.cloudMint.role ?? "owner"
      return json(route, mintBody(WORKSPACE_ID, "cloud", { status: 200, role, tokenExpiresAt: Date.now() + 120_000 }))
    }
    if (url.pathname === `/api/workspace/${UH_WORKSPACE_ID}/connection`) {
      state.mintHits.push(UH_WORKSPACE_ID)
      if (state.uhMint.status !== 200) return json(route, { error: "mint failed" }, state.uhMint.status)
      return json(route, mintBody(UH_WORKSPACE_ID, "user-hosted", state.uhMint))
    }
    if (url.pathname === `/api/workspace/${UH_WORKSPACE_ID}/connection/refresh`) {
      state.refreshHits.push(UH_WORKSPACE_ID)
      return json(route, mintBody(UH_WORKSPACE_ID, "user-hosted", state.uhMint))
    }
    if (isWorkspaceResolvePath(url.pathname)) {
      const workspaceId = url.searchParams.get("workspaceId")
      const directory = url.searchParams.get("directory")
      const uh = workspaceId === UH_WORKSPACE_ID || directory === UH_DIR
      return json(route, {
        workspaceId: uh ? UH_WORKSPACE_ID : WORKSPACE_ID,
        directory: uh ? UH_DIR : DIR,
        kind: uh ? "user-hosted" : "cloud",
        status: "ready",
      })
    }
    if (url.pathname === "/api/control/sessions") return json(route, [])
    if (isSessionListPath(url.pathname)) return json(route, { sessions: [], nextCursor: null })
    if (url.pathname === "/api/claxedo/usage/sync") {
      return json(route, { attempted: 0, delivered: 0, conflicts: 0, pending: 0 })
    }

    // With the query persister installed eagerly, boot fires the signed
    // workspace inventory sync, the harness-scoped central
    // provider catalog, and the loopback-bridged global event stream before the
    // first navigation settles. `/api/workspace` failures are tolerated by the
    // app (`!res.ok -> []`), but the provider catalog and the events stream sit
    // on the session route's suspense path — a 598 there crashes the route into
    // the error boundary ("Something went wrong") before any assertion runs.
    if (url.pathname === "/api/workspace") return json(route, { workspaces: [] })
    if (url.pathname === "/provider") return json(route, providerCatalog())
    if (url.pathname === "/api/wr/events") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: sseEvent({ type: "heartbeat" }),
      })
    }
    // The workspace panel's lifecycle summary fetches its checkpoint snapshot via
    // `getDefaultBaseUrl()` (the window origin in this harness), not the relay.
    if (
      url.pathname === `/api/workspace/${WORKSPACE_ID}/checkpoints` ||
      url.pathname === `/api/workspace/${UH_WORKSPACE_ID}/checkpoints`
    ) {
      return json(route, { worktrees: [] })
    }

    // `workspace-runtime-request.ts`'s `runtimeFetch` (createWorkspaceRuntimeRequest)
    // special-cases `isLoopbackHttpUrl(serverUrl) && !preferRelayOnLoopback` (true
    // in this harness, since `getClaxedoServerUrl()` defaults to loopback
    // `http://127.0.0.1:3001` with no `VITE_CLAXEDO_SERVER_URL` configured) by
    // routing `prepareUserHostedRuntime`'s `/api/wr/health` poll through the
    // CENTRAL server's own origin (`${serverUrl}/workspaces/:id/api/wr/health`)
    // instead of `relayUrl` — a real "claxedo-server proxies the relay in local
    // dev" behavior, not a mock bug. Kept on its own handler (rather than the
    // per-workspace runtime bucket below) because its status drives the
    // user-hosted offline classification under test: a 598 here reads as a
    // non-transient failure and misclassifies as the generic "failed" reason
    // instead of "no-host". The rest of the loopback-routed runtime surface
    // (agent/vcs/provider/session/...) IS answered by the bucket below — the
    // app's boot and panel-mount suspense queries throw on a 598 body and crash
    // the route, so the bucket cannot be narrowed to the relay hostname.
    const loopbackHealthMatch = /^\/workspaces\/([^/]+)\/api\/wr\/health$/.exec(url.pathname)
    if (loopbackHealthMatch) {
      const workspaceId = loopbackHealthMatch[1]
      if (workspaceId === UH_WORKSPACE_ID && state.uhHealth.status !== 200) {
        return route.fulfill({
          status: state.uhHealth.status,
          headers: corsHeaders(),
          body: JSON.stringify(state.uhHealth.body ?? { error: { code: "user_hosted_app_offline" } }),
        })
      }
      return json(route, { healthy: true, version: "1.0.0-test" })
    }

    // Per-workspace runtime surface: relay origin AND loopback-bridged
    // central origin. `createWorkspaceRuntimeRequest` routes cloud/UH runtime
    // calls through `${serverUrl}/workspaces/:id/...` whenever the server URL is
    // loopback (always true in this harness), so the same path shape arrives on
    // 127.0.0.1:3001 as on RELAY_ORIGIN. These answers are load-bearing: the
    // session route's suspense queries (agent/provider/session) and the workspace
    // panel's mount fetches throw the raw body of any 598, which crashes the
    // route into the error boundary before a single assertion runs. The health
    // probe stays on its own narrower handler above (it drives the
    // user-hosted offline classification under test).
    const relayMatch = /^\/workspaces\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (relayMatch && (relayMatch[1] === WORKSPACE_ID || relayMatch[1] === UH_WORKSPACE_ID)) {
      const [, workspaceId, rest] = relayMatch
      const runtimePath = rest || "/"
      if (runtimePath === "/api/wr/health") {
        if (workspaceId === UH_WORKSPACE_ID && state.uhHealth.status !== 200) {
          return route.fulfill({
            status: state.uhHealth.status,
            headers: corsHeaders(),
            body: JSON.stringify(state.uhHealth.body ?? { error: { code: "user_hosted_app_offline" } }),
          })
        }
        return json(route, { healthy: true, version: "1.0.0-test" })
      }
      if (runtimePath === "/vcs") return json(route, { branch: "main", default_branch: "main" })
      if (runtimePath === "/mcp") return json(route, {})
      if (runtimePath === "/agent") return json(route, [{ id: "build", name: "build", mode: "primary" }])
      if (runtimePath === "/command") return json(route, [])
      if (runtimePath === "/file" || runtimePath.startsWith("/file/")) return json(route, [])
      if (runtimePath.startsWith("/find")) return json(route, [])
      if (runtimePath === "/provider") return json(route, providerCatalog())
      if (runtimePath === "/session" || runtimePath === "/experimental/session") return json(route, [])
      if (runtimePath === "/session/status") return json(route, {})
      if (runtimePath === "/permission" || runtimePath === "/question") return json(route, [])
      if (runtimePath === "/permission/modes") {
        return json(route, {
          modes: [],
          unsupported: "opencode has no permission modes of its own",
          appliesFrom: "next-turn",
        })
      }
      if (runtimePath === "/api/wr/events") {
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: corsHeaders(),
          body: sseEvent({ type: "heartbeat" }),
        })
      }
      if (runtimePath === "/api/wr/diff/refs" || runtimePath === "/api/claxedo/diff/refs")
        return json(route, { branches: ["main"], tags: [], recent: [] })
      if (runtimePath === "/api/wr/diff/targets") return json(route, { defaultRef: "main", candidates: ["main"] })
      if (runtimePath === "/api/wr/diff/vcs" || runtimePath === "/api/claxedo/diff/vcs") return json(route, [])
      if (runtimePath === "/api/wr/process" || runtimePath === "/api/claxedo/process") {
        if (request.method() === "GET") return json(route, { configs: [], processes: [] })
        // The UI hides this control for viewer/editor; the runtime must still refuse it.
        return json(route, { error: "read-only runtime token" }, 403)
      }
      state.unhandled.push(`${request.method()} ${url.href}`)
      return json(route, { error: "unexpected relay runtime path used in core-cloud-offline-roles mock" }, 598)
    }

    state.unhandled.push(`${request.method()} ${url.href}`)
    return json(route, { error: "unhandled request in core-cloud-offline-roles mock" }, 598)
  })

  return state
}

async function gotoDraft(page: Page, directory: string) {
  // `waitUntil: "domcontentloaded"` (not the default "load") matches the convention
  // other specs in this suite already use for resilience under load — the SPA never
  // needs cross-origin subresources (images/fonts) to finish for `[data-claxedo]` to
  // paint, and waiting for "load" needlessly risks the whole navigation timing out
  // under host contention.
  await page.goto(`/${slug(directory)}/session`, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

function debugSuffix(state: HarnessState) {
  return `\n\nunhandled:\n${state.unhandled.join("\n") || "(none)"}\n\nfailed:\n${state.failed.join("\n") || "(none)"}\n\nconsole:\n${state.console.join("\n") || "(none)"}`
}

// The editor's aria-label is its placeholder, which changes when role-blocked, so
// select by `data-component` rather than role name.
function composerEditor(page: Page) {
  return page.locator('[data-component="prompt-input"]').last()
}

async function waitForComposerReady(page: Page, state: HarnessState) {
  await expect(composerEditor(page), debugSuffix(state)).toBeVisible({ timeout: RECONNECT_STATE_TIMEOUT })
}

async function expectWorkspaceRole(page: Page, workspaceId: string, role: RelayRole) {
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const seam = (
            window as typeof window & {
              __claxedoConnections?: {
                snapshot?: () => Record<
                  string,
                  {
                    status?: string
                    rolePlacement?: { state?: string; role?: string }
                    relayPlacement?: { role?: string }
                  }
                >
              }
            }
          ).__claxedoConnections
          return seam?.snapshot?.()[id]
        }, workspaceId),
      { timeout: RECONNECT_STATE_TIMEOUT },
    )
    .toMatchObject({
      status: "ready",
      rolePlacement: { state: "role-known", role },
      relayPlacement: { role },
    })
}

async function openWorkspaceNavigator(page: Page, navigator: "Files" | "Changes" | "Processes") {
  const openPanel = page.getByRole("button", { name: "Open workspace panel", exact: true }).first()
  const control = page.locator(`button[aria-label="Open ${navigator}"], button[aria-label="Close ${navigator}"]`).last()
  await expect(openPanel.or(control).first()).toBeVisible({ timeout: 10_000 })
  if (await openPanel.isVisible()) await openPanel.click()
  await expect(control).toBeVisible({ timeout: 10_000 })
  if ((await control.getAttribute("aria-pressed")) !== "true") await control.click()
  await expect(control).toHaveAttribute("aria-pressed", "true")
}

const toasts = (page: Page) => page.locator('[data-component="toast"]')

test.describe("core cloud offline & roles @core", () => {
  // Sibling suites share this machine; every assertion polls DOM or network state, so
  // a longer ceiling only delays reporting a stuck state.
  test.describe.configure({ timeout: 120_000 })
  test("mint forbidden (403) renders the access-denied terminal view, never offline/connecting, single mint attempt", async ({
    page,
  }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    state.cloudMint = { status: 403 }

    await gotoDraft(page, DIR)

    await expect(page.getByTestId("workspace-access-denied"), debugSuffix(state)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("This workspace is not one of yours")).toBeVisible()
    await expect(page.getByTestId("workspace-offline")).toHaveCount(0)
    await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)
    await expect(page.getByTestId("workspace-offline-retry")).toHaveCount(0)

    // `forbidden` is terminal: give any debounced/effect-driven re-drive a beat, then
    // assert the mint fired exactly once rather than opening a retry storm.
    await page.waitForTimeout(1_500)
    expect(state.mintHits.filter((id) => id === WORKSPACE_ID)).toEqual([WORKSPACE_ID])
  })

  test("mint 503/500 renders the offline view with reason copy, not the connecting spinner, and Retry re-drives", async ({
    page,
  }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    state.cloudMint = { status: 503 }

    await gotoDraft(page, DIR)

    await expect(page.getByTestId("workspace-offline"), debugSuffix(state)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("Can't reach the workspace runtime")).toBeVisible()
    await expect(page.getByText(/temporarily unreachable/)).toBeVisible()
    await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)
    await expect(page.getByTestId("workspace-access-denied")).toHaveCount(0)

    const retry = page.getByTestId("workspace-offline-retry")
    await expect(retry).toBeVisible()

    state.cloudMint = { status: 200, role: "owner" }
    await retry.click()
    await waitForComposerReady(page, state)
    expect(state.mintHits.filter((id) => id === WORKSPACE_ID).length).toBeGreaterThanOrEqual(2)
  })

  test("mint 500 classifies as the generic failed reason with its own copy", async ({ page }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    state.cloudMint = { status: 500 }

    await gotoDraft(page, DIR)

    await expect(page.getByTestId("workspace-offline"), debugSuffix(state)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("Workspace failed to start")).toBeVisible()
    await expect(page.getByTestId("workspace-offline-retry")).toBeVisible()
  })

  test("user-hosted host-offline health probe renders the no-host offline copy", async ({ page }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    state.uhHealth = { status: 503, body: { error: { code: "user_hosted_app_offline" } } }

    await gotoDraft(page, UH_DIR)

    await expect(page.getByTestId("workspace-offline"), debugSuffix(state)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("Workspace host is offline")).toBeVisible()
    await expect(page.getByText(/claxedo up/)).toBeVisible()
    await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)
  })

  test("ready -> reconnecting -> ready never raises a toast and resumes without reload", async ({
    page,
  }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    state.cloudMint = { status: 200, role: "owner" }

    await gotoDraft(page, DIR)
    await waitForComposerReady(page, state)
    await expect(toasts(page)).toHaveCount(0)

    // The same transition a sustained event-stream drop causes, without starving the
    // SSE stream for the real cooldown.
    await page.evaluate((id) => {
      ;(
        window as typeof window & { __claxedoConnections?: { markReconnecting?: (id: string) => void } }
      ).__claxedoConnections?.markReconnecting?.(id)
    }, WORKSPACE_ID)

    // The overlay's arrival is also the settle window for any toast.
    await expect(page.locator('[data-component="cloud-startup-view"]'), debugSuffix(state)).toBeVisible({
      timeout: RECONNECT_STATE_TIMEOUT,
    })
    await expect(toasts(page)).toHaveCount(0)

    await page.evaluate((id) => {
      ;(
        window as typeof window & { __claxedoConnections?: { markReconnected?: (id: string) => void } }
      ).__claxedoConnections?.markReconnected?.(id)
    }, WORKSPACE_ID)

    await waitForComposerReady(page, state)
    await expect(toasts(page), debugSuffix(state)).toHaveCount(0)
  })

  test("workspace panel shows its own pending overlay, independent of the main-pane gate", async ({
    page,
  }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    // A failing mint never reaches ready, so the panel's own overlay stays up for the
    // whole test instead of racing a real connect to ready.
    state.cloudMint = { status: 503 }

    await gotoDraft(page, DIR)
    await openWorkspaceNavigator(page, "Files")

    const pending = page.locator('[data-testid="workspace-review-pending"]')
    await expect(pending, debugSuffix(state)).toBeVisible({ timeout: 15_000 })
    await expect(pending).toContainText("isn't available")
  })

  test("arm-once: ready content survives a same-key reconnect; the overlay reappears on top", async ({
    page,
  }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    state.cloudMint = { status: 200, role: "owner" }

    await gotoDraft(page, DIR)
    await waitForComposerReady(page, state)
    await openWorkspaceNavigator(page, "Changes")

    const reviewRegion = page.locator(`[data-review-workspace-id="${WORKSPACE_ID}"]`)
    // `reviewRegion` is the panel's OUTER wrapper (workspace-panel-body.tsx) — it is
    // gated only on `targetSessionId()`, never on connection readiness, so its own
    // presence is not proof of "arm-once". `review-pane-root` is `ReviewWorkspace`'s
    // OWN root element (review-workspace.tsx) — it only exists while that component
    // is actually mounted, which IS gated on `reviewArmed().armed`. This is the
    // selector that actually proves the armed subtree survives a reconnect instead of
    // being torn down and remounted.
    const reviewPaneRoot = page.locator('[data-testid="review-pane-root"]')
    await expect(reviewRegion, debugSuffix(state)).toHaveCount(1)
    await expect(reviewRegion).toHaveAttribute("data-review-workspace-ready", "true", {
      timeout: RECONNECT_STATE_TIMEOUT,
    })
    await expect(reviewPaneRoot, debugSuffix(state)).toHaveCount(1)
    await expect(page.locator('[data-testid="workspace-review-pending"]')).toHaveCount(0)

    // `markWorkspaceReconnecting` no-ops unless the store status is "ready", and the
    // DOM attribute can lead the store write, so drive until the snapshot agrees.
    await expect
      .poll(
        () =>
          page.evaluate((id) => {
            const seam = (
              window as typeof window & {
                __claxedoConnections?: {
                  markReconnecting?: (id: string) => void
                  snapshot?: () => Record<string, { status?: string }>
                }
              }
            ).__claxedoConnections
            seam?.markReconnecting?.(id)
            return seam?.snapshot?.()[id]?.status
          }, WORKSPACE_ID),
        { timeout: RECONNECT_STATE_TIMEOUT },
      )
      .toBe("reconnecting")

    await expect(reviewRegion, debugSuffix(state)).toHaveCount(1)
    await expect(reviewPaneRoot, debugSuffix(state)).toHaveCount(1)
    // The pending overlay legitimately reappears on top of the still-armed content
    // during the drop: `reviewRegionPolicy`'s `showPending` tracks readiness
    // independently of `armed`.
    await expect(page.locator('[data-testid="workspace-review-pending"]')).toBeVisible({
      timeout: RECONNECT_STATE_TIMEOUT,
    })

    await page.evaluate((id) => {
      ;(
        window as typeof window & { __claxedoConnections?: { markReconnected?: (id: string) => void } }
      ).__claxedoConnections?.markReconnected?.(id)
    }, WORKSPACE_ID)

    await expect(page.locator('[data-testid="workspace-review-pending"]')).toHaveCount(0, {
      timeout: RECONNECT_STATE_TIMEOUT,
    })
    await expect(reviewRegion, debugSuffix(state)).toHaveAttribute("data-review-workspace-ready", "true", {
      timeout: RECONNECT_STATE_TIMEOUT,
    })
    await expect(reviewPaneRoot, debugSuffix(state)).toHaveCount(1)
  })

  test("viewer role locks the composer (placeholder, disabled submit, blocked Enter) and hides mutation controls", async ({
    page,
  }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    state.cloudMint = { status: 200, role: "viewer" }

    await gotoDraft(page, DIR)
    await waitForComposerReady(page, state)
    await expectWorkspaceRole(page, WORKSPACE_ID, "viewer")

    const editor = composerEditor(page)
    await expect(editor).toHaveAttribute("aria-label", "Read-only workspace (viewer)")

    const submit = page.locator('[data-action="prompt-submit"]').last()
    await expect(submit).toBeDisabled()
    await expect(submit).toHaveAttribute("aria-label", "Read-only workspace")

    // A disabled button dispatches no click handler even when force-clicked.
    await submit.click({ force: true }).catch(() => {})
    expect(state.promptAsyncHits, debugSuffix(state)).toEqual([])

    // Enter-submit is blocked at the SAME `handleSubmit` handler, independent of the
    // button's `disabled` attribute: `submit-ui-state.ts` checks the authority block
    // first and preventDefaults before any submission work.
    await editor.click()
    await editor.fill("this should never send")
    await page.keyboard.press("Enter")
    await page.waitForTimeout(800)
    expect(state.promptAsyncHits, debugSuffix(state)).toEqual([])

    // "Add process" is gated on `mutate.workspace` (process-pane.tsx), which only
    // `owner`/`admin` hold — `editor` lacks it too. Its absence therefore pins the
    // workspace-mutation gate, not the viewer-vs-editor line the rest of this test does.
    await openWorkspaceNavigator(page, "Processes")
    await expect(page.getByRole("button", { name: "Add process" }), debugSuffix(state)).toHaveCount(0)
  })

  // `/connection/refresh` never fires from a loopback-served harness (runtime traffic
  // is bridged through the central server, not sent relay-direct), so the role flip is
  // driven through `markRole`, the same placement event a real refresh feeds.
  test("a role that live-flips (viewer -> editor) unlocks the composer in place, no reload", async ({
    page,
  }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    state.cloudMint = { status: 200, role: "viewer" }

    await gotoDraft(page, DIR)
    await waitForComposerReady(page, state)
    await expectWorkspaceRole(page, WORKSPACE_ID, "viewer")

    const editor = composerEditor(page)
    const submit = page.locator('[data-action="prompt-submit"]').last()

    await expect(editor, debugSuffix(state)).toHaveAttribute("aria-label", "Read-only workspace (viewer)")

    await page.evaluate((id) => {
      ;(
        window as typeof window & { __claxedoConnections?: { markRole?: (id: string, role: string) => void } }
      ).__claxedoConnections?.markRole?.(id, "editor")
    }, WORKSPACE_ID)

    await expect(editor, debugSuffix(state)).not.toHaveAttribute("aria-label", "Read-only workspace (viewer)", {
      timeout: RECONNECT_STATE_TIMEOUT,
    })
    await expect(submit, debugSuffix(state)).toBeEnabled({ timeout: RECONNECT_STATE_TIMEOUT })
    await expect(submit).not.toHaveAttribute("aria-label", "Read-only workspace")
  })
})
