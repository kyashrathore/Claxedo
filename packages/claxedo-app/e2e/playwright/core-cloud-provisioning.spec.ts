/**
 * A workspace whose runtime is a sandbox the provisioner owns: the startup pipeline,
 * unlock on ready, one send through the relay lane, reload-resume, and the two
 * create-failure shapes.
 *
 * Fixture constraints, none of which a selector shows:
 *   - `sessionWorkspaceRuntimeRef` answers `machine` for a `ws_`-shaped directory the
 *     signed project inventory cannot place. The inventory this spec serves must carry
 *     `{kind: "cloud"}`, or every assertion below runs against the machine lane, which
 *     polls no resolve endpoint and has a different pipeline.
 *   - `CloudStartupView`'s detail line is generic for a plain mid-pipeline step and
 *     becomes a step-specific sentence only on error or ready-handoff. Which step is
 *     current is therefore read from each row's icon slot: a done step renders
 *     `[data-icon="check-small"]` and the active and pending ones render nothing there.
 *     There are no per-row testids.
 *   - Both create-failure shapes must fire exactly one toast. The count assertion is
 *     the guard: a thrown create and a 200 with no `workspaceId` reach the same
 *     handler, and one falling through into the other double-toasts.
 *
 * The invariant the spec exists for: the displayed pipeline step is derived from server
 * state — the resolve response's `status` and the control plane's `provision` notices —
 * never from a client-held log. Every piece of connection state is in-memory, so a
 * reload discards it and re-derives the step, which is what makes "resumes at the
 * current step" provable at all.
 *
 * The submit-time "create a sandbox at first send" path is a different, component-local
 * pipeline that runs before any session exists or the URL navigates. It claims no
 * resume contract; only its failure path is exercised here.
 *
 * Not here: the create-workspace dialog's own pipeline (`core-workspace-lifecycle`),
 * harness ownership over the relay (`core-harness-ownership-cloud`), offline, 403 and
 * viewer-role behavior (`core-cloud-offline-roles`), and the three-step connect
 * pipeline of a workspace placed on a machine (`core-host-tunnel-workspace`).
 */
import { isWorkspaceResolvePath } from "../helpers/contracts/workspace-resolve"
import { isWorkspaceListPath, workspaceListResponse } from "../helpers/contracts/workspace-list"
import { isSessionListPath } from "../helpers/contracts/session-list"
import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import {
  ensureComposerModelSelected,
  expectAssistantReplyVisible,
  expectTurnCounts,
  SELECTORS,
} from "../helpers/turn-oracle"
import { bootstrapDeployment, installMockRuntime, providerCatalogIndex } from "../helpers/mock-runtime"
import { wizardOverflow } from "../helpers/first-run-wizard"
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
const ORG_ID = "org_core_cloud_provisioning"
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
        deployment: bootstrapDeployment(),
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
    if (isWorkspaceListPath(url.pathname)) {
      return json(route, workspaceListResponse({
        host: url.searchParams.get("host"),
        workspaces: workspaceRegistered
          ? [{
              workspace_id: WORKSPACE_ID,
              org_id: ORG_ID,
              project_id: PROJECT_ID,
              display_name: "core-cloud-provisioning",
              backing: "cloud-vm",
              placement: {},
              role: "owner",
            }]
          : [],
      }))
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
 * filesystem and no project route: with no project yet the canvas is the first-run
 * wizard, and a project comes into being as the first cloud workspace the wizard
 * creates at Finish. The AI step there is Pi's provider list, whose keys the plane
 * keeps under `PUT /auth/:providerID?harness=pi`; the sandbox is the deployment's own,
 * so nothing asks for a driver key.
 *
 * `__CLAXEDO_E2E_SERVER_URL__` forces the non-loopback default server; every route glob
 * is origin-agnostic, so the mocks still answer.
 */
const HOSTED_SERVER_URL = "https://cloud.example.test"
const HOSTED_REPO_URL = "https://github.com/acme/app"
const HOSTED_WORKSPACE_ID = "ws_core_cloud_hosted"

test.describe("core cloud project creation on a hosted control plane @core", () => {
  test(
    "a hosted plane with no project walks the wizard and creates the first cloud workspace at Finish",
    async ({ page }) => {
      test.setTimeout(120_000)
      await stampTestAuth(page.context())
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID })

      // A hosted account before its first project: `installMockRuntime`'s default
      // local-worktree row has no cloud kind and the signed inventory contract rejects it.
      await page.route("**/api/claxedo/bootstrap**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            healthy: true,
            version: "1.0.0-test",
            path: { state: "", config: "", worktree: "", directory: "", home: "/tmp" },
            events: { hostAggregate: true },
            deployment: bootstrapDeployment(true),
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
        if (new URL(route.request().url()).pathname !== "/project" || route.request().method() !== "GET") return route.fallback()
        return route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
      })

      // This deployment offers no code host, so the wizard offers the URL field alone.
      await page.route("**/api/claxedo/integrations**", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ integrations: [], connections: [] }) }),
      )
      // A hosted plane has no drivers route and no projects route; the wizard must ask neither.
      let driversRequests = 0
      await page.route("**/api/workspace/drivers**", (route) => {
        driversRequests += 1
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found" } }) })
      })
      let projectPosts = 0
      await page.route("**/api/claxedo/projects**", (route) => {
        if (route.request().method() === "POST") projectPosts += 1
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "route_not_found" } }) })
      })

      // Pi's catalog, the plane's seven launch providers, which reports a
      // provider connected once its key is stored.
      const piKeys: Array<{ providerId: string; body: unknown }> = []
      await page.route("**/api/claxedo/agent-config/providers?**", (route) => {
        const url = new URL(route.request().url())
        if (url.searchParams.get("nativeHarness") !== "pi") {
          return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "provider_catalog_unsupported" } }) })
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(providerCatalogIndex({
            all: [
              { id: "openai-codex", name: "ChatGPT", models: {} },
              { id: "anthropic", name: "Anthropic", models: {} },
              { id: "openai", name: "OpenAI", models: {} },
              { id: "openrouter", name: "OpenRouter", models: {} },
              { id: "google", name: "Google", models: {} },
              { id: "groq", name: "Groq", models: {} },
              { id: "xai", name: "xAI", models: {} },
            ],
            connected: piKeys.map((entry) => entry.providerId),
            default: {},
          })),
        })
      })
      await page.route("**/auth/*?harness=pi**", (route) => {
        if (route.request().method() !== "PUT") return route.fallback()
        const providerId = new URL(route.request().url()).pathname.split("/").pop() ?? ""
        piKeys.push({ providerId, body: route.request().postDataJSON?.() })
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      })

      // The one create, after which the plane lists and resolves the workspace so
      // the route the wizard opens can hold it (its startup pipeline is the
      // provisioning spec's own subject).
      const workspaceCreates: unknown[] = []
      await page.route("**/api/workspace/create", (route) => {
        if (route.request().method() !== "POST") return route.fallback()
        workspaceCreates.push(route.request().postDataJSON?.())
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ workspaceId: HOSTED_WORKSPACE_ID, directory: HOSTED_WORKSPACE_ID, status: "acquiring_sandbox" }),
        })
      })
      await page.route("**/api/workspace**", (route) => {
        const url = new URL(route.request().url())
        if (route.request().method() !== "GET") return route.fallback()
        if (isWorkspaceListPath(url.pathname)) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(workspaceListResponse({
              host: url.searchParams.get("host"),
              workspaces: workspaceCreates.length > 0
                ? [{
                    workspace_id: HOSTED_WORKSPACE_ID,
                    org_id: ORG_ID,
                    project_id: "prj_core_cloud_hosted",
                    display_name: "app",
                    backing: "cloud-vm",
                    placement: {},
                    role: "owner",
                  }]
                : [],
            })),
          })
        }
        if (isWorkspaceResolvePath(url.pathname) && url.searchParams.get("workspaceId") === HOSTED_WORKSPACE_ID) {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              workspaceId: HOSTED_WORKSPACE_ID,
              projectId: "prj_core_cloud_hosted",
              directory: HOSTED_WORKSPACE_ID,
              kind: "cloud",
              status: "acquiring_sandbox",
            }),
          })
        }
        return route.fallback()
      })

      await page.addInitScript((serverUrl: string) => {
        localStorage.clear()
        ;(window as typeof window & { __CLAXEDO_E2E_SERVER_URL__?: string }).__CLAXEDO_E2E_SERVER_URL__ = serverUrl
      }, HOSTED_SERVER_URL)
      // The dark theme; the first-run wizard's own spec walks the light one.
      await page.addInitScript(() => localStorage.setItem("opencode-color-scheme", "dark"))

      await page.goto("/", { waitUntil: "domcontentloaded", timeout: 100_000 })
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

      // Step 1: the form is the screen, with a URL and nothing about execution.
      await expect(page.getByTestId("first-project-canvas")).toBeVisible({ timeout: 20_000 })
      const wizard = page.getByTestId("onboarding-wizard")
      await expect(wizard).toHaveAttribute("data-step", "project")
      await expect(page.getByRole("heading", { name: "Start with a project" })).toBeVisible()
      const form = page.locator('[data-slot="project-create-form"]')
      await expect(form).toBeVisible({ timeout: 20_000 })
      await expect(form.getByRole("button", { name: "Choose folder" })).toHaveCount(0)
      await expect(form.locator('[data-slot="project-create-source"]')).toHaveCount(0)
      const repoUrl = form.getByRole("textbox", { name: "Repository URL" })
      await expect(repoUrl).toBeVisible({ timeout: 20_000 })
      await repoUrl.fill(HOSTED_REPO_URL)
      await page.screenshot({ path: "test-results/evidence/core-cloud-provisioning/hosted-wizard-project.png" })
      await form.getByRole("button", { name: "Continue" }).click()

      // Step 2: Pi's providers are the Models page's own rows; Next waits for a
      // stored key, which the connect form sends to the plane's auth route.
      await expect(wizard).toHaveAttribute("data-step", "ai")
      await expect(page.getByRole("heading", { name: "Connect an AI" })).toBeVisible()
      await expect(page.locator('[data-slot="onboarding-project-name"]')).toContainText("app")
      await expect(page.getByRole("button", { name: "Skip for now" })).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Next" })).toBeDisabled()
      const piSection = page.locator('[data-component="pi-providers-section"]')
      await expect(piSection.locator('[data-provider="anthropic"]')).toBeVisible()
      await expect(page.locator('[data-component="agent-harness-row"]')).toHaveCount(0)

      // Back shows step 1 as it was left, and the step comes back as it was.
      await page.getByRole("button", { name: "Back" }).click()
      await expect(wizard).toHaveAttribute("data-step", "project")
      await expect(repoUrl).toHaveValue(HOSTED_REPO_URL)
      await form.getByRole("button", { name: "Continue" }).click()
      await expect(wizard).toHaveAttribute("data-step", "ai")
      await expect(piSection.locator('[data-provider="anthropic"]')).toBeVisible()

      // Seven rows are taller than a small window: the page and the canvas do
      // not scroll, the card body does, and the footer stays in view.
      const fullViewport = page.viewportSize()!
      for (const viewport of [{ width: 1024, height: 640 }, { width: 375, height: 667 }]) {
        await page.setViewportSize(viewport)
        await page.waitForTimeout(350)
        const overflow = await wizardOverflow(page)
        expect(overflow.page, `${viewport.width}x${viewport.height}: page`).toBeLessThanOrEqual(0)
        expect(overflow.canvas, `${viewport.width}x${viewport.height}: canvas`).toBeLessThanOrEqual(0)
        expect(overflow.body, `${viewport.width}x${viewport.height}: card body`).toBeGreaterThan(0)
        await expect(page.getByRole("button", { name: "Next" })).toBeInViewport()
        await expect(page.getByRole("button", { name: "Back" })).toBeInViewport()
        await expect(page.getByRole("list", { name: "Setup steps" })).toBeInViewport()
        await page.screenshot({ path: `test-results/evidence/core-cloud-provisioning/hosted-wizard-ai-${viewport.width}x${viewport.height}.png` })
      }
      await page.setViewportSize(fullViewport)

      // ChatGPT signs in from a machine's Codex CLI: the plane holds no key for it.
      await piSection.locator('[data-provider="openai-codex"]').getByRole("button", { name: "Connect" }).click()
      const card = page.locator('[data-component="provider-connect-card"]')
      await expect(card.locator('[data-component="provider-connect-unavailable"]')).toContainText("ChatGPT is signed in to from the Codex CLI")
      await expect(card.locator("form")).toHaveCount(0)
      await card.locator('[data-action="provider-connect-close"]').click()
      await expect(card).toHaveCount(0)

      await piSection.locator('[data-provider="anthropic"]').getByRole("button", { name: "Connect" }).click()
      await expect(card).toBeVisible()
      await card.getByRole("radio").and(card.locator('[data-method-type="api"]')).click()
      await card.getByLabel(/Anthropic API key/i).fill("sk-ant-e2e")
      // The plane's entry carries no label, so none is asked for.
      await expect(card.getByLabel("Label", { exact: true })).toHaveCount(0)
      await card.getByRole("button", { name: "Continue" }).click()
      await expect.poll(() => piKeys.length, { timeout: 10_000 }).toBe(1)
      expect(piKeys[0]).toEqual({ providerId: "anthropic", body: { auth: { key: "sk-ant-e2e" } } })
      await expect(card).toHaveCount(0)
      await expect(piSection.locator('[data-provider="anthropic"]').getByRole("button", { name: "Connect" })).toHaveCount(0, { timeout: 10_000 })
      await expect(page.getByRole("button", { name: "Next" })).toBeEnabled()
      await page.screenshot({ path: "test-results/evidence/core-cloud-provisioning/hosted-wizard-ai.png" })
      await page.getByRole("button", { name: "Next" }).click()

      // Step 3: the deployment's sandbox is the answer; Finish creates the one workspace.
      await expect(wizard).toHaveAttribute("data-step", "execution")
      await expect(page.getByRole("radio", { name: /Just this machine/ })).toHaveCount(0)
      await expect(page.getByRole("radio", { name: /A cloud sandbox/ })).toHaveAttribute("aria-checked", "true")
      await expect(page.locator('[data-slot="onboarding-cloud-hosted"]')).toBeVisible()
      expect(driversRequests).toBe(0)
      expect(projectPosts).toBe(0)
      expect(workspaceCreates).toEqual([])
      expect(mock.requests.badResponses).toEqual([])
      await page.waitForTimeout(350)
      const executionOverflow = await wizardOverflow(page)
      expect(executionOverflow.page).toBeLessThanOrEqual(0)
      expect(executionOverflow.canvas).toBeLessThanOrEqual(0)
      await expect(page.getByRole("button", { name: "Create workspace" })).toBeInViewport()
      await page.screenshot({ path: "test-results/evidence/core-cloud-provisioning/hosted-wizard-execution.png" })
      await page.getByRole("button", { name: "Create workspace" }).click()

      await page.waitForURL(new RegExp(`/w/${HOSTED_WORKSPACE_ID}/session`), { timeout: 30_000 })
      expect(workspaceCreates).toEqual([{ projectName: "app", repoUrl: HOSTED_REPO_URL }])
      expect(projectPosts).toBe(0)
      expect(driversRequests).toBe(0)
    },
  )
})
