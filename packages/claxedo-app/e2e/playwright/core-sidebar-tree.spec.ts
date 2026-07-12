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
 *     persistence. See BEHAVIORS #14 / OUT OF SCOPE — this signal's setter is
 *     never invoked with `true` anywhere in the app today.
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
 *      selects/opens that workspace (expands the section, marks it active);
 *      clicking its disclosure caret only toggles open/closed and does not
 *      select or navigate.
 *   2. In `Group by: Project` mode (default), clicking a `project-header`'s
 *      body selects the project's primary workspace and expands it; its
 *      disclosure caret only toggles collapse/expand.
 *   3. Hovering a header reveals its inline action buttons (opacity 0→1);
 *      hovering a session row reveals its Archive button the same way — both
 *      are effectively hidden at rest.
 *   4. A session row's status indicator moves idle (no dot, time label) →
 *      working (`data-sidebar-status="working"`, amber, pulsing) → done
 *      (`data-sidebar-status="done"`, green, unseen) as `session.status`/
 *      `session.idle` SSE events land for a row that is never opened/focused.
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
 *   14. OUT OF SCOPE / KNOWN BUG — the mobile drawer's open path is dead code
 *       today: `setMobileSidebarOpen(true)` (`rail-shell-chrome-state.ts:18`)
 *       is never called anywhere in the app, and even the "close on session
 *       select" wiring is separately dead (`onSessionSelect` is declared as a
 *       `RailSidebar` prop, `rail-sidebar.tsx:212`, but never invoked from
 *       within the component, so `RailSidebarShell`'s `closeMobileSidebar()`
 *       wrapper around it — `rail-sidebar-shell.tsx:139-142` — never fires).
 *       See the `test.fixme` below.
 *   15. A session created with a NON-opencode harness (e.g. Codex via ACP)
 *       becomes visible in the tree once its `session.lifecycle` "created"
 *       event reaches the client, the same way an opencode-native session's
 *       native `session.created` SSE event already does. FIXED BUG (root
 *       cause was server-side, not in this package): harness/ACP session
 *       creation (`packages/workspace-runtime/src/routes/session-core.ts`
 *       `.post("/session")`) only ever publishes a `session.lifecycle` event
 *       on `claxedoBus` (aka `workspaceRuntimeBus`) — it never emits the
 *       native opencode `session.created` event that `globalBus` carries.
 *       `packages/claxedo-server/src/routes/opencode-compat-events.ts`'s
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
 *       `packages/claxedo-server/src/routes/opencode-compat-events.test.ts`.
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
 *   idle→working→done cycle it shares a code path with IS covered); mobile
 *   drawer open/scrim/close-on-select (dead code today, see BEHAVIORS #14).
 */
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-core-sidebar-tree"
const PROJECT_ID = "proj_core_sidebar_tree"
const SESSION_ID = "ses_core_sidebar_tree_mock"

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

  await page.route("**/api/control/session-list**", async (route) => {
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

  await page.route("**/api/workspace/resolve**", async (route) => {
    const url = new URL(route.request().url())
    const directory = url.searchParams.get("directory") ?? opts.dir
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ workspaceId: directory, directory, kind: "local", status: "ready" }),
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

    const draftUrl = page.url()
    await caret.click()
    await expect(caret).toHaveAttribute("aria-expanded", "false")
    expect(page.url()).toBe(draftUrl)

    // Header body click: re-opens the section (proof it does something the
    // caret-only click above didn't undo on its own) and targets the
    // workspace panel at this directory. Unlike project-header,
    // workspace-header's body click (rail-sidebar.tsx:2073-2077,
    // `openWorkspacePanel`) opens the review side panel for this specific
    // worktree — it does not navigate the main route to a `/session` URL;
    // that's `workspace-project-header`'s (the outer, project-level header)
    // job via `onWorkspaceSelect`. Click at x=60 (not x=200): the header
    // row is only ~250px wide and HeaderActions (New session/terminal/
    // Claude/Codex/kebab, opacity-0 at rest but still hit-testable) sit
    // past x~110 — x=200 lands on "New Codex terminal", not the header body.
    await header.click({ position: { x: 60, y: 8 } })
    await expect(caret).toHaveAttribute("aria-expanded", "true", { timeout: 15_000 })
    await expect(page).toHaveURL(draftUrl)
    await expect(header).toHaveAttribute("data-workspace-id", DIR)
  })

  test("hover reveals header actions and the session-row archive button — behavior 3", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "hover" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const header = page.locator('[data-testid="project-header"]')
    const newSessionButton = header.getByRole("button", { name: /New session in/ })
    // The opacity-0/group-hover:opacity-100 pair lives on `HeaderActions`'s
    // own wrapper div (rail-sidebar.tsx:1604-1607), two ancestors above the
    // button (the button sits inside a `<Tooltip>` that adds an unstyled
    // wrapper div) — the button itself always computes opacity:1, so
    // `opacityOf` must target that ancestor, not the button.
    const newSessionActions = newSessionButton.locator("xpath=ancestor::div[contains(@class,'opacity-0')][1]")
    await expect.poll(() => opacityOf(newSessionActions)).toBe(0)
    await header.hover()
    await expect.poll(() => opacityOf(newSessionActions)).toBe(1)

    const row = page.locator('[data-testid="rail-sidebar-session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const archiveButton = row.getByRole("button", { name: /^Archive / })
    await expect.poll(() => opacityOf(archiveButton)).toBe(0)
    await row.hover()
    await expect.poll(() => opacityOf(archiveButton)).toBe(1)
  })

  test("status dot: idle has no dot — behavior 4 (partial; live push half is blocked)", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "status" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const targetId = "ses_status_0"
    const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${targetId}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })

    // Idle: no status dot at all, the relative-time label renders instead.
    // (This much is provable without live SSE — see the fixme below for the
    // working/done transitions, which are blocked by a shared-helper gap.)
    await expect(row.locator("[data-sidebar-status]")).toHaveCount(0)
  })

  test.fixme(
    "status dot moves working -> done as session.status/session.idle SSE land — behavior 4 (shared-helper gap)",
    async () => {
      // SHARED-HELPER GAP, not a real app bug: `installMockRuntime`'s
      // `mock.emit()` (`e2e/helpers/mock-runtime.ts`) queues events onto an
      // `EventBus` drained by a mock of `/global/event`
      // (mock-runtime.ts:547-548). The CURRENT app does not fetch that route
      // at all — its "central" cross-session/background live-event stream is
      // `/api/wr/events` (`src/providers/claxedo-events.tsx:188-191`,
      // `claxedoEventStreamTargets`). `installMockRuntime` only mocks
      // `/api/wr/events` under the relay origin when `options.cloud` is set
      // (mock-runtime.ts:826); the default local-mode path is never
      // intercepted, so it always fails and retries
      // (`[claxedo-events] stream failed (transient, retrying)`, visible in
      // every spec's console noise). Confirmed by a minimal Playwright
      // repro: after `mock.emit()`, zero `/global/event` requests are ever
      // made — only repeated failing `/api/wr/events` ones — and the row
      // never gains a `data-sidebar-status` attribute. Per this spec's
      // STATE MODEL, `session.status`/`session.idle` for a background
      // (unfocused) row are delivered ONLY by this push stream, with no
      // polling fallback (unlike `permission`/`question`, which do poll) —
      // so this scenario cannot pass until `installMockRuntime` also mocks
      // the default, non-relay `/api/wr/events` route. That's a shared-file
      // change forbidden in this pooled run; filed as a finding for a
      // follow-up session with exclusive access to mock-runtime.ts.
    },
  )

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

  test("account footer exposes utilities and restores focus across nested panels", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "account" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const trigger = page.getByTestId("rail-account-trigger")
    await trigger.focus()
    await page.keyboard.press("Enter")
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByRole("menuitem", { name: "View options" })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "Usage limits" })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "Diagnostics" })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "Help" })).toBeVisible()

    await page.getByRole("menuitem", { name: "View options" }).focus()
    await page.keyboard.press("ArrowRight")
    await expect(page.getByRole("menuitemradio", { name: "All" })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menuitemradio", { name: "All" })).toHaveCount(0)
    await expect(page.getByRole("menuitem", { name: "View options" })).toBeVisible()

    await page.getByRole("menuitem", { name: "Usage limits" }).focus()
    await page.keyboard.press("ArrowRight")
    const refreshUsage = page.getByRole("menuitem", { name: "Refresh usage limits" })
    await expect(refreshUsage).toBeVisible()
    await expect(refreshUsage).toBeFocused()

    await page.keyboard.press("Escape")
    await expect(refreshUsage).toHaveCount(0)
    await expect(page.getByRole("menuitem", { name: "Usage limits" })).toBeVisible()

    await page.keyboard.press("Escape")
    await expect(page.getByRole("menu")).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveAttribute("aria-expanded", "false")
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
    await target.hover()
    await target.getByRole("button", { name: /^Archive / }).click()
    await expect(page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_archive_0"]')).toHaveCount(0, { timeout: 15_000 })
    await expect(rows).toHaveCount(1)

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

  test("a harness-created session appears once its session.lifecycle event arrives — behavior 15", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      projectName: "sidebar-tree",
      harness: "codex-acp",
    })
    const fixtures = await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: [] })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    await expect(page.locator('[data-testid="rail-sidebar-session-list-empty"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="rail-sidebar-session-row"]')).toHaveCount(0)

    // The server's control-plane session-list already has the row the
    // instant `POST /session` returns (recorded by claxedo-server's
    // response-sniffing middleware regardless of harness — see
    // `packages/claxedo-server/src/server.ts` around its `/session`
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
    await expect(page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_codex_new"]'))
      .toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="rail-sidebar-session-list-empty"]')).toHaveCount(0)
  })

  test("sidebar-toggle button un-docks the rail (docked state flips) — behavior 13 (partial)", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "toggle" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    // Only the part of behavior 13 that isn't blocked by the width bug below:
    // the toggle button (docked-only per rail-sidebar.tsx:2548, `Show when={docked()}`)
    // disappears once clicked, proving the underlying `docked` state did flip.
    const toggle = page.locator('[data-testid="sidebar-toggle"]')
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(toggle).toHaveCount(0)
  })

  test.fixme(
    "sidebar-toggle collapses/expands the rail's width — behavior 13 (real app bug)",
    async () => {
      // REAL APP BUG, not a test/mock gap. `railToggleCommand`
      // (`src/shell/layout/commands.ts:31-43`) dispatches ONE `region.update`
      // that sets BOTH `docked: !docked` AND `size: {unit:"px", value: docked
      // ? 0 : expandedWidth}` on the "rail" region. Reproduced directly: after
      // clicking `[data-testid="sidebar-toggle"]`, the toggle button itself
      // disappears (`docked()` — `sidebarPinned()` in
      // `src/shell/app-shell-layout.tsx:231` — correctly flips to false), but
      // `[data-testid="rail-sidebar"]`'s inline `width` style stays frozen at
      // "260px" — `sidebarWidth()` (app-shell-layout.tsx:229,
      // `railRegion().size.unit === "px" ? railRegion().size.value : 260`)
      // never reflects the dispatched `size.value: 0`. Same symptom, same
      // computation, blocks drag-resize and hot-zone peek below too (both
      // read/write the same `rail` region). This scenario cannot pass until
      // the `rail` region's `size` actually propagates through the same
      // dispatch that updates `docked`.
    },
  )

  test.fixme(
    "hot-zone peek expands an unpinned collapsed sidebar; leaving the rail auto-collapses it — behavior 11 (real app bug)",
    async () => {
      // REAL APP BUG, not a test gap — blocked by the same rail-width
      // dispatch bug as "sidebar-toggle collapses/expands the rail's width"
      // above (`src/shell/layout/commands.ts:31-43`,
      // `src/shell/app-shell-layout.tsx:229`): the sidebar never visually
      // collapses in the first place (its prerequisite step), so the
      // hot-zone peek/auto-collapse cycle this behavior names has nothing to
      // peek FROM. Filed as a finding alongside the toggle one; re-enable
      // once the rail region's `size` propagates correctly.
    },
  )

  test.fixme(
    "drag-resizing the sidebar handle changes width live and persists across reload — behavior 12 (real app bug)",
    async () => {
      // REAL APP BUG, not a test gap. Reproduced directly: dragging
      // `[aria-hidden="true"].cursor-col-resize` from x=257 (the rail's
      // right edge at the default 260px width) out to a wider position never
      // changes `[data-testid="rail-sidebar"]`'s width, even mid-drag before
      // mouseup (this behavior's own title claims "changes width live").
      // `startResize`/`handleResizeMove`
      // (`src/claxedo-ui/layouts/rail-sidebar-shell.tsx:83-96` and its
      // `pointermove` listener) compute the drag delta against
      // `props.sidebarWidth()`, the SAME accessor implicated in the
      // sidebar-toggle finding above (`src/shell/app-shell-layout.tsx:229`)
      // — so this is very likely the identical rail-width-propagation defect
      // surfacing through a second entry point, not an independent bug.
      // Filed as a finding; re-enable once the rail region's `size`
      // propagates correctly.
    },
  )

  test.fixme(
    "mobile drawer opens on entry, scrim-closes, and closes on session select — behavior 14 (dead code)",
    async () => {
      // REAL APP BUG, not a test gap: the mobile drawer's `mobileSidebarOpen`
      // signal (`src/claxedo-ui/layouts/rail-shell-chrome-state.ts:18`) has no
      // production call site that ever sets it `true` — `closeMobileSidebar`
      // (line 61) is the ONLY setter wired anywhere. There is currently no
      // user action (tap, swipe, hot-zone) that opens the drawer on a mobile
      // viewport, so the scrim-close and close-on-select paths this behavior
      // names are unreachable from the UI today. Compounding it, even if the
      // drawer were open, "close on session select" is separately dead:
      // `RailSidebar`'s `onSessionSelect` prop (`src/claxedo-ui/layouts/rail-
      // sidebar.tsx:212`) is declared but never invoked anywhere in the
      // component, so `RailSidebarShell`'s wrapper that calls
      // `closeMobileSidebar()` after it (`rail-sidebar-shell.tsx:139-142`)
      // never fires from a real session click. Filed as a finding; this spec
      // cannot exercise BEHAVIORS #14 until the app wires an entry point.
    },
  )
})
