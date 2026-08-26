/**
 * SPEC: Rail sidebar — project/session tree
 *
 * PURPOSE — the left rail is the primary navigation surface: a collapsible
 * Project > (Workspace >) Session tree that lets the user see, filter, open,
 * and archive every session across every project without leaving the shell.
 * Source: `src/claxedo-ui/layouts/rail-sidebar.tsx` (disclosure/list/filter
 * logic), `src/claxedo-ui/navigation-islands/session-navigation-list.tsx`
 * (session row + status dot), `src/shell/layout/state.ts` (pin/peek/resize),
 * `src/claxedo-ui/layouts/rail-sidebar-shell.tsx` (shell chrome: resize
 * handle, mobile scrim), `src/claxedo-ui/layouts/rail-shell-chrome-state.ts`
 * (mobile drawer signal).
 *
 * STATE MODEL —
 *   - **View options** (`Group by` / `Show status|environment|git` / `Archived`)
 *     live in one object persisted to `localStorage["claxedo.session-view.v1"]`
 *     (`VIEW_KEY`, rail-sidebar.tsx:90). Malformed JSON at that key is caught
 *     (`loadView()`, rail-sidebar.tsx:360-376) and silently replaced by
 *     `defaultView()` (`{group:"project", status:[], environment:[], git:[],
 *     archived:"active"}`, rail-sidebar.tsx:378-386) — never a thrown error.
 *   - **Disclosure open/closed** per project/workspace section is local
 *     `createSignal` state (NOT persisted); it auto-opens the first time a
 *     section gets rows/terminals or becomes the active section
 *     (`shouldAutoOpenWorkspaceSection`, rail-sidebar.logic.ts:1-9) but stays
 *     closed on subsequent empty renders once the user manually toggles it.
 *   - **Session list pages** are server state fetched per-section from
 *     `GET /api/control/session-list?scope=workspace|project&...` (built by
 *     `controlSessionNavigationListUrl`, `src/utils/workspace-control-routes.
 *     ts:87-104) via TanStack Query (`sessionListQueryOptions`,
 *     `src/shared/query/session-list.ts`); "Load more" appends a page via an
 *     explicit `cursor` fetch merged client-side (`appendSessionListPageQueryData`).
 *     Page size is `SESSION_GROUP_PAGE_SIZE = 5` (rail-sidebar.tsx:94).
 *   - **Filter option availability** (which Status/Environment/Git values show
 *     in the view menu) comes from a SEPARATE global session inventory
 *     (`sessionInventory()`, fed by `GET /api/control/sessions` via
 *     `src/context/global-sync/inventory-source.ts:450-458`), not from the
 *     paginated session-list — the two must be kept consistent by the caller.
 *   - **Per-row status dot** is derived from two independently-updated caches:
 *     `session.status`/`session.idle`/`session.error` SSE events are dispatched
 *     directly into `shellDataKeys.sessionId(id,"status")`
 *     (`applySessionStatusSseEvent`, `src/session/store/session-status-
 *     dispatcher.ts:120-166`); `permission.asked`/`question.asked` do NOT
 *     update the row directly — they only invalidate, and the actual content
 *     is refreshed by a batched `client.session.status()` +
 *     `client.permission.list()` + `client.question.list()` poll scoped per
 *     directory, gated to once per `SIDEBAR_SESSION_STATUS_FRESH_MS` (10s)
 *     (rail-sidebar.tsx:847-995). `SwitcherStatus` priority is permission >
 *     working (busy/retry) > done (unseen) > idle
 *     (`sessionSurfaceStatus`, `src/claxedo-ui/compact-switcher/surface-
 *     status.ts:19-29`); "done" (unseen badge) is set when a row transitions
 *     from active/busy to inactive/idle while never focused
 *     (`nextUnseenDone`, surface-status.ts:89-98).
 *   - **Rapid session-switch** intent is tracked in a short-lived window
 *     (`markFastSessionSwitch`/`fastSessionSwitchAnyQuietDelay`,
 *     `src/session/store/fast-session-switch.ts`, 250ms intent / 2000ms
 *     network-quiet) that suppresses stale status/requests network writes for
 *     a session the user has already navigated away from.
 *   - **Sidebar pin/peek/width** live in `src/shell/layout/state.ts`
 *     (`createShellLayoutState`) as an in-memory command overlay on top of a
 *     `LayoutConfig`; `HOT_ZONE_WIDTH/HEIGHT = 48`px (top-left corner),
 *     `RAIL_MIN_WIDTH = 220`, `RAIL_MAX_WIDTH = 520`. Only the **committed
 *     width** is mirrored back into the persisted `claxedoState.rail` store
 *     (`commitSidebarResize`, `src/shell/app-shell-layout.tsx:256-258`, itself
 *     persisted under `localStorage["claxedo.state.v5"]`); pin/unpin toggles
 *     are session-only and do NOT survive reload (`claxedoState.rail.pin/
 *     unpin/toggle` are never called from production code — only `setWidth`
 *     is). Default boot state is `pinned:true, width:260`
 *     (`src/claxedo-ui/state/persistence.ts:27`).
 *   - **Mobile drawer** open/closed is a plain `createSignal(false)` in
 *     `useRailShellChromeState` (`rail-shell-chrome-state.ts:18`) with no
 *     persistence. Its `openMobileSidebar`/`toggleMobileSidebar` setters ARE
 *     wired (WP-C3 §3.1): `app-shell-layout.tsx` passes them down and the
 *     `md:hidden` opener button in `rail-sidebar-shell.tsx` toggles the drawer.
 *     See BEHAVIORS #14.
 *
 * ANATOMY —
 *   `[data-testid="rail-sidebar"]` — tree root.
 *   `[data-testid="sidebar-toggle"]` — pin/unpin + expand/collapse button.
 *   `[data-testid="project-header"][data-project-id][data-active]` +
 *     `[data-testid="project-group"][data-project-id]` — one row per project
 *     when `Group by: Project` (default).
 *   `[data-testid="workspace-project-header"]` +
 *     `[data-testid="workspace-project-group"]` (outer, per project) wrapping
 *     `[data-testid="workspace-header"][data-workspace-id]` (inner, per
 *     workspace directory) when `Group by: Workspace`.
 *   Each header: a `role="button"` disclosure caret (separate hit target,
 *     `aria-label="Collapse/Expand project|workspace"`, `aria-expanded`) that
 *     `stopPropagation()`s so it never fires the header's own `onClick`
 *     (select+expand); `HeaderActions` (New session / New terminal / New
 *     Claude / New Codex / kebab) fades in via `opacity-0
 *     group-hover/header:opacity-100`.
 *   `[data-testid="rail-sidebar-session-row"][data-session-id][data-session-
 *     ref][data-active]` — a session row; hovering (`.group/session`) fades in
 *     an `aria-label="Archive <title>"` button; a `[data-sidebar-status="working
 *     |permission|done"]` dot (idle renders a relative-time label instead, no
 *     dot at all).
 *   `[data-testid="rail-sidebar-session-list-loading|error|empty|done"]` —
 *     per-section list-state notices; the error notice renders a "Retry"
 *     action button.
 *   A "Load more" / "Loading..." button appears while `nextCursor` is set.
 *   rail account menu → "View options" submenu; contains a
 *     `Group by` radio (Project/Workspace), a `Show` group with conditional
 *     Status/Environment/Git submenus (rendered only when at least one loaded
 *     session carries that dimension) and an unconditional `Archived` radio
 *     (Active/All/Archived).
 *   `[aria-hidden="true"].cursor-col-resize` (no testid) — the sidebar's
 *     right-edge drag-resize handle, a sibling of `[data-testid="rail-
 *     sidebar"]`; distinct from the workspace panel's resize handle, which
 *     carries `role="separator" aria-label="Resize workspace panel"` instead.
 *   Mobile (`max-md:`): the whole rail becomes a `fixed` off-canvas drawer
 *     translated by `mobileSidebarOpen()`, preceded by a click-to-close scrim
 *     (`bg-background-stronger/70`, no testid) when open.
 *
 * BEHAVIORS —
 *   1. In `Group by: Workspace` mode, clicking a `workspace-header`'s body
 *      expands that section AND opens the workspace review side panel for that
 *      worktree (`openWorkspacePanel(section.workspaceDir)` →
 *      `workspacePanel.open("review", {workspaceDir})`, observable as
 *      `[data-testid="workspace-panel-shell"]`'s `data-state-open="true"` /
 *      `data-state-mode="review"` / `data-state-workspace-dir=<dir>`). It does
 *      NOT navigate the main route and there is no `data-active` marker on this
 *      header — route-level workspace selection is the OUTER
 *      `workspace-project-header`'s job (behavior 2's mechanism). Clicking the
 *      inner header's disclosure caret only toggles open/closed and does not
 *      select, open the panel, or navigate.
 *   2. In `Group by: Project` mode (default), clicking a `project-header`'s
 *      body selects the project's primary workspace and expands it; its
 *      disclosure caret only toggles collapse/expand.
 *   3. Hovering a header reveals its inline action buttons (opacity 0→1);
 *      hovering a session row reveals its Archive button the same way — both
 *      are effectively hidden at rest.
 *   4. A session row's status indicator moves idle (no dot, time label) →
 *      working (`data-sidebar-status="working"`, pulsing `bg-text-weak`) → done
 *      (`data-sidebar-status="done"`, solid `bg-text-weak`, unseen) as
 *      `session.status`/`session.idle` SSE events land for a row that is never
 *      opened/focused. (The palette is deliberately minimal — grey for both,
 *      red only for `permission`; `NavigationStatusDot`,
 *      `src/app/workbench/navigation/navigation-row.tsx:116-137`. The earlier
 *      "amber"/"green" wording here never matched the component.) Across a
 *      RELOAD there is no SSE frame to lean on, so a still-running session's
 *      dot is rehydrated purely from `GET /session/status`; the in-memory
 *      unseen-done flag does not survive that, so a turn that finished while
 *      the tab was away comes back as idle rather than "done".
 *   5. Clicking a session row activates it (`data-active="true"`); clicking a
 *      second row before the first click's work settles resolves
 *      deterministically onto the second row, not a stale mix of both.
 *   6. "Load more" fetches the next page (`SESSION_GROUP_PAGE_SIZE = 5` per
 *      page), appends rows without duplicating the first page, and advances
 *      the cursor; once every session is loaded the "All sessions loaded"
 *      done notice replaces the button.
 *   7. The view-options menu's `Group by` radio restructures the tree between
 *      `project-header`/`project-group` and `workspace-project-header`(+nested
 *      `workspace-header`); its `Archived` radio is threaded onto the
 *      session-list query's `archived` param, changing which sessions are
 *      fetched (active vs archived).
 *   8. View-options state persists to `localStorage["claxedo.session-view.v1"]`
 *      and survives reload; malformed JSON at that key falls back silently to
 *      `defaultView()` instead of breaking the tree.
 *   9. The session list surfaces distinct loading / error / empty notices with
 *      stable testids driven by the underlying query state; the error
 *      notice's Retry action re-fires the query.
 *   10. The per-row Archive hover button archives the session (`PATCH /session/
 *       {id}` with `time.archived`) and removes it from the active view
 *       immediately; when that request fails, the row is left exactly in
 *       place (silent no-op besides an error toast) — never optimistically
 *       removed.
 *   11. An unpinned, collapsed sidebar peeks open when the pointer enters the
 *       top-left 48×48px hot zone, and auto-collapses again once the pointer
 *       leaves the rail's bounding rect.
 *   12. Dragging the sidebar's right-edge resize handle live-resizes it
 *       (clamped to [220,520]px); the committed width survives a reload.
 *   13. The `sidebar-toggle` button pins+expands an unpinned/collapsed sidebar
 *       and unpins+collapses a pinned one.
 *   14. On a mobile viewport the rail is an off-canvas drawer: the `md:hidden`
 *       `[data-testid="mobile-sidebar-opener"]` button opens it
 *       (`openMobileSidebar`, `rail-shell-chrome-state.ts`) and flips its own
 *       `aria-expanded`; a `[data-testid="mobile-sidebar-scrim"]` appears only
 *       while open and closes the drawer when tapped; picking a session row
 *       closes the drawer AND activates the row (`RailSidebar.activateSession`
 *       invokes `onSessionSelect`, which `RailSidebarShell` wraps with
 *       `closeMobileSidebar()` — the row's own navigation stays owned by
 *       `activateSession`, the shell wrapper only dismisses the drawer).
 *       LIVE since WP-C3 §3.1 wired the open path end to end — the previous
 *       former "dead code" note here was stale.
 *   15. A session created with a NON-opencode harness (e.g. Codex via ACP)
 *       becomes visible in the tree once its `session.lifecycle` "created"
 *       event reaches the client, the same way an opencode-native session's
 *       native `session.created` SSE event already does. FIXED BUG (root
 *       cause was server-side, not in this package): harness/ACP session
 *       creation (`packages/workspace-runtime/src/routes/session-core.ts`
 *       `.post("/session")`) only ever publishes a `session.lifecycle` event
 *       on `claxedoBus` (aka `workspaceRuntimeBus`) — it never emits the
 *       native opencode `session.created` event that `globalBus` carries.
 *       `packages/claxedo-local-server/src/opencode/compat-routes/events.ts`'s
 *       `streamGlobalEvents` — the handler behind BOTH `/global/event` and
 *       the local-mode `/api/wr/events` fallback, the ONLY stream a
 *       local/unsigned workspace ever opens
 *       (`claxedoEventStreamTargets` in `packages/claxedo-app/src/providers/
 *       claxedo-events.tsx` only adds a workspace-scoped connection for
 *       `cloud`/`user-hosted` kinds) — used to subscribe ONLY to `globalBus`,
 *       so a harness session's only notification was silently dropped and
 *       `applyClaxedoSessionLifecycleToSync`
 *       (`src/context/global-sync/event-ingress.ts`) never fired. Fixed by
 *       making `streamGlobalEvents` also forward `claxedoBus` events, written
 *       flat/unwrapped to match the shape `ClaxedoEventsProvider`'s
 *       `isClaxedoEvent` guard requires. This spec's mock cannot exercise the
 *       server-side transport bug itself (Tier M mocks bypass the real
 *       server) — it pins the FRONTEND contract the fix depends on: once a
 *       `session.lifecycle` "created" event for a harness session arrives
 *       (`mock.emitFlat`, matching the real unwrapped wire shape), the
 *       already-correct frontend handling
 *       (`applySessionInventoryLifecycle`) surfaces the new row. The actual
 *       transport fix is pinned server-side by
 *       `packages/claxedo-local-server/src/opencode/compat-routes/events.test.ts`.
 *   16. The rail's account footer (`[data-testid="rail-account-trigger"]`) is
 *       keyboard-operable and focus-restoring: Enter opens the menu
 *       (`aria-expanded="true"`) exposing View options / Usage /
 *       Settings / Help (Diagnostics is env-gated — see the test's comment);
 *       ArrowRight opens the focused item's submenu and moves focus into it;
 *       Escape closes the submenu and returns focus to its parent item, and a
 *       final Escape closes the menu and returns focus to the trigger with
 *       `aria-expanded="false"`. The View-options submenu this exposes is the
 *       entry point behaviors 7/8 drive.
 *
 * INVARIANTS — disclosure-caret clicks never trigger the header body's select
 *   action and vice versa (both stopPropagation the other's handler); a
 *   completed-but-unfocused turn always ends in the "done" unseen state, never
 *   silently reverting to "idle" (see `nextUnseenDone`); archive is
 *   all-or-nothing from the tree's point of view — a failed archive leaves the
 *   row fully intact, never partially removed.
 *
 * HARNESS NOTES — the sidebar tree's OWN reads (session-list/status APIs) are
 *   harness-agnostic, but a NEWLY created session's live appearance depends on
 *   a harness-specific event path reaching the client first — see BEHAVIORS
 *   #15: opencode-native sessions ride the native `session.created` SSE
 *   event, non-opencode/harness sessions ride `session.lifecycle` instead,
 *   and (until the fix above) only the former reliably reached a
 *   local/unsigned workspace's client.
 *
 * OUT OF SCOPE — sending prompts / oracle-proved replies (every other
 *   `core-*` spec); workspace lifecycle actions reachable from the header
 *   kebab (Edit project, Delete workspace, Remove project, Share workspace —
 *   `core-workspace-lifecycle`); terminal rows (`core-terminal`); the
 *   `permission`/`question` sub-state of the status dot (it depends on a
 *   ~10s-freshness-gated background poll rather than direct SSE dispatch —
 *   see STATE MODEL — and is not exercised here to keep the suite fast; the
 *   idle→working→done cycle it shares a code path with IS covered). The mobile
 *   drawer is IN scope and covered by BEHAVIORS #14.
 */
import { workspaceResolveRoute } from "../helpers/contracts/workspace-resolve"
import { sessionListRoute } from "../helpers/contracts/session-list"
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-core-sidebar-tree"
const PROJECT_ID = "proj_core_sidebar_tree"
const SESSION_ID = "ses_core_sidebar_tree_mock"

// Contention-tolerant ceiling for the keyboard-driven menu/focus transitions in the
// account-footer test, which a starved CI runner was blowing past the 10s expect
// default (doc entry 8: CI-only, focus-restoration "timing-sensitive under
// contention"). Each assertion still awaits the actual visibility/focus transition —
// the wider ceiling only outlasts host lag, it never weakens the assertion.
const MENU_FOCUS_TIMEOUT = 30_000

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

type FixtureSession = {
  sessionId: string
  title: string
  tags?: string[]
  createdAt: number
  updatedAt: number
  archivedAt?: number
}

type ViewOverride = {
  group?: "project" | "workspace"
  status?: string[]
  environment?: string[]
  git?: string[]
  archived?: "active" | "all" | "archived"
}

async function seedProject(page: Page, opts: { dir: string; view?: ViewOverride | "malformed" }) {
  await page.addInitScript(
    ([dir, view]: [string, ViewOverride | "malformed" | undefined]) => {
      // No `localStorage.clear()` here: Playwright re-runs `addInitScript`
      // on every navigation within a test, including `page.reload()` — a
      // fresh context already starts with empty storage (this call was a
      // no-op there), but clearing on reload was wiping out whatever the
      // page itself had just persisted (e.g. the "view state survives
      // reload" scenario's own `localStorage.setItem` from a real user
      // interaction), which is exactly what those scenarios exist to prove.
      ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
        serverUrl: window.location.origin,
        activeDirectory: dir,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: { local: [{ worktree: dir, expanded: true }] },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
      if (view === "malformed") {
        localStorage.setItem("claxedo.session-view.v1", "{not valid json")
      } else if (view) {
        localStorage.setItem("claxedo.session-view.v1", JSON.stringify(view))
      }
    },
    [opts.dir, opts.view] as [string, ViewOverride | "malformed" | undefined],
  )
}

/**
 * Installs the two control-plane endpoints the sidebar tree needs that
 * `installMockRuntime` does not cover (it only mocks the OpenCode-native
 * `/session` surface, not the control-plane session inventory/list used by
 * the tree itself — see SPEC STATE MODEL):
 *   - `GET /api/control/session-list` — the paginated, filterable rows a
 *     project/workspace section actually renders.
 *   - `GET /api/control/sessions` — the flat inventory that feeds the view
 *     menu's Status/Environment/Git filter option lists.
 * Registered AFTER `installMockRuntime` so it wins (Playwright routes run
 * most-recently-registered-first).
 *
 * Also overrides `GET /api/workspace/resolve` (`installMockRuntime`,
 * mock-runtime.ts:608-610, always answers `workspaceId: local-${sessionId}`
 * regardless of the requested `directory` — a shared-helper gap, not fixable
 * here per the pooled-run rules). Left unpatched, every workspace-resolve
 * call — including ones for OUR real `dir` — collapses onto that one bogus
 * id, which spuriously auto-navigates the tree onto `/w/local-<sessionId>`
 * before any test interaction and confuses the review panel's per-directory
 * scoping. This override answers each request with a `workspaceId` that
 * actually reflects the directory that was queried.
 */
async function installSessionTreeFixtures(page: Page, opts: { dir: string; projectId: string; sessions: FixtureSession[] }) {
  let sessions = [...opts.sessions]
  let sessionListDelayMs = 0
  // A persistent flag, not a one-shot one: TanStack Query's default `retry`
  // silently re-issues the query on failure, so a single failing response
  // never reaches an observable error state — it just retries and succeeds
  // before any assertion can see it. Keep failing until the test explicitly
  // clears it (e.g. right before exercising the Retry button, so that click
  // actually succeeds).
  let sessionListFailing = false
  const sessionListRequests: string[] = []

  const toNavRow = (item: FixtureSession) => ({
    type: "session",
    sessionRef: item.sessionId,
    sessionId: item.sessionId,
    title: item.title,
    directory: opts.dir,
    workspaceId: undefined,
    projectId: opts.projectId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.archivedAt ? { archivedAt: item.archivedAt } : {}),
    tags: item.tags ?? [],
    attachments: [],
  })

  await page.route(sessionListRoute, async (route) => {
    const url = new URL(route.request().url())
    sessionListRequests.push(url.search)
    if (sessionListDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, sessionListDelayMs))
    if (sessionListFailing) {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) })
    }
    const archived = url.searchParams.get("archived") ?? "active"
    const statusFilter = (url.searchParams.get("status") ?? "").split(",").filter(Boolean)
    const limit = Number(url.searchParams.get("limit") ?? "5") || 5
    const cursor = url.searchParams.get("cursor")
    const offset = cursor ? Number(cursor) || 0 : 0

    let filtered = sessions.filter((item) => {
      if (archived === "active") return !item.archivedAt
      if (archived === "archived") return !!item.archivedAt
      return true
    })
    if (statusFilter.length > 0) {
      filtered = filtered.filter((item) => (item.tags ?? []).some((tag) => statusFilter.includes(tag)))
    }
    filtered = [...filtered].sort((a, b) => b.updatedAt - a.updatedAt)

    const page_ = filtered.slice(offset, offset + limit)
    const nextCursor = offset + limit < filtered.length ? String(offset + limit) : undefined

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        view: { scope: url.searchParams.get("scope") ?? "workspace", groupBy: "none", sort: "updated_desc", limit },
        items: page_.map(toNavRow),
        nextCursor,
        totalKnown: filtered.length,
      }),
    })
  })

  await page.route("**/api/control/sessions**", async (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: sessions.map((item) => ({
          sessionID: item.sessionId,
          title: item.title,
          directory: opts.dir,
          projectID: opts.projectId,
          tags: item.tags ?? [],
          attachments: [],
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          ...(item.archivedAt ? { archived: item.archivedAt } : {}),
        })),
      }),
    })
  })

  await page.route(workspaceResolveRoute, async (route) => {
    const url = new URL(route.request().url())
    const directory = url.searchParams.get("directory") ?? opts.dir
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ workspaceId: opts.projectId, directory, kind: "local", status: "ready" }),
    })
  })

  // Direct `/s/:id` recovery resolves through this metadata endpoint. Keep it
  // backed by the same mutable rows as the list/PATCH fixtures so an archived
  // session cannot be reconstructed from an independently stale mock.
  await page.route("**/api/claxedo/session/*/meta**", async (route) => {
    const pathname = new URL(route.request().url()).pathname
    const match = pathname.match(/^\/api\/claxedo\/session\/([^/]+)\/meta$/)
    const sessionId = match?.[1] ? decodeURIComponent(match[1]) : undefined
    const target = sessionId ? sessions.find((item) => item.sessionId === sessionId) : undefined
    if (!target) {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) })
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionID: target.sessionId,
        host: "workspace",
        directory: opts.dir,
        projectID: opts.projectId,
        title: target.title,
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
        tags: target.tags ?? [],
        attachments: [],
        ...(target.archivedAt ? { archived: target.archivedAt } : {}),
      }),
    })
  })

  // Archive PATCH: `installMockRuntime`'s generic `**/session/*` catch-all
  // answers any method (including PATCH) with a canned 200 and doesn't track
  // `time.archived`, so it never affects OUR in-memory `sessions` array. If
  // anything ever re-fetches `/api/control/session-list` after an archive
  // (a background revalidation, another reconciliation path, etc.), the
  // stale unarchived list would silently undo the optimistic row removal.
  // Track the archive here too so a refetch stays consistent with what the
  // UI already believes happened. Registered after the two list routes
  // above so it wins for this exact path.
  await page.route("**/session/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    const pathname = new URL(route.request().url()).pathname
    const match = pathname.match(/^\/session\/([^/]+)$/)
    const sessionId = match?.[1]
    const target = sessionId ? sessions.find((item) => item.sessionId === sessionId) : undefined
    if (target) target.archivedAt = Date.now()
    return route.fallback()
  })

  return {
    get sessions() {
      return sessions
    },
    setSessions(next: FixtureSession[]) {
      sessions = next
    },
    setSessionListDelay(ms: number) {
      sessionListDelayMs = ms
    },
    /**
     * Fails every session-list request until `stopFailingSessionList()` is
     * called. Persistent, not one-shot: TanStack Query's default `retry`
     * silently re-issues the query on failure, so a single failing response
     * gets retried-and-succeeded before any assertion can observe the error
     * state.
     */
    failNextSessionList() {
      sessionListFailing = true
    },
    stopFailingSessionList() {
      sessionListFailing = false
    },
    sessionListRequests,
  }
}

function makeSessions(count: number, opts: { prefix: string; tags?: string[]; baseTime?: number } = { prefix: "s" }) {
  const base = opts.baseTime ?? Date.now() - count * 60_000
  const rows: FixtureSession[] = []
  for (let i = 0; i < count; i++) {
    rows.push({
      sessionId: `ses_${opts.prefix}_${i}`,
      title: `${opts.prefix} session ${i}`,
      tags: opts.tags,
      createdAt: base + i * 1000,
      updatedAt: base + i * 1000,
    })
  }
  return rows
}

async function openTree(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="rail-sidebar"]')).toBeVisible({ timeout: 20_000 })
}

function opacityOf(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((el) => Number(getComputedStyle(el).opacity))
}

test.describe("core sidebar tree @core", () => {
  test("project-header disclosure caret toggles collapse only, never navigates — behavior 2", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "root" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const header = page.locator('[data-testid="project-header"]')
    await expect(header).toBeVisible()
    const caret = header.locator('[role="button"][aria-label*="project"]')
    await expect(caret).toHaveAttribute("aria-expanded", "true")

    // Disclosure caret click: toggles collapse only, never navigates
    // (INVARIANTS: caret stopPropagation()s the body's select handler).
    const draftUrl = page.url()
    await caret.click()
    await expect(caret).toHaveAttribute("aria-expanded", "false")
    expect(page.url()).toBe(draftUrl)

    await caret.click()
    await expect(caret).toHaveAttribute("aria-expanded", "true")
    expect(page.url()).toBe(draftUrl)
  })

  test("project-header body click selects the project's primary workspace — behavior 2", async ({ page }) => {
    // Fixed in Wave 2 (WP-B2): `openOrCreateSession`
    // (src/claxedo-ui/layout-actions/workspace-actions.ts) now excludes the
    // `"new"` draft sentinel from its reuse check
    // (`existing.sessionId && existing.sessionId !== "new"`), so a
    // project-header body click on a bare draft route no longer treats the draft
    // as a reusable session and navigates to the malformed `/s/new`. It routes
    // to `workspaceSessionRoute(workspaceDir)` (`/w/<dir>/session`).
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "primary" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const header = page.locator('[data-testid="project-header"]')
    await expect(header).toBeVisible({ timeout: 15_000 })

    // Click the header BODY (x=60 clears the disclosure caret at the far left
    // and lands ahead of the opacity-0 HeaderActions further right) — this fires
    // `onWorkspaceSelect` -> `handleWorkspaceSelect` -> `openOrCreateSession`.
    await header.click({ position: { x: 60, y: 8 } })

    // Fix proof: navigates to the canonical workspace session route, never the
    // malformed `/s/new` dead-end the "new" sentinel used to produce.
    await expect(page).toHaveURL(/\/w\/.+\/session/, { timeout: 15_000 })
    await expect(page).not.toHaveURL(/\/s\/new/)
  })

  test("workspace-header disclosure caret toggles collapse only, never navigates — behavior 1", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "ws" }) })
    await seedProject(page, { dir: DIR, view: { group: "workspace" } })
    await openTree(page, DIR)

    const header = page.locator('[data-testid="workspace-header"]')
    await expect(header).toBeVisible({ timeout: 15_000 })
    const caret = header.locator('[role="button"][aria-label*="workspace"]')
    await expect(caret).toHaveAttribute("aria-expanded", "true")

    // The workspace review panel is the observable effect of the BODY click
    // below, so pin its closed starting state first — otherwise the post-click
    // assertion could not tell "the click opened it" from "it was already open".
    // Since ae3086a8 the panel shell is disposed while closed and only mounts
    // on first open (`workspacePanelMounted`/`motion.shellMounted` gating the
    // `<RailWorkspacePanelShell>` Show in rail-workbench-shell.tsx), so the
    // closed starting state is "not in the DOM at all" — stronger evidence of
    // "closed" than the old always-mounted data-state-open="false".
    const panel = page.locator('[data-testid="workspace-panel-shell"]')
    await expect(panel).toHaveCount(0)

    const draftUrl = page.url()
    await caret.click()
    await expect(caret).toHaveAttribute("aria-expanded", "false")
    expect(page.url()).toBe(draftUrl)
    // The caret's `stopPropagation()` means it never reaches the header body's
    // handler: no navigation (above) and no panel either — it stays unmounted.
    await expect(panel).toHaveCount(0)

    // Header body click: re-opens the section (proof it does something the
    // caret-only click above didn't undo on its own) and targets the
    // workspace panel at this directory. Unlike project-header,
    // workspace-header's body click (`openWorkspacePanel` in
    // src/app/workbench/rail/rail-sidebar.tsx) opens the review side panel for
    // this specific worktree — it does not navigate the main route to a
    // `/session` URL; that's `workspace-project-header`'s (the outer,
    // project-level header) job via `onWorkspaceSelect`. Click at x=60 (not
    // x=200): the header row is only ~250px wide and HeaderActions (New
    // session/terminal/Claude/Codex/kebab, opacity-0 at rest but still
    // hit-testable) sit past x~110 — x=200 lands on "New Codex terminal", not
    // the header body.
    await header.click({ position: { x: 60, y: 8 } })
    await expect(caret).toHaveAttribute("aria-expanded", "true", { timeout: 15_000 })
    await expect(page).toHaveURL(draftUrl)
    // The click's actual selection effect. `toHaveAttribute("data-workspace-id",
    // DIR)` on the header itself would be a tautology — that attribute is the
    // element's static identity, true before any click ever happened — so pin
    // the panel state the click produced instead: open, in review mode, aimed
    // at THIS worktree. (`workspace-header` carries no `data-active` marker;
    // route-level selection belongs to the outer project header, behavior 2.)
    await expect(panel).toHaveAttribute("data-state-open", "true", { timeout: 15_000 })
    await expect(panel).toHaveAttribute("data-state-mode", "review")
    await expect(panel).toHaveAttribute("data-state-workspace-dir", DIR)
  })

  test("hover reveals header actions and the session-row archive button — behavior 3", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "hover" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const header = page.locator('[data-testid="project-header"]')
    const newSessionButton = header.getByRole("button", { name: /New session in/ })
    // MOUNT-ON-ENGAGEMENT (rail-hover-engagement.ts, commit 40e02011): at rest
    // the header's action cluster is NOT in the DOM at all — its wrapper only
    // reserves the buttons' box (`railHeaderActionsBox`) so layout stays
    // byte-stable. "Hidden at rest" is therefore count 0, not opacity 0.
    await expect(newSessionButton).toHaveCount(0)
    await header.hover()
    // Engaged (pointerenter): the buttons mount, and the cluster wrapper —
    // which still carries the opacity-0/group-hover:opacity-100 fade — settles
    // at computed opacity 1, i.e. actually visible to the user.
    await expect(newSessionButton).toBeVisible()
    const newSessionActions = header.locator('[data-icon-interaction="row-actions"]')
    await expect.poll(() => opacityOf(newSessionActions)).toBe(1)

    const row = page.locator('[data-testid="rail-sidebar-session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    // Same contract on the session row: the archive button mounts on row
    // engagement (`NavigationRow.onEngagedChange` -> `engaged()` Show), so
    // pre-hover it is absent, and post-hover it is mounted AND fades to
    // computed opacity 1 (`.ui-session-navigation-archive` + the row's
    // :hover rule).
    const archiveButton = row.getByRole("button", { name: /^Archive / })
    await expect(archiveButton).toHaveCount(0)
    await row.hover()
    await expect(archiveButton).toBeVisible()
    await expect.poll(() => opacityOf(archiveButton)).toBe(1)
  })

  test("status dot: idle has no dot — behavior 4 (partial)", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "status" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const targetId = "ses_status_0"
    const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${targetId}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })

    // Idle: no status dot at all, the relative-time label renders instead.
    // The working/done half of behavior 4 is the sibling test below.
    await expect(row.locator("[data-sidebar-status]")).toHaveCount(0)
  })

  test("status dot moves working -> done as session.status/session.idle SSE land — behavior 4", async ({ page }) => {
    const targetId = "ses_live_0"
    // Two independently-updated caches decide this row's dot (see SPEC STATE
    // MODEL): the SSE dispatch into `shellDataKeys.sessionId(id,"status")`, and
    // the sidebar's batched `client.session.status()` reconciliation. The
    // mock's live-session map is moved in step with every frame emitted here
    // so the two can never disagree — which is what the real server does
    // anyway, publishing `session.status` and updating the map it serves from
    // the same `SessionStatus.set` call (`opencode/src/session/status.ts:38-47`).
    //
    // MEASURED, so nobody re-derives it from the source and gets it wrong the
    // way this test's `fixme` note did: with the mock's OLD status handling
    // restored, this scenario still passed 6/6. The batch fires once per
    // `sessionStatusTargetSignature` change and is then gated for
    // `SIDEBAR_SESSION_STATUS_FRESH_MS` (10s), so it had already run before the
    // first emit — and it could not have contradicted anything anyway, because
    // `GET /session/status` was being answered by the shared mock's
    // `**/session/*` catch-all with a session ROW rather than a status map (see
    // that route's comment in mock-runtime.ts). The `setSessionStatus` calls
    // below therefore keep the mock honest rather than papering over a live
    // race here; where the map IS decisive is the reload scenario in the next
    // test, which has no SSE frame to lean on at all.
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "live" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${targetId}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.locator("[data-sidebar-status]")).toHaveCount(0)

    // idle -> working. `busy` is the only status the dot's "working" branch
    // reads besides `retry` (`sessionSurfaceStatus`, surface-status.ts:28).
    mock.setSessionStatus(targetId, { type: "busy" })
    mock.emit({ type: "session.status", properties: { sessionID: targetId, status: { type: "busy" } } })
    await expect(row.locator('[data-sidebar-status="working"]')).toHaveCount(1, { timeout: 20_000 })

    // working -> done. The row was never opened or focused (this spec never
    // clicks it), so the active->inactive edge sets the unseen-done flag
    // rather than falling back to idle — the INVARIANT that a completed but
    // unfocused turn never silently reverts to "no dot". Settling clears the
    // session from the live map: the real route reports idle by OMITTING the
    // key, never by sending `{type:"idle"}` (e2e/helpers/contracts/
    // session-status.ts).
    mock.setSessionStatus(targetId)
    mock.emit({ type: "session.idle", properties: { sessionID: targetId } })
    await expect(row.locator('[data-sidebar-status="done"]')).toHaveCount(1, { timeout: 20_000 })
    await expect(row.locator('[data-sidebar-status="working"]')).toHaveCount(0)
  })

  test("status dot rehydrates from GET /session/status after a reload, with no SSE frame — behavior 4", async ({ page }) => {
    // The other half of the two-cache model in behavior 4, and the half no SSE
    // test can reach: a reload throws away every in-memory status cache, so a
    // session that is STILL busy on the server can only get its dot back from
    // the batched `client.session.status()` read (rail-sidebar.tsx:912-927).
    // If that read reports the row idle, the dot is silently wrong for up to
    // the whole rest of the turn — the row looks finished while the agent is
    // still working.
    //
    // This is also what pins the shared mock's live-session map: the map is the
    // only input here. Seeded via `options.sessionStatuses` rather than
    // `setSessionStatus` so it is already live at first paint, exactly as a
    // server restarted mid-turn would report it.
    const targetId = "ses_rehydrate_0"
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      projectName: "sidebar-tree",
      sessionStatuses: { [targetId]: { type: "busy" } },
    })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "rehydrate" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${targetId}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.locator('[data-sidebar-status="working"]')).toHaveCount(1, { timeout: 20_000 })

    // Reload with the session still busy server-side: the dot must come back.
    await page.reload()
    await expect(page.locator('[data-testid="rail-sidebar"]')).toBeVisible({ timeout: 20_000 })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.locator('[data-sidebar-status="working"]')).toHaveCount(1, { timeout: 20_000 })

    // And settling it server-side (the key is DROPPED, not set to idle — see
    // e2e/helpers/contracts/session-status.ts) clears the dot on the next
    // reload. "done" is deliberately NOT expected here: the unseen-done flag is
    // in-memory sidebar state that a reload discards, so a turn that finished
    // while the tab was gone rehydrates as plain idle, not as unseen-done.
    mock.setSessionStatus(targetId)
    await page.reload()
    await expect(page.locator('[data-testid="rail-sidebar"]')).toBeVisible({ timeout: 20_000 })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.locator("[data-sidebar-status]")).toHaveCount(0, { timeout: 20_000 })
  })

  test("clicking a session row activates it; a rapid second click resolves onto the last row — behavior 5", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "race" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const rowA = page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_race_0"]')
    const rowB = page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_race_1"]')
    await expect(rowA).toBeVisible({ timeout: 15_000 })
    await expect(rowB).toBeVisible({ timeout: 15_000 })

    // Single click activates deterministically.
    await rowA.click()
    await expect(rowA).toHaveAttribute("data-active", "true", { timeout: 15_000 })
    await expect(rowB).toHaveAttribute("data-active", "false")

    // Rapid switch: click B immediately after A, before A's activation
    // settles. The tree must land on B, not a stale mix of both.
    await rowB.click()
    await rowA.click()
    await rowB.click()
    await expect(rowB).toHaveAttribute("data-active", "true", { timeout: 15_000 })
    await expect(rowA).toHaveAttribute("data-active", "false", { timeout: 15_000 })
  })

  test("load more paginates in pages of 5, appending without duplicates — behavior 6", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(7, { prefix: "page" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const rows = page.locator('[data-testid="rail-sidebar-session-row"]')
    await expect(rows).toHaveCount(5, { timeout: 15_000 })
    await expect(page.getByText("7 total")).toHaveCount(0) // "N total" only shows once fully paged without a load-more button

    const loadMore = page.getByRole("button", { name: "Load more" })
    await expect(loadMore).toBeVisible()
    await loadMore.click()

    await expect(rows).toHaveCount(7, { timeout: 15_000 })

    // No duplicate rows across the two pages.
    const ids = await rows.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-session-id")))
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("load more's done notice replaces the button once every session is loaded — behavior 6", async ({ page }) => {
    // Fixed in Wave 2 (WP-A7): `mergeSessionListResponses`
    // (src/shared/query/session-list.ts) now advances an append to the
    // freshly-fetched page's OWN `nextCursor` — including `undefined` once the
    // server reports no further pages — instead of keeping the stale first-page
    // cursor. So once the final page loads, `nextCursor` clears, `more()` goes
    // falsy, the "Load more" button disappears and `doneLoaded()` fires.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(7, { prefix: "done" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const rows = page.locator('[data-testid="rail-sidebar-session-row"]')
    await expect(rows).toHaveCount(5, { timeout: 15_000 })

    const loadMore = page.getByRole("button", { name: "Load more" })
    await expect(loadMore).toBeVisible()
    await loadMore.click()

    await expect(rows).toHaveCount(7, { timeout: 15_000 })

    // Fix proof: page 2's cursor is `undefined`, so after the append the
    // "Load more" button is gone and the done notice renders in its place.
    await expect(loadMore).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText("All sessions loaded.")).toBeVisible({ timeout: 15_000 })
  })

  test("view options: Group by restructures the tree; Archived radio changes the fetched set — behavior 7", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    const fixtures = await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "viewopt" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    await expect(page.locator('[data-testid="project-header"]')).toBeVisible()
    await expect(page.locator('[data-testid="workspace-header"]')).toHaveCount(0)

    await page.getByTestId("rail-account-trigger").click()
    await page.getByRole("menuitem", { name: "View options" }).hover()
    await page.getByRole("menuitemradio", { name: "Workspace" }).click()

    await expect(page.locator('[data-testid="workspace-project-header"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="workspace-header"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="project-header"]')).toHaveCount(0)

    // Archived radio threads onto the session-list query's `archived` param.
    // The view-options menu stays open across radio selections (it's a
    // multi-section settings panel, not a close-on-select menu) — re-clicking
    // the "View options" trigger here would toggle it closed instead of
    // opening it, since it's already open from the "Workspace" click above.
    fixtures.sessionListRequests.length = 0
    await page.getByRole("menuitemradio", { name: "All" }).click()
    await expect.poll(() => fixtures.sessionListRequests.some((q) => q.includes("archived=all")), { timeout: 10_000 }).toBe(true)
  })

  test("account footer exposes utilities and restores focus across nested panels — behavior 16", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "account" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const trigger = page.getByTestId("rail-account-trigger")
    await trigger.focus()
    await page.keyboard.press("Enter")
    await expect(trigger).toHaveAttribute("aria-expanded", "true", { timeout: MENU_FOCUS_TIMEOUT })
    await expect(page.getByRole("menuitem", { name: "View options" })).toBeVisible({ timeout: MENU_FOCUS_TIMEOUT })
    await expect(page.getByRole("menuitem", { name: "Usage" })).toBeVisible({ timeout: MENU_FOCUS_TIMEOUT })
    // "Diagnostics" is gated by `<Show when={usePlatform().platform === "desktop" ||
    // config?.sandboxEnabled !== true}>` (rail-account-menu.tsx) — this dev harness
    // bakes `VITE_SANDBOX_ENABLED=true` (.env.local) and runs the web platform (never
    // "desktop"), so the item is permanently absent here, the same class of
    // unreachable-by-baked-env-flag gating documented in core-settings-auth.spec.ts's
    // HARNESS NOTES (e.g. the Sandbox-tab-absent-when-disabled scenario).
    await expect(page.getByRole("menuitem", { name: "Diagnostics" })).toHaveCount(0)
    await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible({ timeout: MENU_FOCUS_TIMEOUT })
    await expect(page.getByRole("menuitem", { name: "Help" })).toBeVisible({ timeout: MENU_FOCUS_TIMEOUT })

    await page.getByRole("menuitem", { name: "View options" }).focus()
    await page.keyboard.press("ArrowRight")
    await expect(page.getByRole("menuitemradio", { name: "All" })).toBeVisible({ timeout: MENU_FOCUS_TIMEOUT })
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menuitemradio", { name: "All" })).toHaveCount(0, { timeout: MENU_FOCUS_TIMEOUT })
    await expect(page.getByRole("menuitem", { name: "View options" })).toBeVisible({ timeout: MENU_FOCUS_TIMEOUT })

    await page.getByRole("menuitem", { name: "Usage" }).click()
    await expect(page.getByRole("dialog", { name: "Usage" })).toBeVisible({ timeout: MENU_FOCUS_TIMEOUT })
    await expect(page.getByRole("menu")).toHaveCount(0, { timeout: MENU_FOCUS_TIMEOUT })
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog", { name: "Usage" })).toHaveCount(0, { timeout: MENU_FOCUS_TIMEOUT })
    await expect(trigger).toBeFocused({ timeout: MENU_FOCUS_TIMEOUT })
    await expect(trigger).toHaveAttribute("aria-expanded", "false", { timeout: MENU_FOCUS_TIMEOUT })
  })

  test("view state persists to localStorage across reload; malformed JSON falls back to defaults — behavior 8", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "persist" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    await page.getByTestId("rail-account-trigger").click()
    await page.getByRole("menuitem", { name: "View options" }).hover()
    await page.getByRole("menuitemradio", { name: "Workspace" }).click()

    await expect.poll(async () => {
      const raw = await page.evaluate(() => localStorage.getItem("claxedo.session-view.v1"))
      return raw ? JSON.parse(raw).group : undefined
    }).toBe("workspace")

    await page.reload()
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator('[data-testid="workspace-header"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="project-header"]')).toHaveCount(0)
  })

  test("malformed view JSON is caught and replaced by defaults, not a broken tree — behavior 8", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "malformed" }) })
    await seedProject(page, { dir: DIR, view: "malformed" })
    await openTree(page, DIR)

    // defaultView(): group="project", archived="active" -> project-header tree renders fine.
    await expect(page.locator('[data-testid="project-header"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="workspace-header"]')).toHaveCount(0)
  })

  test("loading/error/empty notices render with stable testids; Retry re-fires the query — behavior 9", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    const fixtures = await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: [] })
    await seedProject(page, { dir: DIR })

    fixtures.setSessionListDelay(1500)
    await openTree(page, DIR)
    await expect(page.locator('[data-testid="rail-sidebar-session-list-loading"]')).toBeVisible({ timeout: 5_000 })
    fixtures.setSessionListDelay(0)
    await expect(page.locator('[data-testid="rail-sidebar-session-list-empty"]')).toBeVisible({ timeout: 15_000 })

    fixtures.failNextSessionList()
    await page.getByTestId("rail-account-trigger").click()
    await page.getByRole("menuitem", { name: "View options" }).hover()
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    // Force a refetch by flipping the archived filter, which changes the
    // query signature and re-fires the request against our failing route.
    await page.getByTestId("rail-account-trigger").click()
    await page.getByRole("menuitem", { name: "View options" }).hover()
    await page.getByRole("menuitemradio", { name: "All" }).click()
    await page.keyboard.press("Escape")
    await expect(page.locator('[data-testid="rail-sidebar-session-list-error"]')).toBeVisible({ timeout: 15_000 })

    fixtures.stopFailingSessionList()
    const retry = page.locator('[data-testid="rail-sidebar-session-list-error"]').getByText("Retry")
    await retry.click()
    await expect(page.locator('[data-testid="rail-sidebar-session-list-empty"]')).toBeVisible({ timeout: 15_000 })
  })

  test("archive hover button removes the row; a failed archive is a silent no-op — behavior 10", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "archive" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const rows = page.locator('[data-testid="rail-sidebar-session-row"]')
    await expect(rows).toHaveCount(2, { timeout: 15_000 })

    const target = page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_archive_0"]')
    await target.click()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toContain("ses_archive_0")
    await target.hover()
    await target.getByRole("button", { name: /^Archive / }).click()
    await expect(page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_archive_0"]')).toHaveCount(0, { timeout: 15_000 })
    await expect(rows).toHaveCount(1)
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe("/s/ses_archive_1")

    // Failure case: PATCH /session/:id fails -> row must remain, untouched.
    let sawArchivePatch = false
    await page.route("**/session/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback()
      sawArchivePatch = true
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "archive failed" }) })
    })
    const remaining = page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_archive_1"]')
    await remaining.hover()
    await remaining.getByRole("button", { name: /^Archive / }).click()
    await expect.poll(() => sawArchivePatch, { timeout: 10_000 }).toBe(true)
    await expect(page.getByText("Error archiving session")).toBeVisible({ timeout: 10_000 })
    await expect(remaining).toBeVisible()
    await expect(rows).toHaveCount(1)
  })

  test("archiving the only active session leaves its URL for the project root — behavior 10", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    const fixtures = await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "only-archive" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const target = page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_only-archive_0"]')
    await target.click()
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toContain("ses_only-archive_0")

    await target.hover()
    await target.getByRole("button", { name: /^Archive / }).click()

    await expect(target).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe(`/w/${PROJECT_ID}`)
    expect(fixtures.sessions.find((item) => item.sessionId === "ses_only-archive_0")?.archivedAt).toEqual(expect.any(Number))

    // Archive completion is a synchronous client-state boundary. No
    // per-session shell resource, directory row, inventory row, or active list
    // row may remain available to rehydrate the closed session.
    await expect.poll(() => page.evaluate((sessionId: string) => {
      const qc = (window as unknown as {
        __claxedoQueryClient?: {
          getQueryCache(): { getAll(): Array<{ queryKey: unknown[]; state: { data?: unknown } }> }
        }
      }).__claxedoQueryClient
      const queries = qc?.getQueryCache().getAll() ?? []
      return queries.some((query) => {
        const key = query.queryKey
        if (!Array.isArray(key)) return false
        if (key[0] === "shell" && key[1] === "session" && key[2] === sessionId) return true
        const scopedInventory = key.includes("sessionInventory")
        const scopedList = key.includes("sessionList")
        const scopedDirectory = key.includes("sessionCache")
        return (scopedInventory || scopedList || scopedDirectory) && (JSON.stringify(query.state.data) ?? "").includes(sessionId)
      })
    }, "ses_only-archive_0"), { timeout: 10_000 }).toBe(false)

    // Re-entering the old URL must consult authoritative archived metadata and
    // return to the workspace instead of reconstructing a ghost session.
    await page.goto(new URL("/s/ses_only-archive_0", page.url()).toString())
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe(`/w/${PROJECT_ID}`)
    await expect(page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_only-archive_0"]')).toHaveCount(0)
  })

  test("a harness-created session appears once its session.lifecycle event arrives — behavior 15", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      projectName: "sidebar-tree",
      harness: "codex-acp",
      workspaces: {
        [DIR]: { workspaceId: PROJECT_ID, kind: "local", directory: DIR, available: true },
      },
    })
    const fixtures = await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: [] })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    await expect(page.locator('[data-testid="rail-sidebar-session-list-empty"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="rail-sidebar-session-row"]')).toHaveCount(0)

    // The server's control-plane session-list already has the row the
    // instant `POST /session` returns (recorded by claxedo-server's
    // response-sniffing middleware regardless of harness — see
    // `packages/claxedo-server/src/deployments/local/server.ts` around its `/session`
    // create/update/delete tap) — model that here by seeding the fixture's
    // list BEFORE the event arrives, exactly like the real backend.
    const now = Date.now()
    fixtures.setSessions([
      { sessionId: "ses_codex_new", title: "New Codex session", createdAt: now, updatedAt: now },
    ])

    // The one notification a non-opencode/harness session's `POST /session`
    // ever publishes: a `session.lifecycle` "created" event on `claxedoBus`
    // — see BEHAVIORS #15. Injected flat/unwrapped via `emitFlat`, matching
    // the real (fixed) wire shape `ClaxedoEventsProvider` requires.
    mock.emitFlat({
      type: "session.lifecycle",
      phase: "created",
      directory: DIR,
      sessionID: "ses_codex_new",
      workspaceId: PROJECT_ID,
      info: {
        id: "ses_codex_new",
        slug: "ses_codex_new",
        projectID: PROJECT_ID,
        directory: DIR,
        title: "New Codex session",
        version: "1",
        time: { created: now, updated: now },
      },
      ts: now,
    })

    // Asserted on the RENDERED sidebar row, deliberately not on any
    // window-level debug handle (`__claxedoQueryClient` etc.) — debug seams
    // can be DEV-only and dead-code-eliminated from production builds, and
    // the visible row is the behavior users get. Delivery can take a few
    // seconds: the events stream is a reconnect-poll loop (~2s cadence), and
    // the row renders after inventory -> section recompute -> session-list
    // refetch, so keep the generous timeout.
    // The lifecycle row can currently appear in both the project and workspace
    // sections; duplication is tracked separately from this delivery proof.
    await expect(page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_codex_new"]').first())
      .toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="rail-sidebar-session-list-empty"]')).toHaveCount(0)
  })

  test("sidebar-toggle button un-docks the rail (docked state flips) — behavior 13 (partial)", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "toggle" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    // The `docked`-state half of behavior 13, isolated from the width half the
    // sibling test below owns (which pins the full 260 -> 0 -> 260 transition —
    // there is no outstanding width bug; that note was stale). The toggle
    // button is rendered only while docked (`Show when={docked()}` in
    // rail-sidebar.tsx), so it disappearing on click IS the state flip.
    const toggle = page.locator('[data-testid="sidebar-toggle"]')
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(toggle).toHaveCount(0)
  })

  test("sidebar-toggle collapses/expands the rail's width — behavior 13", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "width" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    // Read the dispatched inline width (the rail carries a 1px right border, so
    // the bordered client rect never reads exactly 0 when collapsed).
    const railWidth = () =>
      page.locator('[data-testid="rail-sidebar"]').evaluate((el) => parseFloat((el as HTMLElement).style.width) || 0)

    // Docked at the default 260px.
    await expect.poll(railWidth, { timeout: 10_000 }).toBe(260)

    // Collapsing the docked rail flips `docked` (the toggle hides) AND drives
    // the rail's width to 0 — `railToggleCommand` dispatches both on one
    // `region.update`, and `sidebarWidth()` must reflect the dispatched size.
    await page.locator('[data-testid="sidebar-toggle"]').click()
    await expect(page.locator('[data-testid="sidebar-toggle"]')).toHaveCount(0)
    // Collapsing holds: the Show-Sidebar affordance rendering under the still
    // cursor must NOT re-peek the rail (the peek is muted until the pointer
    // leaves the corner), so the width settles at 0 without moving the mouse.
    await expect.poll(railWidth, { timeout: 10_000 }).toBe(0)

    // Re-expanding via the header "Show Sidebar" affordance restores the width.
    await page.getByRole("button", { name: "Show Sidebar" }).click()
    await expect.poll(railWidth, { timeout: 10_000 }).toBe(260)
    await expect(page.locator('[data-testid="sidebar-toggle"]')).toBeVisible()
  })

  test("hot-zone peek expands an unpinned collapsed sidebar; leaving the rail auto-collapses it — behavior 11", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "peek" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const rail = page.locator('[data-testid="rail-sidebar"]')
    const railWidth = () => rail.evaluate((el) => parseFloat((el as HTMLElement).style.width) || 0)
    const railPinned = () => rail.evaluate((el) => el.getAttribute("data-pinned") !== null)

    await expect.poll(railWidth, { timeout: 10_000 }).toBe(260)

    // Collapse into the unpinned, zero-width state this behavior peeks from.
    await page.locator('[data-testid="sidebar-toggle"]').click()
    await expect.poll(railWidth, { timeout: 10_000 }).toBe(0)
    // Move the pointer clear of the corner so the toggle-collapse mute lifts.
    await page.mouse.move(700, 420)
    await expect.poll(railPinned).toBe(false)

    // Entering the top-left hot-zone peeks the rail open without re-docking it.
    await page.mouse.move(8, 8)
    await expect.poll(railWidth, { timeout: 10_000 }).toBe(260)
    expect(await railPinned()).toBe(false)

    // Leaving the rail lets it auto-collapse again.
    await page.mouse.move(700, 420)
    await expect.poll(railWidth, { timeout: 10_000 }).toBe(0)
  })

  test("drag-resizing the sidebar handle changes width live and persists across reload — behavior 12", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "drag" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const rail = page.locator('[data-testid="rail-sidebar"]')
    const railWidth = () => rail.evaluate((el) => parseFloat((el as HTMLElement).style.width) || 0)
    await expect.poll(railWidth, { timeout: 10_000 }).toBe(260)

    // The resize handle straddles the rail's right edge but its parent clips
    // the outer half (overflow-hidden), so grab a pixel just inside the 260px
    // edge. Drag right by 80px: the width tracks the pointer live.
    await page.mouse.move(258, 360)
    await page.mouse.down()
    await page.mouse.move(338, 360, { steps: 6 })
    await expect.poll(railWidth, { timeout: 10_000 }).toBe(340)
    await page.mouse.up()
    await expect.poll(railWidth, { timeout: 10_000 }).toBe(340)

    // The committed width survives a full reload.
    await openTree(page, DIR)
    await expect.poll(railWidth, { timeout: 15_000 }).toBe(340)
  })

  test("mobile drawer opens via the opener, scrim-closes, and closes on session select — behavior 14", async ({ page }) => {
    // Live once WP-C3 §3.1 wired the drawer end to end: `openMobileSidebar`
    // (rail-shell-chrome-state.ts) is a real setter reached from the `md:hidden`
    // opener button in rail-sidebar-shell.tsx, and `RailSidebar.activateSession`
    // now invokes `onSessionSelect`, which the shell uses to close the drawer on
    // a session pick (the session's own navigation is owned by activateSession,
    // so the shell wrapper only dismisses the drawer — it never re-navigates).
    await page.setViewportSize({ width: 390, height: 844 })
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "drawer" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const opener = page.locator('[data-testid="mobile-sidebar-opener"]')
    const scrim = page.locator('[data-testid="mobile-sidebar-scrim"]')

    // Closed on entry: the opener is the only reachable affordance, no scrim yet.
    await expect(opener).toBeVisible({ timeout: 10_000 })
    await expect(opener).toHaveAttribute("aria-expanded", "false")
    await expect(scrim).toHaveCount(0)

    // Opener opens the drawer (scrim appears; opener stays mounted as a toggle).
    await opener.click()
    await expect(scrim).toBeVisible({ timeout: 5_000 })
    await expect(opener).toHaveAttribute("aria-expanded", "true")

    // Tapping the scrim (right of the 280px drawer) closes it.
    await scrim.click({ position: { x: 340, y: 400 } })
    await expect(scrim).toHaveCount(0)
    await expect(opener).toHaveAttribute("aria-expanded", "false")

    // Re-open, then pick a session: the drawer closes AND the row activates.
    await opener.click()
    await expect(scrim).toBeVisible({ timeout: 5_000 })
    const row = page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_drawer_0"]')
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()
    await expect(scrim).toHaveCount(0)
    await expect(opener).toHaveAttribute("aria-expanded", "false")
    await expect(row).toHaveAttribute("data-active", "true", { timeout: 15_000 })
  })
})
