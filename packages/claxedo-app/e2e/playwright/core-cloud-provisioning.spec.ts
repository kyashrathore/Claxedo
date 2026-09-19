/**
 * Cloud workspace provisioning: the startup pipeline, unlock on ready, one send through
 * the relay lane, reload-resume, create failures, and hosted-plane project creation.
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
 * picker; DELETED as dead code per e2e/e2e-decisions.md #16 (2026-07-20).
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
 * client-held log. (2) it listens for `provision` notices on the control plane's
 * stream (`GET /api/cp/events`, event shape `{type:"provision", workspaceId, step, ts,
 * message?}` — `src/app/integrations/claxedo-events.tsx`) for further step transitions. (3) it
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
 *     `"Failed to create cloud environment"` (hardcoded in `submit-directory.ts`, not
 *     translated) for BOTH failure shapes.
 *   The composer's new-session workspace picker (`session-new-design-view.tsx`) uses the
 *     `[data-slot="context-chip-environment"]` popover trigger over
 *     `[data-slot="list-item"][data-key="self"|"provisioner"]` rows. Picking the
 *     provisioner on a project with zero existing cloud workspaces auto-selects "Create new"
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
 *      "Failed to create cloud environment" toast, never opens the pipeline overlay
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
 *   is fixed to one configured connection throughout — the full cloud harness matrix is
 *   `core-harness-ownership-cloud` (spec 12). This spec's own invariant: the pipeline's
 *   displayed step is DERIVED FROM SERVER STATE (the resolve endpoint's `status` field
 *   and `provision` SSE events), never from client-side assumptions about how
 *   provisioning "should" progress — a reload must never regress the displayed step.
 *
 * HARNESS NOTES — the fixture publishes one generic connection with model options so
 *   the pipeline/relay-routing contract stays isolated from provider-specific behavior.
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
import {
  ensureComposerModelSelected,
  expectAssistantReplyVisible,
  expectTurnCounts,
  SELECTORS,
} from "../helpers/turn-oracle"
import { installMockRuntime, providerCatalogIndex } from "../helpers/mock-runtime"
import { stampTestAuth } from "../playwright-global-setup"
import { eventStream, lastEventId } from "../helpers/sse-route"
import {
  assertSessionConfigPatchResponse,
  parseSessionConfigPatch,
  SESSION_CONFIG_PATCH_SUCCESS_STATUS,
} from "../helpers/contracts/session-config"
import {
  isSessionRegistrationReservePath,
  parseSessionReservationRequest,
  sessionReservationResponse,
  sessionReservationStatus,
} from "../helpers/contracts/session-registration"

const DIR = "/tmp/e2e-core-cloud-provisioning"
const PROJECT_ID = "proj_core_cloud_provisioning"
const WORKSPACE_ID = "ws_core_cloud_provisioning"
const SESSION_ID = "ses_core_cloud_provisioning"
const CONNECTION_ID = "cloud-agent"
// A versioned id: the bare "big-pickle" is the non-selectable pre-provisioning
// placeholder and would leave the composer on "Select model".
const BIG_PICKLE = { id: "big-pickle-1", name: "Big Pickle" }

type PipelineStep = "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready"

const STEP_LABEL: Record<Exclude<PipelineStep, "ready">, string> = {
  acquiring_sandbox: "Acquiring sandbox",
  cloning: "Cloning repository",
  starting_runtime: "Starting runtime",
  waiting_health: "Waiting for health check",
}

// Scoped to `span` so it resolves to the row's label, not an ancestor. The live-log
// strip can echo the current step's label, so bound the current step from its
// neighbours rather than reading its own row.
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

async function selectCloudEnvironment(page: Page) {
  const trigger = page.locator('[data-slot="context-chip-environment"]').filter({ visible: true })
  await expect(trigger).toHaveCount(1, { timeout: 20_000 })
  await trigger.click()
  const row = page.locator('[data-slot="list-item"][data-key="provisioner"]').filter({ visible: true })
  await expect(row).toHaveCount(1, { timeout: 20_000 })
  await expect(row).toContainText("Cloud")
  await row.click()
  await expect(trigger).toContainText("Cloud", { timeout: 10_000 })
}

async function selectCloudAgentConnection(page: Page) {
  const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(control).toBeEnabled({ timeout: 30_000 })
  await control.click()
  const picker = page.locator('[data-component="harness-model-picker"]')
  await expect(picker).toBeVisible({ timeout: 15_000 })
  await picker.locator('[data-slot="harness-picker-section"]').first().click()
  const option = picker.getByRole("button", { name: /^Cloud agent$/ })
  await expect(option).toBeVisible({ timeout: 20_000 })
  await option.click()
  await page.keyboard.press("Escape")
  await expect(picker).toBeHidden({ timeout: 10_000 })
  await expect(control).toHaveAttribute("data-harness", CONNECTION_ID, { timeout: 20_000 })
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

// Cursor-resumed SSE event log: every reader gets each event in order and reconnects
// with its own Last-Event-ID. mock-runtime's cloud support does not model the control
// plane's provision notices or the `/workspaces/:id/...` lane.
class Bus<T> {
  private log: Array<{ id: number; payload: T }> = []
  private sequence = 0
  private waiters: Array<() => void> = []
  private subscribers = new Set<(batch: Array<{ id: number; payload: T }>) => void>()
  emit(payload: T) {
    this.sequence += 1
    const entry = { id: this.sequence, payload }
    this.log.push(entry)
    for (const subscriber of this.subscribers) subscriber([entry])
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }
  /** A persistent reader (a WebSocket): the backlog past `cursor` now, every later frame as it lands. */
  subscribe(cursor: number, receive: (batch: Array<{ id: number; payload: T }>) => void) {
    receive(this.log.filter((entry) => entry.id > cursor))
    this.subscribers.add(receive)
    return () => { this.subscribers.delete(receive) }
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

async function seedCloudProject(page: Page, opts: { registerWorkspace: boolean }) {
  await page.addInitScript(
    (input: { dir: string; projectId: string; workspaceId: string; registerWorkspace: boolean }) => {
      localStorage.clear()
      ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
        serverUrl: window.location.origin,
        activeDirectory: input.dir,
      }
      localStorage.setItem(
        "claxedo.global.dat:server",
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

async function installCloudRuntimeMock(
  page: Page,
  opts: {
    registerWorkspace: boolean
    /** Initial `/api/workspace/resolve` step. Ignored if the workspace isn't registered yet. */
    initialStep?: PipelineStep
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
    harness: { id: CONNECTION_ID, access: "connection" },
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

  // Advance starts on the first resolve hit, not at install: under load the page may
  // reach that request after an install-time timer had already finished. Each dwell
  // must outlast a warm first paint, or the pipeline is never observed.
  let advanceStarted = false
  function startAutoAdvance() {
    if (!opts.autoAdvance || advanceStarted) return
    advanceStarted = true
    void (async () => {
      for (const step of ["cloning", "starting_runtime", "waiting_health"] as const) {
        await wait(800)
        currentStep = step
        emitProvision(step)
      }
      await wait(800)
      currentStep = "ready"
    })()
  }

  // An unsigned loopback surface reads the control plane's notices over a
  // WebSocket; `provision` steps ride it.
  await page.routeWebSocket("**/api/cp/events**", (socket) => {
    const cursor = Number(new URL(socket.url()).searchParams.get("lastEventId") ?? 0)
    socket.send(`id: ${cursor}\ndata: {"type":"heartbeat"}\n\n`)
    const unsubscribe = provisionBus.subscribe(cursor, (batch) => {
      if (batch.length > 0) socket.send(eventStream(batch))
    })
    socket.onClose(unsubscribe)
  })

  await page.route("**/*", async (route) => {
    if (!api(route)) return route.continue()
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()

    if (url.pathname === "/api/claxedo/bootstrap") {
      return json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
        events: { hostAggregate: true },
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
    if (url.pathname === "/api/claxedo/agent-config/connections") {
      return json(route, {
        status: "supported",
        connections: [{
          connectionId: CONNECTION_ID,
          label: "Cloud agent",
          enabled: true,
          readiness: "ready",
          capabilities: {
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
            subagents: true,
          },
          modelSelection: { status: "optional" },
        }],
      })
    }
    if (url.pathname === "/api/claxedo/agent-config/harness") {
      const selection = { kind: "connection", connectionId: CONNECTION_ID }
      return json(route, {
        harness: selection,
        activeHarness: selection,
        model: BIG_PICKLE.id,
        modelProviderID: "opencode",
        status: "ready",
        ready: true,
      })
    }
    // Unanswered, the startup gate reads the server as unreachable.
    if (url.pathname === "/health" || url.pathname === "/global/health" || url.pathname === "/api/claxedo/health") {
      return json(route, { healthy: true, ok: true, version: "1.0.0-test" })
    }
    if (url.pathname === "/project" || url.pathname === "/experimental/project") return json(route, [projectRow()])
    if (/^\/project\/[^/]+$/.test(url.pathname)) return json(route, projectRow())
    if (url.pathname === "/agent") return json(route, [{ id: "build", name: "build", description: "Build agent" }])
    if (url.pathname === "/mcp") return json(route, {})
    if (url.pathname === "/vcs") return json(route, {})
    if (url.pathname === "/command") return json(route, [{ name: "build", description: "Build command" }])
    if (url.pathname === "/permission") return json(route, [])
    if (url.pathname === "/question") return json(route, [])
    if (isWorkspaceResolvePath(url.pathname) && url.searchParams.get("workspaceId") !== WORKSPACE_ID) {
      return json(route, { workspaceId: `local:${PROJECT_ID}`, directory: DIR, kind: "local", status: "ready" })
    }
    if (url.pathname === "/api/cp/events") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: `id: 0\ndata: ${JSON.stringify({ type: "heartbeat" })}\n\n` }).catch(() => {})
    }
    // The daemon's host aggregate — `/api/wr/events` naming no workspace — which
    // a loopback surface opens for its local runtimes. This spec's workspace is
    // cloud-backed and speaks on the relay-prefixed stream below, so the
    // aggregate has nothing to say here; left unanswered it would 598 on the
    // session route's suspense path.
    if (url.pathname === "/api/wr/events") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: `id: 0\ndata: ${JSON.stringify({ type: "heartbeat" })}\n\n` }).catch(() => {})
    }

    // ---- Control-plane session catalog: the sidebar reads this, not the runtime's
    // own /session list ----
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
        view: { scope: url.searchParams.get("scope") ?? "workspace", groupBy: url.searchParams.get("groupBy") ?? "none", sort: url.searchParams.get("sort") ?? "updated_desc", limit: Number(url.searchParams.get("limit") ?? "5") },
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
      return json(route, { transport: "runtime", abort: true, reconnect: true, replay: true, permissions: true, questions: true, todos: true, commands: true, fork: true, revert: true, unrevert: true, configOptions: false })
    }
    if (url.pathname === `/api/control/sessions/${SESSION_ID}/messages`) return json(route, { messages })
    if (url.pathname === `/api/control/sessions/${SESSION_ID}/gateway`) return json(route, { gatewayUrl: null })
    if (
      url.pathname === `/api/control/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/register` ||
      url.pathname === `/api/control/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/checkpoint`
    ) {
      return json(route, { ok: true })
    }
    // The reservation boundary crossed before the runtime create; unanswered, the send
    // aborts before any session exists.
    if (isSessionRegistrationReservePath(url.pathname) && method === "POST") {
      const reservation = parseSessionReservationRequest(request.postDataJSON?.() ?? undefined, request.url())
      const result = sessionReservationResponse(reservation)
      return json(route, result, sessionReservationStatus(result))
    }
    if (url.pathname === "/api/workspace") {
      const access = url.searchParams.get("access")
      if (access === "cloud") {
        return json(route, { workspaces: workspaceRegistered ? [{ workspace_id: WORKSPACE_ID, project_id: PROJECT_ID, backing: "cloud-vm", placement: {}, display_name: "core-cloud-provisioning" }] : [] })
      }
      return json(route, { workspaces: [] })
    }

    if (url.pathname === "/api/workspace/create" && method === "POST") {
      requests.workspaceCreateCount += 1
      workspaceRegistered = true
      currentStep = "acquiring_sandbox"
      return json(route, { workspaceId: WORKSPACE_ID, directory: WORKSPACE_ID, projectId: PROJECT_ID, provider: "modal", status: "acquiring_sandbox" })
    }

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

    if (url.pathname === `/api/workspace/${WORKSPACE_ID}/connection` || url.pathname === `/api/workspace/${WORKSPACE_ID}/connection/refresh`) {
      if (currentStep !== "ready") return json(route, { status: "provisioning", retryAfterMs: 500 })
      return json(route, {
        backing: "cloud-vm",
        // A provisioned sandbox delegates to the control plane's session authority, so
        // it serves session-scoped event streams only.
        sessionAuthority: "managed-private",
        workspaceId: WORKSPACE_ID,
        role: "owner",
        relayUrl: url.origin,
        runtimeAccessToken: "rat_core_cloud_provisioning",
        tokenExpiresAt: Date.now() + 120_000,
      })
    }

    const prefix = `/workspaces/${WORKSPACE_ID}`
    if (url.pathname.startsWith(prefix)) {
      const runtimePath = url.pathname.slice(prefix.length) || "/"

      if (runtimePath === "/vcs") return json(route, {})
      if (runtimePath === "/mcp") return json(route, {})
      if (runtimePath === "/agent") return json(route, [{ id: "build", name: "build", description: "Build agent", mode: "primary" }])
      if (runtimePath === "/command") return json(route, [])
      if (runtimePath === "/permission") return json(route, [])
      if (runtimePath === "/question") return json(route, [])
      if (runtimePath === "/provider") {
        return json(route, providerCatalog())
      }
      if (runtimePath === "/api/wr/health") return json(route, { healthy: true })
      if (runtimePath === "/api/wr/harness-config-options") {
        return json(route, { source: "harness", stale: false, options: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: BIG_PICKLE.id, selectOptions: [BIG_PICKLE] }] })
      }
      // The workspace's one stream carries the cursor-resumed turn log.
      if (runtimePath === "/api/wr/events") {
        const batch = await sessionBus.drain(4000, lastEventId(route))
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: eventStream(batch) }).catch(() => {})
      }
      // A harness without Goals answers "not implemented" with a null goal.
      if (/^\/session\/[^/]+\/goal\/state$/.test(runtimePath)) {
        return json(route, { capabilities: { implemented: false, available: false, actions: [] }, goal: null })
      }
      if (runtimePath === "/session/status") {
        return json(route, sessionCreated && sessionBusy ? { [SESSION_ID]: { type: "busy" } } : {})
      }
      // A cloud draft admits a session worktree before prompt_async; `path` becomes the
      // session directory, so keep it the workspace ref this lane is keyed on.
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
        return json(route, { transport: "runtime", abort: true, reconnect: true, replay: true, permissions: true, questions: true, todos: true, commands: true, fork: true, revert: true, unrevert: true, configOptions: false })
      }
      if (/^\/session\/[^/]+\/todo$/.test(runtimePath)) return json(route, [])
      // The real route answers a page envelope, never a bare array.
      if (/^\/session\/[^/]+\/message$/.test(runtimePath)) return json(route, { messages, maxEventOrdinal: 0 })
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

    // The usage outbox beacon fires on every boot.
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
  test("cloud workspace mid-provisioning renders the pipeline, unlocks on ready, and a send is proven by the oracle", async ({ page }) => {
    // A cold cloud-workspace route transforms many modules on a shared dev server.
    test.setTimeout(120_000)
    await installCloudRuntimeMock(page, { registerWorkspace: true, initialStep: "acquiring_sandbox", autoAdvance: true })
    await seedCloudProject(page, { registerWorkspace: true })

    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 100_000 })
    await page.waitForLoadState("domcontentloaded")

    await expect(page.locator('[data-component="cloud-startup-view"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)

    await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0, { timeout: 20_000 })
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(input).toBeVisible({ timeout: 20_000 })
    await expect(input).toHaveAttribute("contenteditable", "true")
    // Drafts do not invent a default: pick the connection, then its model.
    await selectCloudAgentConnection(page)
    await ensureComposerModelSelected(page, { modelName: /^Big Pickle$/i, search: "Big Pickle" })

    const promptText = "core cloud provisioning first turn"
    await input.click()
    await input.fill(promptText)
    await expect(input).toContainText(promptText, { timeout: 10_000 })
    await page.locator(SELECTORS.submitControl).last().click()

    await expectAssistantReplyVisible(page, `cloud ack 1: ${promptText}`)
    await expectTurnCounts(page, { user: 1, assistant: 1 })
  })

  test("reload mid-provisioning resumes at the current step, not step 0", async ({ page }) => {
    test.setTimeout(120_000)
    const mock = await installCloudRuntimeMock(page, { registerWorkspace: true, initialStep: "starting_runtime", autoAdvance: false })
    await seedCloudProject(page, { registerWorkspace: true })

    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 100_000 })
    await page.waitForLoadState("domcontentloaded")

    const view = page.locator('[data-component="cloud-startup-view"]')
    await expect(view).toBeVisible({ timeout: 20_000 })
    await expect(view).toContainText(STEP_LABEL.starting_runtime, { timeout: 20_000 })
    // The two earlier rows read done and the next reads not-done, bracketing the
    // active row without reading its own (ambiguous while current).
    await expectStepDone(view, STEP_LABEL.acquiring_sandbox)
    await expectStepDone(view, STEP_LABEL.cloning)
    await expectStepNotDone(view, STEP_LABEL.waiting_health)
    expect(mock.currentStep()).toBe("starting_runtime")

    await page.reload({ waitUntil: "domcontentloaded", timeout: 100_000 })

    const viewAfterReload = page.locator('[data-component="cloud-startup-view"]')
    await expect(viewAfterReload).toBeVisible({ timeout: 20_000 })
    await expect(viewAfterReload).toContainText(STEP_LABEL.starting_runtime, { timeout: 20_000 })
    await expectStepDone(viewAfterReload, STEP_LABEL.acquiring_sandbox)
    await expectStepDone(viewAfterReload, STEP_LABEL.cloning)
    await expectStepNotDone(viewAfterReload, STEP_LABEL.waiting_health)
  })

  test(
    "cloud workspace create failure (request rejected) shows a toast, opens no pipeline, creates no session, and preserves composer text",
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
        ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
          serverUrl: window.location.origin,
          activeDirectory: dir,
        }
        localStorage.setItem(
          "claxedo.global.dat:server",
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
      // Switching to cloud re-resolves the catalog; drafts do not invent a default.
      await ensureComposerModelSelected(page, { modelName: /^Big Pickle$/i, search: "Big Pickle" })
      const promptText = "should not create a cloud vm"
      await input.click()
      await input.fill(promptText)
      await expect(input).toContainText(promptText, { timeout: 10_000 })
      await page.locator(SELECTORS.submitControl).last().click()

      // One toast: a rejected create must not also fall through to the missing-workspaceId toast.
      await expect(page.locator('[data-slot="toast-title"]')).toHaveCount(1, { timeout: 10_000 })
      await expect(page.locator('[data-slot="toast-title"]')).toContainText("Failed to create cloud environment", { timeout: 10_000 })
      await expect(page.locator('[data-slot="toast-description"]')).toContainText("workspace creation blew up", { timeout: 10_000 })

      await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)
      expect(mock.requests.createSessionCount).toBe(0)
      await expect(input).toContainText(promptText)
    },
  )

  test("cloud workspace create failure (200 with missing workspaceId) shows the same toast and preserves composer text", async ({ page }) => {
    test.setTimeout(120_000)
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID })
    await page.route("**/api/workspace/create", (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })

    await page.addInitScript((dir: string) => {
      localStorage.clear()
      ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
        serverUrl: window.location.origin,
        activeDirectory: dir,
      }
      localStorage.setItem(
        "claxedo.global.dat:server",
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
    await ensureComposerModelSelected(page, { modelName: /^Big Pickle$/i, search: "Big Pickle" })
    const promptText = "should not create a cloud vm either"
    await input.click()
    await input.fill(promptText)
    await expect(input).toContainText(promptText, { timeout: 10_000 })
    await page.locator(SELECTORS.submitControl).last().click()

    await expect(page.locator('[data-slot="toast-title"]')).toContainText("Failed to create cloud environment", { timeout: 10_000 })
    // The response was rejected at the create API's schema boundary; the toast
    // names the missing field rather than printing the validator's issue list.
    await expect(page.locator('[data-slot="toast-description"]')).toContainText("Workspace create returned an invalid response (workspaceId:", { timeout: 10_000 })

    await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)
    expect(mock.requests.createSessionCount).toBe(0)
    await expect(input).toContainText(promptText)
  })
})

/**
 * A hosted plane (`platform === "web"`, non-loopback central transport) has no
 * filesystem, so the create form offers a repository only. With no project yet the
 * canvas IS that form (`FirstProjectCanvas`); every later project comes from the
 * composer's Project chip, which renders the same `ProjectCreateForm`. Creating a
 * project never asks where it runs; execution is the Environment/Workspace chips'
 * question at first send.
 *
 * `__CLAXEDO_E2E_SERVER_URL__` forces the non-loopback default server; every route glob
 * is origin-agnostic, so the mocks still answer. The hosted plane does not serve
 * `/api/claxedo/projects` yet, so listing the created project is not asserted.
 */
const HOSTED_SERVER_URL = "https://cloud.example.test"
const HOSTED_REPO_URL = "https://github.com/acme/app"
const HOSTED_PROJECT_ID = "prj_core_cloud_hosted"

test.describe("core cloud project creation on a hosted control plane @core", () => {
  test(
    "a hosted plane with no project opens on the create form and makes a repository project from it",
    async ({ page }) => {
      test.setTimeout(120_000)
      await stampTestAuth(page.context())
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID })

      // A hosted account before its first project: `installMockRuntime`'s default
      // local-worktree row has no cloud kind and the signed inventory contract rejects it.
      const created: Array<{ id: string; name: string }> = []
      await page.route("**/api/claxedo/bootstrap**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            healthy: true,
            version: "1.0.0-test",
            path: { state: "", config: "", worktree: "", directory: "", home: "/tmp" },
            events: { hostAggregate: true },
            project: created.map((project) => ({
              id: project.id,
              name: project.name,
              worktree: `ws_${project.id}`,
              workspaces: {},
              time: { created: 1, updated: 1 },
            })),
            provider: { all: [], default: {}, connected: [] },
            provider_auth: {},
            config: {},
          }),
        }),
      )
      // The Project chip lists `GET /project`; same rows as bootstrap.
      await page.route("**/project**", (route) => {
        const type = route.request().resourceType()
        if (type !== "fetch" && type !== "xhr") return route.continue()
        if (new URL(route.request().url()).pathname !== "/project" || route.request().method() !== "GET") return route.fallback()
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(created.map((project) => ({
            id: project.id,
            name: project.name,
            worktree: `ws_${project.id}`,
            workspaces: {},
            time: { created: 1, updated: 1 },
          }))),
        })
      })

      // A hosted plane has no drivers route; creation must not ask for one.
      let driversRequests = 0
      await page.route("**/api/workspace/drivers**", (route) => {
        driversRequests += 1
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found" } }) })
      })
      // ...and never provisions a workspace: a project is a repository and a name.
      let workspaceCreates = 0
      await page.route("**/api/workspace/create", (route) => {
        workspaceCreates += 1
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "unexpected" } }) })
      })

      const createBodies: unknown[] = []
      await page.route("**/api/claxedo/projects**", (route) => {
        const request = route.request()
        const wire = created.map((project) => ({
          id: project.id,
          name: project.name,
          env: {},
          directory: null,
          repoUrl: HOSTED_REPO_URL,
          created_at: 1,
          updated_at: 1,
        }))
        if (request.method() === "GET") {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: wire }) })
        }
        if (request.method() !== "POST") return route.fallback()
        const body = request.postDataJSON?.() as { name?: string } | undefined
        createBodies.push(body)
        const project = { id: HOSTED_PROJECT_ID, name: body?.name ?? "" }
        created.push(project)
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            project: { ...project, env: {}, directory: null, repoUrl: HOSTED_REPO_URL, created_at: 1, updated_at: 1 },
          }),
        })
      })

      // On a hosted plane the project inventory is the signed workspace inventory; a
      // created project has to be re-listed from it before the canvas can move on.
      let inventoryReads = 0
      page.on("request", (request) => {
        const url = new URL(request.url())
        if (request.method() === "GET" && url.pathname === "/api/workspace" && url.searchParams.get("access") === "cloud") {
          inventoryReads += 1
        }
      })

      await page.addInitScript((serverUrl: string) => {
        localStorage.clear()
        ;(window as typeof window & { __CLAXEDO_E2E_SERVER_URL__?: string }).__CLAXEDO_E2E_SERVER_URL__ = serverUrl
      }, HOSTED_SERVER_URL)

      await page.goto("/", { waitUntil: "domcontentloaded", timeout: 100_000 })
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

      // No project: the form is the screen, with nothing to click through first.
      await expect(page.getByTestId("first-project-canvas")).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole("button", { name: "New Project", exact: true })).toHaveCount(0)
      const form = page.locator('[data-slot="project-create-form"]')
      await expect(form).toBeVisible({ timeout: 20_000 })

      // No folder, no source switch, no provider control: execution is not this form's question.
      await expect(form.getByRole("button", { name: "Choose folder" })).toHaveCount(0)
      await expect(form.locator('[data-slot="project-create-source"]')).toHaveCount(0)
      await expect(page.getByText("Sandbox Provider")).toHaveCount(0)
      const repoUrl = form.getByRole("textbox", { name: "Repository URL" })
      await expect(repoUrl).toBeVisible()
      await repoUrl.fill(HOSTED_REPO_URL)
      await page.screenshot({ path: "test-results/evidence/core-cloud-provisioning/hosted-create-project-panel.png" })

      // The name defaults to the repository's basename when left blank.
      const inventoryReadsBeforeCreate = inventoryReads
      await form.getByRole("button", { name: "Create project" }).click()
      await expect.poll(() => createBodies.length, { timeout: 30_000 }).toBe(1)
      expect(createBodies[0]).toEqual({ name: "app", source: { kind: "repository", repoUrl: HOSTED_REPO_URL } })

      // Success re-lists the inventory. This mock's inventory never carries the project
      // (a repository project has no workspace row), so the form is still the screen;
      // the canvas leaving the form once a project lists is `rail-workbench-canvas`'s own.
      await expect.poll(() => inventoryReads, { timeout: 20_000 }).toBeGreaterThan(inventoryReadsBeforeCreate)
      await expect(form).toBeVisible()
      await page.screenshot({ path: "test-results/evidence/core-cloud-provisioning/hosted-project-created.png" })

      expect(driversRequests).toBe(0)
      expect(workspaceCreates).toBe(0)
      expect(mock.requests.badResponses).toEqual([])
    },
  )
})
