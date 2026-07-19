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
 * shapes. It does NOT own the create-workspace DIALOG's own in-dialog pipeline UI (a
 * separate component, `DialogCreateCloudWorkspace` in
 * `src/components/dialog-create-cloud-workspace.tsx`, with its own `PROVISION_PIPELINE`
 * const) — that belongs to `core-workspace-lifecycle` (spec 18).
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
 *     (`src/components/session/cloud-startup-view.tsx`); breadcrumb line
 *     `Workspace runtime / <step label>`, a 4-row step list (icon + label + duration),
 *     and a summary line `{step label} before the composer unlocks.` (exact text from
 *     `cloudSummary()`) that this spec asserts on directly — it is the single most
 *     robust indicator of which step is CURRENT, since per-row testids do not exist.
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
 *   `role="group" aria-label="Workspace environment"` (local/cloud toggle) and
 *     `role="group" aria-label="Workspace source"` (Select/"Create new") — the
 *     composer's new-session workspace picker (`session-new-design-view.tsx`); clicking
 *     "cloud" on a project with zero existing cloud workspaces auto-selects "Create new"
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
 *      reset to `acquiring_sandbox` — proven via the exact `cloudSummary()` text before
 *      and after reload.
 *   6. A cloud-workspace CREATE failure — either the create request being rejected
 *      (`POST /api/workspace/create` non-2xx, causing `createCloudWorkspace` to throw)
 *      or succeeding with `200` but a body missing `workspaceId` — shows the
 *      "Failed to create cloud workspace" toast, never opens the pipeline overlay
 *      (`gate.open`/`onCloudStartup` is never invoked on this path), creates zero
 *      sessions, and leaves the composer's typed text untouched. REAL BUG (confirmed,
 *      not hypothesized — see the `test.fixme` below): the rejected/thrown shape fires
 *      this toast TWICE (`submit-directory.ts:125-137` — the `.catch()` handler shows
 *      one toast and returns `undefined` instead of returning out of the function, so
 *      the following `!createdWorkspace?.workspaceId` check fires a second, less
 *      informative one); the 200-missing-fields shape correctly fires exactly one.
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
import { expect, test, type Page, type Route } from "@playwright/test"
import { expectAssistantReplyVisible, expectTurnCounts, SELECTORS } from "../helpers/turn-oracle"
import { installMockRuntime } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-core-cloud-provisioning"
const PROJECT_ID = "proj_core_cloud_provisioning"
const WORKSPACE_ID = "ws_core_cloud_provisioning"
const SESSION_ID = "ses_core_cloud_provisioning"
const BIG_PICKLE = { id: "big-pickle", name: "Big Pickle" }

type PipelineStep = "acquiring_sandbox" | "cloning" | "starting_runtime" | "waiting_health" | "ready"

const STEP_SUMMARY: Record<Exclude<PipelineStep, "ready">, string> = {
  acquiring_sandbox: "Acquiring sandbox before the composer unlocks.",
  cloning: "Cloning repository before the composer unlocks.",
  starting_runtime: "Starting runtime before the composer unlocks.",
  waiting_health: "Waiting for health check before the composer unlocks.",
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
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

// Minimal SSE delivery bus, same delivery mechanism as
// e2e/helpers/mock-runtime.ts's EventBus ("How streaming works" there): each
// GET blocks until an event is pending (or idles out), fulfills with the
// queued batch, then ends — the app's own SSE-reconnect loop drives further
// polls. Duplicated here (not imported) because mock-runtime.ts's cloud/relay
// support is explicitly "best-effort scaffolding" (see its own comment) and
// does not model the `/api/wr/events` central provision stream or the
// `/workspaces/:id/...` proxy lane this spec needs — see FINDINGS in the task
// report for the follow-up to fold this back into the shared helper.
class Bus<T> {
  private pending: T[] = []
  private waiters: Array<() => void> = []
  emit(payload: T) {
    this.pending.push(payload)
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }
  private async waitForPending(idleTimeoutMs: number) {
    if (this.pending.length > 0) return
    await Promise.race([new Promise<void>((resolve) => this.waiters.push(resolve)), wait(idleTimeoutMs)])
  }
  async drain(idleTimeoutMs: number) {
    await this.waitForPending(idleTimeoutMs)
    const batch = this.pending
    this.pending = []
    return batch
  }
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
  let messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
  let promptCount = 0
  const requests = { createSessionCount: 0, promptCount: 0, workspaceCreateCount: 0 }

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
      const batch = await provisionBus.drain(4000)
      const body = batch.length === 0 ? ": heartbeat\n\n" : batch.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
      await route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => {})
      return
    }

    // ---- Bootstrap / project inventory ----
    if (url.pathname === "/api/claxedo/bootstrap") {
      return json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
        project: [projectRow()],
        provider: {
          all: [{ id: "opencode", name: "opencode", env: [], models: { [BIG_PICKLE.id]: { id: BIG_PICKLE.id, name: BIG_PICKLE.name, release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } }],
          default: { opencode: BIG_PICKLE.id },
          connected: ["opencode"],
        },
        provider_auth: {},
        config: { provider: { id: "opencode", model: BIG_PICKLE.id }, agent: { id: "build" } },
      })
    }
    if (url.pathname === "/provider") return json(route, { all: [], connected: [], default: {} })
    if (url.pathname === "/provider/auth") return json(route, {})
    if (url.pathname === "/path") return json(route, { worktree: DIR })
    if (url.pathname === "/config") return json(route, { provider: { id: "opencode", model: BIG_PICKLE.id }, agent: { id: "build" } })
    if (url.pathname === "/project" || url.pathname === "/experimental/project") return json(route, [projectRow()])
    if (url.pathname === "/agent" || url.pathname === "/app/agents") return json(route, [{ id: "build", name: "build", description: "Build agent" }])
    if (url.pathname === "/mcp") return json(route, {})
    if (url.pathname === "/lsp") return json(route, [])
    if (url.pathname === "/vcs") return json(route, {})
    if (url.pathname === "/command") return json(route, [{ name: "build", description: "Build command" }])
    if (url.pathname === "/permission") return json(route, [])
    if (url.pathname === "/question") return json(route, [])
    if (url.pathname === "/api/workspace/resolve" && url.searchParams.get("workspaceId") !== WORKSPACE_ID) {
      return json(route, { workspaceId: `local:${PROJECT_ID}`, directory: DIR, kind: "local", status: "ready" })
    }
    if (url.pathname === "/global/event" || url.pathname === "/event") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n` }).catch(() => {})
    }

    // ---- Control-plane session catalog (sidebar list; separate from the
    // /workspaces/:id/session CRUD lane above — a signed-control-plane cloud
    // workspace's sidebar reads THIS, not the runtime's own /session list) ----
    if (url.pathname === "/api/control/session-list") {
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
    if (url.pathname === "/api/workspace" && url.searchParams.get("access") === "cloud") {
      return json(route, { workspaces: workspaceRegistered ? [{ workspace_id: WORKSPACE_ID, project_id: PROJECT_ID, backing: "cloud-vm", access: "cloud", display_name: "core-cloud-provisioning" }] : [] })
    }

    // ---- Workspace create (submit-time first-ever sandbox) ----
    if (url.pathname === "/api/workspace/create" && method === "POST") {
      requests.workspaceCreateCount += 1
      workspaceRegistered = true
      currentStep = "acquiring_sandbox"
      return json(route, { workspaceId: WORKSPACE_ID, directory: WORKSPACE_ID, projectId: PROJECT_ID, provider: "modal", status: "acquiring_sandbox" })
    }

    // ---- Workspace resolve (provisioning progress, polled repeatedly) ----
    if (url.pathname === "/api/workspace/resolve" && url.searchParams.get("workspaceId") === WORKSPACE_ID) {
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
        return json(route, {
          all: [{ id: "opencode", name: "opencode", env: [], models: { [BIG_PICKLE.id]: { id: BIG_PICKLE.id, name: BIG_PICKLE.name, release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } }],
          default: { opencode: BIG_PICKLE.id },
          connected: ["opencode"],
        })
      }
      if (runtimePath === "/api/wr/health") return json(route, { healthy: true })
      if (runtimePath === "/api/wr/harness-config-options") {
        return json(route, { source: "runner", stale: false, options: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: BIG_PICKLE.id, selectOptions: [BIG_PICKLE] }] })
      }
      if (runtimePath === "/api/wr/events" || runtimePath === "/api/claxedo/runtime-events" || runtimePath === "/api/wr/runtime-events") {
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" }).catch(() => {})
      }
      if (runtimePath === "/global/event" || runtimePath === "/event") {
        const batch = await sessionBus.drain(4000)
        const body = batch.length === 0 ? ": heartbeat\n\n" : batch.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
        return route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => {})
      }
      if (runtimePath === "/session/status") return json(route, sessionCreated ? { [SESSION_ID]: { type: "idle" } } : {})
      if (runtimePath === "/session" && method === "POST") {
        requests.createSessionCount += 1
        sessionCreated = true
        messages = []
        return json(route, {
          id: SESSION_ID,
          slug: SESSION_ID,
          projectID: PROJECT_ID,
          directory: WORKSPACE_ID,
          title: "",
          version: "2",
          time: { created: Date.now(), updated: Date.now() },
          summary: { additions: 0, deletions: 0, files: 0 },
          config: { harness: { type: "opencode", model: BIG_PICKLE.id, status: "ready", ready: true }, model: { providerID: "opencode", modelID: BIG_PICKLE.id }, provider: { id: "opencode", model: BIG_PICKLE.id }, agent: "build" },
        })
      }
      if (runtimePath === "/session") return json(route, sessionCreated ? [{ id: SESSION_ID, directory: WORKSPACE_ID, title: "" }] : [])
      if (/^\/session\/[^/]+$/.test(runtimePath)) return json(route, { id: SESSION_ID, directory: WORKSPACE_ID, title: textOf(messages[0]?.parts) || "" })
      if (/^\/session\/[^/]+\/config$/.test(runtimePath)) {
        if (method === "GET") return json(route, { harness: { type: "opencode", model: BIG_PICKLE.id, status: "ready", ready: true }, model: { providerID: "opencode", modelID: BIG_PICKLE.id }, provider: { id: "opencode", model: BIG_PICKLE.id }, agent: "build" })
        return json(route, { ok: true })
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
    await expect(page.locator('[data-action="prompt-model"]')).toContainText(/Big Pickle|big-pickle/i, { timeout: 20_000 })

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
    await expect(view).toContainText(STEP_SUMMARY.starting_runtime, { timeout: 20_000 })
    // Never regressed to step 0's summary while settling.
    await expect(view).not.toContainText(STEP_SUMMARY.acquiring_sandbox)
    expect(mock.currentStep()).toBe("starting_runtime")

    await page.reload({ waitUntil: "domcontentloaded", timeout: 100_000 })

    const viewAfterReload = page.locator('[data-component="cloud-startup-view"]')
    await expect(viewAfterReload).toBeVisible({ timeout: 20_000 })
    // Behavior 5: resumed at the SAME step the server reports, not reset to
    // "Acquiring sandbox" — the resolve response is server truth, and reload
    // fully discards client-held state, so this only holds if the app reads
    // that server truth on every fresh mount.
    await expect(viewAfterReload).toContainText(STEP_SUMMARY.starting_runtime, { timeout: 20_000 })
    await expect(viewAfterReload).not.toContainText(STEP_SUMMARY.acquiring_sandbox)
    await expect(viewAfterReload).not.toContainText(STEP_SUMMARY.cloning)
  })

  // Fixed in Wave 2 (WP-B4): `resolveCloudSessionDirectory`
  // (src/components/prompt-input/submit-directory.ts) now sets a
  // `creationRejected` flag inside the `.catch()` and `return`s immediately
  // afterward, so a rejected cloud-create fires exactly one toast instead of
  // falling through to the second `!createdWorkspace?.workspaceId` toast.
  // Flipped from test.fixme; awaiting leader gate run.
  test(
    "cloud workspace create failure (request rejected) shows a toast, opens no pipeline, creates no session, and preserves composer text — behavior 6",
    async ({ page }) => {
      test.setTimeout(120_000)
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

      const environment = page.getByRole("group", { name: "Workspace environment" })
      await environment.getByRole("button", { name: "cloud" }).click()
      await expect(environment.getByRole("button", { name: "cloud" })).toHaveAttribute("aria-pressed", "true")
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
      await expect(page.locator('[data-action="prompt-model"]')).toContainText(/Big Pickle|big-pickle/i, { timeout: 20_000 })
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

    const environment = page.getByRole("group", { name: "Workspace environment" })
    await environment.getByRole("button", { name: "cloud" }).click()
    await expect(page.getByText("New cloud sandbox", { exact: true })).toBeVisible({ timeout: 10_000 })

    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(input).toBeVisible({ timeout: 20_000 })
    // See the "request rejected" scenario above: the cloud-scope provider/model
    // catalog can still be resolving right after the environment switch, and
    // sending before it settles hits the composer's own "no-model" submit
    // block instead of ever reaching `createCloudWorkspace`.
    await expect(page.locator('[data-action="prompt-model"]')).toContainText(/Big Pickle|big-pickle/i, { timeout: 20_000 })
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
