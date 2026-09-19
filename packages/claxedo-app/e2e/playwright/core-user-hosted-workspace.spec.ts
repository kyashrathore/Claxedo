/**
 * Connecting to a user-hosted workspace: a real machine somebody is running `claxedo up`
 * on, reached through the Workspace Relay tunnel. Nothing is provisioned or cloned — the
 * workspace already exists — so the whole "getting ready" story is about reaching it.
 * Everything here is mocked; a real tunnel, real JWTs, WS multiplexing and transport-layer
 * role enforcement belong to live-user-hosted-relay.spec.ts.
 *
 * The connection authority is the one cloud workspaces use: `workspaceConnection`, keyed by
 * `workspaceId` and ref-counted across mounted panes. `WorkspaceGate` renders
 * `CloudStartupView variant="user-hosted"` until status is `ready`, `WorkspaceOfflineView`
 * when status is `{offline: reason}`, and its children once ready.
 *
 * STATE MODEL — the SAME single connection authority as cloud workspaces owns this:
 * `workspaceConnection` (in-memory Solid store, `src/features/workspaces/data/
 * workspace-connection.ts`), keyed by `workspaceId`, ref-counted across mounted panes.
 * `WorkspaceGate` (`src/features/workspaces/data/workspace-gate.tsx`) renders `CloudStartupView
 * variant="user-hosted"` while `connections[workspaceId].status !== "ready"`, the terminal
 * `WorkspaceOfflineView` while `status` is `{offline: reason}`, and `props.children`
 * (the real session/composer surface) once `status === "ready"`.
 *   Kind resolution — `sessionWorkspaceRuntimeRef` (`src/platform/runtime/session-
 *   workspace.ts`) reads the workspace's kind off the signed project inventory
 *   (`/api/claxedo/bootstrap`'s `project[].workspaces` map); a `ws_`-shaped workspaceId
 *   with NO matching inventory entry DEFAULTS to `"user-hosted"` (never `"cloud"` —
 *   `"cloud"` would route through the sandbox-provisioning resolve endpoint, which 404s
 *   for a workspace that has no central sandbox). This spec registers the workspace
 *   explicitly as `kind: "user-hosted"` for clarity rather than relying on the default.
 *   Connect sequence — `acquireWorkspaceConnection` → `driveConnection` (kind
 *   `"user-hosted"`) calls `prepareUserHostedRuntime` (`src/platform/runtime/cloud/
 *   workspace-runtime-store.ts`) directly — NO `/api/workspace/resolve` polling and NO `provision`
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
 *   loop keeps running underneath and can still recover to `ready` — see BEHAVIORS #5;
 *   (4) any other non-2xx fails FAST (no
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
 *   Share/register — sharing is MACHINE level and no longer a per-workspace gesture.
 *   Enabling remote access (Settings > Devices) publishes every local workspace this
 *   machine holds, and one opened later is published as soon as the inventory reports it.
 *   The reconciler is `useLocalWorkspaceAutoShareDriver` (`features/workspaces/data/auto-
 *   share-local-workspaces.tsx`), mounted once by the app shell in `app/entry/runtime-
 *   providers.tsx`; per workspace it still fires the same ONE-SHOT
 *   `publishWorkspacePlacement` (`features/workspaces/data/share-workspace.ts`) →
 *   `POST /api/workspace/:id/host-assignment`. It does not touch `workspaceConnection` at
 *   all — it is orthogonal to the connect pipeline above. Which workspaces qualify is
 *   still `localWorkspaceShareTarget`
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
 *     composer unlocks when the runtime is ready.") for a plain mid-pipeline step; a
 *     `cloudSummary()` sentence appears only on error or ready-handoff — so this spec
 *     proves the 3-step pipeline via the row labels themselves, not a step-specific
 *     summary sentence.
 *   `[data-testid="workspace-offline"]` (`src/features/workspaces/data/workspace-gate.tsx`'s
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
 *   Settings > Devices — the one remote-access surface. Off state offers a single
 *     "Enable remote access" button; once on, the machine card states `Serving N
 *     workspaces` beside a live dot that is green only when the published set equals the
 *     machine's local inventory. There is no per-workspace tick list and no per-workspace
 *     QR: the rail's old "Share workspace" kebab item was removed with them.
 *
 * A successful connect is remembered per workspace in
 * `localStorage['claxedo.workspace-connection.ready.v1']` for 60s. A reconnect inside that
 * window renders `ready` from frame zero while the health check runs behind it
 * (`keepReadyWhileChecking`, so status is not reset to connecting first), and the same
 * `onOffline` path flips that optimistic render to the offline view if the host has since
 * gone away. That transition is what "paused" looks like.
 *
 * `"no-host"` is the only offline reason exercised here, and it is not terminal, so the
 * offline view offers Retry. Its copy comes from the gate's own `OFFLINE_COPY`;
 * `prepareUserHostedRuntime` carries a slightly different default message that is never
 * rendered.
 *
 * Sharing is a machine-level gesture, not a per-workspace one: enabling remote access in
 * Settings > Devices publishes every local workspace this machine holds, reconciled by
 * `useLocalWorkspaceAutoShareDriver` through the same one-shot
 * `publishWorkspacePlacement` → `POST /api/workspace/:id/host-assignment`. It never
 * touches `workspaceConnection`.
 */
import { isWorkspaceResolvePath } from "../helpers/contracts/workspace-resolve"
import { isSessionInventoryPath, isSessionListPath } from "../helpers/contracts/session-list"
import {
  isSessionRegistrationReservePath,
  parseSessionReservationRequest,
  sessionReservationResponse,
  sessionReservationStatus,
} from "../helpers/contracts/session-registration"
import { expect, test, type Page, type Route } from "@playwright/test"
import { ensureComposerModelSelected, expectAssistantReplyVisible, expectTurnCounts, selectComposerAgent, SELECTORS } from "../helpers/turn-oracle"
import { stampTestAuth } from "../playwright-global-setup"
import {
  assertSessionConfigPatchResponse,
  parseSessionConfigPatch,
  SESSION_CONFIG_PATCH_SUCCESS_STATUS,
} from "../helpers/contracts/session-config"
import { draftDefaultStorageKey } from "../../src/features/session/harness/draft-defaults"
import { DEFAULT_LOCAL_CLAXEDO_SERVER_URL } from "../../src/platform/api/local-server"
import { eventStream, lastEventId } from "../helpers/sse-route"
import { createClientPresentationProjection } from "@claxedo/agent-event-runtime/client-presentation"

const PROJECT_ID = "proj_core_user_hosted_workspace"
const WORKSPACE_ID = "ws_core_user_hosted_workspace"
const SESSION_ID = "run_core_user_hosted_workspace"
const DIR = "/tmp/e2e-core-user-hosted-workspace"
// The path the HOST machine serves this workspace from — a directory on
// somebody else's filesystem. The control plane reports it as the row's
// `remote_directory`, and it is metadata only: nothing in the app may address
// the workspace, or a session on it, by this path.
const HOST_DIR = "/Users/host/e2e-core-user-hosted-workspace"
// The one identity the app addresses this workspace by — `workspaceRowDirectory`
// in src/features/workspaces/data/workspace-catalog.ts, and the same form
// `sessionRowDirectory` stamps on every session row of a relay-backed workspace.
const WORKSPACE_REF = `workspace:${WORKSPACE_ID}`
// Contention-tolerant ceiling for reactive UI transitions that a starved CI runner
// was blowing past the 10-20s local budget (CI-only "runner-contention timing";
// the oracle-send and Share-toast waits are the named victims). Every use
// still awaits the actual state transition — this only outlasts host lag, it never
// weakens what is asserted.
const CONTENTION_TIMEOUT = 45_000
// Real, versioned, servable house-model id — NOT the bare "big-pickle", which
// the app reserves as the non-selectable pre-provisioning placeholder
// (`signed-workspace-model.ts`); serving that exact id as the only model leaves
// the composer stuck on "Select model". Display name stays "Big Pickle".
const BIG_PICKLE = { id: "big-pickle-1", name: "Big Pickle" }

// The title the host's runtime already carries for a session created before
// this page loaded — the rail has no other way to name it.
const SEEDED_SESSION_TITLE = "session on the host"

// The last user message of that already-existing transcript. A turn started on
// the HOST answers it, and the runtime announces the reply as `${id}_r`.
const HOST_USER_MESSAGE_ID = "msg_uh_host_turn"
const IDLE_SESSION_ID = "run_core_user_hosted_idle"
const IDLE_SESSION_TITLE = "idle since it was created"

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

type HealthOutcome = 200 | 409 | 503

async function seedProject(page: Page, opts: { registerWorkspace: boolean; model?: typeof BIG_PICKLE }) {
  const serverUrl = process.env.VITE_CLAXEDO_SERVER_URL ?? DEFAULT_LOCAL_CLAXEDO_SERVER_URL
  await page.addInitScript(
    (input: {
      dir: string
      workspaceId: string
      registerWorkspace: boolean
      draftDefaultKey: string
      model?: typeof BIG_PICKLE
    }) => {
      localStorage.clear()
      ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
        serverUrl: window.location.origin,
        activeDirectory: input.dir,
      }
      localStorage.setItem(
        "claxedo.global.dat:server",
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
      if (input.model) {
        localStorage.setItem(input.draftDefaultKey, JSON.stringify({
          version: 1,
          harness: "opencode",
          model: { providerID: "opencode", modelID: input.model.id },
          labels: { provider: "opencode", model: input.model.name },
        }))
      }
    },
    {
      dir: DIR,
      workspaceId: WORKSPACE_ID,
      registerWorkspace: opts.registerWorkspace,
      draftDefaultKey: draftDefaultStorageKey({ serverUrl, workspaceKey: WORKSPACE_ID }),
      model: opts.model,
    },
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
    /** The host already has a session; `GET /session` answers with it. */
    existingRuntimeSession?: boolean
    /** A SECOND host session, created later but idle ever since. */
    idleRuntimeSession?: boolean
  },
) {
  // The workspace runtime's one stream, `${relayUrl}/workspaces/:id/api/wr/events`.
  // The host's daemon composes the unbound local session policy, so it serves
  // it WORKSPACE-WIDE to its owner: every session's projected turn frames
  // (`{ directory, payload }` presentation events, projected on the HOST from
  // the harness's raw runtime frames by `createClientPresentationProjection`),
  // and the workspace's control frames — `pty.*`, `process.*`, `agent.lifecycle`,
  // `session.lifecycle` — which belong to no session and which a route with no
  // session (a terminal) has to be able to open.
  const workspaceBus = new Bus<Record<string, unknown>>()
  let sessionCreated = opts.existingRuntimeSession ?? false
  let sessionBusy = false
  // A session that already exists on the host has a transcript, and it is the
  // ONLY thing this client fetches: the last user message, with no reply.
  //
  // That is what an attached viewer holds. The host creates a turn's assistant
  // row when the turn STARTS (`mkAssistantId` -> `buildAssistantMessage`,
  // workspace-runtime `session/service.ts`), which is after this client read
  // the transcript, and nothing refetches it — the behavior below asserts the
  // refetch count never moves. So the reply's row and its text both have to
  // arrive on the workspace stream or not at all.
  let messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> =
    opts.existingRuntimeSession
      ? [
        {
          info: { id: HOST_USER_MESSAGE_ID, sessionID: SESSION_ID, role: "user", time: { created: 1 }, model: { providerID: "opencode", modelID: BIG_PICKLE.id } },
          parts: [{ id: `${HOST_USER_MESSAGE_ID}_text`, sessionID: SESSION_ID, messageID: HOST_USER_MESSAGE_ID, type: "text", text: SEEDED_SESSION_TITLE }],
        },
      ]
      : []
  let promptCount = 0
  let healthAttempt = 0
  const requests = {
    createSessionCount: 0,
    promptCount: 0,
    healthProbeCount: 0,
    mintCount: 0,
    /** The raw runtime frames the host projected a turn from, in order. */
    runtimeFramesEmitted: [] as Array<Record<string, unknown>>,
    /** `?sessionID=` of every `/api/wr/events` GET, in order (`null` = workspace-wide). */
    workspaceEventScopes: [] as Array<string | null>,
    /**
     * `Last-Event-ID` of every `/api/wr/events` GET. A cursor past a frame's id
     * is the reader's own receipt for it: only a consumer that parsed the frame
     * off the wire can resume from beyond it.
     */
    workspaceEventCursors: [] as number[],
    /** GETs of `/session/:id/message` — the whole-turn refetch path. */
    messageFetchCount: 0,
    relayHits: [] as string[],
    bareHitsDuringReady: [] as string[],
    /**
     * Every request that scoped itself by the HOST's own filesystem path —
     * `?directory=/Users/host/…` or the same value in `x-opencode-directory`.
     * The path exists only on the machine serving this workspace, so whichever
     * server received such a request cannot answer it. Must stay empty.
     */
    hostPathScopes: [] as string[],
  }
  let ready = false
  const attachedTurnProjections = new Map<string, ReturnType<typeof createClientPresentationProjection>>()

  const sessionConfig = () => ({
    harness: { id: "pi", access: "native" },
    model: { providerID: "opencode", modelID: BIG_PICKLE.id },
    agent: "build",
  })
  // A runtime always names its OWN filesystem path; `sessionRowDirectory` is
  // what decides the identity the row carries into the app.
  const sessionRow = () => ({
    id: SESSION_ID,
    slug: SESSION_ID,
    projectID: PROJECT_ID,
    directory: HOST_DIR,
    title: textOf(messages[0]?.parts) || SEEDED_SESSION_TITLE,
    version: "2",
    time: { created: 1, updated: Date.now() },
    summary: { additions: 0, deletions: 0, files: 0 },
    config: sessionConfig(),
  })

  // Created AFTER the session above and untouched since: the two rows order
  // one way by creation and the other way by activity, so the rail's order is
  // decided rather than accidental.
  const idleSessionRow = () => ({
    id: IDLE_SESSION_ID,
    slug: IDLE_SESSION_ID,
    projectID: PROJECT_ID,
    directory: HOST_DIR,
    title: IDLE_SESSION_TITLE,
    version: "2",
    time: { created: Date.now(), updated: 2 },
    summary: { additions: 0, deletions: 0, files: 0 },
    config: sessionConfig(),
  })

  // Shaped as `controlPlaneCatalogProjects` builds it from a real
  // `/api/workspace?access=user-hosted` row: the workspace is keyed and
  // addressed by `workspace:<id>`, and the host's own path rides along as
  // `remote_directory` — the workspace's LOCATION, which the UI can show and
  // nothing may scope a request by.
  const projectRow = () => ({
    id: PROJECT_ID,
    worktree: DIR,
    name: "core-user-hosted-workspace",
    sandboxes: [WORKSPACE_REF],
    workspaces: {
      [WORKSPACE_REF]: {
        id: WORKSPACE_ID,
        workspaceId: WORKSPACE_ID,
        kind: "user-hosted",
        role: "owner",
        hostOnline: true,
        workspace_name: "shared",
        directory: WORKSPACE_REF,
        remote_directory: HOST_DIR,
      },
    },
  })

  // An unsigned loopback surface reads the control plane's notices over a
  // WebSocket; nothing this mock drives rides it, so it is held open quietly.
  await page.routeWebSocket("**/api/cp/events**", (socket) => {
    socket.send('id: 0\ndata: {"type":"heartbeat"}\n\n')
  })
  await page.route("**/*", async (route) => {
    if (!api(route)) return route.continue()
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()

    // Record — never answer — any read that scoped itself by the HOST's path.
    // Recording it rather than failing the request keeps the surrounding
    // behavior intact, so the assertion reads as "this never happened" instead
    // of as a cascade of downstream failures.
    for (const scope of [url.searchParams.get("directory"), request.headers()["x-opencode-directory"]]) {
      if (scope === HOST_DIR) requests.hostPathScopes.push(`${method} ${url.pathname}`)
    }

    // Intent-time sprite warming uses fetch(), so Playwright reports these
    // static bundle reads as the same resource type as an API request. They
    // are not a workspace-runtime lane at all; let Vite serve both its built
    // `/assets` namespace and dev-only `/@fs` source assets, keeping the
    // bare-hit oracle scoped to runtime/control APIs.
    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/@fs/")) return route.continue()

    // Bootstrap discovery is legitimately bare-origin at ANY readiness state
    // (it is how the app learns which workspaces/projects exist at all, not
    // part of the per-workspace runtime lane Behavior 3 pins) — it is
    // deliberately NOT counted in `bareHitsDuringReady`.
    if (url.pathname === "/api/claxedo/bootstrap") {
      return json(route, {
        healthy: true,
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
        events: { hostAggregate: true },
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
    // ---- Control-plane session inventory + notice stream (bare
    // origin, always — independent of any workspace's connect/ready state;
    // `src/context/global-sync/inventory-source.ts` and
    // `src/providers/claxedo-events.tsx`). Not part of the per-workspace runtime
    // lane, so never counted in `bareHitsDuringReady`.
    if (isSessionListPath(url.pathname)) {
      return json(route, { view: { scope: "global", groupBy: "none", sort: "updated_desc", limit: 50 }, items: [], groups: [] })
    }
    // Flat control-plane inventory, both spellings (`fetchLocalControlSessions`
    // now reads GET /api/claxedo/session) — control-plane discovery like the
    // session-list above, not the per-workspace runtime lane.
    if (isSessionInventoryPath(url.pathname)) return json(route, { sessions: [] })
    if (url.pathname === "/api/claxedo/agent-config/connections") {
      return json(route, { status: "supported", connections: [] })
    }
    if (url.pathname === "/api/claxedo/agent-config/harness") {
      const selected = { kind: "native", harnessId: "pi" }
      return json(route, { harness: selected, activeHarness: selected, model: BIG_PICKLE.id, ok: true, status: "ready", ready: true })
    }
    if (url.pathname === "/api/workspace") return json(route, { workspaces: [] })
    // The control plane's notice stream. `ClaxedoEventsProvider` opens it on
    // every signed page; leaving it unanswered does not silence a stream, it
    // makes the provider retry a rejected fetch for the life of the page and
    // charge every attempt to the bare-origin count.
    if (url.pathname === "/api/cp/events") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'id: 0\ndata: {"type":"heartbeat"}\n\n' }).catch(() => {})
    }
    // The daemon's HOST AGGREGATE: `/api/wr/events` naming no workspace, which
    // a loopback surface opens for its own local runtimes. Bare-origin by
    // contract — it is the daemon's own route, not this workspace's runtime
    // lane — so it is answered here and never counted below. It carries
    // nothing of a user-hosted workspace: that runtime is on another machine
    // and speaks only through the relay mount above.
    if (url.pathname === "/api/wr/events") {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'id: 0\ndata: {"type":"heartbeat"}\n\n' }).catch(() => {})
    }
    // Session share grants (`listSessionShares`, src/features/session/data/
    // session-share-api.ts → GET /api/control/sessions/:id/shares?workspaceId=…).
    // Control-plane people data about a session, never the workspace runtime —
    // same category as the inventory above. Nobody has shared this session.
    if (/^\/api\/control\/sessions\/[^/]+\/shares$/.test(url.pathname) && method === "GET") {
      return json(route, { can_manage_shares: true, grants: [], participants: [], teams: [] })
    }
    // The signed session-reservation boundary a relay-backed send crosses
    // BEFORE the runtime create (`reservePrivateSession`,
    // src/platform/runtime/private-session-reservation.ts). Bare origin by
    // design — it is the control plane's own route — so it is not part of the
    // runtime lane either. Unanswered it does not degrade: the
    // client refuses a receipt that is not its own intent and the send aborts
    // before any session exists. See ../helpers/contracts/session-registration.ts.
    if (isSessionRegistrationReservePath(url.pathname) && method === "POST") {
      const reservation = parseSessionReservationRequest(request.postDataJSON?.() ?? undefined, request.url())
      const result = sessionReservationResponse(reservation)
      return json(route, result, sessionReservationStatus(result))
    }
    if (/^\/api\/control\/workspaces\/[^/]+\/sessions\/[^/]+\/(register|checkpoint|repair)$/.test(url.pathname) && method === "POST") {
      // `src/platform/runtime/agent/session-projection.ts` fire-and-forget pull —
      // bare origin by design (`getClaxedoServerUrl()`), not the relay lane.
      return json(route, { ok: true })
    }
    // Sharing is control-plane metadata, not a workspace runtime operation.
    // Answer it before the ready-state routing oracle so the oracle remains
    // scoped to requests that could legitimately have leaked off the relay.
    if (/^\/api\/control\/sessions\/[^/]+\/shares$/.test(url.pathname) && method === "GET") {
      return json(route, {
        can_manage_shares: false,
        grants: [],
        participants: [],
        teams: [],
      })
    }
    // A `ws_...`-shaped workspaceId with no inventory entry defaults to
    // "user-hosted" (`sessionWorkspaceRuntimeRef`), but OTHER resolve calls for
    // unrelated ids (there shouldn't be any in this spec) must not fall through
    // to the unhandled-request 598 below.
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
        // What `user-hosted-connection.ts` mints: the HOST's own runtime is the
        // authority for this workspace's sessions, so the app reads and opens
        // them there rather than in the control plane's registry.
        sessionAuthority: "local",
        relayUrl: url.origin,
        runtimeAccessToken: `rat_${WORKSPACE_ID}`,
        tokenExpiresAt: Date.now() + 10 * 60_000,
      })
    }

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
      if (runtimePath === "/agent") return json(route, [{ id: "build", name: "build", description: "Build agent", mode: "primary" }])
      if (runtimePath === "/command") return json(route, [])
      if (runtimePath === "/permission") return json(route, [])
      // Not left to the `json(route, {})` catch-all at the bottom of this handler, and
      // the difference is fatal rather than cosmetic. The composer fetches this on every
      // render (composer/permission-mode-wiring.ts), and `harnessPermissionModes` reads
      // `report.modes` straight off the body (session/permission/modes.ts). An empty
      // object has no `modes`; that read throws inside a Solid memo and escapes to the
      // app-level boundary, so the whole page becomes "Something went wrong" and there is
      // no composer left to assert on. The body below is what workspace-runtime serves
      // for a harness with no adapter-reported modes (routes/session-core.ts).
      if (runtimePath === "/permission/modes") {
        return json(route, {
          modes: [],
          unsupported: "Pi runs tools on the selected machine and exposes no permission policy",
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
      // The workspace's stream (see `workspaceBus` above). Recorded with its
      // scope so a spec can prove the app opened the WORKSPACE-WIDE form this
      // runtime serves its owner rather than a session-scoped one a
      // session-less route could never open.
      if (runtimePath === "/api/wr/events") {
        requests.workspaceEventScopes.push(url.searchParams.get("sessionID"))
        requests.workspaceEventCursors.push(lastEventId(route))
        const batch = await workspaceBus.drain(4000, lastEventId(route))
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
      if (runtimePath === "/session") {
        return json(route, sessionCreated ? [sessionRow(), ...(opts.idleRuntimeSession ? [idleSessionRow()] : [])] : [])
      }
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
      // The SESSION-scoped half of the same contract. `getPermissionModes`
      // (platform/runtime/agent/agent-runtime-client.ts) switches from the
      // directory-scoped `/permission/modes` to this path the moment a session id
      // exists — so a draft that becomes a session moves onto it mid-test, and
      // leaving it to the `{}` catch-all reintroduces the identical crash.
      if (/^\/session\/[^/]+\/permission-mode$/.test(runtimePath)) {
        return json(route, {
          modes: [],
          unsupported: "Pi runs tools on the selected machine and exposes no permission policy",
          appliesFrom: "next-turn",
        })
      }
      if (/^\/session\/[^/]+\/todo$/.test(runtimePath)) return json(route, [])
      if (/^\/session\/[^/]+\/message$/.test(runtimePath)) {
        requests.messageFetchCount += 1
        // The real route answers a page envelope (`{ messages, maxEventOrdinal }`),
        // never a bare array — see mock-runtime's `**/session/*/message**`.
        return json(route, { messages, maxEventOrdinal: 0 })
      }
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
        // `assistantMessageIdForUserMessage` matching (src/features/session/data/
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

        // Fire-and-forget: drive the turn the way the HOST does — the harness's
        // raw `AgentRuntimeEvent` frames go through the host's own compat
        // projection (`createTurnEventProjector`, agent-sdk-runtime), and what
        // that projection produces is BOTH what the runtime store persists (so
        // `GET /session/:id/message` reads it back) AND what `wr/events`
        // carries to this client. Running the one projection here for both is
        // how the mock keeps the streamed part and the settled part the same
        // identity; an invented id would make the settle look like a SECOND
        // part beside the one the client streamed — a duplicate the real runtime
        // never produces. The projected `session.status busy` → `message.completed`
        // + `session.idle` pair drives the app's turn busy→settled transition.
        const hostProjection = createClientPresentationProjection({
          sessionId: SESSION_ID,
          directory: HOST_DIR,
          assistantMessageId: assistantID,
        })
        const persistedParts = new Map<string, { id: string; sessionID: string; messageID: string; type: string; text: string }>()
        const persistCompat = (payload: Record<string, unknown>) => {
          const projected = hostProjection.ingest(payload as never).map((event) => event.payload)
          for (const event of projected) {
            if (event.type === "message.part.updated") {
              const part = event.properties.part as { id: string; type: string; text?: string }
              if (part.type !== "text") continue
              persistedParts.set(part.id, {
                id: part.id,
                sessionID: SESSION_ID,
                messageID: assistantID,
                type: "text",
                text: part.text ?? "",
              })
              continue
            }
            if (event.type !== "message.part.delta") continue
            const existing = persistedParts.get(event.properties.partID)
            if (existing) existing.text += event.properties.delta
          }
          return projected
        }
        const emitFrame = (payload: Record<string, unknown>) => {
          requests.runtimeFramesEmitted.push({
            directory: HOST_DIR,
            sessionId: SESSION_ID,
            assistantMessageId: assistantID,
            payload,
          })
          // A runtime stamps every frame with its OWN filesystem path — see
          // `HOST_DIR`. Addressing the frame as the workspace is the CLIENT's
          // job (`eventStreamFrameAddress`),
          // so emitting the workspace id here would hide that translation and
          // let a change in it pass unnoticed.
          for (const event of persistCompat(payload)) workspaceBus.emit({ directory: HOST_DIR, payload: event })
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
          messages = [...messages, { info: completedInfo, parts: [...persistedParts.values()] }]
          await wait(40)
          // `finish` projects to `message.completed` + `session.idle`, settling the turn.
          sessionBusy = false
          emitFrame({ type: "finish", sessionId: SESSION_ID })
        })()
        return
      }
      // `GET /session/:id/goal/state` (workspace-runtime `session-core.ts`): the
      // session view reads the Goal capabilities and the goal in one round trip
      // on activation; a harness without Goals answers "not implemented" with a
      // null goal.
      if (/^\/session\/[^/]+\/goal\/state$/.test(runtimePath)) {
        return json(route, { capabilities: { implemented: false, available: false, actions: [] }, goal: null })
      }
      if (runtimePath === "/file" || runtimePath.startsWith("/file/")) return json(route, [])
      if (runtimePath === "/api/wr/diff/refs") return json(route, { branches: [], tags: [], recent: [] })
      if (runtimePath === "/api/wr/diff/targets") return json(route, {})
      if (runtimePath === "/api/wr/diff/vcs") return json(route, [])
      if (runtimePath.startsWith("/find")) return json(route, [])
      // Unmatched-but-relay-scoped path: accept generically rather than
      // faking an exact shape (e.g. a PTY create call this spec does not
      // otherwise model) — still recorded in `relayHits` above, which is what the
      // routing assertion checks.
      return json(route, {})
    }

    // ---- Control-plane provider catalog (bare origin) ----
    // Production's unscoped `GET /provider` is empty (`emptyProvider()`); the
    // workspace catalog is a relay read. A catalog harness's composer list,
    // however, is `useProviders(<pi|opencode>)` →
    // `GET /api/claxedo/agent-config/providers?nativeHarness=…&directory=…`
    // (`providerListQuery`, src/platform/query/control-plane.ts), and until
    // that request is rewritten onto `/workspaces/:id/...` the picker is fed
    // this bare response. Serving the same catalog the relay lane returns
    // keeps the draft selectable without inventing an app auto-seed. Unscoped
    // (no harness) stays empty so the control-plane contract is still
    // exercised.
    if (url.pathname === "/provider" || url.pathname === "/api/claxedo/agent-config/providers") {
      const harness = url.searchParams.get("nativeHarness") ?? url.searchParams.get("harness")
      if (harness === "pi" || harness === "opencode") {
        return json(route, {
          all: [{ id: "opencode", name: "opencode", env: [], models: { [BIG_PICKLE.id]: { id: BIG_PICKLE.id, name: BIG_PICKLE.name, release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } }],
          default: { opencode: BIG_PICKLE.id },
          connected: ["opencode"],
        })
      }
      return json(route, { all: [], connected: [], default: {} })
    }
    if (url.pathname === "/provider/auth" || url.pathname === "/api/claxedo/agent-config/providers/auth") return json(route, {})

    // ---- Central boot reads (bare origin, always) ----
    // Each of these is issued by a mount, not by a workspace: the shell's home-directory
    // read (`pathQuery` via `queryOptions.path(null)`), the central connection's health
    // probe (`checkOpenCodeServerHealthCached`), this machine's remote-access device list
    // and the usage outbox beacon (`installUsageOutboxWakeups`). They belong with the
    // bootstrap/inventory block above — central discovery, never the per-workspace
    // runtime lane — and answering them here is what keeps the routing oracle meaning "no
    // bare runtime equivalent". They are issued concurrently with the first
    // `/api/wr/health` probe, i.e. with the very request that flips `ready`, so an
    // unmodeled one falls through to the counter below on whichever side of that race it
    // lands and reads as a bare runtime hit it never was.
    if (url.pathname === "/path") {
      return json(route, { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" })
    }
    if (url.pathname === "/global/health") return json(route, { healthy: true, version: "1.0.0-test" })
    // The central's own health document (`claxedoHealthUrl`, `checkServerHealth`):
    // the composer reads `localExecution` from it to decide which environments
    // it offers — a central read, and one this loopback central answers with
    // `localExecution: true` exactly as the real local server does.
    if (url.pathname === "/api/claxedo/health") return json(route, { healthy: true, version: "1.0.0-test", localExecution: true })
    // The central is up; nothing has been published from this surface.
    if (url.pathname === "/api/claxedo/remote-access/devices") return json(route, { devices: [] })
    // An empty outbox syncs to zeros. Same contract mock-runtime serves.
    if (url.pathname === "/api/claxedo/usage/sync") {
      return json(route, { attempted: 0, delivered: 0, conflicts: 0, pending: 0 })
    }

    if (ready) requests.bareHitsDuringReady.push(`${method} ${url.pathname}`)
    return json(route, { error: "unhandled request in core-user-hosted-workspace mock", path: url.pathname }, 598)
  })

  return {
    requests,
    /**
     * Feeds one raw runtime frame to the HOST's projection for a turn nobody
     * here started, and publishes what it projects on the workspace stream —
     * exactly how such a turn reaches an attached viewer. The host's projector
     * announces the assistant row the parts hang from: `AgentRuntimeEvent` has
     * no message variant, so the row can come from nowhere else.
     */
    emitRuntimeFrame(payload: Record<string, unknown>, input: { assistantMessageId: string }) {
      requests.runtimeFramesEmitted.push({
        directory: HOST_DIR,
        sessionId: SESSION_ID,
        assistantMessageId: input.assistantMessageId,
        payload,
      })
      let projection = attachedTurnProjections.get(input.assistantMessageId)
      if (!projection) {
        projection = createClientPresentationProjection({
          sessionId: SESSION_ID,
          directory: HOST_DIR,
          assistantMessageId: input.assistantMessageId,
          announcesAssistantMessage: true,
        })
        attachedTurnProjections.set(input.assistantMessageId, projection)
      }
      for (const event of projection.ingest(payload as never)) workspaceBus.emit({ directory: HOST_DIR, payload: event.payload })
    },
    /**
     * The transcript `GET /session/:id/message` serves, right now.
     *
     * The refetch oracle: a reply that is not in here cannot have been put on
     * screen by a whole-turn refetch, however many of those happen.
     */
    restTranscript() {
      return messages
    },
    /** Publishes one of the workspace's control frames on its stream. */
    emitWorkspaceFrame(payload: Record<string, unknown>) {
      workspaceBus.emit({ directory: HOST_DIR, payload })
    },
  }
}

function workspaceRoute(sessionId?: string) {
  return sessionId ? `/w/${encodeURIComponent(WORKSPACE_ID)}/session/${sessionId}` : `/w/${encodeURIComponent(WORKSPACE_ID)}/session`
}

test.describe("core user-hosted workspace @core", () => {
  test("landing on an unready user-hosted workspace renders the distinct 3-step pipeline", async ({ page }) => {
    // Pad well beyond the suite's 60s default: this is the FIRST navigation
    // of the file, which pays for cold dev-server compile on a shared server
    // that may also be serving other concurrent spec runs.
    test.setTimeout(120_000)
    // A generous mint delay so the pipeline is still on screen when the first assertion
    // polls it, whatever the cold-compile jitter on a run's first navigation. There is
    // no mint-latency contract to pin; this is test-timing margin only.
    await installUserHostedRuntimeMock(page, { health: [200], mintDelayMs: 3000, healthDelayMs: 800 })
    await seedProject(page, { registerWorkspace: true })

    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")

    const view = page.locator('[data-component="cloud-startup-view"]')
    await expect(view).toBeVisible({ timeout: 20_000 })
    // Capture the transient connecting state once. The health response may
    // legitimately move the app to the composer at any point after this view
    // appears; separate locator assertions accidentally require the old view
    // to remain mounted for the whole assertion sequence.
    const connecting = await view.evaluate((element) => ({
      text: element.textContent ?? "",
      composerVisible: !!document.querySelector('[role="textbox"][aria-label*="Ask anything"]'),
    }))
    expect(connecting.text).toContain("Connecting to workspace")
    // The detail line under the heading is generic — no step-specific
    // `cloudSummary()` sentence for a plain mid-pipeline step — so the
    // distinct-3-step-pipeline proof is the row labels themselves.
    expect(connecting.text).toContain("Establishing relay tunnel")
    expect(connecting.text).toContain("Checking runtime health")

    // Never the cloud pipeline's vocabulary.
    expect(connecting.text).not.toContain("Acquiring sandbox")
    expect(connecting.text).not.toContain("Cloning repository")
    expect(connecting.text).not.toContain("Starting runtime")
    expect(connecting.text).not.toContain("Waiting for health check")
    // Heading distinct from cloud's "Preparing workspace".
    expect(connecting.text).not.toContain("Preparing workspace")

    expect(connecting.composerVisible).toBe(false)

    await expect(view).toHaveCount(0, { timeout: 20_000 })
  })

  // The reply renders through the real projection path: the host projects the
  // turn's raw frames onto the workspace stream over the relay, and the projected
  // `busy` → `finish` pair settles it into a message-list refetch over the same relay.
  test("ready unlocks the composer and a send is proven by the oracle through the relay lane", async ({ page }) => {
    test.setTimeout(120_000)
    const mock = await installUserHostedRuntimeMock(page, { health: [200] })
    await seedProject(page, { registerWorkspace: true, model: BIG_PICKLE })

    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")

    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(input).toBeVisible({ timeout: CONTENTION_TIMEOUT })
    await expect(input).toHaveAttribute("contenteditable", "true")
    await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)
    // Catalog can be ready while the draft still has no selected model (product
    // requires an explicit pick). Wait for the catalog first, then drive the picker.
    const modelControl = page.locator('[data-action="prompt-harness-model"]')
    await expect(modelControl).toBeEnabled({ timeout: CONTENTION_TIMEOUT })
    // A remote workspace inherits no harness. Pick the native Pi connection
    // explicitly, as a user must on a fresh workspace.
    await selectComposerAgent(page, /^Pi$/)
    await expect(modelControl).toHaveAttribute("data-readiness", "ready", { timeout: CONTENTION_TIMEOUT })
    await ensureComposerModelSelected(page, { modelName: /Big Pickle/i, search: "Big Pickle" })
    await expect(modelControl).toContainText(/Big Pickle|big-pickle/i, {
      timeout: CONTENTION_TIMEOUT,
    })

    const promptText = "core user-hosted workspace first turn"
    await input.click()
    await input.fill(promptText)
    await expect(input).toContainText(promptText, { timeout: 10_000 })
    await page.locator(SELECTORS.submitControl).last().click()

    await expectAssistantReplyVisible(page, `user-hosted ack 1: ${promptText}`)
    await expectTurnCounts(page, { user: 1, assistant: 1 })

    // Everything that happened while ready went through the relay lane; nothing hit a
    // bare/global runtime equivalent instead.
    expect(mock.requests.promptCount).toBe(1)
    expect(mock.requests.relayHits.some((h) => h.includes("/prompt_async"))).toBe(true)
    expect(mock.requests.relayHits.some((h) => h.includes("/session") && h.startsWith("POST"))).toBe(true)
    expect(mock.requests.bareHitsDuringReady).toEqual([])

    // Consumption proof: the workspace stream was read over the relay (> 0
    // opens), and the raw frames the host projected the reply from were the
    // turn's real sequence.
    expect(mock.requests.workspaceEventScopes.length).toBeGreaterThan(0)
    expect(mock.requests.relayHits.some((h) => h.includes("/api/wr/events"))).toBe(true)
    expect(mock.requests.runtimeFramesEmitted.map((f) => (f.payload as { type: string }).type)).toEqual([
      "session-status",
      "text-delta",
      "text-delta",
      "finish",
    ])
    for (const frame of mock.requests.runtimeFramesEmitted) {
      expect(frame.sessionId).toBe(SESSION_ID)
      // The runtime names an assistant reply `${userMessageId}_r`.
      expect(String(frame.assistantMessageId).endsWith("_r")).toBe(true)
    }
  })

  test("a persistently offline host renders the terminal offline view with the exact claxedo-up copy", async ({ page }) => {
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

  test("transient 409/503 health hiccups still reach ready", async ({ page }) => {
    test.setTimeout(120_000)
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

  test("a workspace ready before an earlier connect flips ready-to-offline on a warm reload while the host is now paused", async ({ page }) => {
    // Two navigations (initial connect + reload); pad generously beyond the suite
    // default for cold-navigation margin.
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

  test("enabling remote access publishes this machine's workspaces with no per-workspace gesture", async ({ page }) => {
    test.setTimeout(120_000)
    await stampTestAuth(page.context())
    // Deliberately not the user-hosted connect pipeline: the reconciler resolves
    // against the project's own main workspace directory, so a plain local session
    // with no relay backing at all is enough.
    const assignments: string[] = []
    // The machine's own publication state, as the control plane would hold it.
    const machine = { enabled: false, workspaceIds: [] as string[] }

    await page.route("**/*", async (route) => {
      if (!api(route)) return route.continue()
      const url = new URL(route.request().url())
      const method = route.request().method()

      if (url.pathname === "/api/claxedo/bootstrap") {
        return json(route, {
          healthy: true,
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
          events: { hostAggregate: true },
          project: [{ id: PROJECT_ID, worktree: DIR, name: "core-user-hosted-workspace", time: { created: Date.now(), updated: Date.now() } }],
          provider: { all: [{ id: "opencode", name: "opencode", env: [], models: { [BIG_PICKLE.id]: { id: BIG_PICKLE.id, name: BIG_PICKLE.name, release_date: "2026-01-01", attachment: true, reasoning: true, temperature: true, tool_call: true, limit: { context: 200000, output: 8192 }, cost: { input: 0, output: 0 }, options: {} } } }], default: { opencode: BIG_PICKLE.id }, connected: ["opencode"] },
          provider_auth: {},
          config: { provider: { id: "opencode", model: BIG_PICKLE.id }, agent: { id: "build" } },
        })
      }
      if (url.pathname === "/project" || url.pathname === "/experimental/project") {
        return json(route, [{ id: PROJECT_ID, worktree: DIR, name: "core-user-hosted-workspace", time: { created: Date.now(), updated: Date.now() } }])
      }
      if (url.pathname === "/api/cp/events") {
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'id: 0\ndata: {"type":"heartbeat"}\n\n' }).catch(() => {})
      }
      if (url.pathname === "/provider") return json(route, { all: [], connected: [], default: {} })
      if (url.pathname === "/provider/auth" || url.pathname === "/api/claxedo/agent-config/providers/auth") return json(route, {})
      if (url.pathname === "/path") return json(route, { worktree: DIR })
      if (url.pathname === "/config") return json(route, { provider: { id: "opencode", model: BIG_PICKLE.id }, agent: { id: "build" } })
      if (url.pathname === "/agent") return json(route, [{ id: "build", name: "build", description: "Build agent" }])
      if (url.pathname === "/mcp") return json(route, {})
      if (url.pathname === "/vcs") return json(route, {})
      if (url.pathname === "/command") return json(route, [])
      if (url.pathname === "/permission") return json(route, [])
      // Same fatal gap as the relay lane above: this mock's trailing
      // `json(route, {}, 200)` would serve `{}` here, the composer would read `.modes`
      // off it, and the app would render its error boundary instead of the shell.
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
      // Reaching Settings means opening the rail account menu, which mounts the
      // org/team switcher. Same fatal gap as `/permission/modes` above: the trailing
      // `json(route, {}, 200)` would serve `{}`, the switcher would call `.find` on it,
      // and the app would render its error boundary instead of the shell.
      if (url.pathname === "/api/control/orgs") return json(route, [])
      if (url.pathname.startsWith("/api/control/orgs/")) return json(route, [])

      // The three remote-access routes the browser product's port speaks. The
      // devices list is this machine's own row, which is where the panel's
      // served count and the reconciler's "already published" set both come
      // from — so the two can never disagree in this test.
      if (url.pathname === "/api/claxedo/remote-access/devices") {
        return json(route, {
          devices: machine.enabled
            ? [{ host_id: "host_1", display_name: "This machine", last_seen_at: Date.now(), workspace_ids: machine.workspaceIds }]
            : [],
        })
      }
      if (url.pathname === "/api/claxedo/remote-access/enable" && method === "POST") {
        machine.enabled = true
        return json(route, { host_id: "host_1", connection_count: 0 })
      }
      if (url.pathname === "/api/claxedo/remote-access") {
        return json(route, {
          device_login_configured: true,
          relay_configured: true,
          hosted_signed_in: true,
          enabled: machine.enabled,
          enrolled: machine.enabled,
          second_device_open: false,
        })
      }
      if (url.pathname === `/api/workspace/${encodeURIComponent(PROJECT_ID)}/host-assignment` && method === "POST") {
        assignments.push(`${method} ${url.pathname}`)
        if (!machine.workspaceIds.includes(PROJECT_ID)) machine.workspaceIds.push(PROJECT_ID)
        return json(route, { workspaceId: PROJECT_ID, assigned: true })
      }
      // The daemon's host aggregate. Answered as a stream rather than by the
      // `{}` catch-all below so the reader parks on an open connection instead
      // of re-opening it as fast as a JSON body ends.
      if (url.pathname === "/api/wr/events") {
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'id: 0\ndata: {"type":"heartbeat"}\n\n' }).catch(() => {})
      }

      return json(route, {}, 200)
    })

    await seedProject(page, { registerWorkspace: false })
    await page.goto(`/s/new`, { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    await page.getByTestId("rail-account-trigger").click()
    await page.getByRole("menuitem", { name: /settings/i }).click()
    await page.getByRole("tab", { name: "Devices" }).click()

    // Nothing is published before the machine is enabled — the reconciler must
    // not post an assignment at a machine that is not up.
    const enable = page.getByRole("button", { name: "Enable remote access" })
    await expect(enable).toBeVisible({ timeout: CONTENTION_TIMEOUT })
    expect(assignments).toEqual([])

    await enable.click()

    // One gesture, and the machine's whole local inventory is published: the
    // assignment reaches the wire with nobody ticking anything, and the panel
    // reports what it now serves.
    await expect(page.getByText(/^Serving /)).toBeVisible({ timeout: CONTENTION_TIMEOUT })
    await expect(page.getByText("Serving 1 workspace")).toBeVisible({ timeout: CONTENTION_TIMEOUT })
    expect(assignments).toEqual([`POST /api/workspace/${encodeURIComponent(PROJECT_ID)}/host-assignment`])

    // And no tick list came with it.
    await expect(page.getByRole("checkbox", { name: /share/i })).toHaveCount(0)
  })
  test("the rail's project view lists the host's sessions and opens one on its workspace route", async ({ page }) => {
    test.setTimeout(120_000)
    // The central server answers NOTHING for this project (`isSessionListPath`
    // above returns an empty page), so any row the rail shows can only have
    // come from the workspace's own runtime over the relay. That is the whole
    // point: in the rail's default "Projects" view the project section is the
    // only place a user-hosted workspace's sessions appear.
    const mock = await installUserHostedRuntimeMock(page, {
      health: [200],
      existingRuntimeSession: true,
      idleRuntimeSession: true,
    })
    await seedProject(page, { registerWorkspace: true })

    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByTestId("rail-sidebar")).toBeVisible({ timeout: CONTENTION_TIMEOUT })

    const projectGroup = page.locator(`[data-testid="project-group"][data-project-id="${PROJECT_ID}"]`)
    await expect(projectGroup).toBeVisible({ timeout: CONTENTION_TIMEOUT })
    const expand = projectGroup.getByLabel("Expand project")
    if (await expand.count()) await expand.first().click()

    const row = projectGroup.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${SESSION_ID}"]`)
    await expect(row).toBeVisible({ timeout: CONTENTION_TIMEOUT })
    await expect(row).toContainText(SEEDED_SESSION_TITLE)
    await expect(projectGroup.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${IDLE_SESSION_ID}"]`))
      .toBeVisible({ timeout: CONTENTION_TIMEOUT })
    // Never the "nothing here" state of a list read from the central server alone.
    await expect(projectGroup.getByTestId("rail-sidebar-session-list-empty")).toHaveCount(0)
    expect(mock.requests.relayHits).toContain("GET /session")

    // Most recently ACTIVE first: the idle row was created later, so an order
    // taken from creation time would put it on top and leave the session the
    // user last worked in below it.
    await expect(projectGroup.locator('[data-testid="rail-sidebar-session-row"]').first())
      .toHaveAttribute("data-session-id", SESSION_ID, { timeout: CONTENTION_TIMEOUT })

    // The row's own identity decides where it opens: the signed workspace
    // route, never the bare `/s/<id>` one the rail falls back to when a row's
    // workspace cannot be resolved.
    await row.click()
    await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}/session/${SESSION_ID}$`), { timeout: CONTENTION_TIMEOUT })

    // And it opens ADDRESSED BY THE WORKSPACE. The pane's directory is what
    // every later read is scoped by, so the host's path here is not cosmetic:
    // it turns each of those reads into a question about a directory that
    // exists on another machine.
    await expect(page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]:visible`))
      .toHaveAttribute("data-session-directory", WORKSPACE_REF, { timeout: CONTENTION_TIMEOUT })
    // And it is the ONLY surface for this session. The rail wrote the workspace
    // id into the URL and opened the surface under that same id, so the route
    // layer mirroring the URL finds that surface instead of opening a second
    // one beside it. A second surface stashes the click's own before its page
    // is built, and a page built hidden has no pane identity to address its
    // composer by: the whole app falls to the error boundary.
    await expect(page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]`))
      .toHaveCount(1, { timeout: CONTENTION_TIMEOUT })
    expect(mock.requests.hostPathScopes).toEqual([])
  })

  // Attaching to a turn already running on the HOST. The host projects the turn
  // onto the workspace stream exactly as it does for a viewer who merely
  // navigated to the session; nothing adds the reply's text to the REST message
  // list, so a whole-turn `GET /session/:id/message` refetch cannot be what
  // carries it.
  //
  // What this pins is the stream: open before the turn's frames exist, and read
  // as they are published.
  test("attaching to a running session by route opens its live stream", async ({ page }) => {
    test.setTimeout(120_000)
    const mock = await installUserHostedRuntimeMock(page, { health: [200], existingRuntimeSession: true })
    await seedProject(page, { registerWorkspace: true, model: BIG_PICKLE })

    // ATTACH: reach the session by its route. The composer never ran here, so
    // nothing published the session to `session-event-scope` — the route is the
    // only thing that names it.
    await page.goto(workspaceRoute(SESSION_ID), { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]`))
      .toBeVisible({ timeout: CONTENTION_TIMEOUT })

    // Reached by ROUTE rather than by a rail click, and addressed the same
    // way: `/w/<workspace id>` resolves to the workspace's own address, so the
    // attach path scopes its reads by the workspace and never by the host's
    // directory.
    await expect(page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]:visible`))
      .toHaveAttribute("data-session-directory", WORKSPACE_REF, { timeout: CONTENTION_TIMEOUT })

    // The stream must be OPEN before the turn's frames exist — a stream that
    // opens afterwards turns a live turn into a late burst. The owner's own
    // runtime serves it workspace-wide, so no session scope is negotiated.
    await expect
      .poll(() => mock.requests.workspaceEventScopes.length, { timeout: CONTENTION_TIMEOUT })
      .toBeGreaterThan(0)
    expect(mock.requests.workspaceEventScopes.every((scope) => scope === null)).toBe(true)

    // A turn STARTS on the host, answering the last user message: the exact
    // raw frame sequence the harness produces for a turn nobody here started
    // (`AgentRuntime` names the reply `${userMessageId}_r`, then the harness
    // adapter's deltas follow), projected on the host.
    const assistantMessageId = `${HOST_USER_MESSAGE_ID}_r`
    mock.emitRuntimeFrame({ type: "session-status", status: "busy" }, { assistantMessageId })
    mock.emitRuntimeFrame({ type: "text-delta", delta: "streamed from the host " }, { assistantMessageId })
    mock.emitRuntimeFrame({ type: "text-delta", delta: "while attached" }, { assistantMessageId })

    // This client really read them off the wire: its own SSE cursor moved past
    // the frames it applied (the row, the status, and the streamed part).
    await expect.poll(() => Math.max(0, ...mock.requests.workspaceEventCursors), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(3)
    // And the words are ON SCREEN, growing, within a second of being published —
    // not as one finished block at the end of the turn.
    await expect(page.locator(SELECTORS.assistantContent))
      .toContainText("streamed from the host while attached", { timeout: 1_000 })
    // Not the poll — and asserted as a FACT about the transcript rather than as
    // a refetch count. Attaching schedules one catch-up refresh anchored to
    // activation (`session-controller`'s `refresh`, scheduled through
    // `activationRelativeDelay`), which fires whether or not a turn is running,
    // so counting refetches across the second this assertion waits measures
    // that timer, not the lane. What is absolute is that the host's REST
    // transcript never gains this reply — no row for it and no text — so
    // nothing a whole-turn `GET /session/:id/message` returns could have put
    // those words on screen.
    expect(mock.restTranscript().map((row) => row.info.role)).toEqual(["user"])
    expect(JSON.stringify(mock.restTranscript())).not.toContain("streamed from the host")
    // Nothing this attach did — the pane's own reads, the transcript, the
    // supporting bootstrap calls — asked any server about the host's path.
    expect(mock.requests.hostPathScopes).toEqual([])
  })

  // The workspace stream is WORKSPACE-wide on this runtime, and it has to be:
  // `pty.*` and `process.*` belong to no session, and the route that needs them
  // most — a terminal — names no session at all: the `pty.created` frame that
  // registers a terminal arrives on this stream and no other.
  test("the workspace stream opens workspace-wide on a session-less route", async ({ page }) => {
    test.setTimeout(120_000)
    const mock = await installUserHostedRuntimeMock(page, { health: [200] })
    await seedProject(page, { registerWorkspace: true, model: BIG_PICKLE })

    // A draft route: no session id anywhere, which is the same standing the
    // terminal route has.
    await page.goto(workspaceRoute(), { waitUntil: "domcontentloaded", timeout: 90_000 })
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last())
      .toBeVisible({ timeout: CONTENTION_TIMEOUT })

    await expect.poll(() => mock.requests.workspaceEventScopes.length, { timeout: CONTENTION_TIMEOUT })
      .toBeGreaterThan(0)
    // Every open is the workspace-wide form. A `?sessionID=` here would mean the
    // app narrowed a stream this runtime serves whole — and could not open it at
    // all from a route with no session.
    expect(mock.requests.workspaceEventScopes.every((scope) => scope === null)).toBe(true)

    // And the app really reads it: a frame published on the bus moves the
    // reader's own SSE cursor past it on the next connection.
    mock.emitWorkspaceFrame({
      type: "pty.created",
      info: {
        id: "pty_core_user_hosted",
        title: "zsh",
        command: "zsh",
        args: [],
        cwd: HOST_DIR,
        status: "running",
        pid: 4242,
      },
    })
    await expect.poll(() => Math.max(0, ...mock.requests.workspaceEventCursors), { timeout: CONTENTION_TIMEOUT })
      .toBeGreaterThanOrEqual(1)
  })
})
