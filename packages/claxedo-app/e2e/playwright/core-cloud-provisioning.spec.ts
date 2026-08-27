/**
 * SPEC: Cloud workspace provisioning
 *
 * PURPOSE — a "cloud" workspace has no local backing: its runtime is a sandbox VM
 * provisioned and reached through the Claxedo control plane + Workspace Relay. Before
 * that runtime is reachable, every workspace-scoped surface (session pane, composer,
 * terminal, Review panel) must show a startup pipeline instead of the real content, and
 * that pipeline must reflect the server's ACTUAL provisioning progress — including when
 * the browser reloads mid-provision. This spec owns that generic "landed on a
 * not-yet-ready cloud workspace" contract: the 4-step pipeline UI, composer unlock on
 * ready, one send through the relay (oracle), reload-resume, and the two create-failure
 * shapes. It does NOT own the create-workspace DIALOG's own in-dialog pipeline UI —
 * that was a separate component, `DialogCreateCloudWorkspace`, with its own
 * `PROVISION_PIPELINE` const, reachable only through the dead New-workspace Local/Cloud
 * picker; DELETED as dead code per docs/e2e-decisions.md #16 (2026-07-20).
 *
 * STATE MODEL — the SINGLE connection authority is `workspaceConnection` (in-memory
 * Solid store, `src/shell/workspace/workspace-connection.ts`), keyed by `workspaceId`,
 * ref-counted across mounted panes. `WorkspaceGate` (`src/shell/workspace/
 * workspace-gate.tsx`) is the ONE component wrapping the whole workspace surface
 * (`SessionPaneScope` → `WorkspaceGate`): while `connections[workspaceId].status !==
 * "ready"`, it renders `CloudStartupView` instead of children. The kind (`cloud` vs
 * `user-hosted` vs `local`) is resolved from the SIGNED PROJECT INVENTORY
 * (`queryOptions.projects()`, fed by `/api/claxedo/bootstrap`'s `project[].workspaces`
 * map) via `sessionWorkspaceRuntimeRef` — a `ws_...`-shaped directory with NO matching
 * inventory entry defaults to `"user-hosted"`, not `"cloud"` (see `session-workspace-
 * key.ts`), so the inventory must carry `{kind: "cloud"}` for this spec's workspace.
 * `acquireWorkspaceConnection` drives `prepareWorkspaceRuntime` (`src/cloud/runtime/
 * workspace-runtime-store.ts`): (1) `GET /api/workspace/resolve?workspaceId=` — if the
 * returned snapshot's `status` is not `"ready"`/`"failed"` (`pendingCloudRuntime`), the
 * step reported THERE becomes the pipeline's initial phase immediately (`onStatus`/
 * `onLog` fire synchronously with `workspace.status`) — this is the "resume at current
 * step" mechanism: the server's resolve response IS the source of truth, not a
 * client-held log. (2) it listens for `provision` events on the CENTRAL SSE stream
 * (`GET /api/wr/events`, event shape `{type:"provision", workspaceId, step, ts,
 * message?}` — `src/providers/claxedo-events.tsx`) for further step transitions. (3) it
 * calls `ensureWorkspaceRuntime` → `openWorkspaceConnection` (mint,
 * `GET /api/workspace/:id/connection`), which itself retries while the mint body is
 * `{status:"provisioning", retryAfterMs}` (`workspace-relay-connection.ts`); only once
 * mint succeeds does `driveConnection` call `setReady`, flipping the gate to children.
 * All of this state (`connections` store, in-flight mint promise) is IN-MEMORY JS state
 * — a page reload fully discards it and re-derives everything from the server's current
 * truth (the resolve endpoint's `status` field), which is exactly what proves the
 * "resumes at current step, not step 0" behavior. Separately, the SUBMIT-TIME "create a
 * brand-new cloud sandbox at first send" path (`src/components/prompt-input/submit.ts` →
 * `submit-directory.ts`'s `resolveCloudSessionDirectory`) is a DIFFERENT, ephemeral,
 * component-local pipeline (session.tsx's `gate` store, driven by the composer's
 * `onCloudStartup` callback) that runs entirely BEFORE any session is created or the URL
 * navigates — a reload during THIS phase abandons the whole submission (no resume
 * contract is claimed or tested for it); this spec only exercises its FAILURE path
 * (`POST /api/workspace/create` failing before any pipeline UI is ever shown).
 *
 * ANATOMY —
 *   `[data-component="cloud-startup-view"]` — the pipeline view root
 *     (`src/features/session/ui/components/cloud-startup-view.tsx`); a static
 *     `Workspace runtime` eyebrow (dev 8d1227e44's rebuild dropped the old
 *     `Workspace runtime / <step label>` breadcrumb), a 4-row step list (icon + label +
 *     duration), and a detail line that is now GENERIC ("The composer unlocks when the
 *     runtime is ready.") for a plain mid-pipeline step — it only becomes the step-
 *     specific `cloudSummary()` sentence on error or ready-handoff — so a mid-pipeline
 *     step is no longer provable from that line. Per-row testids still do not exist, but
 *     each row's icon slot does: `stepState()` renders `[data-icon="check-small"]` for a
 *     `"done"` step and nothing there for the active/pending ones, which is this spec's
 *     robust indicator of which step is CURRENT instead.
 *   `CLOUD_STARTUP_PIPELINE` (4 keys, in order): `acquiring_sandbox` ("Acquiring
 *     sandbox"), `cloning` ("Cloning repository"), `starting_runtime` ("Starting
 *     runtime"), `waiting_health` ("Waiting for health check"). A step is `"done"` (check
 *     icon) if an earlier step's log exists, `"active"` (spinner) if it is the latest
 *     logged step, `"pending"` (empty ring) otherwise, `"error"` (warning icon) if
 *     `hasError()` at the active index.
 *   `[data-testid="workspace-access-denied"]` / `[data-testid="workspace-offline"]` —
 *     terminal gate states this spec does not own (403 / offline — `core-cloud-offline-
 *     roles`, spec 13).
 *   `[role="textbox"][aria-label*="Ask anything"]` — once `WorkspaceGate` renders
 *     children, the draft composer appears exactly like a local session (this spec's
 *     proof of "composer unlocks on ready").
 *   `[data-slot="toast-title"]` / `[data-slot="toast-description"]` — create-failure
 *     toast (`@opencode-ai/ui/toast`), title is the literal string
 *     `"Failed to create cloud workspace"` (hardcoded in `submit-directory.ts`, not
 *     translated) for BOTH failure shapes.
 *   The composer's new-session workspace picker (`session-new-design-view.tsx`) uses the
 *     `[data-slot="context-chip-environment"]` popover trigger over
 *     `[data-slot="list-item"][data-key="local"|"cloud"]` rows. Picking "cloud" on a
 *     project with zero existing cloud workspaces auto-selects "Create new"
 *     (`creatingWorkspace` in `session-new-workspace-options.ts`), showing "New cloud
 *     sandbox".
 *
 * BEHAVIORS —
 *   1. Landing on a cloud workspace whose runtime is not yet ready renders the 4-step
 *      pipeline (`CloudStartupView`) instead of the session/composer surface.
 *   2. Once the runtime becomes ready (mint succeeds), the gate unlocks: the pipeline
 *      view disappears and the draft composer becomes reachable/editable.
 *   3. A prompt sent through the now-ready cloud workspace dispatches through the
 *      workspace-scoped relay lane (`/workspaces/:id/...`) and the oracle proves the
 *      reply renders (DOM + geometric + evidence).
 *   4. Sending that prompt creates exactly one session with exactly one user + one
 *      assistant row (no duplication).
 *   5. Reloading the page while the workspace is mid-provisioning (server-reported step
 *      is NOT the first pipeline step) re-renders the pipeline at that SAME step, not
 *      reset to `acquiring_sandbox` — proven via every earlier step's row reading `done`
 *      (check icon) and the reported step's row not, before and after reload.
 *   6. A cloud-workspace CREATE failure — either the create request being rejected
 *      (`POST /api/workspace/create` non-2xx, causing `createCloudWorkspace` to throw)
 *      or succeeding with `200` but a body missing `workspaceId` — shows the
 *      "Failed to create cloud workspace" toast, never opens the pipeline overlay
 *      (`gate.open`/`onCloudStartup` is never invoked on this path), creates zero
 *      sessions, and leaves the composer's typed text untouched. Both shapes fire
 *      EXACTLY ONE toast: `resolveCloudSessionDirectory` in
 *      `src/features/session/composer/ui/submit-directory.ts` sets a `creationRejected`
 *      flag inside its `.catch()` and returns on it, so a thrown create no longer falls
 *      through into the `!createdWorkspace?.workspaceId` branch and double-toasts. (The
 *      double-toast was a real bug; it is fixed, and the count assertion in the
 *      "request rejected" test is the regression guard.)
 *
 * INVARIANTS — completed assistant content is never hidden by stale busy state (#2 in
 *   e2e/INVARIANTS.md, exercised via the oracle in behavior 3/4); harness ownership (#1)
 *   is fixed to `opencode` throughout — the full cloud harness matrix is
 *   `core-harness-ownership-cloud` (spec 12). This spec's own invariant: the pipeline's
 *   displayed step is DERIVED FROM SERVER STATE (the resolve endpoint's `status` field
 *   and `provision` SSE events), never from client-side assumptions about how
 *   provisioning "should" progress — a reload must never regress the displayed step.
 *
 * HARNESS NOTES — none; harness stays `opencode` (default, no config-options harness) so
 *   the pipeline/relay-routing contract stays isolated from harness selection concerns.
 *
 * OUT OF SCOPE — the create-workspace DIALOG's own pipeline/timeout/retry-banner UI
 *   (`core-workspace-lifecycle`, spec 18); harness ownership over the relay
 *   (`core-harness-ownership-cloud`, spec 12); relay offline/403/viewer-role behavior
 *   (`core-cloud-offline-roles`, spec 13); user-hosted's 3-step connect pipeline
 *   (`core-user-hosted-workspace`, spec 14).
 */
import { isWorkspaceResolvePath } from "../helpers/contracts/workspace-resolve"
import { isSessionListPath } from "../helpers/contracts/session-list"
import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { expectAssistantReplyVisible, expectTurnCounts, SELECTORS } from "../helpers/turn-oracle"
import { installMockRuntime, providerCatalogIndex } from "../helpers/mock-runtime"
import { stampTestAuth } from "../playwright-global-setup"
import {
  assertSessionConfigPatchResponse,
  parseSessionConfigPatch,
  SESSION_CONFIG_PATCH_SUCCESS_STATUS,
} from "../helpers/contracts/session-config"

const DIR = "/tmp/e2e-core-cloud-provisioning"
const PROJECT_ID = "proj_core_cloud_provisioning"
const WORKSPACE_ID = "ws_core_cloud_provisioning"
const SESSION_ID = "ses_core_cloud_provisioning"
// Real, versioned, servable house-model id — NOT the bare "big-pickle", which
// the app reserves as the non-selectable pre-provisioning placeholder
// (`signed-workspace-model.ts`); serving that exact id as the only model leaves
// the composer stuck on "Select model". Display name stays "Big Pickle".
const BIG_PICKLE = { id: "big-pickle-1", name: "Big Pickle" }

type PipelineStep = "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready"

// Bare row labels (`CLOUD_STARTUP_PIPELINE` in cloud-startup-view.tsx) — the
// detail line no longer restates these as a `{label} before the composer
// unlocks.` sentence (dev 8d1227e44), so the row text itself is what a spec
// asserts against now.
const STEP_LABEL: Record<Exclude<PipelineStep, "ready">, string> = {
  acquiring_sandbox: "Acquiring sandbox",
  cloning: "Cloning repository",
  starting_runtime: "Starting runtime",
  waiting_health: "Waiting for health check",
}

// The pipeline row for `label`: its icon slot carries `[data-icon="check-
// small"]` once `stepState()` marks that row `"done"`, nothing while it is
// active/pending. `.filter({hasText})` scoped to `span` (never `div`) so it
// resolves to the row's own label span, not any ancestor whose aggregate text
// also happens to contain it — the live-log strip below the pipeline can echo
// the CURRENT step's own label verbatim (`latestLog()` falls back to
// `cloudStep(last.step)` when the log has no custom message), so callers
// should only use labels for steps that are NOT the one under test at that
// moment (bound it from its done/not-done neighbours instead, as behavior 5
// does below).
function stepRow(view: Locator, label: string) {
  return view.locator("span").filter({ hasText: label }).locator("xpath=..")
}

async function expectStepDone(view: Locator, label: string) {
  const row = stepRow(view, label)
  await expect(row).toHaveCount(1)
  await expect(row.locator('[data-icon="check-small"]')).toHaveCount(1)
}

async function expectStepNotDone(view: Locator, label: string) {
  const row = stepRow(view, label)
  await expect(row).toHaveCount(1)
  await expect(row.locator('[data-icon="check-small"]')).toHaveCount(0)
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Switch the empty-draft composer's canonical environment chip to "cloud" and
// prove the selected value is reflected by the trigger.
async function selectCloudEnvironment(page: Page) {
  const trigger = page.locator('[data-slot="context-chip-environment"]').filter({ visible: true })
  await expect(trigger).toHaveCount(1, { timeout: 20_000 })
  await trigger.click()
  const row = page.locator('[data-slot="list-item"][data-key="cloud"]').filter({ visible: true })
  await expect(row).toHaveCount(1, { timeout: 20_000 })
  await expect(row).toContainText("Cloud")
  await row.click()
  await expect(trigger).toContainText("Cloud", { timeout: 10_000 })
}

function api(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr"
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return []
      if (!("type" in part) || part.type !== "text") return []
      if (!("text" in part) || typeof (part as { text?: unknown }).text === "undefined") return []
      return [(part as { text: string }).text]
    })
    .join("\n")
    .trim()
}

// Cursor-resumed SSE event log, matching e2e/helpers/mock-runtime.ts's EventBus:
// every concurrent reader receives each event in order and reconnects with its
// own Last-Event-ID. Duplicated here because mock-runtime.ts's cloud/relay
// support does not model the `/api/wr/events` central provision stream or the
// `/workspaces/:id/...` proxy lane this spec needs.
class Bus<T> {
  private log: Array<{ id: number; payload: T }> = []
  private sequence = 0
  private waiters: Array<() => void> = []
  emit(payload: T) {
    this.sequence += 1
    this.log.push({ id: this.sequence, payload })
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }
  private async waitForPending(idleTimeoutMs: number, cursor: number) {
    if (this.sequence > cursor) return
    await Promise.race([new Promise<void>((resolve) => this.waiters.push(resolve)), wait(idleTimeoutMs)])
  }
  async drain(idleTimeoutMs: number, cursor = 0) {
    await this.waitForPending(idleTimeoutMs, cursor)
    return this.log.filter((entry) => entry.id > cursor)
  }
}

function lastEventId(route: Route) {
  const value = Number(route.request().headers()["last-event-id"])
  return Number.isFinite(value) && value > 0 ? value : 0
}

function eventStream<T>(events: Array<{ id: number; payload: T }>) {
  if (events.length === 0) return ": heartbeat\n\n"
  return events.map((event) => `id: ${event.id}\ndata: ${JSON.stringify(event.payload)}\n\n`).join("")
}

async function seedCloudProject(page: Page, opts: { registerWorkspace: boolean }) {
  await page.addInitScript(
    (input: { dir: string; projectId: string; workspaceId: string; registerWorkspace: boolean }) => {
      localStorage.clear()
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: window.location.origin,
        activeDirectory: input.dir,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: { local: [{ worktree: input.dir, expanded: true, sandboxes: input.registerWorkspace ? [input.workspaceId] : [] }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    },
    { dir: DIR, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, registerWorkspace: opts.registerWorkspace },
  )
}

/**
 * Installs the FULL cloud-workspace mock: bootstrap/project inventory (with or without
 * the workspace pre-registered as `kind: "cloud"`), workspace create, resolve, mint
 * (connection), the central `provision` SSE stream, and the `/workspaces/:id/...`
 * runtime proxy lane (session/prompt/message/config/capabilities + the supporting
 * agent/provider/mcp/lsp/vcs/command/permission/question/todo/event endpoints) needed to
 * complete one full turn once the workspace is ready.
 */
async function installCloudRuntimeMock(
  page: Page,
  opts: {
    /** Whether the project inventory already carries the workspace (kind: cloud). */
    registerWorkspace: boolean
    /** Initial `/api/workspace/resolve` step. Ignored if the workspace isn't registered yet. */
    initialStep?: PipelineStep
    /** Auto-advance acquiring_sandbox -> cloning -> starting_runtime -> waiting_health -> ready over real ticks. */
    autoAdvance?: boolean
  },
) {
  let workspaceRegistered = opts.registerWorkspace
  let currentStep: PipelineStep = opts.initialStep ?? "acquiring_sandbox"
  const provisionBus = new Bus<Record<string, unknown>>()
  const sessionBus = new Bus<Record<string, unknown>>()
  let sessionCreated = false
  let sessionBusy = false
  let messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
  let promptCount = 0
  const requests = { createSessionCount: 0, promptCount: 0, workspaceCreateCount: 0 }

  const providerCatalog = () => ({
    all: [{ id: "opencode", name: "opencode", env: [], models: { [BIG_PICKLE.id]: { id: BIG_PICKLE.id, name: BIG_PICKLE.name, release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } }],
    default: { opencode: BIG_PICKLE.id },
    connected: ["opencode"],
  })
  const sessionConfig = () => ({
    harness: { id: "opencode", access: "native" },
    model: { providerID: "opencode", modelID: BIG_PICKLE.id },
    agent: "build",
  })
  const sessionRow = () => ({
    id: SESSION_ID,
    slug: SESSION_ID,
    projectID: PROJECT_ID,
    directory: WORKSPACE_ID,
    title: textOf(messages[0]?.parts) || "",
    version: "2",
    time: { created: 1, updated: Date.now() },
    summary: { additions: 0, deletions: 0, files: 0 },
    config: sessionConfig(),
  })

  const emitProvision = (step: Exclude<PipelineStep, "ready">, message?: string) =>
    provisionBus.emit({ type: "provision", workspaceId: WORKSPACE_ID, step, message, ts: Date.now() })

  const projectRow = () => ({
    id: PROJECT_ID,
    worktree: DIR,
    name: "core-cloud-provisioning",
    sandboxes: workspaceRegistered ? [WORKSPACE_ID] : [],
    workspaces: workspaceRegistered
      ? { [WORKSPACE_ID]: { id: WORKSPACE_ID, kind: "cloud", workspace_name: "main", directory: WORKSPACE_ID } }
      : {},
  })

  // Auto-advance is triggered LAZILY, on the first real `/api/workspace/resolve`
  // hit for this workspace (below), not at install time. The page can take a
  // while to actually reach that request under load (cold Vite module
  // transforms, shared dev server contention) — starting the timer at install
  // time would let the workspace reach "ready" before the app ever observes
  // the earlier steps, making behavior 1 (the pipeline actually rendering)
  // unobservable/flaky.
  let advanceStarted = false
  function startAutoAdvance() {
    if (!opts.autoAdvance || advanceStarted) return
    advanceStarted = true
    void (async () => {
      for (const step of ["cloning", "starting_runtime", "waiting_health"] as const) {
        await wait(150)
        currentStep = step
        emitProvision(step)
      }
      await wait(150)
      currentStep = "ready"
    })()
  }

  await page.route("**/*", async (route) => {
    if (!api(route)) return route.continue()
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    // Let real Clerk network calls through unmocked. The dev server backing
    // this suite (`vite preview`, a built production bundle) reports
    // `import.meta.env.DEV === false`, which short-circuits `testAuth()`'s
    // very first guard in `src/utils/auth-client.ts` (`if (!import.meta.env.DEV
    // && import.meta.env.MODE !== "test") return {}`) BEFORE it ever reaches
    // the `navigator.webdriver` auto-bypass check — so the webdriver-detection
    // escape hatch this suite otherwise relies on never engages here, and
    // `initClaxedo` (VITE_AUTH_ENABLED=true in .env.local) really does call
    // `initializeClerk()`. Catching this spec's own catch-all 598 on Clerk's
    // `dev_browser`/`client` endpoints breaks Clerk's SDK init with "ClerkJS:
    // Something went wrong initializing Clerk in development mode.", which the
    // central events stream then surfaces as a stream failure — unrelated to
    // this spec's own mocked surface, and the real Clerk dev sandbox
    // (VITE_CLERK_PUBLISHABLE_KEY in .env.local) answers these harmlessly over
    // real network, so let them through rather than intercepting.
    if (url.hostname.endsWith(".clerk.accounts.dev") || url.hostname.endsWith(".clerk.com")) return route.continue()

    // ---- Central Claxedo event bus (pty/provision/lifecycle events) ----
    if (url.pathname === "/api/wr/events") {
      const batch = await provisionBus.drain(4000, lastEventId(route))
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: eventStream(batch) }).catch(() => {})
      return
    }

    // ---- Bootstrap / project inventory ----
    if (url.pathname === "/api/claxedo/bootstrap") {
      return json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
        project: [projectRow()],
        provider: providerCatalogIndex(providerCatalog()),
        provider_auth: {},
        config: { provider: { id: "opencode", model: BIG_PICKLE.id }, agent: { id: "build" } },
      })
    }
    if (url.pathname === "/provider") return json(route, providerCatalog())
    if (url.pathname === "/provider/auth") return json(route, {})
    if (url.pathname === "/path") return json(route, { worktree: DIR })
    if (url.pathname === "/config") return json(route, { provider: { id: "opencode", model: BIG_PICKLE.id }, agent: { id: "build" } })
    // The ConnectionGate polls the claxedo health endpoint; a 598 here reads as
    // "server unreachable" and gates the whole app behind the error screen.
    if (url.pathname === "/health" || url.pathname === "/global/health" || url.pathname === "/api/claxedo/health") {
      return json(route, { healthy: true, ok: true, version: "1.0.0-test" })
    }
    if (url.pathname === "/project" || url.pathname === "/experimental/project") return json(route, [projectRow()])
    if (/^\/project\/[^/]+$/.test(url.pathname)) return json(route, projectRow())
    if (url.pathname === "/agent" || url.pathname === "/app/agents") return json(route, [{ id: "build", name: "build", description: "Build agent" }])
    if (url.pathname === "/mcp") return json(route, {})
    if (url.pathname === "/lsp") return json(route, [])
    if (url.pathname === "/vcs") return json(route, {})
    if (url.pathname === "/command") return json(route, [{ name: "build", description: "Build command" }])
    if (url.pathname === "/permission") return json(route, [])
    if (url.pathname === "/question") return json(route, [])
    if (isWorkspaceResolvePath(url.pathname) && url.searchParams.get("workspaceId") !== WORKSPACE_ID) {
      return json(route, { workspaceId: `local:${PROJECT_ID}`, directory: DIR, kind: "local", status: "ready" })
    }
    if (url.pathname === "/global/event" || url.pathname === "/event") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n` }).catch(() => {})
    }

    // ---- Control-plane session catalog (sidebar list; separate from the
    // /workspaces/:id/session CRUD lane above — a signed-control-plane cloud
    // workspace's sidebar reads THIS, not the runtime's own /session list) ----
    if (isSessionListPath(url.pathname)) {
      const rows = sessionCreated
        ? [{
            type: "session",
            sessionRef: `workspace:${WORKSPACE_ID}:session:${SESSION_ID}`,
            sessionId: SESSION_ID,
            title: textOf(messages[0]?.parts) || "",
            directory: WORKSPACE_ID,
            workspaceId: WORKSPACE_ID,
            projectId: PROJECT_ID,
            createdAt: 1,
            updatedAt: 2,
            tags: [],
            attachments: [],
            harness: { type: "opencode", model: BIG_PICKLE.id, status: "ready", ready: true },
          }]
        : []
      return json(route, {
        view: { scope: url.searchParams.get("scope") ?? "workspace", groupBy: url.searchParams.get("groupBy") ?? "none", sort: "updated_desc", limit: Number(url.searchParams.get("limit") ?? "5") },
        items: rows,
        totalKnown: rows.length,
      })
    }
    if (/^\/api\/control\/sessions$/.test(url.pathname)) {
      return json(route, {
        sessions: sessionCreated
          ? [{ session_id: SESSION_ID, title: textOf(messages[0]?.parts) || "", created_at: 1, updated_at: 2, harness: { type: "opencode", model: BIG_PICKLE.id, status: "ready", ready: true } }]
          : [],
      })
    }
    if (url.pathname === `/api/control/sessions/${SESSION_ID}/capabilities`) {
      return json(route, { transport: "opencode", abort: true, reconnect: true, replay: true, permissions: true, questions: true, todos: true, commands: true, fork: true, revert: true, unrevert: true, configOptions: false })
    }
    if (url.pathname === `/api/control/sessions/${SESSION_ID}/messages`) return json(route, { messages })
    if (url.pathname === `/api/control/sessions/${SESSION_ID}/gateway`) return json(route, { gatewayUrl: null })
    if (
      url.pathname === `/api/control/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/register` ||
      url.pathname === `/api/control/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/checkpoint`
    ) {
      return json(route, { ok: true })
    }
    if (url.pathname === "/api/workspace") {
      const access = url.searchParams.get("access")
      if (access === "cloud") {
        return json(route, { workspaces: workspaceRegistered ? [{ workspace_id: WORKSPACE_ID, project_id: PROJECT_ID, backing: "cloud-vm", access: "cloud", display_name: "core-cloud-provisioning" }] : [] })
      }
      return json(route, { workspaces: [] })
    }

    // ---- Workspace create (submit-time first-ever sandbox) ----
    if (url.pathname === "/api/workspace/create" && method === "POST") {
      requests.workspaceCreateCount += 1
      workspaceRegistered = true
      currentStep = "acquiring_sandbox"
      return json(route, { workspaceId: WORKSPACE_ID, directory: WORKSPACE_ID, projectId: PROJECT_ID, provider: "modal", status: "acquiring_sandbox" })
    }

    // ---- Workspace resolve (provisioning progress, polled repeatedly) ----
    if (isWorkspaceResolvePath(url.pathname) && url.searchParams.get("workspaceId") === WORKSPACE_ID) {
      startAutoAdvance()
      return json(route, {
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        directory: WORKSPACE_ID,
        kind: "cloud",
        status: currentStep,
      })
    }

    // ---- Connection mint (provisioning until currentStep === "ready") ----
    if (url.pathname === `/api/workspace/${WORKSPACE_ID}/connection` || url.pathname === `/api/workspace/${WORKSPACE_ID}/connection/refresh`) {
      if (currentStep !== "ready") return json(route, { status: "provisioning", retryAfterMs: 500 })
      return json(route, {
        access: "cloud",
        backing: "cloud-vm",
        workspaceId: WORKSPACE_ID,
        role: "owner",
        relayUrl: url.origin,
        runtimeAccessToken: "rat_core_cloud_provisioning",
        tokenExpiresAt: Date.now() + 120_000,
      })
    }

    // ---- Workspace runtime lane, proxied through /workspaces/:id/... ----
    const prefix = `/workspaces/${WORKSPACE_ID}`
    if (url.pathname.startsWith(prefix)) {
      const runtimePath = url.pathname.slice(prefix.length) || "/"

      if (runtimePath === "/vcs") return json(route, {})
      if (runtimePath === "/mcp") return json(route, {})
      if (runtimePath === "/lsp") return json(route, [])
      if (runtimePath === "/agent") return json(route, [{ id: "build", name: "build", description: "Build agent", mode: "primary" }])
      if (runtimePath === "/command") return json(route, [])
      if (runtimePath === "/permission") return json(route, [])
      if (runtimePath === "/question") return json(route, [])
      if (runtimePath === "/provider") {
        return json(route, providerCatalog())
      }
      if (runtimePath === "/api/wr/health") return json(route, { healthy: true })
      if (runtimePath === "/api/wr/harness-config-options") {
        return json(route, { source: "runner", stale: false, options: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: BIG_PICKLE.id, selectOptions: [BIG_PICKLE] }] })
      }
      // Session-scoped event channels all carry the same cursor-resumed turn log.
      // The app subscribes to whichever channel its transport resolves.
      if (runtimePath === "/api/wr/events" || runtimePath === "/api/claxedo/runtime-events" || runtimePath === "/api/wr/runtime-events" || runtimePath === "/global/event" || runtimePath === "/event") {
        const batch = await sessionBus.drain(4000, lastEventId(route))
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: eventStream(batch) }).catch(() => {})
      }
      if (runtimePath === "/session/status") {
        return json(route, sessionCreated && sessionBusy ? { [SESSION_ID]: { type: "busy" } } : {})
      }
      // Draft-submit worktree admission (`prepareWorkspaceSessionWorktree`): a
      // cloud draft's first turn admits a session worktree before prompt_async.
      // `path` becomes the session directory — keep it the workspace ref so every
      // other handler in this lane stays keyed on WORKSPACE_ID.
      if (runtimePath === "/api/wr/worktrees" && method === "POST") {
        return json(route, { worktree: { path: WORKSPACE_ID, branch: "main", baseCommit: "e2e-base-commit" } })
      }
      if (runtimePath === "/api/wr/process" || runtimePath === "/api/claxedo/process") {
        if (method === "GET") return json(route, { configs: [], processes: [] })
        return json(route, { error: "read-only runtime token" }, 403)
      }
      if (runtimePath === "/session" && method === "POST") {
        requests.createSessionCount += 1
        sessionCreated = true
        messages = []
        return json(route, sessionRow())
      }
      if (runtimePath === "/session") return json(route, sessionCreated ? [sessionRow()] : [])
      if (/^\/session\/[^/]+$/.test(runtimePath)) return json(route, sessionRow())
      if (/^\/session\/[^/]+\/config$/.test(runtimePath)) {
        if (method === "GET") return json(route, sessionConfig())
        parseSessionConfigPatch(request.postDataJSON(), request.url())
        const saved = sessionConfig()
        assertSessionConfigPatchResponse(saved, request.url())
        return json(route, saved, SESSION_CONFIG_PATCH_SUCCESS_STATUS)
      }
      if (/^\/session\/[^/]+\/capabilities$/.test(runtimePath)) {
        return json(route, { transport: "opencode", abort: true, reconnect: true, replay: true, permissions: true, questions: true, todos: true, commands: true, fork: true, revert: true, unrevert: true, configOptions: false })
      }
      if (/^\/session\/[^/]+\/todo$/.test(runtimePath)) return json(route, [])
      if (/^\/session\/[^/]+\/message$/.test(runtimePath)) return json(route, messages)
      if (/^\/session\/[^/]+\/prompt_async$/.test(runtimePath)) {
        promptCount += 1
        requests.promptCount += 1
        const body = request.postDataJSON() as { messageID?: string; parts?: unknown; agent?: string; model?: { providerID?: string; modelID?: string } }
        const text = textOf(body?.parts) || `cloud message ${promptCount}`
        const userID = body?.messageID || `msg_cloud_user_${promptCount}`
        const assistantID = `msg_cloud_assistant_${promptCount}`
        messages = [
          ...messages,
          { info: { id: userID, sessionID: SESSION_ID, role: "user", time: { created: Date.now() }, model: { providerID: "opencode", modelID: BIG_PICKLE.id } }, parts: [{ id: `${userID}_text`, sessionID: SESSION_ID, messageID: userID, type: "text", text }] },
        ]
        await route.fulfill({ status: 204, body: "" })

        void (async () => {
          await wait(20)
          sessionBusy = true
          sessionBus.emit({ directory: WORKSPACE_ID, payload: { type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "busy" } } } })
          await wait(40)
          const pendingInfo = { id: assistantID, sessionID: SESSION_ID, role: "assistant", time: { created: Date.now() }, parentID: userID, agent: "build", providerID: "opencode", modelID: BIG_PICKLE.id, mode: "code", path: { cwd: WORKSPACE_ID, root: WORKSPACE_ID }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
          messages = [...messages, { info: pendingInfo, parts: [] }]
          sessionBus.emit({ directory: WORKSPACE_ID, payload: { type: "message.updated", properties: { sessionID: SESSION_ID, info: pendingInfo } } })
          const fullText = `cloud ack ${promptCount}: ${text}`
          const midpoint = Math.max(1, Math.floor(fullText.length / 2))
          for (const chunk of [fullText.slice(0, midpoint), fullText.slice(midpoint)]) {
            await wait(20)
            sessionBus.emit({ directory: WORKSPACE_ID, payload: { type: "message.part.delta", properties: { sessionID: SESSION_ID, messageID: assistantID, partID: `${assistantID}_text`, field: "text", delta: chunk } } })
          }
          const finalPart = { id: `${assistantID}_text`, sessionID: SESSION_ID, messageID: assistantID, type: "text", text: fullText }
          messages = messages.map((row) => (row.info.id === assistantID ? { ...row, parts: [finalPart] } : row))
          sessionBus.emit({ directory: WORKSPACE_ID, payload: { type: "message.part.updated", properties: { sessionID: SESSION_ID, part: finalPart, time: Date.now() } } })
          await wait(40)
          const completedInfo = { ...pendingInfo, time: { ...pendingInfo.time, completed: Date.now() } }
          messages = messages.map((row) => (row.info.id === assistantID ? { ...row, info: completedInfo } : row))
          sessionBus.emit({ directory: WORKSPACE_ID, payload: { type: "message.updated", properties: { sessionID: SESSION_ID, info: completedInfo } } })
          await wait(30)
          sessionBusy = false
          sessionBus.emit({ directory: WORKSPACE_ID, payload: { type: "session.idle", properties: { sessionID: SESSION_ID } } })
        })()
        return
      }
      if (runtimePath === "/file" || runtimePath.startsWith("/file/")) return json(route, [])
      if (runtimePath === "/api/wr/diff/refs") return json(route, { branches: [], tags: [], recent: [] })
      if (runtimePath === "/api/wr/diff/targets") return json(route, {})
      if (runtimePath === "/api/wr/diff/vcs") return json(route, [])
      if (runtimePath.startsWith("/find")) return json(route, [])
      return json(route, { error: "unhandled cloud runtime path", path: runtimePath }, 599)
    }

    // The usage outbox beacon fires on every boot (installUsageOutboxWakeups);
    // an empty outbox syncs to zeros. Same contract mock-runtime serves.
    if (url.pathname === "/api/claxedo/usage/sync") {
      return json(route, { attempted: 0, delivered: 0, conflicts: 0, pending: 0 })
    }
    return json(route, { error: "unhandled request in core-cloud-provisioning mock", path: url.pathname }, 598)
  })

  return { requests, emitProvision, currentStep: () => currentStep }
}

function workspaceRoute(sessionId?: string) {
  return sessionId ? `/w/${encodeURIComponent(WORKSPACE_ID)}/session/${sessionId}` : `/w/${encodeURIComponent(WORKSPACE_ID)}/session`
}

test.describe("core cloud provisioning @core", () => {
  test("cloud workspace mid-provisioning renders the pipeline, unlocks on ready, and a send is proven by the oracle — behaviors 1,2,3,4", async ({ page }) => {
    // Shared dev server can be under heavy concurrent load from other agents'
    // spec runs; a cold cloud-workspace route transforms many ESM modules the
    // first time it's visited. Give this test headroom beyond the file's
    // default 60s budget (matches the pattern in core-busy-abort-errors.spec.ts).
    test.setTimeout(120_000)
    await installCloudRuntimeMock(page, { registerWorkspace: true, initialStep: "acquiring_sandbox", autoAdvance: true })
    await seedCloudProject(page, { registerWorkspace: true })

    // waitUntil: "domcontentloaded" (not the default "load") — the shared dev
    // server transforms hundreds of ESM modules on a cold first visit to this
    // route, and "load" would wait on all of them; the app itself only needs
    // the document parsed, matching what every other spec in this suite
    // already waits for right after goto.
    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 100_000 })
    await page.waitForLoadState("domcontentloaded")

    // Behavior 1: the 4-step pipeline renders instead of the session surface.
    await expect(page.locator('[data-component="cloud-startup-view"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)

    // Behavior 2: once the runtime is ready, the pipeline disappears and the
    // draft composer becomes reachable/editable.
    await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0, { timeout: 20_000 })
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(input).toBeVisible({ timeout: 20_000 })
    await expect(input).toHaveAttribute("contenteditable", "true")
    // The gate unlocking only proves the WORKSPACE connection is ready — the
    // draft's own provider/model catalog (a separate relay request, fired once
    // the gate renders children) can still be in flight for a moment after.
    // Sending before it resolves hits the composer's own (correct) "no-model"
    // submit block, which no-ops the click — wait for a real model to land in
    // the model control first, matching the pattern every other cloud spec
    // that sends a first turn already uses (e.g. core-harness-ownership-
    // cloud.spec.ts's `expectOnlyOpenCodeModelControl`).
    await expect(page.locator('[data-action="prompt-harness-model"]')).toContainText(/Big Pickle|big-pickle/i, { timeout: 20_000 })

    // Behavior 3/4: a send dispatches through the workspace-scoped relay lane
    // and the oracle proves the reply renders; exactly one user + one
    // assistant row.
    const promptText = "core cloud provisioning first turn"
    await input.click()
    await input.fill(promptText)
    await expect(input).toContainText(promptText, { timeout: 10_000 })
    await page.locator(SELECTORS.submitControl).last().click()

    await expectAssistantReplyVisible(page, `cloud ack 1: ${promptText}`)
    await expectTurnCounts(page, { user: 1, assistant: 1 })
  })

  test("reload mid-provisioning resumes at the current step, not step 0 — behavior 5", async ({ page }) => {
    // Shared dev server can be under heavy concurrent load from other agents'
    // spec runs; a cold cloud-workspace route transforms many ESM modules the
    // first time it's visited. Give this test headroom beyond the file's
    // default 60s budget (matches the pattern in core-busy-abort-errors.spec.ts).
    test.setTimeout(120_000)
    const mock = await installCloudRuntimeMock(page, { registerWorkspace: true, initialStep: "starting_runtime", autoAdvance: false })
    await seedCloudProject(page, { registerWorkspace: true })

    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 100_000 })
    await page.waitForLoadState("domcontentloaded")

    const view = page.locator('[data-component="cloud-startup-view"]')
    await expect(view).toBeVisible({ timeout: 20_000 })
    await expect(view).toContainText(STEP_LABEL.starting_runtime, { timeout: 20_000 })
    // Resumed AT starting_runtime, not step 0: the two earlier steps read
    // `done` (check icon) and the step after starting_runtime reads not-done —
    // together that brackets the active row to exactly index 2, matching the
    // mock's `initialStep`, without ever needing to read starting_runtime's
    // own row (ambiguous while it's current — see `stepRow`'s note).
    await expectStepDone(view, STEP_LABEL.acquiring_sandbox)
    await expectStepDone(view, STEP_LABEL.cloning)
    await expectStepNotDone(view, STEP_LABEL.waiting_health)
    expect(mock.currentStep()).toBe("starting_runtime")

    await page.reload({ waitUntil: "domcontentloaded", timeout: 100_000 })

    const viewAfterReload = page.locator('[data-component="cloud-startup-view"]')
    await expect(viewAfterReload).toBeVisible({ timeout: 20_000 })
    // Behavior 5: resumed at the SAME step the server reports, not reset to
    // "Acquiring sandbox" — the resolve response is server truth, and reload
    // fully discards client-held state, so this only holds if the app reads
    // that server truth on every fresh mount.
    await expect(viewAfterReload).toContainText(STEP_LABEL.starting_runtime, { timeout: 20_000 })
    await expectStepDone(viewAfterReload, STEP_LABEL.acquiring_sandbox)
    await expectStepDone(viewAfterReload, STEP_LABEL.cloning)
    await expectStepNotDone(viewAfterReload, STEP_LABEL.waiting_health)
  })

  // `resolveCloudSessionDirectory`
  // (src/features/session/composer/ui/submit-directory.ts) sets a
  // `creationRejected` flag inside the `.catch()` and `return`s immediately
  // afterward, so a rejected cloud-create fires exactly one toast instead of
  // falling through to the second `!createdWorkspace?.workspaceId` toast. The
  // toast-COUNT assertion below is that fix's regression guard.
  test(
    "cloud workspace create failure (request rejected) shows a toast, opens no pipeline, creates no session, and preserves composer text — behavior 6",
    async ({ page }) => {
      test.setTimeout(120_000)
      await stampTestAuth(page.context())
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID })
      await page.route("**/api/workspace/create", (route) => {
        if (route.request().method() !== "POST") return route.fallback()
        return route.fulfill({ status: 500, contentType: "text/plain", body: "workspace creation blew up" })
      })

      await page.addInitScript((dir: string) => {
        localStorage.clear()
        ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
          serverUrl: window.location.origin,
          activeDirectory: dir,
        }
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({ list: [], projects: { local: [{ worktree: dir, expanded: true, sandboxes: [] }] }, lastProject: {}, workspaceServer: {}, closedProjects: {} }),
        )
      }, DIR)

      await page.goto(`/${slug(DIR)}/session`, { waitUntil: "domcontentloaded", timeout: 100_000 })
      await page.waitForLoadState("domcontentloaded")
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

      await selectCloudEnvironment(page)
      await expect(page.getByText("New cloud sandbox", { exact: true })).toBeVisible({ timeout: 10_000 })

      const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
      await expect(input).toBeVisible({ timeout: 20_000 })
      // Switching the draft's environment to "cloud" re-resolves the provider/
      // model catalog for the (virtual, not-yet-created) cloud scope — sending
      // before that resolves hits the composer's own "no-model" submit block,
      // which no-ops the click before `resolveCloudSessionDirectory` (and thus
      // `createCloudWorkspace`) is ever reached, so the create-failure path
      // under test never fires at all. Wait for a real model first, matching
      // core-cloud-provisioning's other send scenarios.
      await expect(page.locator('[data-action="prompt-harness-model"]')).toContainText(/Big Pickle|big-pickle/i, { timeout: 20_000 })
      const promptText = "should not create a cloud vm"
      await input.click()
      await input.fill(promptText)
      await expect(input).toContainText(promptText, { timeout: 10_000 })
      await page.locator(SELECTORS.submitControl).last().click()

      // Exactly one toast — this used to also fail 2-for-1 on the double-toast
      // bug (see submit-directory.ts's `creationRejected` comment); now fixed.
      await expect(page.locator('[data-slot="toast-title"]')).toHaveCount(1, { timeout: 10_000 })
      await expect(page.locator('[data-slot="toast-title"]')).toContainText("Failed to create cloud workspace", { timeout: 10_000 })
      await expect(page.locator('[data-slot="toast-description"]')).toContainText("workspace creation blew up", { timeout: 10_000 })

      // No pipeline overlay ever opens on this path.
      await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)
      // No session created.
      expect(mock.requests.createSessionCount).toBe(0)
      // Composer text preserved exactly.
      await expect(input).toContainText(promptText)
    },
  )

  test("cloud workspace create failure (200 with missing workspaceId) shows the same toast and preserves composer text — behavior 6", async ({ page }) => {
    // Shared dev server can be under heavy concurrent load from other agents'
    // spec runs; a cold cloud-workspace route transforms many ESM modules the
    // first time it's visited. Give this test headroom beyond the file's
    // default 60s budget (matches the pattern in core-busy-abort-errors.spec.ts).
    test.setTimeout(120_000)
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID })
    await page.route("**/api/workspace/create", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })

    await page.addInitScript((dir: string) => {
      localStorage.clear()
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: window.location.origin,
        activeDirectory: dir,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ list: [], projects: { local: [{ worktree: dir, expanded: true, sandboxes: [] }] }, lastProject: {}, workspaceServer: {}, closedProjects: {} }),
      )
    }, DIR)

    await page.goto(`/${slug(DIR)}/session`, { waitUntil: "domcontentloaded", timeout: 100_000 })
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    await selectCloudEnvironment(page)
    await expect(page.getByText("New cloud sandbox", { exact: true })).toBeVisible({ timeout: 10_000 })

    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(input).toBeVisible({ timeout: 20_000 })
    // See the "request rejected" scenario above: the cloud-scope provider/model
    // catalog can still be resolving right after the environment switch, and
    // sending before it settles hits the composer's own "no-model" submit
    // block instead of ever reaching `createCloudWorkspace`.
    await expect(page.locator('[data-action="prompt-harness-model"]')).toContainText(/Big Pickle|big-pickle/i, { timeout: 20_000 })
    const promptText = "should not create a cloud vm either"
    await input.click()
    await input.fill(promptText)
    await expect(input).toContainText(promptText, { timeout: 10_000 })
    await page.locator(SELECTORS.submitControl).last().click()

    await expect(page.locator('[data-slot="toast-title"]')).toContainText("Failed to create cloud workspace", { timeout: 10_000 })
    await expect(page.locator('[data-slot="toast-description"]')).toContainText("Request failed", { timeout: 10_000 })

    await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)
    expect(mock.requests.createSessionCount).toBe(0)
    await expect(input).toContainText(promptText)
  })
})

/**
 * BEHAVIOR 7 — the hosted "New Project" dialog, end to end.
 *
 * WHY THIS LIVES HERE and not in `core-workspace-lifecycle`: that spec owns the
 * LOCAL `DialogSelectDirectory` branch of `handleNewProject`. The branch below is
 * the OTHER one — `platform === "web"` AND a non-loopback central transport — and
 * it was, in production on app.claxedo.com, completely unusable:
 *
 *   1. `DialogCreateCloudProject`'s onMount calls `GET /api/workspace/drivers`,
 *      a route that exists ONLY on the local control plane
 *      (`sandbox-driver-routes.ts`, mounted by the local `WorkspaceRoutes`). On
 *      hosted it 404s, the `.catch` set `provider("")`, and the submit button
 *      was gated on `provider()` — so "Clone & Open" was disabled forever and NO
 *      cloud project could be created at all.
 *   2. The repository picker rendered only when `repositories().length > 0` and
 *      the dialog carried no "Connect GitHub" action, so a user with no
 *      connection had no way forward from inside the flow.
 *   3. Hosted device/OAuth connect could not complete server-side: the hosted
 *      connections service is built PER REQUEST with no shared attempt store, so
 *      `GET /attempts/:state` always answered `attempt_not_found` (fixed by
 *      `convex/connectionAttempts.ts`; the mock below stands in for that route's
 *      now-durable behavior).
 *   4. The device `userCode` was dropped by the connect flow, leaving the user on
 *      github.com/login/device with no code to type.
 *
 * TRANSPORT — `window.__CLAXEDO_E2E_SERVER_URL__` (read by `resolveDefaultUrl()`
 * in `src/app/entry/app.tsx`, dev/e2e builds only) forces a NON-loopback default
 * server, which is what makes `centralTransportForServer() !== "loopback"` and so
 * routes `handleNewProject` down the cloud branch. Requests still resolve to this
 * origin's mocks because every route glob below is origin-agnostic.
 *
 * INVARIANTS — no turn is sent here, so the assistant-reply oracle
 * (`e2e/INVARIANTS.md` rule "every send uses expectAssistantReplyVisible") does
 * not apply: this spec ends at workspace creation, and its proof obligation is the
 * `POST /api/workspace/create` body plus the provisioning pipeline appearing.
 */
const HOSTED_SERVER_URL = "https://cloud.example.test"

const GITHUB_INTEGRATION = {
  id: "github",
  name: "GitHub",
  methods: ["oauth", "key"],
  capabilities: ["code-host", "work-source"],
}

const CONNECTED_REPOSITORY = {
  id: "repo_1",
  name: "app",
  fullName: "acme/app",
  private: true,
  permissions: { read: true, write: true },
}

/**
 * The `/api/claxedo/integrations` family, as a hosted user walks it.
 *
 * Starts with NO connection. `POST /github/connect` answers a device grant
 * carrying a `userCode`; the first `GET /attempts/:state` is `pending` and the
 * second is `complete` — which is exactly the two-request sequence the old
 * in-memory attempt store could not survive, since each hosted request built its
 * own empty Map. After completion the listing reports a live connection and the
 * repository list becomes non-empty.
 */
async function installIntegrationsMock(page: Page) {
  const state = { connected: false, attemptPolls: 0, connectBodies: [] as unknown[] }

  await page.route("**/api/claxedo/integrations**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^.*\/api\/claxedo\/integrations/, "")

    if (path.endsWith("/connect") && request.method() === "POST") {
      state.connectBodies.push(request.postDataJSON?.() ?? undefined)
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          url: "https://github.com/login/device",
          attemptId: "attempt_1",
          userCode: "WDJB-MJHT",
          intervalMs: 100,
        }),
      })
    }

    if (path.startsWith("/attempts/")) {
      state.attemptPolls += 1
      // First poll pending, then complete — proves the attempt SURVIVED the
      // request that created it, which is the whole point of the durable store.
      const status = state.attemptPolls >= 2 ? "complete" : "pending"
      if (status === "complete") state.connected = true
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status, integrationId: "github", scope: "team" }),
      })
    }

    if (path.endsWith("/repositories")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ repositories: state.connected ? [CONNECTED_REPOSITORY] : [] }),
      })
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        integrations: [GITHUB_INTEGRATION],
        connections: state.connected
          ? [{
              id: "connection-1",
              integrationId: "github",
              scope: "team",
              grantedCapabilities: ["code-host"],
              fields: {},
              status: "connected",
              createdAt: 1,
              updatedAt: 1,
            }]
          : [],
        personalScopeEnabled: false,
      }),
    })
  })

  return state
}

test.describe("core cloud project creation on a hosted control plane @core", () => {
  test(
    "New Project connects GitHub with a visible device code, lists the repo, and creates the workspace — behavior 7",
    async ({ page }) => {
      test.setTimeout(120_000)
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID })
      const integrations = await installIntegrationsMock(page)

      // This is a hosted account before its first project exists. Do not leave
      // installMockRuntime's default local-worktree row in the signed hosted
      // inventory: a local row has no cloud/user-hosted workspace kind and the
      // real signed runtime contract correctly rejects it. Empty inventory is
      // the authoritative pre-create state this flow starts from.
      await page.route("**/api/claxedo/bootstrap**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            healthy: true,
            version: "1.0.0-test",
            path: { state: "", config: "", worktree: "", directory: "", home: "/tmp" },
            project: [],
            provider: { all: [], default: {}, connected: [] },
            provider_auth: {},
            config: {},
          }),
        }),
      )
      await page.route("**/project**", (route) => {
        const type = route.request().resourceType()
        if (type !== "fetch" && type !== "xhr") return route.continue()
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
      })

      // The hosted control plane has no drivers route. This 404 is the exact
      // production condition that used to disable submit forever.
      await page.route("**/api/workspace/drivers**", (route) =>
        route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found" } }) }),
      )

      const createBodies: unknown[] = []
      await page.route("**/api/workspace/create", (route) => {
        if (route.request().method() !== "POST") return route.fallback()
        createBodies.push(route.request().postDataJSON?.() ?? undefined)
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            workspaceId: WORKSPACE_ID,
            projectId: PROJECT_ID,
            directory: `/workspaces/${WORKSPACE_ID}`,
            kind: "cloud",
            status: "acquiring_sandbox",
          }),
        })
      })

      await page.addInitScript((serverUrl: string) => {
        localStorage.clear()
        ;(window as typeof window & { __CLAXEDO_E2E_SERVER_URL__?: string }).__CLAXEDO_E2E_SERVER_URL__ = serverUrl
      }, HOSTED_SERVER_URL)

      await page.goto("/", { waitUntil: "domcontentloaded", timeout: 100_000 })
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

      await page.getByRole("button", { name: "New Project", exact: true }).first().click()

      // The cloud branch, not the local directory picker.
      await expect(page.locator('[data-slot="dialog-title"]')).toHaveText("New Cloud Project", { timeout: 20_000 })

      // Failure 1: with the drivers route absent the provider control is gone
      // entirely rather than rendering an empty, unsatisfiable <select>.
      await expect(page.getByText("Sandbox Provider")).toHaveCount(0)

      // Failure 2: zero connections used to render nothing actionable at all.
      const connect = page.getByRole("button", { name: "Connect GitHub" })
      await expect(connect).toBeVisible({ timeout: 20_000 })
      await page.screenshot({ path: "test-results/evidence/core-cloud-provisioning/connect-github-offer.png" })
      await connect.click()

      await expect(page.getByRole("button", { name: "Continue with OAuth" })).toBeVisible({ timeout: 20_000 })
      await page.getByRole("button", { name: "Continue with OAuth" }).click()

      // Failure 4: the code the user must type at github.com/login/device.
      await expect(page.getByTestId("device-user-code")).toHaveText("WDJB-MJHT", { timeout: 20_000 })
      // Evidence, per e2e/INVARIANTS.md: a passing text assertion does not prove
      // the code is legibly ON SCREEN, which is the entire point of showing it.
      await page.screenshot({ path: "test-results/evidence/core-cloud-provisioning/device-user-code.png" })

      // Failure 3: the attempt is polled across MORE THAN ONE request and
      // settles — the sequence the per-request in-memory store always 404'd.
      await expect
        .poll(() => integrations.attemptPolls, { timeout: 30_000 })
        .toBeGreaterThanOrEqual(2)
      await expect(page.getByTestId("device-user-code")).toHaveCount(0, { timeout: 20_000 })

      // Back on the create dialog, refreshed in place: the repo the new
      // connection exposes is now selectable.
      await expect(page.getByText("Connected GitHub repository")).toBeVisible({ timeout: 20_000 })
      const repoSelect = page.locator('[data-slot="dialog-title"]')
        .locator("xpath=ancestor::*[@data-dialog-layer]")
        .locator("select")
        .last()
      await repoSelect.selectOption("repo_1")

      const submit = page.getByRole("button", { name: "Clone & Open" })
      await expect(submit).toBeEnabled({ timeout: 20_000 })
      await page.screenshot({ path: "test-results/evidence/core-cloud-provisioning/repo-selected-submit-enabled.png" })
      await submit.click()

      await expect.poll(() => createBodies.length, { timeout: 30_000 }).toBe(1)
      const body = createBodies[0] as Record<string, unknown>
      // No `driver`: the hosted plane composes one from env, so the client must
      // not invent an empty string for it.
      expect(Object.keys(body)).not.toContain("driver")
      expect(body).toMatchObject({ connectionId: "connection-1", repo: { fullName: "acme/app" } })

      // The dialog hands off to its provisioning phase rather than silently
      // doing nothing — the user-visible proof the create actually landed.
      await expect(page.getByText("Provisioning cloud workspace...")).toBeVisible({ timeout: 20_000 })

      expect(integrations.connectBodies).toHaveLength(1)
      // The ONLY tolerated bad response is the drivers 404 this test installs on
      // purpose — that absent route IS the hosted condition under test. Anything
      // else escaping as a 4xx/5xx is a real finding.
      expect(mock.requests.badResponses.filter((entry) => !entry.includes("/api/workspace/drivers"))).toEqual([])
    },
  )
})
