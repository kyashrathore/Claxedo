/**
 * SPEC: Workspace connection authority — offline surfaces, role gating, and the
 * panel-local readiness overlay
 *
 * PURPOSE — a relay-backed workspace (cloud VM or user-hosted machine) is not always
 * reachable, and not every principal who can open a relay-backed workspace may mutate
 * it. This spec owns the single connection authority's non-happy-path surface: what a
 * user sees when the relay/runtime is unreachable or forbidden, how the app recovers
 * silently from a transient drop, how a panel that is NOT the main session pane shows
 * its own readiness chrome, and how a "viewer" role locks the composer down (and
 * un-locks live if the role changes) without any of this ever depending on a full page
 * reload.
 *
 * STATE MODEL — `src/shell/workspace/workspace-connection.ts` is the SINGLE writer for
 * every workspace's connection state, keyed by `workspaceId` in a Solid store
 * (`connections`, module-scope, ref-counted by mounted consumers via
 * `acquireWorkspaceConnection`/`releaseWorkspaceConnection`). Each entry's `status` is
 * one of: `"connecting"` (first mint/health in flight) → `"ready"` (runtime reachable)
 * → `"reconnecting"` (was ready, sustained event-stream drop, queries paused, NO
 * teardown) → `{ offline: reason }` where `reason` is `"forbidden"` (mint 401/403 — not
 * your workspace, TERMINAL, never auto-retried), `"no-host"` (user-hosted machine is
 * offline), `"unreachable"` (502/503/509/timeout/network), or `"failed"` (any other
 * mint/provision error). `local` workspaces (no relay backing) are synthesized `ready`
 * immediately (`driveConnection`'s `kind === "local"` branch) — this spec's every
 * scenario uses a `cloud` or `user-hosted` workspace.
 *   Each entry also carries `rolePlacement` (`src/shell/state/connection-placement.ts`):
 *   `role-pending` → `role-known { role }` → `reconnecting` → `disconnected`, driven by
 *   `applyWorkspaceConnectionInfo` every time the connection MINT (`GET
 *   /api/workspace/:id/connection`) or REFRESH (`POST
 *   /api/workspace/:id/connection/refresh`, called lazily by
 *   `createWorkspaceRelayConnection`'s `ensureFresh()` before any relay fetch once the
 *   token is inside its refresh window) resolves — so a role that changes on the
 *   server (a later refresh reporting a different `role`) updates this SAME store entry
 *   in place; every reader (`workspacePlacement(workspaceId)`) is reactive, so nothing
 *   downstream needs to remount to pick up the change.
 *   All of this lives in-memory only (a `queryClient`-cached promise for the mint,
 *   `createStore` for `connections`); nothing here is persisted across reload except a
 *   "was recently ready" timestamp (`localStorage['claxedo.workspace-connection.ready.v1']`,
 *   60s TTL, used only to warm-start a user-hosted reconnect — out of scope here).
 *
 * ANATOMY —
 *   `WorkspaceGate` (`src/shell/workspace/workspace-gate.tsx`) is the ONE component at
 *   the workspace-scope boundary, wrapping the whole main session pane (composer,
 *   timeline, model picker — NOT the sidebar list, which is central-DB-driven and stays
 *   live). It acquires (ref-counted) for as long as mounted and switches on
 *   `workspaceConnection(id)`:
 *     - `status === "ready"` → renders `props.children` (the real session UI).
 *     - `offline() === "forbidden"` → `WorkspaceAccessDeniedView`
 *       (`data-testid="workspace-access-denied"`, `data-component="workspace-access-denied"`);
 *       no Retry control exists in this branch at all.
 *     - `offline()` truthy (any other reason) → `WorkspaceOfflineView`
 *       (`data-testid="workspace-offline"`, `data-component="workspace-offline"`) — a
 *       title + detail from a per-reason `OFFLINE_COPY` table, and a Retry button
 *       (`data-testid="workspace-offline-retry"`) shown only when `!terminal`.
 *     - otherwise (`"connecting"` OR `"reconnecting"`) → `CloudStartupView`
 *       (`data-component="cloud-startup-view"`) — the step-pipeline spinner. Note this
 *       means `"reconnecting"` swaps the WHOLE main-pane subtree out for the spinner
 *       (same branch as first connect) — "silent" recovery in this codebase means "no
 *       error toast", not "the main pane never re-renders its chrome".
 *   `WorkspacePanelBody` (`src/claxedo-ui/layouts/workspace-panel-body.tsx`) is a
 *   SEPARATE, panel-scoped surface (the right-rail Files/Changes/Processes navigator +
 *   the embedded Review region) that explicitly does NOT use `WorkspaceGate`
 *   (`SessionPaneScope suppressConnectionGate` — see its inline comment). It reads the
 *   SAME connection store directly (`isWorkspaceReady`, `workspaceOffline`) and renders
 *   its OWN pending overlay: `[data-testid="workspace-review-pending"]`, containing
 *   "Connecting to workspace..." normally or "This workspace isn't available." when
 *   `workspaceOffline(id)` is set. Whether this overlay is shown/the Review content is
 *   mounted is governed by `reviewRegionPolicy` (`src/shell/chrome/review-region-
 *   policy.ts`): `armed = !!key && (ready || (sameKey && prevArmed))` — once a
 *   `workspaceId + "uncommitted"` key reaches `ready`, `armed` never goes false again
 *   for that SAME key, so the mounted `ReviewWorkspace` subtree — its own root is
 *   `[data-testid="review-pane-root"]` (`review-workspace.tsx`), gated by `armed` at
 *   `workspace-panel-body.tsx:246` — is never torn down by a later drop (the panel's
 *   OUTER wrapper, `div[data-review-workspace-id]`, is a weaker signal: it is gated
 *   only on `targetSessionId()`, not on `armed`/readiness, so it was never at risk of
 *   teardown in the first place). `showPending = !!key && !ready` — this is
 *   INDEPENDENT of `armed`, so the pending overlay DOES reappear on top during a
 *   same-key drop (see `review-region-policy.test.ts`'s "does not disarm the same key
 *   during a reconnect" case: `{ armed: true, showPending: true }`). A DIFFERENT key
 *   (workspace/directory switch) always starts `armed: false, showPending: true`.
 *   Composer role gate (`src/session-client/composer/role-gate.ts` +
 *   `src/shell/auth/role.tsx`): `RolePolicy.viewer` lacks `mutate.session` (and
 *   `use.terminal`/`mutate.workspace`); `submitBlockedByWorkspaceRole(workspaceId)` folds
 *   into the composer's `roleSubmitBlocked` memo, which (a) sets the design placeholder
 *   to `"Read-only workspace (viewer)"` (`promptDesignPlaceholder`), (b) is OR'd into
 *   `submitDisabled` so `[data-action="prompt-submit"]` is `disabled` with
 *   `aria-label="Read-only workspace"` (`readOnlyLabel` in `submit-control.tsx`), and (c)
 *   is checked FIRST inside `handleSubmit` (`submit-ui-state.ts`) which
 *   `event.preventDefault()`s before any submission work — the SAME `handleSubmit` is
 *   wired to both the submit button's `type="submit"` and the editor's Enter-key path
 *   (`editor-keymap.ts` line ~180), so both are blocked identically, at the handler, not
 *   just via the `disabled` attribute. Workspace-mutation-only controls (gated on
 *   `mutate.workspace`, a DIFFERENT capability neither `viewer` nor `editor` holds — only
 *   `owner`/`admin`) are hidden independently, e.g. the Processes panel's "Add process"
 *   button (`src/claxedo-ui/context/process-pane.tsx`).
 *   Toasts render as `[data-component="toast"]` (`packages/ui/src/components/toast.tsx`).
 *
 * BEHAVIORS —
 *   1. A relay-backed workspace whose connection MINT is forbidden (401/403) renders
 *      `WorkspaceAccessDeniedView` — never the offline view, never the connecting
 *      pipeline — with no Retry control, and the failure is TERMINAL: the mint fires
 *      exactly once (no auto-retry storm; `isTerminalReason("forbidden") === true`).
 *   2. A relay-backed workspace whose connection MINT fails with a non-forbidden status
 *      (503 → `"unreachable"`, 500 → `"failed"`) renders `WorkspaceOfflineView` with the
 *      reason-specific title/detail copy — a real offline screen, not
 *      `CloudStartupView`'s spinner — and, being non-terminal, exposes a Retry control
 *      that re-drives the connection (a fresh mint attempt).
 *   3. A user-hosted workspace whose runtime health probe reports the host offline
 *      (503 `user_hosted_app_offline`) renders the SAME `WorkspaceOfflineView` component
 *      with the `"no-host"` copy ("Workspace host is offline" / "claxedo up").
 *   4. A workspace connection recovering from a `ready → reconnecting → ready` cycle
 *      (the app's own sustained-event-stream-drop signal, driven here through the
 *      dev-only `window.__claxedoConnections.markReconnecting`/`markReconnected` test
 *      hooks — see `workspace-connection.ts`'s "E2E/debug escape hatch" comment) never
 *      raises an error toast at any point in the cycle, and the workspace resumes
 *      usability (composer visible and unblocked again) once reconnected, with no page
 *      reload.
 *   5. The workspace panel body's Review region shows its OWN panel-local pending
 *      overlay (`workspace-review-pending`) while the SAME workspace's connection is not
 *      yet ready — independent of, and while, the main-pane `WorkspaceGate` may be
 *      rendering something else entirely (they read the same store, but render
 *      different chrome, per ANATOMY).
 *   6. Arm-once: once a workspace/key reaches ready, the mounted `ReviewWorkspace`
 *      subtree (`[data-testid="review-pane-root"]`, gated by `armed`) survives a later
 *      same-key `reconnecting` drop without being torn down/remounted — but the
 *      pending overlay reappears ON TOP of it during that drop (armed persistence is
 *      about content-mount durability, not overlay suppression).
 *   7. Switching the panel to a DIFFERENT workspace key re-gates the policy from
 *      scratch (`armed: false, showPending: true`) regardless of the previous key's
 *      armed state.
 *   8. A `viewer`-role workspace shows the composer's read-only placeholder, disables
 *      the submit control with the read-only `aria-label`, and blocks BOTH click-submit
 *      and Enter-submit at the handler (zero `prompt_async` requests survive either
 *      attempt); a `mutate.workspace`-gated control (Processes panel's "Add process") is
 *      absent.
 *   9. A role that live-flips (viewer → editor, via a connection-refresh response that
 *      reports a different `role` than the initial mint) updates the composer's
 *      block state IN PLACE — placeholder text and submit-disabled state both change —
 *      with no navigation and no remount, because the role is read reactively off the
 *      single connection-store entry every render.
 *
 * INVARIANTS — this spec's workspaces are always `cloud`/`user-hosted` (never `local`,
 *   which is a structural no-op for the whole authority under test). Every assertion of
 *   "no toast" is proven by `page.locator('[data-component="toast"]')` staying at count
 *   0 across the whole window of the transition, not by a single point-in-time check.
 *   No scenario here sends a prompt to completion (submission is either blocked-by-role
 *   or simply never attempted), so the shared turn oracle (`e2e/helpers/turn-oracle.ts`)
 *   is not invoked by this file — the oracle's contract is for a COMPLETED assistant
 *   reply, which is out of scope for every behavior owned here.
 *
 * HARNESS NOTES — none; every workspace here uses the default `opencode` harness. The
 *   relay/mint/health surface this spec drives is IDENTICAL regardless of which harness
 *   a session would eventually use.
 *
 * OUT OF SCOPE — cloud VM provisioning pipeline steps and their own reload-resume
 *   (`core-cloud-provisioning`); harness ownership over the relay
 *   (`core-harness-ownership-cloud`); user-hosted's full 3-step connect pipeline copy
 *   and `claxedo up` share flow (`core-user-hosted-workspace`); terminal/session-relay
 *   routing correctness matrix (legacy `cloud-runtime-relay-routing.spec.ts`, harvested
 *   for route shapes here but not re-asserted route-by-route); the `editor` role's full
 *   capability surface and the `owner`/`admin` roles (only `viewer` is exercised, plus
 *   one `viewer → editor` flip — `role.tsx`'s `RolePolicy` table itself is unit-tested
 *   in `role.test.ts`); a role flipping DOWN (editor → viewer) is the SAME state-machine
 *   transition code (`transitionConnectionPlacement`'s `role` event, unconditional
 *   re-set regardless of direction — unit-pinned in `connection-placement.test.ts`) and
 *   is not separately re-proven at the DOM layer here to keep this spec's mock harness
 *   deterministic (concurrently-issued relay fetches racing a second near-expiry
 *   refresh have no ordering guarantee); Processes/Files/Changes panel CONTENT
 *   correctness (`core-processes`, `core-terminal`); the product-open question of
 *   whether role should be enforced server-side at the relay/runtime transport layer
 *   (flagged in the 25-spec plan under spec 25 — this spec pins the CURRENT UI-only
 *   contract, not a verdict on it).
 */
import { isWorkspaceResolvePath } from "../helpers/contracts/workspace-resolve"
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
// box was blowing (doc entry 6: CI-only, "runner-contention timing").
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
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: window.location.origin,
        activeDirectory: input.directory,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
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

function bootstrapBody() {
  return {
    healthy: true,
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
    access: kind,
    backing: kind === "cloud" ? "cloud-vm" : "local-worktree",
    workspaceId,
    role: mint.role ?? "owner",
    relayUrl: RELAY_ORIGIN,
    runtimeAccessToken: `rat_test_${mint.role ?? "owner"}`,
    tokenExpiresAt: mint.tokenExpiresAt ?? Date.now() + 120_000,
  }
}

/**
 * Installs the full workspace-relay harness: same-origin bootstrap/composer-harness
 * routes plus the connection mint/refresh + relay-origin workspace-runtime routes for
 * BOTH the cloud and user-hosted workspaces declared above. Mutating the returned
 * `state` between actions changes what the NEXT mint/refresh/health call answers —
 * every route reads `state` live, it is not snapshotted at install time.
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
  // Tracks EVERY request touching prompt_async regardless of how (or whether) a
  // route handler answers it — the definitive proof that a blocked submit/Enter
  // never dispatched a turn, independent of the catch-all's "unhandled" bucket.
  page.on("request", (request) => {
    if (request.url().includes("prompt_async")) state.promptAsyncHits.push(request.url())
  })

  await page.route("**/*", async (route) => {
    if (!api(route)) return route.continue()
    const request = route.request()
    const url = new URL(request.url())

    // Third-party auth/analytics (Clerk, PostHog) are NOT part of this spec's
    // surface and must reach the real network unmodified — unlike
    // `mock-runtime.ts`'s per-path `page.route()` calls (which simply never
    // match these URLs, so they fall through to the network automatically),
    // this file's single `page.route("**/*")` catch-all would otherwise fake
    // a 598 for them too. A faked Clerk response breaks ClerkJS
    // initialization ("Something went wrong initializing Clerk in
    // development mode"), which in turn blocks every downstream app fetch
    // (bootstrap/health never even fire) — the app never renders
    // `[data-claxedo]` and every scenario in this file hangs on the
    // "Could not reach 127.0.0.1:3001" screen. Discovered while remediating
    // this spec under the pooled e2e run (2026-07-10): every test failed
    // identically at `gotoDraft`'s `[data-claxedo]` wait until this bypass
    // was added.
    if (url.hostname.endsWith("clerk.accounts.dev") || url.hostname.endsWith("posthog.com")) {
      return route.continue()
    }

    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }

    // The Codex icon sprite is fetch()ed (resourceType "fetch"), so `api()` is
    // true for it — but it is a same-origin STATIC ASSET served by
    // vite/preview, not an API escape. Let the web server answer it.
    if (/sprite[^/]*\.svg$/.test(url.pathname)) return route.continue()

    // ---- Same-origin: bootstrap + composer-harness (central claxedo-server) ----
    if (url.pathname === "/api/claxedo/bootstrap") return json(route, bootstrapBody())
    // Boot-time central-server surface fired against the loopback central URL
    // (`.env.local`'s VITE_CLAXEDO_SERVER_URL). All three are tolerated by the
    // app when they fail, but answering them keeps the unhandled ledger clean.
    // Real routes: claxedo-local-server/src/app/local-app.ts mounts
    // UserExtensionRoutes at /api/claxedo/extensions and LocalUsageRoutes at
    // /api/claxedo/usage; meta-routes.ts serves GET /api/claxedo/session.
    if (url.pathname === "/api/claxedo/extensions") return json(route, { extensions: [], skipped: [] })
    if (url.pathname === "/api/claxedo/session") return json(route, { sessions: [] })
    if (url.pathname === "/api/claxedo/usage/sync")
      return json(route, { attempted: 0, delivered: 0, conflicts: 0, pending: 0 })
    // The app boot's `ConnectionGate` (src/app.tsx) polls `GET /api/claxedo/health`
    // (src/utils/server-health.ts's `checkServerHealth` -> `claxedoHealthUrl`), NOT
    // `/health` — a bare `/health`/`/global/health` match here left that request
    // unhandled (598), which `checkServerHealth` reads as unhealthy, which flips the
    // whole app into its permanent "Could not reach <server>" `ConnectionError`
    // screen (`[data-claxedo]` never renders). This was a real bug in this mock, not
    // app/env flakiness — every scenario in this file failed on it until fixed.
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
    if (url.pathname === "/global/event" || url.pathname === "/event") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: corsHeaders(),
        body: sseEvent({ directory: "global", payload: { type: "server.connected", properties: {} } }),
      })
    }

    // ---- Same-origin: workspace connection mint/refresh ----
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
    // The usage outbox beacon fires on every boot (installUsageOutboxWakeups);
    // an empty outbox syncs to zeros. Same contract mock-runtime serves.
    if (url.pathname === "/api/claxedo/usage/sync") {
      return json(route, { attempted: 0, delivered: 0, conflicts: 0, pending: 0 })
    }

    // ---- Same-origin: boot-time control-plane surface ----
    // With the query persister installed eagerly (no longer deferred to idle),
    // boot fires the signed workspace inventory sync, the harness-scoped central
    // provider catalog, and the loopback-bridged global event stream before the
    // first navigation settles. `/api/workspace` failures are tolerated by the
    // app (`!res.ok -> []`), but the provider catalog and the events stream sit
    // on the session route's suspense path — a 598 there crashes the route into
    // the error boundary ("Something went wrong") before any assertion runs.
    if (url.pathname === "/api/workspace") return json(route, { workspaces: [] })
    if (url.pathname === "/provider") return json(route, providerCatalog())
    if (
      url.pathname === "/api/wr/events" ||
      url.pathname === "/api/wr/runtime-events" ||
      url.pathname === "/api/claxedo/runtime-events"
    ) {
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

    // ---- Same-origin: loopback-proxied user-hosted health probe ----
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
    // the route, so narrowing the bucket to the relay hostname is no longer
    // viable (it was, when this spec was remediated on 2026-07-10).
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

    // ---- Per-workspace runtime surface: relay origin AND loopback-bridged
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
      if (runtimePath === "/lsp") return json(route, [])
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
      if (runtimePath === "/global/event" || runtimePath === "/event") {
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: corsHeaders(),
          body: sseEvent({ directory: DIR, payload: { type: "server.connected", properties: {} } }),
        })
      }
      if (
        runtimePath === "/api/wr/events" ||
        runtimePath === "/api/wr/runtime-events" ||
        runtimePath === "/api/claxedo/runtime-events"
      ) {
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
        // Defense in depth: a viewer/editor's UI never shows the control that would
        // fire this, but if it somehow did, the runtime must not silently accept it.
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
  // under host contention (observed directly while authoring this file).
  await page.goto(`/${slug(directory)}/session`, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

function debugSuffix(state: HarnessState) {
  return `\n\nunhandled:\n${state.unhandled.join("\n") || "(none)"}\n\nfailed:\n${state.failed.join("\n") || "(none)"}\n\nconsole:\n${state.console.join("\n") || "(none)"}`
}

// The composer editor's accessible name IS its design placeholder
// (`aria-label={designPlaceholder()}` in frame.tsx) — it reads "Ask anything..."
// only when NOT role-blocked. Select it by its stable `data-component`, never by
// role name, so this selector works identically whether the workspace is
// read-only or not.
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
  if (await openPanel.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await openPanel.click({ timeout: 5_000 }).catch(() => {})
  }
  const control = page.locator(`button[aria-label="Open ${navigator}"], button[aria-label="Close ${navigator}"]`).last()
  await expect(control).toBeVisible({ timeout: 10_000 })
  if ((await control.getAttribute("aria-pressed")) !== "true") await control.click()
  await expect(control).toHaveAttribute("aria-pressed", "true")
}

const toasts = (page: Page) => page.locator('[data-component="toast"]')

test.describe("core cloud offline & roles @core", () => {
  // This shared box runs several sibling e2e suites concurrently; page loads and
  // reactive updates can lag well beyond a quiet-machine budget (matches the
  // documented pattern in core-busy-abort-errors.spec.ts). Every assertion below is
  // a real DOM-state poll or network-log check (never waitForTimeout as the sole
  // guard), so a longer ceiling only affects how long a genuinely stuck state takes
  // to be reported, not correctness.
  test.describe.configure({ timeout: 120_000 })
  test("mint forbidden (403) renders the access-denied terminal view, never offline/connecting, single mint attempt — behavior 1", async ({
    page,
  }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    state.cloudMint = { status: 403 }

    await gotoDraft(page, DIR)

    await expect(page.getByTestId("workspace-access-denied"), debugSuffix(state)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("You don't have access to this workspace")).toBeVisible()
    await expect(page.getByTestId("workspace-offline")).toHaveCount(0)
    await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)
    await expect(page.getByTestId("workspace-offline-retry")).toHaveCount(0)

    // Terminal: give any debounced/effect-driven re-drive a beat, then assert the
    // mint fired exactly once (no retry storm) — a real network-count assertion,
    // not a timeout used as the sole guard.
    await page.waitForTimeout(1_500)
    expect(state.mintHits.filter((id) => id === WORKSPACE_ID)).toEqual([WORKSPACE_ID])
  })

  test("mint 503/500 renders the offline view with reason copy, not the connecting spinner, and Retry re-drives — behavior 2", async ({
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

    // Fix the mint before retrying, then prove Retry re-drives to ready.
    state.cloudMint = { status: 200, role: "owner" }
    await retry.click()
    await waitForComposerReady(page, state)
    expect(state.mintHits.filter((id) => id === WORKSPACE_ID).length).toBeGreaterThanOrEqual(2)
  })

  test("mint 500 classifies as the generic failed reason with its own copy — behavior 2", async ({ page }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    state.cloudMint = { status: 500 }

    await gotoDraft(page, DIR)

    await expect(page.getByTestId("workspace-offline"), debugSuffix(state)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("Workspace failed to start")).toBeVisible()
    await expect(page.getByTestId("workspace-offline-retry")).toBeVisible()
  })

  test("user-hosted host-offline health probe renders the no-host offline copy — behavior 3", async ({ page }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    state.uhHealth = { status: 503, body: { error: { code: "user_hosted_app_offline" } } }

    await gotoDraft(page, UH_DIR)

    await expect(page.getByTestId("workspace-offline"), debugSuffix(state)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("Workspace host is offline")).toBeVisible()
    await expect(page.getByText(/claxedo up/)).toBeVisible()
    await expect(page.locator('[data-component="cloud-startup-view"]')).toHaveCount(0)
  })

  test("ready -> reconnecting -> ready never raises a toast and resumes without reload — behavior 4", async ({
    page,
  }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    state.cloudMint = { status: 200, role: "owner" }

    await gotoDraft(page, DIR)
    await waitForComposerReady(page, state)
    await expect(toasts(page)).toHaveCount(0)

    // Dev-only escape hatch (see workspace-connection.ts's "E2E/debug escape hatch"
    // comment) — drives the SAME transition a sustained event-stream drop would,
    // without needing to actually starve the mocked SSE stream for the ~cooldown
    // window the real code waits before escalating.
    await page.evaluate((id) => {
      ;(
        window as typeof window & { __claxedoConnections?: { markReconnecting?: (id: string) => void } }
      ).__claxedoConnections?.markReconnecting?.(id)
    }, WORKSPACE_ID)

    // Await the reconnecting overlay explicitly — this is the transition, and its
    // arrival is also the settle window that lets any (buggy) toast surface before
    // the toasts-absent check below runs.
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

  test("workspace panel shows its own pending overlay, independent of the main-pane gate — behavior 5", async ({
    page,
  }) => {
    await seed(page)
    const state = await installWorkspaceHarness(page)
    // Never resolves ready — the mint hangs (never 200s) so the panel stays pending
    // for the whole test without racing a real connect.
    state.cloudMint = { status: 503 }

    await gotoDraft(page, DIR)
    await openWorkspaceNavigator(page, "Files")

    const pending = page.locator('[data-testid="workspace-review-pending"]')
    await expect(pending, debugSuffix(state)).toBeVisible({ timeout: 15_000 })
    await expect(pending).toContainText("isn't available")
  })

  test("arm-once: ready content survives a same-key reconnect; the overlay reappears on top — behaviors 6,7", async ({
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
    // is actually mounted, which IS gated on `reviewArmed().armed`
    // (workspace-panel-body.tsx:246). This is the selector that actually proves the
    // armed subtree survives a reconnect instead of being torn down/remounted.
    const reviewPaneRoot = page.locator('[data-testid="review-pane-root"]')
    await expect(reviewRegion, debugSuffix(state)).toHaveCount(1)
    // Reactive: readiness flips true only once the mocked connect resolves. Give it
    // the contention ceiling — it still awaits the actual attribute transition.
    await expect(reviewRegion).toHaveAttribute("data-review-workspace-ready", "true", {
      timeout: RECONNECT_STATE_TIMEOUT,
    })
    await expect(reviewPaneRoot, debugSuffix(state)).toHaveCount(1)
    await expect(page.locator('[data-testid="workspace-review-pending"]')).toHaveCount(0)

    // `markWorkspaceReconnecting` silently no-ops unless the store status is
    // exactly "ready" — the DOM ready-attribute asserted above can lead the
    // store write under CI load, so drive-and-verify against the store itself:
    // keep invoking until the snapshot actually reads "reconnecting".
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

    // Behavior 6: armed content is never torn down for the same key — both the outer
    // wrapper AND the actual `ReviewWorkspace` mount it wraps are still present...
    await expect(reviewRegion, debugSuffix(state)).toHaveCount(1)
    await expect(reviewPaneRoot, debugSuffix(state)).toHaveCount(1)
    // ...even though the pending overlay legitimately reappears on top of it during
    // the drop (reviewRegionPolicy's showPending tracks readiness independently of
    // armed — see SPEC ANATOMY / review-region-policy.test.ts).
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

  test("viewer role locks the composer (placeholder, disabled submit, blocked Enter) and hides mutation controls — behavior 8", async ({
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

    // Click-submit is a no-op: a native `disabled` button does not dispatch a
    // click handler at all, even force-clicked via CDP — proving the DOM-level
    // half of the lockout.
    await submit.click({ force: true }).catch(() => {})
    expect(state.promptAsyncHits, debugSuffix(state)).toEqual([])

    // Enter-submit is blocked at the SAME `handleSubmit` handler, independent of
    // the button's `disabled` attribute (submit-ui-state.ts checks
    // `roleSubmitBlocked()` first and preventDefaults) — fill text, press Enter,
    // and prove no prompt request fires via a deterministic network assertion
    // (never waitForTimeout alone).
    await editor.click()
    await editor.fill("this should never send")
    await page.keyboard.press("Enter")
    await page.waitForTimeout(800)
    expect(state.promptAsyncHits, debugSuffix(state)).toEqual([])

    await openWorkspaceNavigator(page, "Processes")
    await expect(page.getByRole("button", { name: "Add process" }), debugSuffix(state)).toHaveCount(0)
  })

  // FINDING (2026-07-10, remediation of behaviors 4/6/7/8/9): behavior 9's premise —
  // "the FIRST relay fetch issued once ready ... triggers a refresh before this test
  // does anything else" — is structurally unreachable from ANY e2e run served off a
  // loopback host (localhost/127.0.0.1), which every Playwright run in this repo is.
  // `refreshWorkspaceConnection`/`ensureFresh()` (src/utils/workspace-relay-
  // connection.ts:307-337) is only invoked by the REAL relay-fetch path inside
  // `createWorkspaceRuntimeRequest` (src/utils/workspace-runtime-request.ts:220-244),
  // which is skipped in favor of a same-origin "central server bridges the relay"
  // path whenever `isLoopbackHttpUrl(serverUrl) && !preferRelayOnLoopback` — see that
  // file's own already-existing comment on the analogous health-probe bridging, and
  // this file's `loopbackHealthMatch` handler above, which documents the identical
  // pattern for `/api/wr/health`. `getClaxedoServerUrl()` (src/utils/api.ts:211-224)
  // is what every workspace-runtime call (agent/vcs/session/provider/command/events —
  // confirmed via network capture: they resolve to the build-time
  // `VITE_CLAXEDO_SERVER_URL` origin, `http://127.0.0.1:3001` in this repo's
  // `.env.local`) resolves its central server from, and `localBackendForCurrentHost`
  // (src/utils/api.ts:107-118) HARD-CODES that resolution to a loopback origin
  // whenever `window.location.hostname` is itself a loopback host — which it always
  // is when Playwright drives this app from `http://localhost:<port>`. This function
  // does NOT consult `window.__OPENCODE__.serverUrl` (that seam feeds a DIFFERENT
  // function, `getDefaultBaseUrl()`, src/utils/api.ts:246-254, used by an unrelated
  // code path) — confirmed empirically: overriding `__OPENCODE__.serverUrl` to a
  // non-loopback fake origin in an initScript had NO effect on which origin
  // agent/vcs/session/provider/events resolved to. Net effect: in this harness, a
  // relay-backed workspace's post-ready traffic is UNCONDITIONALLY bridged through
  // the central server rather than going relay-direct from the browser, so
  // `createWorkspaceRelayConnection` (the only production caller of
  // `refreshWorkspaceConnection`) is never constructed and `POST
  // /api/workspace/:id/connection/refresh` never fires — confirmed by a full 20s
  // `expect.poll` staying at 0 while every other post-ready relay request (agent,
  // vcs, session, provider, command, events) DOES fire and IS observed by the mock.
  // This is not a spec-local mocking gap (spec-local `page.route` cannot patch a
  // build-time env constant or the browser's own hostname) and not fixable without
  // either an app-source change (an explicit e2e override seam for
  // `getClaxedoServerUrl()`, mirroring the existing `__OPENCODE__.serverUrl` seam for
  // `getDefaultBaseUrl()`) or running this spec from a genuinely non-loopback host —
  // both out of scope for this remediation pass. The role-transition STATE MACHINE
  // itself (`transitionConnectionPlacement`'s `role` event) is already unit-pinned in
  // `src/shell/state/connection-placement.test.ts` and
  // `src/shell/workspace/workspace-connection.test.ts`, so the logic this behavior
  // describes is covered — only the end-to-end "refresh fires from ambient traffic"
  // wiring is unprovable here.
  // Behavior 9's original premise — a near-expiry (500ms) token racing the app's
  // post-ready relay traffic to fire a real `/connection/refresh`
  // carrying the upgraded role — is BOTH non-deterministic AND structurally unreachable
  // from a loopback-served harness: `refreshWorkspaceConnection` is only invoked by the
  // relay-direct fetch path, which is bridged through the central server whenever the
  // server URL is loopback (see `localBackendForCurrentHost`), so the refresh request
  // never leaves the browser here. Per doc entry 34 rec A we make the sequencing
  // deterministic by driving the role flip through the `markRole` connection seam —
  // the SAME `{type:"role"}` placement event `applyWorkspaceConnectionInfo` feeds on a
  // real connect/refresh — so this exercises the real placement state machine and the
  // real composer role-gate reactivity, minus only the unreachable network hop (the
  // transition logic itself is additionally unit-pinned in connection-placement.test.ts
  // / workspace-connection.test.ts). Same class of dev-only escape hatch behaviors 4/6/7
  // already use for reconnect.
  test("a role that live-flips (viewer -> editor) unlocks the composer in place, no reload — behavior 9", async ({
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

    // Starts locked (viewer).
    await expect(editor, debugSuffix(state)).toHaveAttribute("aria-label", "Read-only workspace (viewer)")

    // A live role upgrade arrives (viewer -> editor) without any navigation or reload.
    await page.evaluate((id) => {
      ;(
        window as typeof window & { __claxedoConnections?: { markRole?: (id: string, role: string) => void } }
      ).__claxedoConnections?.markRole?.(id, "editor")
    }, WORKSPACE_ID)

    // ...and the composer unlocks in place — placeholder gone, submit enabled — on the
    // same page instance. Contention ceiling on the reactive transition, not a sleep.
    await expect(editor, debugSuffix(state)).not.toHaveAttribute("aria-label", "Read-only workspace (viewer)", {
      timeout: RECONNECT_STATE_TIMEOUT,
    })
    await expect(submit, debugSuffix(state)).toBeEnabled({ timeout: RECONNECT_STATE_TIMEOUT })
    await expect(submit).not.toHaveAttribute("aria-label", "Read-only workspace")
  })
})
