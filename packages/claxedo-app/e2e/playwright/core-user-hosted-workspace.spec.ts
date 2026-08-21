/**
 * SPEC: User-hosted workspace connect (mocked-relay tier)
 *
 * PURPOSE — a "user-hosted" workspace is NOT a central sandbox: it is a real machine the
 * user (or a teammate) is running `claxedo up` on, reached through the Workspace Relay
 * tunnel. Unlike a cloud workspace there is nothing to provision or clone — the workspace
 * already exists — so its "getting ready" story is entirely about REACHING it: mint a
 * relay connection, then probe the host's runtime health through the tunnel until it
 * answers or a bounded retry budget is exhausted. This spec owns that connect experience
 * end to end in the mocked-relay tier: the distinct 3-step pipeline, the host-offline
 * terminal state and its exact "run `claxedo up`" copy, the health probe's tolerance for
 * transient relay hiccups, that every workspace-scoped surface (session send, and whatever
 * else is exercised while ready) routes through the relay lane rather than any bare/local
 * endpoint, a workspace going from ready to paused (host taken offline) after a warm
 * reload, and the in-app "Share workspace" entry point that registers a workspace as
 * user-hosted. The DEEP half — real relay/JWT fixtures, genuine WS multiplexing, PTY/file
 * writes through a live tunnel, role enforcement — is Tier L's `live-user-hosted-relay`
 * (spec 25); this spec never makes a real network call.
 *
 * STATE MODEL — the SAME single connection authority as cloud workspaces owns this:
 * `workspaceConnection` (in-memory Solid store, `src/shell/workspace/workspace-
 * connection.ts`), keyed by `workspaceId`, ref-counted across mounted panes.
 * `WorkspaceGate` (`src/shell/workspace/workspace-gate.tsx`) renders `CloudStartupView
 * variant="user-hosted"` while `connections[workspaceId].status !== "ready"`, the terminal
 * `WorkspaceOfflineView` while `status` is `{offline: reason}`, and `props.children`
 * (the real session/composer surface) once `status === "ready"`.
 *   Kind resolution — `sessionWorkspaceRuntimeRef` (`src/shell/workspace/session-
 *   workspace-key.ts`) reads the workspace's kind off the signed project inventory
 *   (`/api/claxedo/bootstrap`'s `project[].workspaces` map); a `ws_`-shaped workspaceId
 *   with NO matching inventory entry DEFAULTS to `"user-hosted"` (never `"cloud"` —
 *   `"cloud"` would route through the sandbox-provisioning resolve endpoint, which 404s
 *   for a workspace that has no central sandbox). This spec registers the workspace
 *   explicitly as `kind: "user-hosted"` for clarity rather than relying on the default.
 *   Connect sequence — `acquireWorkspaceConnection` → `driveConnection` (kind
 *   `"user-hosted"`) calls `prepareUserHostedRuntime` (`src/cloud/runtime/workspace-
 *   runtime-store.ts`) directly — NO `/api/workspace/resolve` polling and NO `provision`
 *   SSE stream (that machinery is cloud-only). `prepareUserHostedRuntime`: (1) emits
 *   `connecting_workspace` then, synchronously right after (no network yet), emits
 *   `establishing_relay`; (2) builds a `workspace-relay` transport and calls
 *   `transport.fetch("/api/wr/health")` in a retry loop (up to `USER_HOSTED_HEALTH_MAX_
 *   ATTEMPTS`=15 attempts, `USER_HOSTED_HEALTH_RETRY_MS`=1500ms apart, each probe capped
 *   at `USER_HOSTED_HEALTH_TIMEOUT_MS`=6000ms) — the FIRST call to `transport.fetch`
 *   lazily mints the relay connection (`GET /api/workspace/:id/connection`, cached by
 *   `openWorkspaceConnection`) before proxying through `${relayUrl}/workspaces/:id/api/wr/
 *   health`; (3) a 502/503/409 response (or a network/abort error) is TRANSIENT — the loop
 *   emits `checking_health` and keeps retrying, but ALSO calls `onOffline` on the very
 *   FIRST such miss (not debounced to "N consecutive misses") — `workspace-connection.ts`
 *   wires that straight to `setOffline(workspaceId, "no-host", message)`, so a single
 *   transient relay hiccup DOES flip the gate to the offline view even though the retry
 *   loop keeps running underneath and can still recover to `ready` — see BEHAVIORS #5 and
 *   the finding filed in this spec's task report; (4) any other non-2xx fails FAST (no
 *   retry) with a generic error, not `offline`; (5) success emits `checking_health` then
 *   `ready`. None of these three timing constants are overridable from the app's call
 *   site (`driveConnection` calls `prepareUserHostedRuntime` with no attempt/delay/timeout
 *   overrides), so a persistent-offline scenario in this spec genuinely takes the full
 *   retry budget (~21s) — there is no way to speed it up short of monkey-patching the
 *   module, which this spec does not do.
 *   Reload / warm start — `acquireWorkspaceConnection` remembers the last successful
 *   connect per `workspaceId` in `localStorage['claxedo.workspace-connection.ready.v1']`
 *   with a 60s TTL (`wasRecentlyReady`). A user-hosted workspace that reconnects within
 *   that window is optimistically rendered `ready` from frame zero (`warmUserHosted`) —
 *   `driveConnection` still runs `prepareUserHostedRuntime` in the background
 *   (`keepReadyWhileChecking: true`, so it does NOT reset status to "connecting" first),
 *   and if the host is now actually unreachable, the SAME `onOffline`/`setOffline` path
 *   flips the optimistic `ready` render to the offline view once the background health
 *   check reports it. This is the mechanism this spec pins as "pause" — a host that goes
 *   offline between an earlier successful connect and a later reload of the same page
 *   surfaces as an offline transition, not a stuck stale-ready UI. NONE of this state
 *   lives in a session/turn sense — it is connection-authority state, entirely orthogonal
 *   to the session timeline, and (aside from the localStorage warm-start marker) is
 *   in-memory only, fully discarded by a real page reload.
 *   Share/register — `registerUserHostedWorkspace` (`src/utils/share-workspace.ts`) is a
 *   ONE-SHOT `POST /api/workspace/:id/user-hosted/register` fired from the sidebar's
 *   "Share workspace" action (`src/claxedo-ui/layouts/rail-sidebar.tsx`'s
 *   `HeaderActions`); it does not touch `workspaceConnection` at all — it is orthogonal to
 *   the connect pipeline above, just a call that marks a LOCAL project's workspace as
 *   registered/shareable server-side and copies a share URL. It is gated by
 *   `Can do="share.workspace"` (`src/shell/auth/role.tsx`) — available to `signed`/`org-
 *   member` principals, never `local`/`anonymous` — and by `localWorkspaceShareTarget`
 *   finding a non-cloud workspace row for the clicked directory (falls back to the
 *   project's own id/worktree when the directory equals the project's main worktree, so
 *   no prior workspace registration is required to reach it).
 *
 * ANATOMY —
 *   `[data-component="cloud-startup-view"]` with `variant="user-hosted"` — same component
 *     cloud workspaces use (`src/features/session/ui/components/cloud-startup-view.tsx`),
 *     rendering the DISTINCT `USER_HOSTED_STARTUP_PIPELINE` (3 keys, in order): `connecting_
 *     workspace` ("Connecting to workspace"), `establishing_relay` ("Establishing relay
 *     tunnel"), `checking_health` ("Checking runtime health") — never cloud's 4-key
 *     pipeline (`acquiring_sandbox`/`cloning`/`starting_runtime`/`waiting_health`). Its
 *     heading reads exactly "Connecting to workspace" (`isUserHosted() ? "Connecting to
 *     workspace" : "Preparing workspace"`). The detail line under it is GENERIC ("The
 *     composer unlocks when the runtime is ready.") for a plain mid-pipeline step — dev
 *     8d1227e44 dropped the old always-on `cloudSummary()` sentence there (it now only
 *     appears on error or ready-handoff) — so this spec proves the 3-step pipeline via the
 *     row labels themselves, not a step-specific summary sentence.
 *   `[data-testid="workspace-offline"]` (`src/shell/workspace/workspace-gate.tsx`'s
 *     `WorkspaceOfflineView`) — the terminal "can't reach it" state for reason `"no-
 *     host"`: title "Workspace host is offline", detail EXACTLY "Start it by running
 *     `claxedo up` on the machine that serves this workspace, then retry." (note: this is
 *     the GATE's own copy, distinct from `prepareUserHostedRuntime`'s internal default
 *     offline message string, which differs slightly and is never rendered directly since
 *     the gate always supplies its own `OFFLINE_COPY` text). Not terminal (`isTerminalReason
 *     ("no-host") === false`), so `[data-testid="workspace-offline-retry"]` ("Retry")
 *     renders and calls `retryWorkspaceConnection`.
 *   `[role="textbox"][aria-label*="Ask anything"]` — once the gate renders children, the
 *     draft composer appears exactly like a local/cloud session (proof the gate unlocked).
 *   Rail sidebar "Share workspace" — `DropdownMenu.Item` inside the workspace header's
 *     kebab menu (`aria-label="More options for <project label>"`), gated by
 *     `Can do="share.workspace"` and `!shareTarget() || sharing()` (disabled). Success
 *     shows a `[data-slot="toast-title"]` "Workspace shared" toast whose description is
 *     the copied share URL (or a "copied to clipboard" message when the clipboard write
 *     succeeds); failure shows `[data-slot="toast-title"]` "Failed to share workspace".
 *
 * BEHAVIORS —
 *   1. Landing on a not-yet-ready user-hosted workspace renders the 3-step pipeline with
 *      the "Connecting to workspace" heading and step labels/order distinct from cloud's
 *      4-step pipeline — no cloud-only step key or label ever appears.
 *   2. Once the connection mints and the health probe succeeds, the gate unlocks: the
 *      pipeline view disappears and the draft composer becomes reachable/editable.
 *   3. A prompt sent through the now-ready user-hosted workspace — and every supporting
 *      bootstrap/session call the composer makes while ready (provider, agent, session
 *      create/get/message/config/capabilities, prompt dispatch, plus the diff/vcs
 *      plumbing) — is served EXCLUSIVELY through the relay lane (`/workspaces/:id/...`);
 *      the oracle proves the reply renders, and zero of those calls ever hit a bare/local
 *      equivalent path.
 *   4. A persistently offline host (every health probe answers `503 user_hosted_app_
 *      offline`) renders the terminal offline view with the exact "run `claxedo up`"
 *      detail copy, offers Retry (non-terminal reason), and never renders the composer.
 *   5. Transient relay hiccups on the health probe (409/503, simulating the DO presence-
 *      registration gap) do not prevent the workspace from eventually reaching `ready` —
 *      the retry loop recovers and the composer unlocks — proving the retry BUDGET
 *      tolerates them, i.e. a blip is never misclassified as the terminal "genuine runtime
 *      error" branch (which fails fast with zero retries).
 *   6. A workspace that was ready before an earlier connect, reloaded within the 60s warm-
 *      start window while the host is now offline, is optimistically shown ready for a
 *      moment and then flips to the offline view once the background health check
 *      confirms the host is unreachable — "pause" surfaces as a real state transition, not
 *      a stuck stale-ready UI.
 *   7. The in-app "Share workspace" entry point (rail sidebar kebab menu, gated by `Can
 *      do="share.workspace"`) calls `registerUserHostedWorkspace`, and on success shows
 *      the "Workspace shared" toast — the app-triggered path to `share-workspace.ts`
 *      reaches a registered state without any dedicated user-hosted connect flow required
 *      first (it targets the project's own main workspace).
 *
 * INVARIANTS — completed assistant content is never hidden by stale busy state (#2 in
 *   e2e/INVARIANTS.md, exercised via the oracle in behavior 3); harness ownership (#1) is
 *   fixed to `opencode` throughout — this spec is about the CONNECTION layer, not harness
 *   selection. This spec's own pinned invariant: the gate's displayed state (pipeline step
 *   / offline / ready) is DERIVED FROM the connection authority's server-reported truth
 *   (mint + health probe results), never from client-side assumptions about elapsed time.
 *
 * HARNESS NOTES — none; harness stays `opencode` (default, no config-options harness) so
 *   the connect/relay-routing contract stays isolated from harness selection concerns
 *   (`core-harness-ownership-cloud`, spec 12, owns the harness matrix over the relay).
 *
 * OUT OF SCOPE — real relay/JWT fixtures, genuine WS multiplexing, connection token
 *   refresh/JTI rotation, restart-tunnel-without-reload, viewer/editor role enforcement at
 *   the transport layer (`live-user-hosted-relay`, spec 25); 403/forbidden terminal state
 *   and reconnect-without-error-toast behavior, which is the CLOUD equivalent's contract
 *   (`core-cloud-offline-roles`, spec 13) — this spec only exercises the `"no-host"`
 *   offline reason, the one unique to user-hosted; the create-cloud-workspace dialog and
 *   4-step cloud pipeline (`core-cloud-provisioning`, spec 11, and `core-workspace-
 *   lifecycle`, spec 18); full Terminal/Files panel UI and their own dedicated behaviors
 *   (`core-terminal`, spec 19; diff/file panel rendering, spec 8/others) — this spec proves
 *   only that the panels' underlying REQUESTS route through the relay lane, via the
 *   session send and its supporting calls, not their rendered UI.
 */
import { isWorkspaceResolvePath } from "../helpers/contracts/workspace-resolve"
import { isSessionListPath } from "../helpers/contracts/session-list"
import { expect, test, type Page, type Route } from "@playwright/test"
import { expectAssistantReplyVisible, expectTurnCounts, SELECTORS } from "../helpers/turn-oracle"
import {
  assertSessionConfigPatchResponse,
  parseSessionConfigPatch,
  SESSION_CONFIG_PATCH_SUCCESS_STATUS,
} from "../helpers/contracts/session-config"

const PROJECT_ID = "proj_core_user_hosted_workspace"
const WORKSPACE_ID = "ws_core_user_hosted_workspace"
// Runtime-native session id (NOT `ses_`-prefixed): the relay `/api/wr/runtime-events`
// lane is consumed by global-sdk's runtime loop, which gates every frame on
// `runtimeProjectionOwnsCompat` → `runtimeOwnsOpencodeCompatProjection`
// (`packages/agent-event-runtime/.../opencode-compat/ownership.ts`), and that
// returns `false` for any `ses_`-prefixed id (those are OpenCode-legacy sessions
// whose compat frames arrive on the classic `/global/event` loop instead). A
// `ses_` id here would make the runtime consumer `continue` past every frame, so
// the contract-v4 lane below could never render. Real user-hosted runtime
// sessions are runtime-native, so this matches production, not just the gate.
const SESSION_ID = "run_core_user_hosted_workspace"
const DIR = "/tmp/e2e-core-user-hosted-workspace"
// Contention-tolerant ceiling for reactive UI transitions that a starved CI runner
// was blowing past the 10-20s local budget (doc entry 7: CI-only, "runner-contention
// timing"; the oracle-send and Share-toast waits are the named victims). Every use
// still awaits the actual state transition — this only outlasts host lag, it never
// weakens what is asserted.
const CONTENTION_TIMEOUT = 45_000
// The AgentRuntimeEvent contract version the consumer requires verbatim
// (`AGENT_RUNTIME_EVENT_CONTRACT_VERSION` in
// `packages/agent-event-runtime/src/contracts/agent-runtime-event.ts`); a frame
// with any other value is dropped by `runtimeEnvelope` (src/context/global-sdk.tsx).
const RUNTIME_EVENT_CONTRACT_VERSION = 4
// Real, versioned, servable house-model id — NOT the bare "big-pickle", which
// the app reserves as the non-selectable pre-provisioning placeholder
// (`signed-workspace-model.ts`); serving that exact id as the only model leaves
// the composer stuck on "Select model". Display name stays "Big Pickle".
const BIG_PICKLE = { id: "big-pickle-1", name: "Big Pickle" }

const OFFLINE_DETAIL =
  "Start it by running `claxedo up` on the machine that serves this workspace, then retry."

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

// Cursor-resumed SSE event log matching e2e/helpers/mock-runtime.ts's EventBus
// and core-cloud-provisioning.spec.ts. Each concurrent reader receives every
// event in order and resumes with its own Last-Event-ID. Duplicated here
// because mock-runtime.ts's cloud/relay support does not model the user-hosted
// mint/health sequence this spec needs.
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

type HealthOutcome = 200 | 409 | 503

async function seedProject(page: Page, opts: { registerWorkspace: boolean }) {
  await page.addInitScript(
    (input: { dir: string; workspaceId: string; registerWorkspace: boolean }) => {
      localStorage.clear()
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: window.location.origin,
        activeDirectory: input.dir,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: {
            local: [{
              worktree: input.dir,
              expanded: true,
              sandboxes: input.registerWorkspace ? [input.workspaceId] : [],
            }],
          },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
    },
    { dir: DIR, workspaceId: WORKSPACE_ID, registerWorkspace: opts.registerWorkspace },
  )
}

/**
 * Installs the user-hosted workspace mock: bootstrap/project inventory (registered as
 * `kind: "user-hosted"`), the connection mint endpoint, the `/api/wr/health` probe (driven
 * by `opts.health`, a queue of outcomes consumed one per probe — the last entry repeats
 * once exhausted), and the `/workspaces/:id/...` runtime proxy lane needed to complete a
 * full turn once ready.
 */
async function installUserHostedRuntimeMock(
  page: Page,
  opts: {
    health: HealthOutcome[]
    mintDelayMs?: number
    healthDelayMs?: number
  },
) {
  const provisioningBus = new Bus<Record<string, unknown>>()
  const sessionBus = new Bus<Record<string, unknown>>()
  // The contract-v4 runtime-events lane. A ready user-hosted (workspace-relay)
  // session consumes live turn events ONLY through global-sdk's runtime loop
  // (`startRuntimeEvents`, src/context/global-sdk.tsx), which fetches
  // `${relayUrl}/workspaces/:id/api/wr/runtime-events` and reads each frame with
  // `runtimeEnvelope` — a `{contractVersion, directory, sessionId,
  // assistantMessageId?, payload: AgentRuntimeEvent}` shape run through
  // `createOpencodeCompatProjection`. For a workspace-routed session the classic
  // `/global/event` loop short-circuits (`workspaceRuntimeOwnsLiveEvents()` →
  // idle), so this lane is the ONLY channel that drives the turn. Frames go here,
  // NOT on `sessionBus` (whose `/global/event` route the app never polls for this
  // route shape — the exact gap the fixme pinned).
  const runtimeBus = new Bus<Record<string, unknown>>()
  let sessionCreated = false
  let sessionBusy = false
  let messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
  let promptCount = 0
  let healthAttempt = 0
  const requests = {
    createSessionCount: 0,
    promptCount: 0,
    healthProbeCount: 0,
    mintCount: 0,
    /** GETs of `/workspaces/:id/api/wr/runtime-events` — proof the emitter is actually consumed. */
    runtimeEventsPollCount: 0,
    /** Contract-v4 frames actually pushed onto `runtimeBus`. */
    runtimeFramesEmitted: [] as Array<Record<string, unknown>>,
    relayHits: [] as string[],
    bareHitsDuringReady: [] as string[],
  }
  let ready = false

  provisioningBus.emit({ directory: "global", payload: { type: "server.connected", properties: {} } })

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

  const projectRow = () => ({
    id: PROJECT_ID,
    worktree: DIR,
    name: "core-user-hosted-workspace",
    sandboxes: [WORKSPACE_ID],
    workspaces: {
      [WORKSPACE_ID]: { id: WORKSPACE_ID, kind: "user-hosted", workspace_name: "shared", directory: WORKSPACE_ID },
    },
  })

  await page.route("**/*", async (route) => {
    if (!api(route)) return route.continue()
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()

    // ---- Bootstrap / project inventory (bare origin) ----
    // Bootstrap discovery is legitimately bare-origin at ANY readiness state
    // (it is how the app learns which workspaces/projects exist at all, not
    // part of the per-workspace runtime lane Behavior 3 pins) — it is
    // deliberately NOT counted in `bareHitsDuringReady`.
    if (url.pathname === "/api/claxedo/bootstrap") {
      return json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
        project: [projectRow()],
        provider: { all: [], connected: [], default: {} },
        provider_auth: {},
        config: { provider: { id: "opencode", model: BIG_PICKLE.id }, agent: { id: "build" } },
      })
    }
    if (url.pathname === "/project" || url.pathname === "/experimental/project") return json(route, [projectRow()])
    if (/^\/project\/[^/]+$/.test(url.pathname) && method === "PATCH") {
      // `client.project.update` (dialog-edit-project.tsx) — control-plane
      // project metadata, unrelated to the per-workspace runtime lane.
      return json(route, projectRow())
    }
    if (url.pathname === "/global/event" || url.pathname === "/event") {
      const batch = await provisioningBus.drain(4000, lastEventId(route))
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: eventStream(batch) }).catch(() => {})
    }
    // ---- Control-plane session inventory + central event stream (bare
    // origin, ALWAYS — independent of any workspace's connect/ready state;
    // `src/context/global-sync/inventory-source.ts` and
    // `src/providers/claxedo-events.tsx`). Not part of Behavior 3's runtime
    // lane, so never counted in `bareHitsDuringReady`.
    if (isSessionListPath(url.pathname)) {
      return json(route, { view: { scope: "global", groupBy: "none", sort: "updated_desc", limit: 50 }, items: [], groups: [] })
    }
    if (url.pathname === "/api/control/sessions") return json(route, { sessions: [] })
    if (url.pathname === "/api/workspace") return json(route, { workspaces: [] })
    if (url.pathname === "/api/wr/events") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" }).catch(() => {})
    }
    if (/^\/api\/control\/workspaces\/[^/]+\/sessions\/[^/]+\/(register|checkpoint|repair)$/.test(url.pathname) && method === "POST") {
      // `src/runtime/session-projection.ts` fire-and-forget projection pull —
      // bare origin by design (`getClaxedoServerUrl()`), not the relay lane.
      return json(route, { ok: true })
    }
    // A `ws_...`-shaped workspaceId with no inventory entry defaults to
    // "user-hosted" (session-workspace-key.ts), but OTHER resolve calls for
    // unrelated ids (there shouldn't be any in this spec) should not 599.
    if (isWorkspaceResolvePath(url.pathname)) {
      return json(route, { workspaceId: WORKSPACE_ID, directory: WORKSPACE_ID, kind: "user-hosted", status: "ready" })
    }

    // ---- Connection mint (always succeeds fast; the bottleneck for user-
    // hosted is the HEALTH probe, not provisioning) ----
    if (
      url.pathname === `/api/workspace/${WORKSPACE_ID}/connection` ||
      url.pathname === `/api/workspace/${WORKSPACE_ID}/connection/refresh`
    ) {
      requests.mintCount += 1
      if (opts.mintDelayMs) await wait(opts.mintDelayMs)
      return json(route, {
        access: "user-hosted",
        backing: "local-worktree",
        workspaceId: WORKSPACE_ID,
        role: "owner",
        relayUrl: url.origin,
        runtimeAccessToken: `rat_${WORKSPACE_ID}`,
        tokenExpiresAt: Date.now() + 10 * 60_000,
      })
    }

    // ---- Workspace runtime lane, proxied through /workspaces/:id/... ----
    const prefix = `/workspaces/${WORKSPACE_ID}`
    if (url.pathname.startsWith(prefix)) {
      const runtimePath = url.pathname.slice(prefix.length) || "/"
      requests.relayHits.push(`${method} ${runtimePath}`)

      if (runtimePath === "/api/wr/health") {
        requests.healthProbeCount += 1
        if (opts.healthDelayMs) await wait(opts.healthDelayMs)
        const outcome = opts.health[Math.min(healthAttempt, opts.health.length - 1)]
        healthAttempt += 1
        if (outcome === 200) {
          ready = true
          return json(route, { status: "ready" })
        }
        if (outcome === 409) {
          return json(route, { error: { code: "relay_resolver_workspace_target_unavailable" } }, 409)
        }
        return json(route, { error: { code: "user_hosted_app_offline" } }, 503)
      }

      if (runtimePath === "/vcs") return json(route, {})
      if (runtimePath === "/mcp") return json(route, {})
      if (runtimePath === "/lsp") return json(route, [])
      if (runtimePath === "/agent") return json(route, [{ id: "build", name: "build", description: "Build agent", mode: "primary" }])
      if (runtimePath === "/command") return json(route, [])
      if (runtimePath === "/permission") return json(route, [])
      // Deliberately NOT left to the `json(route, {})` catch-all at the bottom of
      // this handler, and the difference is fatal rather than cosmetic. The
      // composer fetches this on every render (composer/permission-mode-wiring.ts),
      // and `harnessPermissionModes` reads `report.modes` straight off the body
      // (session/permission/modes.ts). An empty object has no `modes`, the read
      // used to throw inside a Solid memo, and the error escaped to the app-level
      // boundary — so the WHOLE page became "Something went wrong" and this spec
      // saw no composer at all rather than a broken one. The body below is
      // verbatim what workspace-runtime serves for a harness with no
      // adapter-reported modes (routes/session-core.ts), which is opencode — the
      // harness this spec's session config pins.
      if (runtimePath === "/permission/modes") {
        return json(route, {
          modes: [],
          unsupported: "opencode has no permission modes of its own",
          appliesFrom: "next-turn",
        })
      }
      if (runtimePath === "/question") return json(route, [])
      if (runtimePath === "/provider") {
        return json(route, {
          all: [{ id: "opencode", name: "opencode", env: [], models: { [BIG_PICKLE.id]: { id: BIG_PICKLE.id, name: BIG_PICKLE.name, release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } }],
          default: { opencode: BIG_PICKLE.id },
          connected: ["opencode"],
        })
      }
      if (runtimePath === "/api/wr/harness-config-options") {
        return json(route, { source: "runner", stale: false, options: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: BIG_PICKLE.id, selectOptions: [BIG_PICKLE] }] })
      }
      // The contract-v4 turn lane (see `runtimeBus` above). Frames are served from
      // the cursor-resumed log and already carry the full
      // `{contractVersion, directory, sessionId, assistantMessageId, payload}`
      // envelope the consumer expects, so they go on the wire verbatim.
      if (runtimePath === "/api/wr/runtime-events") {
        requests.runtimeEventsPollCount += 1
        const batch = await runtimeBus.drain(4000, lastEventId(route))
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: eventStream(batch) }).catch(() => {})
      }
      // ClaxedoEventsProvider's central stream + the legacy runtime-events alias:
      // neither carries this spec's turn, so a bare heartbeat is correct.
      if (runtimePath === "/api/wr/events" || runtimePath === "/api/claxedo/runtime-events") {
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": heartbeat\n\n" }).catch(() => {})
      }
      if (runtimePath === "/global/event" || runtimePath === "/event") {
        const batch = await sessionBus.drain(4000, lastEventId(route))
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: eventStream(batch) }).catch(() => {})
      }
      if (runtimePath === "/session/status") {
        return json(route, sessionCreated && sessionBusy ? { [SESSION_ID]: { type: "busy" } } : {})
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
      // The SESSION-scoped half of the same contract. `getPermissionModes`
      // (platform/runtime/agent/agent-runtime-client.ts) switches from the
      // directory-scoped `/permission/modes` to this path the moment a session id
      // exists — so a draft that becomes a session moves onto it mid-test, and
      // leaving it to the `{}` catch-all reintroduces the identical crash.
      if (/^\/session\/[^/]+\/permission-mode$/.test(runtimePath)) {
        return json(route, {
          modes: [],
          unsupported: "opencode has no permission modes of its own",
          appliesFrom: "next-turn",
        })
      }
      if (/^\/session\/[^/]+\/todo$/.test(runtimePath)) return json(route, [])
      if (/^\/session\/[^/]+\/message$/.test(runtimePath)) return json(route, messages)
      if (/^\/session\/[^/]+\/prompt_async$/.test(runtimePath)) {
        promptCount += 1
        requests.promptCount += 1
        const body = request.postDataJSON() as { messageID?: string; parts?: unknown; agent?: string; model?: { providerID?: string; modelID?: string } }
        const text = textOf(body?.parts) || `user-hosted message ${promptCount}`
        const userID = body?.messageID || `msg_uh_user_${promptCount}`
        // Production convention (`mkAssistantId`, workspace-runtime/src/session/
        // service.ts): the assistant reply's id is `${userMessageId}_r`. The app's
        // settle-triggered REST reconciliation (`syncSessionHistory` in
        // session-controller.ts, fired when the turn goes busy→idle) and its
        // `assistantMessageIdForUserMessage` matching (src/shared/data/
        // session-types.ts) both key on EXACTLY this id — so this id is what makes
        // the re-fetched message list render as the reply. The runtime frames
        // below carry the SAME id as their `assistantMessageId` so the compat
        // projection's streamed parts target the same message.
        const assistantID = `${userID}_r`
        messages = [
          ...messages,
          { info: { id: userID, sessionID: SESSION_ID, role: "user", time: { created: Date.now() }, model: { providerID: "opencode", modelID: BIG_PICKLE.id } }, parts: [{ id: `${userID}_text`, sessionID: SESSION_ID, messageID: userID, type: "text", text }] },
        ]
        await route.fulfill({ status: 204, body: "" })

        // Fire-and-forget: emit the turn as CONTRACT-V4 AgentRuntimeEvent frames on
        // the runtime-events lane. Each frame is the exact envelope `runtimeEnvelope`
        // (src/context/global-sdk.tsx) validates — `contractVersion` === 4,
        // `directory`, `sessionId`, `assistantMessageId`, and a `payload` that is one
        // `AgentRuntimeEvent` variant — then handed to `createOpencodeCompatProjection`.
        // The `session-status: busy` → `finish` pair drives the app's turn
        // busy→settled transition, and the settle re-fetches the message list over
        // the relay lane (which now carries the `${userID}_r` assistant row), which
        // is what renders the reply through the real projection path.
        const emitFrame = (payload: Record<string, unknown>) => {
          const frame = {
            contractVersion: RUNTIME_EVENT_CONTRACT_VERSION,
            directory: WORKSPACE_ID,
            sessionId: SESSION_ID,
            assistantMessageId: assistantID,
            payload,
          }
          requests.runtimeFramesEmitted.push(frame)
          runtimeBus.emit(frame)
        }

        void (async () => {
          await wait(20)
          sessionBusy = true
          emitFrame({ type: "session-status", status: "busy" })
          const fullText = `user-hosted ack ${promptCount}: ${text}`
          const midpoint = Math.max(1, Math.floor(fullText.length / 2))
          for (const chunk of [fullText.slice(0, midpoint), fullText.slice(midpoint)]) {
            await wait(20)
            emitFrame({ type: "text-delta", delta: chunk })
          }
          // Land the completed assistant row in the REST message list BEFORE the
          // `finish` frame, so the settle-triggered `syncSessionHistory` re-fetch
          // returns the reply. Mirrors the shape the local lane's driveTurn produces.
          const completedInfo = { id: assistantID, sessionID: SESSION_ID, role: "assistant", time: { created: Date.now(), completed: Date.now() }, parentID: userID, agent: "build", providerID: "opencode", modelID: BIG_PICKLE.id, mode: "code", path: { cwd: WORKSPACE_ID, root: WORKSPACE_ID }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
          const finalPart = { id: `${assistantID}_text`, sessionID: SESSION_ID, messageID: assistantID, type: "text", text: fullText }
          messages = [...messages, { info: completedInfo, parts: [finalPart] }]
          await wait(40)
          // `finish` projects to `message.completed` + `session.idle`, settling the turn.
          sessionBusy = false
          emitFrame({ type: "finish", sessionId: SESSION_ID })
        })()
        return
      }
      if (runtimePath === "/file" || runtimePath.startsWith("/file/")) return json(route, [])
      if (runtimePath === "/api/wr/diff/refs") return json(route, { branches: [], tags: [], recent: [] })
      if (runtimePath === "/api/wr/diff/targets") return json(route, {})
      if (runtimePath === "/api/wr/diff/vcs") return json(route, [])
      if (runtimePath.startsWith("/find")) return json(route, [])
      // Unmatched-but-relay-scoped path: accept generically rather than
      // faking an exact shape (e.g. a PTY create call this spec does not
      // otherwise model) — still recorded in `relayHits` above, which is
      // what behavior 3's routing assertion checks.
      return json(route, {})
    }

    // ---- Control-plane provider catalog (bare origin, ALWAYS) ----
    // The signed control plane serves a bare `GET /provider` (and
    // `/provider/auth`) that returns an EMPTY catalog for the default
    // (opencode) harness — the workspace's real provider/model list is a
    // RUNTIME-owned read routed through the relay (`/workspaces/:id/provider`
    // above), exactly as `packages/claxedo-server/src/routes/hosted/shell.ts`
    // (`GET /provider` → `emptyProvider()`) does. The app fires this global
    // control-plane catalog query independent of any workspace's readiness, so
    // — like `/api/claxedo/bootstrap` and `/api/control/session-list` above —
    // it is NOT the per-workspace runtime lane and is deliberately NOT counted
    // in `bareHitsDuringReady`.
    if (url.pathname === "/provider") return json(route, { all: [], connected: [], default: {} })
    if (url.pathname === "/provider/auth") return json(route, {})

    if (ready) requests.bareHitsDuringReady.push(`${method} ${url.pathname}`)
    // The usage outbox beacon fires on every boot (installUsageOutboxWakeups);
    // an empty outbox syncs to zeros. Same contract mock-runtime serves.
    if (url.pathname === "/api/claxedo/usage/sync") {
      return json(route, { attempted: 0, delivered: 0, conflicts: 0, pending: 0 })
    }
    return json(route, { error: "unhandled request in core-user-hosted-workspace mock", path: url.pathname }, 598)
  })

  return { requests }
}

function workspaceRoute(sessionId?: string) {
  return sessionId ? `/w/${encodeURIComponent(WORKSPACE_ID)}/session/${sessionId}` : `/w/${encodeURIComponent(WORKSPACE_ID)}/session`
}

test.describe("core user-hosted workspace @core", () => {
  test("landing on an unready user-hosted workspace renders the distinct 3-step pipeline — behavior 1", async ({ page }) => {
    // Pad well beyond the suite's 60s default: this is the FIRST navigation
    // of the file, which pays for cold dev-server compile on a shared server
    // that may also be serving other concurrent spec runs.
    test.setTimeout(120_000)
    // A generous mint delay (real-time, not simulated) so the pipeline is
    // guaranteed to still be on screen by the time the first assertion polls
    // it, regardless of dev-server cold-compile/hydration jitter on the very
    // first navigation of a run — the connect sequence itself has no fixed
    // mint-latency contract to pin (unlike the health retry constants in this
    // spec's STATE MODEL section), so this value is purely a test-timing
    // margin, not a behavior under test.
    await installUserHostedRuntimeMock(page, { health: [200], mintDelayMs: 3000, healthDelayMs: 800 })
    await seedProject(page, { registerWorkspace: true })

    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")

    const view = page.locator('[data-component="cloud-startup-view"]')
    await expect(view).toBeVisible({ timeout: 20_000 })
    await expect(view).toContainText("Connecting to workspace", { timeout: 10_000 })
    // The detail line under the heading is generic post-8d1227e44 (no more
    // step-specific `cloudSummary()` sentence for a plain mid-pipeline step),
    // so the distinct-3-step-pipeline proof is the row labels themselves.
    await expect(view).toContainText("Establishing relay tunnel", { timeout: 10_000 })
    await expect(view).toContainText("Checking runtime health")

    // Never the cloud pipeline's vocabulary.
    await expect(view).not.toContainText("Acquiring sandbox")
    await expect(view).not.toContainText("Cloning repository")
    await expect(view).not.toContainText("Starting runtime")
    await expect(view).not.toContainText("Waiting for health check")
    // Heading distinct from cloud's "Preparing workspace".
    await expect(page.getByText("Preparing workspace", { exact: true })).toHaveCount(0)

    // Composer is not offered while connecting.
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)

    await expect(view).toHaveCount(0, { timeout: 20_000 })
  })

  // The reply renders through the real projection path: the mock emits the turn as
  // CONTRACT-V4 AgentRuntimeEvent frames on the relay `/api/wr/runtime-events` lane
  // (`{contractVersion:4, directory, sessionId, assistantMessageId, payload}`), which
  // global-sdk's runtime loop reads via `runtimeEnvelope` and runs through
  // `createOpencodeCompatProjection`. The `session-status: busy` → `finish` pair
  // settles the turn, and the settle re-fetches the message list over the relay lane
  // (now carrying the `${userID}_r` assistant row) — see `installUserHostedRuntimeMock`
  // above. The runtime-native session id (`SESSION_ID` = `run_...`, not `ses_...`) is
  // what lets the frames pass `runtimeProjectionOwnsCompat`.
  test("ready unlocks the composer and a send is proven by the oracle through the relay lane — behaviors 2,3", async ({ page }) => {
    test.setTimeout(120_000)
    const mock = await installUserHostedRuntimeMock(page, { health: [200] })
    await seedProject(page, { registerWorkspace: true })

    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")

    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(input).toBeVisible({ timeout: CONTENTION_TIMEOUT })
    await expect(input).toHaveAttribute("contenteditable", "true")
    await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)
    // The gate unlocking only proves the CONNECTION is ready — the draft's own
    // provider/model catalog (a separate relay request, fired once the gate
    // renders children) can still be in flight for a moment after. Sending
    // before it resolves hits the composer's own (correct) "no-model" submit
    // block, which no-ops the click — wait for a real model to land in the
    // model control first, matching core-cloud-provisioning.spec.ts and
    // core-harness-ownership-cloud.spec.ts's established pattern.
    await expect(page.locator('[data-action="prompt-harness-model"]')).toContainText(/Big Pickle|big-pickle/i, {
      timeout: CONTENTION_TIMEOUT,
    })

    const promptText = "core user-hosted workspace first turn"
    await input.click()
    await input.fill(promptText)
    await expect(input).toContainText(promptText, { timeout: 10_000 })
    await page.locator(SELECTORS.submitControl).last().click()

    await expectAssistantReplyVisible(page, `user-hosted ack 1: ${promptText}`)
    await expectTurnCounts(page, { user: 1, assistant: 1 })

    // Behavior 3: everything that happened while ready went through the
    // relay lane; nothing hit a bare/global runtime equivalent instead.
    expect(mock.requests.promptCount).toBe(1)
    expect(mock.requests.relayHits.some((h) => h.includes("/prompt_async"))).toBe(true)
    expect(mock.requests.relayHits.some((h) => h.includes("/session") && h.startsWith("POST"))).toBe(true)
    expect(mock.requests.bareHitsDuringReady).toEqual([])

    // Consumption proof: the contract-v4 emitter is actually drained by the app —
    // the relay `/api/wr/runtime-events` stream was polled (> 0), and the frames the
    // reply was reconstructed from were really pushed onto that lane.
    expect(mock.requests.runtimeEventsPollCount).toBeGreaterThan(0)
    expect(mock.requests.relayHits.some((h) => h.includes("/api/wr/runtime-events"))).toBe(true)
    expect(mock.requests.runtimeFramesEmitted.map((f) => (f.payload as { type: string }).type)).toEqual([
      "session-status",
      "text-delta",
      "text-delta",
      "finish",
    ])
    for (const frame of mock.requests.runtimeFramesEmitted) {
      expect(frame.contractVersion).toBe(4)
      expect(frame.sessionId).toBe(SESSION_ID)
      // `${userID}_r` convention (Tier-M reconciliation rule, e2e/INVARIANTS.md).
      expect(String(frame.assistantMessageId).endsWith("_r")).toBe(true)
    }
  })

  test("a persistently offline host renders the terminal offline view with the exact claxedo-up copy — behavior 4", async ({ page }) => {
    // The real retry budget alone is ~22s (15 attempts * 1.5s); pad well
    // beyond the suite's 60s default so a slow/cold navigation on a shared,
    // possibly contended dev server doesn't race the test timeout
    // independent of the assertions.
    test.setTimeout(120_000)
    await installUserHostedRuntimeMock(page, { health: [503] })
    await seedProject(page, { registerWorkspace: true })

    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")

    const offline = page.getByTestId("workspace-offline")
    await expect(offline).toBeVisible({ timeout: 40_000 })
    await expect(offline).toContainText("Workspace host is offline")
    await expect(offline).toContainText(OFFLINE_DETAIL)
    await expect(page.getByTestId("workspace-offline-retry")).toBeVisible()

    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)
  })

  test("transient 409/503 health hiccups still reach ready — behavior 5", async ({ page }) => {
    test.setTimeout(120_000)
    // Two transient misses (409 then 503), third probe succeeds.
    await installUserHostedRuntimeMock(page, { health: [409, 503, 200] })
    await seedProject(page, { registerWorkspace: true })

    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")

    // Eventually reaches ready: the retry BUDGET tolerates transient
    // 409/503 rather than classifying them as the fail-fast "genuine
    // runtime error" branch (which never retries at all).
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(input).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)
  })

  test("a workspace ready before an earlier connect flips ready-to-offline on a warm reload while the host is now paused — behavior 6", async ({ page }) => {
    // Two navigations (initial connect + reload); pad generously beyond the
    // suite default for the same cold-navigation margin as behaviors 4/5.
    test.setTimeout(120_000)
    await installUserHostedRuntimeMock(page, { health: [200] })
    await seedProject(page, { registerWorkspace: true })

    // First connect: succeeds, marks the workspace "recently ready" in
    // localStorage (warm-start TTL).
    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(input).toBeVisible({ timeout: 20_000 })

    // The host is now paused: swap the mock so every future health probe
    // reports offline, matching a real "claxedo up" process having been
    // stopped after the first successful connect.
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === `/workspaces/${WORKSPACE_ID}/api/wr/health`) {
        return json(route, { error: { code: "user_hosted_app_offline" } }, 503)
      }
      return route.fallback()
    })

    // Reload WITHOUT re-running addInitScript's localStorage.clear() (no
    // new seedProject call) — the warm-start marker survives a real reload.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 })

    // The offline view eventually wins once the background health check
    // reports the host unreachable, proving "pause" surfaces as a real
    // transition rather than a UI stuck on stale "ready".
    await expect(page.getByTestId("workspace-offline")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("workspace-offline")).toContainText("Workspace host is offline")
  })

  test("the in-app Share workspace entry point registers the workspace and shows a confirmation toast — behavior 7", async ({ page }) => {
    test.setTimeout(120_000)
    // Deliberately NOT the user-hosted connect pipeline: `localWorkspaceShareTarget`
    // resolves against the project's own main workspace directory, so a plain
    // local session (no relay backing at all) is enough to reach the action —
    // see this spec's STATE MODEL section on share/register.
    const requests: string[] = []
    await page.route("**/*", async (route) => {
      if (!api(route)) return route.continue()
      const url = new URL(route.request().url())
      const method = route.request().method()

      if (url.pathname === "/api/claxedo/bootstrap") {
        return json(route, {
          healthy: true,
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
          project: [{ id: PROJECT_ID, worktree: DIR, name: "core-user-hosted-workspace", time: { created: Date.now(), updated: Date.now() } }],
          provider: { all: [{ id: "opencode", name: "opencode", env: [], models: { [BIG_PICKLE.id]: { id: BIG_PICKLE.id, name: BIG_PICKLE.name, release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } }], default: { opencode: BIG_PICKLE.id }, connected: ["opencode"] },
          provider_auth: {},
          config: { provider: { id: "opencode", model: BIG_PICKLE.id }, agent: { id: "build" } },
        })
      }
      if (url.pathname === "/project" || url.pathname === "/experimental/project") {
        return json(route, [{ id: PROJECT_ID, worktree: DIR, name: "core-user-hosted-workspace", time: { created: Date.now(), updated: Date.now() } }])
      }
      if (url.pathname === "/global/event" || url.pathname === "/event") {
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } })}\n\n` }).catch(() => {})
      }
      if (url.pathname === "/provider") return json(route, { all: [], connected: [], default: {} })
      if (url.pathname === "/provider/auth") return json(route, {})
      if (url.pathname === "/path") return json(route, { worktree: DIR })
      if (url.pathname === "/config") return json(route, { provider: { id: "opencode", model: BIG_PICKLE.id }, agent: { id: "build" } })
      if (url.pathname === "/agent" || url.pathname === "/app/agents") return json(route, [{ id: "build", name: "build", description: "Build agent" }])
      if (url.pathname === "/mcp") return json(route, {})
      if (url.pathname === "/lsp") return json(route, [])
      if (url.pathname === "/vcs") return json(route, {})
      if (url.pathname === "/command") return json(route, [])
      if (url.pathname === "/permission") return json(route, [])
      // Same fatal gap as the relay lane above: this mock's trailing
      // `json(route, {}, 200)` would serve `{}` here, the composer would read
      // `.modes` off it, and the app would render its error boundary instead of
      // the shell — which is exactly how this test lost `[data-claxedo]`.
      if (url.pathname === "/permission/modes") {
        return json(route, {
          modes: [],
          unsupported: "opencode has no permission modes of its own",
          appliesFrom: "next-turn",
        })
      }
      if (url.pathname === "/question") return json(route, [])
      if (url.pathname === "/session/status") return json(route, {})
      if (url.pathname === "/session" || url.pathname === "/experimental/session") return json(route, [])
      if (isWorkspaceResolvePath(url.pathname)) {
        return json(route, { workspaceId: `local-${PROJECT_ID}`, directory: DIR, kind: "local", status: "ready" })
      }

      if (url.pathname === `/api/workspace/${encodeURIComponent(PROJECT_ID)}/user-hosted/register` && method === "POST") {
        requests.push(`${method} ${url.pathname}`)
        return json(route, { workspaceId: PROJECT_ID, registered: true })
      }

      return json(route, {}, 200)
    })

    await seedProject(page, { registerWorkspace: false })
    await page.goto(`/s/new`, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    const moreOptions = page.getByRole("button", { name: /More options for/i }).first()
    await expect(moreOptions).toBeVisible({ timeout: CONTENTION_TIMEOUT })
    await moreOptions.hover()
    await moreOptions.click({ force: true })

    const shareItem = page.getByRole("menuitem", { name: /Share workspace/i })
    await expect(shareItem).toBeVisible({ timeout: CONTENTION_TIMEOUT })
    await shareItem.click()

    // Await the confirmation toast explicitly (it appears only after the register
    // POST resolves) — the register-request assertion below then confirms the exact
    // network effect that produced it.
    await expect(page.locator('[data-slot="toast-title"]')).toContainText("Workspace shared", {
      timeout: CONTENTION_TIMEOUT,
    })
    expect(requests).toEqual([`POST /api/workspace/${encodeURIComponent(PROJECT_ID)}/user-hosted/register`])
  })
})
