/**
 * Rail sidebar — project/session tree. Test titles cite the numbered
 * behaviors below.
 *
 * Sources: `src/app/workbench/rail/rail-sidebar.tsx` (disclosure/list/filter),
 * `src/features/session/ui/navigation/session-navigation-list.tsx` (session
 * row + status dot), `src/app/layout/state.ts` (pin/peek/resize),
 * `src/app/workbench/rail/rail-sidebar-shell.tsx` (resize handle, mobile
 * scrim), `src/app/workbench/rail/rail-shell-chrome-state.ts` (mobile drawer
 * signal).
 *
 * STATE MODEL —
 *   - View options (`Group by` / `Show status|environment|git` / `Archived`)
 *     persist to `localStorage["claxedo.session-view.v1"]`. Malformed JSON at
 *     that key is caught and silently replaced by `defaultView()`
 *     (`{group:"project", status:[], environment:[], git:[],
 *     archived:"active"}`) — never a thrown error.
 *   - Disclosure open/closed per section is local signal state, NOT persisted.
 *   - Section rows come from `GET /api/control/session-list`, paginated at
 *     `SESSION_GROUP_PAGE_SIZE = 5`; "Load more" appends a page via an explicit
 *     `cursor` fetch merged client-side.
 *   - Which Status/Environment/Git values appear in the view menu comes from a
 *     SEPARATE global session inventory (`GET /api/control/sessions`), not from
 *     the paginated session-list — a fixture must keep the two consistent.
 *   - The per-row status dot has two independently-updated inputs: `session.
 *     status`/`session.idle`/`session.error` SSE events dispatched straight
 *     into the row's status cache, and a batched `client.session.status()` +
 *     `client.permission.list()` + `client.question.list()` poll scoped per
 *     directory, gated to once per `SIDEBAR_SESSION_STATUS_FRESH_MS` (10s).
 *     `permission.asked`/`question.asked` do NOT update the row directly —
 *     they only invalidate. Dot priority is permission > working (busy/retry) >
 *     done (unseen) > idle; "done" is set when a row goes active/busy ->
 *     inactive/idle while never focused (`nextUnseenDone`). Idle renders a
 *     relative-time label and no dot at all; the palette is deliberately
 *     minimal — grey for working and done, red only for `permission`.
 *   - Sidebar pin/peek/width live in `createShellLayoutState` as an in-memory
 *     command overlay on a `LayoutConfig`; the hot zone is the top-left
 *     48x48px and rail width clamps to [220,520]. Only the COMMITTED width is
 *     mirrored into the persisted `claxedoState.rail` store (itself under
 *     `localStorage["claxedo.state.v5"]`) — pin/unpin toggles are session-only
 *     and do NOT survive reload (`claxedoState.rail.pin/unpin/toggle` are
 *     never called from production code; only `setWidth` is). Boot default is
 *     `pinned:true, width:260`.
 *   - Mobile drawer open/closed is a plain signal with no persistence.
 *
 * BEHAVIORS —
 *   1. `Group by: Workspace`: a `workspace-header` body click expands that
 *      section AND opens the workspace review side panel for that worktree
 *      (observable as `workspace-panel-shell`'s `data-state-open` /
 *      `data-state-mode` / `data-state-workspace-dir`). It does NOT navigate
 *      the main route and carries no `data-active` marker — route-level
 *      workspace selection is the OUTER `workspace-project-header`'s job. The
 *      inner header's caret only toggles open/closed.
 *   2. `Group by: Project` (default): a `project-header` body click selects the
 *      project's primary workspace and expands it; its caret only toggles.
 *   3. Header action buttons and a row's Archive button are revealed by hover.
 *   4. A row's dot moves idle (no dot, time label) -> working -> done as
 *      `session.status`/`session.idle` SSE land for a row that is never
 *      opened/focused. Across a RELOAD there is no SSE frame to lean on, so a
 *      still-running session's dot is rehydrated purely from
 *      `GET /session/status`; the in-memory unseen-done flag does not survive
 *      that, so a turn that finished while the tab was away comes back as idle
 *      rather than "done".
 *   5. Clicking a row activates it (`data-active="true"`); a second click
 *      before the first settles resolves onto the second row, not a stale mix.
 *   6. "Load more" fetches the next page, appends rows without duplicating the
 *      first page, and advances the cursor; the "All sessions loaded" done
 *      notice replaces the button once every session is loaded.
 *   7. `Group by` restructures the tree between `project-header`/`project-group`
 *      and `workspace-project-header` (+ nested `workspace-header`); `Archived`
 *      threads onto the session-list query's `archived` param, changing which
 *      sessions are fetched.
 *   8. View-options state survives reload; malformed JSON at the key falls back
 *      silently to `defaultView()` instead of breaking the tree.
 *   9. The session list surfaces distinct loading / error / empty notices under
 *      stable testids; the error notice's Retry action re-fires the query.
 *   10. The per-row Archive hover button archives the session (`PATCH
 *       /session/{id}` with `time.archived`) and removes it from the active
 *       view immediately; a failed archive leaves the row exactly in place
 *       (silent no-op besides an error toast) — never optimistically removed.
 *   11. An unpinned, collapsed sidebar peeks open when the pointer enters the
 *       top-left hot zone, and auto-collapses once the pointer leaves the
 *       rail's bounding rect.
 *   12. Dragging the right-edge resize handle live-resizes the rail; the
 *       committed width survives a reload.
 *   13. `sidebar-toggle` pins+expands an unpinned/collapsed sidebar and
 *       unpins+collapses a pinned one.
 *   14. On a mobile viewport the rail is an off-canvas drawer: the `md:hidden`
 *       `mobile-sidebar-opener` button opens it and flips its own
 *       `aria-expanded`; `mobile-sidebar-scrim` exists only while open and
 *       closes the drawer when tapped; picking a session row closes the drawer
 *       AND activates the row (`RailSidebarShell` wraps `onSessionSelect` with
 *       `closeMobileSidebar()` — the row's own navigation stays owned by
 *       `RailSidebar.activateSession`, the shell wrapper only dismisses).
 *   15. A created session becomes visible once its `session.lifecycle`
 *       "created" frame reaches the client. Session creation publishes
 *       `session.lifecycle` on `workspaceRuntimeBus`, which the
 *       workspace's `/api/wr/events` (`workspace-runtime/src/routes/events.ts`)
 *       serves as a `{ directory, payload }` control frame. Tier M mocks
 *       bypass the real server, so this spec can only pin the frontend half:
 *       given a `session.lifecycle` "created" frame, `applySessionInventoryLifecycle`
 *       surfaces the row. The transport itself is pinned by
 *       `packages/claxedo-local-server/src/shell/events.test.ts`.
 *   16. The account footer (`rail-account-trigger`) is keyboard-operable and
 *       focus-restoring: Enter opens the menu, ArrowRight opens the focused
 *       item's submenu and moves focus into it, Escape closes the submenu and
 *       returns focus to its parent item, and a final Escape closes the menu
 *       and returns focus to the trigger.
 *
 * OUT OF SCOPE — sending prompts / oracle-proved replies (every other `core-*`
 *   spec); workspace lifecycle actions reachable from the header kebab
 *   (`core-workspace-lifecycle`); terminal rows (`core-terminal`); the
 *   `permission`/`question` sub-state of the status dot, which depends on the
 *   10s-freshness-gated background poll rather than direct SSE dispatch and is
 *   skipped to keep the suite fast (the idle->working->done cycle it shares a
 *   code path with IS covered).
 */
import { workspaceResolveRoute } from "../helpers/contracts/workspace-resolve"
import { sessionListRoute } from "../helpers/contracts/session-list"
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-core-sidebar-tree"
const PROJECT_ID = "proj_core_sidebar_tree"
const SESSION_ID = "ses_core_sidebar_tree_mock"

// The account-footer test's keyboard-driven menu/focus transitions blow past the
// 10s expect default on a contended CI runner. A ceiling, not a wait — every
// assertion below still awaits the real visibility/focus transition.
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
      // No `localStorage.clear()`: Playwright re-runs init scripts on every navigation,
      // including `page.reload()`, so clearing here would wipe what the page itself just
      // persisted — exactly what the reload-survival scenarios assert on.
      ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
        serverUrl: window.location.origin,
        activeDirectory: dir,
      }
      localStorage.setItem(
        "claxedo.global.dat:server",
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
 * Installs the two control-plane endpoints the tree reads — `/api/control/session-list`
 * for the rows and `/api/control/sessions` for the filter options — which
 * `installMockRuntime` does not cover. Registered after it so these win.
 *
 * Also overrides `GET /api/workspace/resolve`. `installMockRuntime`'s handler
 * answers `id: options.workspaceId ?? directory`, so the scenarios below that
 * omit `workspaceId` would resolve every directory to the raw path string as a
 * workspace id, and the tree would navigate onto `/w//tmp/...`. This override
 * answers with `opts.projectId` for whichever directory was queried.
 */
async function installSessionTreeFixtures(page: Page, opts: { dir: string; projectId: string; sessions: FixtureSession[] }) {
  let sessions = [...opts.sessions]
  let sessionListDelayMs = 0
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
    // Ordered as the CLIENT asked. A fixture that answered its own order regardless
    // would pass whatever the rail requested, so the order under test would never be
    // exercised. These sessions carry no human turn, so `human_turn_desc` falls through
    // to creation for all of them.
    const sort = url.searchParams.get("sort")
    filtered = [...filtered].sort((a, b) =>
      sort === "created_desc" || sort === "human_turn_desc"
        ? b.createdAt - a.createdAt
        : b.updatedAt - a.updatedAt)

    const page_ = filtered.slice(offset, offset + limit)
    const nextCursor = offset + limit < filtered.length ? String(offset + limit) : undefined

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        view: { scope: url.searchParams.get("scope") ?? "workspace", groupBy: "none", sort: url.searchParams.get("sort") ?? "updated_desc", limit },
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

  // The shared runtime's `**/session/*` catch-all answers PATCH with a canned 200 and
  // never records `time.archived`, so any refetch of the list would serve the stale
  // unarchived rows and undo the optimistic removal. Track the archive here instead.
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
    /** Fails every session-list request until `stopFailingSessionList()`. Persistent
     * because TanStack Query retries, so one failing response never surfaces an error. */
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
  test("project-header disclosure caret toggles collapse only, never navigates", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "root" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const header = page.locator('[data-testid="project-header"]')
    await expect(header).toBeVisible()
    const caret = header.locator('[role="button"][aria-label*="project"]')
    await expect(caret).toHaveAttribute("aria-expanded", "true")

    // The caret `stopPropagation()`s the header body's select handler, so a
    // caret click can never reach it and never navigates.
    const draftUrl = page.url()
    await caret.click()
    await expect(caret).toHaveAttribute("aria-expanded", "false")
    expect(page.url()).toBe(draftUrl)

    await caret.click()
    await expect(caret).toHaveAttribute("aria-expanded", "true")
    expect(page.url()).toBe(draftUrl)
  })

  test("project-header body click selects the project's primary workspace", async ({ page }) => {
    // `openOrCreateSession` excludes the `"new"` draft sentinel from its reuse check, so a
    // header click on a bare draft route goes to `/w/<workspaceId>/session` rather than
    // treating the draft as a reusable session and building `/s/new`.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "primary" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const header = page.locator('[data-testid="project-header"]')
    await expect(header).toBeVisible({ timeout: 15_000 })

    // x=60 clears the caret at the far left and stays ahead of the header actions further
    // right, so the click lands on the body and fires `onWorkspaceSelect`.
    await header.click({ position: { x: 60, y: 8 } })

    await expect(page).toHaveURL(/\/w\/.+\/session/, { timeout: 15_000 })
    await expect(page).not.toHaveURL(/\/s\/new/)
  })

  test("workspace-header disclosure caret toggles collapse only, never navigates", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "ws" }) })
    await seedProject(page, { dir: DIR, view: { group: "workspace" } })
    await openTree(page, DIR)

    const header = page.locator(`[data-testid="workspace-header"][data-workspace-id="${DIR}"]`)
    await expect(header).toBeVisible({ timeout: 15_000 })
    const caret = header.locator('[role="button"][aria-label*="workspace"]')
    await expect(caret).toHaveAttribute("aria-expanded", "true")

    // The workspace review panel is the observable effect of the BODY click
    // below, so pin its closed starting state first — otherwise the post-click
    // assertion could not tell "the click opened it" from "it was already open".
    // The panel shell is disposed while closed and only mounts on first open
    // (`workspacePanelMounted`/`motion.shellMounted` gate the
    // `<RailWorkspacePanelShell>` Show in rail-workbench-shell.tsx), so the
    // closed starting state is "not in the DOM at all", not
    // `data-state-open="false"`.
    const panel = page.locator('[data-testid="workspace-panel-shell"]')
    await expect(panel).toHaveCount(0)

    const draftUrl = page.url()
    await caret.click()
    await expect(caret).toHaveAttribute("aria-expanded", "false")
    expect(page.url()).toBe(draftUrl)
    // The caret never reaches the body's handler, so no panel either.
    await expect(panel).toHaveCount(0)

    // A workspace header's body click opens the review panel for this worktree; it does not
    // navigate, unlike the outer project header. The row is only ~250px wide and the header
    // actions start around x=110, so x=60 is the only safe body target.
    await header.click({ position: { x: 60, y: 8 } })
    await expect(caret).toHaveAttribute("aria-expanded", "true", { timeout: 15_000 })
    await expect(page).toHaveURL(draftUrl)
    // Asserting `data-workspace-id` on the header would be a tautology — it is the element's
    // static identity — so pin the panel state the click produced instead.
    await expect(panel).toHaveAttribute("data-state-open", "true", { timeout: 15_000 })
    await expect(panel).toHaveAttribute("data-state-mode", "review")
    await expect(panel).toHaveAttribute("data-state-workspace-dir", DIR)
  })

  test("hover reveals header actions and the session-row archive button", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "hover" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const header = page.locator('[data-testid="project-header"]')
    const newSessionButton = header.getByRole("button", { name: /New session in/ })
    // MOUNT-ON-ENGAGEMENT (rail-hover-engagement.ts): at rest the header's
    // action cluster is NOT in the DOM at all — its wrapper only reserves the
    // buttons' box (`railHeaderActionsBox`) so layout stays byte-stable.
    // "Hidden at rest" is therefore count 0, not opacity 0.
    await expect(newSessionButton).toHaveCount(0)
    await header.hover()
    // Once mounted the wrapper still has to finish its fade to be genuinely visible.
    await expect(newSessionButton).toBeVisible()
    const newSessionActions = header.locator('[data-icon-interaction="row-actions"]')
    await expect.poll(() => opacityOf(newSessionActions)).toBe(1)

    const row = page.locator('[data-testid="rail-sidebar-session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    // Same mount-then-fade contract on the session row's archive button.
    const archiveButton = row.getByRole("button", { name: /^Archive / })
    await expect(archiveButton).toHaveCount(0)
    await row.hover()
    await expect(archiveButton).toBeVisible()
    await expect.poll(() => opacityOf(archiveButton)).toBe(1)
  })

  test("status dot: idle has no dot", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "status" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const targetId = "ses_status_0"
    const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${targetId}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })

    // Idle: no status dot at all, the relative-time label renders instead.
    await expect(row.locator("[data-sidebar-status]")).toHaveCount(0)
  })

  test("status dot moves working -> done as session.status/session.idle SSE land", async ({ page }) => {
    const targetId = "ses_live_0"
    // Two independently-updated caches decide this row's dot: the SSE dispatch
    // into `shellDataKeys.sessionId(id,"status")`, and the sidebar's batched
    // `client.session.status()` reconciliation. The mock's live-session map is
    // moved in step with every frame emitted here so the two can never
    // disagree — which is what the real server does anyway, publishing
    // `session.status` and updating the map it serves from the same
    // `SessionStatus.set` call.
    //
    // MEASURED: with the mock's OLD status handling restored, this scenario
    // still passed 6/6. The batch fires once per
    // `sessionStatusTargetSignature` change and is then gated for
    // `SIDEBAR_SESSION_STATUS_FRESH_MS` (10s), so it had already run before the
    // first emit — and it could not have contradicted anything anyway, because
    // `GET /session/status` was being answered by the shared mock's
    // `**/session/*` catch-all with a session ROW rather than a status map. The
    // `setSessionStatus` calls below therefore keep the mock honest rather than
    // papering over a live race here; where the map IS decisive is the reload
    // scenario in the next test, which has no SSE frame to lean on at all.
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "live" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${targetId}"]`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.locator("[data-sidebar-status]")).toHaveCount(0)

    // idle -> working. `busy` is the only status the dot's "working" branch
    // reads besides `retry` (`sessionSurfaceStatus`, surface-status.ts).
    mock.setSessionStatus(targetId, { type: "busy" })
    mock.emit({ type: "session.status", properties: { sessionID: targetId, status: { type: "busy" } } })
    await expect(row.locator('[data-sidebar-status="working"]')).toHaveCount(1, { timeout: 20_000 })

    // The row is never clicked, so finishing sets the unseen-done flag rather than falling
    // back to no dot. The real status route reports idle by omitting the key, so settling
    // clears the entry instead of writing `{type:"idle"}`.
    mock.setSessionStatus(targetId)
    mock.emit({ type: "session.idle", properties: { sessionID: targetId } })
    await expect(row.locator('[data-sidebar-status="done"]')).toHaveCount(1, { timeout: 20_000 })
    await expect(row.locator('[data-sidebar-status="working"]')).toHaveCount(0)
  })

  test("status dot rehydrates from GET /session/status after a reload, with no SSE frame", async ({ page }) => {
    // A reload discards every in-memory status cache, so a session still busy on the server
    // can only get its dot back from the batched `client.session.status()` read — the one
    // path no SSE scenario reaches. Seeded through `options.sessionStatuses` so the map is
    // already live at first paint.
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

    await page.reload()
    await expect(page.locator('[data-testid="rail-sidebar"]')).toBeVisible({ timeout: 20_000 })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.locator('[data-sidebar-status="working"]')).toHaveCount(1, { timeout: 20_000 })

    // Settling drops the key, and the next reload has no dot at all: the unseen-done flag is
    // in-memory, so a turn that finished while the tab was gone comes back as plain idle.
    mock.setSessionStatus(targetId)
    await page.reload()
    await expect(page.locator('[data-testid="rail-sidebar"]')).toBeVisible({ timeout: 20_000 })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.locator("[data-sidebar-status]")).toHaveCount(0, { timeout: 20_000 })
  })

  test("clicking a session row activates it; a rapid second click resolves onto the last row", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "race" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const rowA = page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_race_0"]')
    const rowB = page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_race_1"]')
    await expect(rowA).toBeVisible({ timeout: 15_000 })
    await expect(rowB).toBeVisible({ timeout: 15_000 })

    await rowA.click()
    await expect(rowA).toHaveAttribute("data-active", "true", { timeout: 15_000 })
    await expect(rowB).toHaveAttribute("data-active", "false")

    // Rapid switch: alternate clicks faster than one activation can settle.
    // The tree must land on the LAST row clicked, not a stale mix of both.
    await rowB.click()
    await rowA.click()
    await rowB.click()
    await expect(rowB).toHaveAttribute("data-active", "true", { timeout: 15_000 })
    await expect(rowA).toHaveAttribute("data-active", "false", { timeout: 15_000 })
  })

  test("load more paginates in pages of 5, appending without duplicates", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
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

    const ids = await rows.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-session-id")))
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("load more's done notice replaces the button once every session is loaded", async ({ page }) => {
    // `mergeSessionListResponses` adopts each appended page's own `nextCursor`, including
    // `undefined` on the last page. Keeping the first page's cursor instead would leave
    // "Load more" on screen forever.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(7, { prefix: "done" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const rows = page.locator('[data-testid="rail-sidebar-session-row"]')
    await expect(rows).toHaveCount(5, { timeout: 15_000 })

    const loadMore = page.getByRole("button", { name: "Load more" })
    await expect(loadMore).toBeVisible()
    await loadMore.click()

    await expect(rows).toHaveCount(7, { timeout: 15_000 })

    await expect(loadMore).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText("All sessions loaded.")).toBeVisible({ timeout: 15_000 })
  })

  test("view options: Group by restructures the tree; Archived radio changes the fetched set", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    const fixtures = await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "viewopt" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    await expect(page.locator('[data-testid="project-header"]')).toBeVisible()
    await expect(page.locator('[data-testid="workspace-header"]')).toHaveCount(0)

    await page.getByTestId("rail-account-trigger").click()
    await page.getByRole("menuitem", { name: "View options" }).hover()
    await page.getByRole("menuitemradio", { name: "Workspace" }).click()

    await expect(page.locator('[data-testid="workspace-project-header"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(`[data-testid="workspace-header"][data-workspace-id="${DIR}"]`)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="project-header"]')).toHaveCount(0)

    // The view-options menu stays open across radio selections (a multi-section
    // settings panel, not a close-on-select menu), so there is deliberately no
    // re-open here — re-clicking the trigger would toggle it closed instead.
    fixtures.sessionListRequests.length = 0
    await page.getByRole("menuitemradio", { name: "All" }).click()
    await expect.poll(() => fixtures.sessionListRequests.some((q) => q.includes("archived=all")), { timeout: 10_000 }).toBe(true)
  })

  test("account footer exposes utilities and restores focus across nested panels", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
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
    // "desktop"), so the item is permanently absent here.
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

  test("view state persists to localStorage across reload; malformed JSON falls back to defaults", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
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
    await expect(page.locator(`[data-testid="workspace-header"][data-workspace-id="${DIR}"]`)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="project-header"]')).toHaveCount(0)
  })

  test("malformed view JSON is caught and replaced by defaults, not a broken tree", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "malformed" }) })
    await seedProject(page, { dir: DIR, view: "malformed" })
    await openTree(page, DIR)

    // defaultView(): group="project", archived="active" -> project-header tree renders fine.
    await expect(page.locator('[data-testid="project-header"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="workspace-header"]')).toHaveCount(0)
  })

  test("loading/error/empty notices render with stable testids; Retry re-fires the query", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
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
    // Flipping the archived filter changes the query signature, re-firing the request.
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

  test("archive hover button removes the row; a failed archive is a silent no-op", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
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

  test("archiving the only active session leaves its URL for the project root", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
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

    // Nothing left in the query cache may rehydrate the closed session — not the per-session
    // shell resource, nor its inventory, list, or directory rows.
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

    // Re-entering the old URL must redirect rather than reconstruct a ghost session.
    await page.goto(new URL("/s/ses_only-archive_0", page.url()).toString())
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe(`/w/${PROJECT_ID}`)
    await expect(page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_only-archive_0"]')).toHaveCount(0)
  })

  test("a harness-created session appears once its session.lifecycle event arrives", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      projectName: "sidebar-tree",
      harness: "acp:codex",
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
    // `packages/claxedo-server/src/deployments/self-hosted-node/app.ts` around
    // its `/session` create/update/delete tap) — model that here by seeding the
    // list BEFORE the event arrives, exactly like the real backend.
    const now = Date.now()
    fixtures.setSessions([
      { sessionId: "ses_codex_new", title: "New Codex session", createdAt: now, updatedAt: now },
    ])

    // The one notification a non-opencode/harness session's `POST /session`
    // ever publishes: a `session.lifecycle` "created" control frame on the
    // workspace's stream — see BEHAVIORS #15.
    mock.emit({
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

    // Asserted on the rendered row rather than a window debug handle, which is DEV-only.
    // Delivery is slow — a ~2s reconnect-poll plus inventory, section recompute and refetch —
    // hence the wide timeout, and `.first()` because the row can land in both sections.
    await expect(page.locator('[data-testid="rail-sidebar-session-row"][data-session-id="ses_codex_new"]').first())
      .toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="rail-sidebar-session-list-empty"]')).toHaveCount(0)
  })

  test("sidebar-toggle button un-docks the rail (docked state flips)", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "toggle" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    // The `docked`-state half of behavior 13, isolated from the width half the
    // sibling test below owns (which pins the full 260 -> 0 -> 260 transition).
    // The toggle stays mounted in every rail state and reports `docked` through
    // `aria-pressed` (rail-sidebar.tsx), so the attribute flipping IS the state flip.
    const toggle = page.locator('[data-testid="sidebar-toggle"]')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await expect(toggle).toHaveAttribute("aria-label", "Hide Sidebar")
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-pressed", "false")
    await expect(toggle).toHaveAttribute("aria-label", "Pin Sidebar")
  })

  test("sidebar-toggle collapses/expands the rail's width", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "width" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    // Read the dispatched inline width (the rail carries a 1px right border, so
    // the bordered client rect never reads exactly 0 when collapsed).
    const railWidth = () =>
      page.locator('[data-testid="rail-sidebar"]').evaluate((el) => parseFloat((el as HTMLElement).style.width) || 0)

    await expect.poll(railWidth, { timeout: 10_000 }).toBe(260)

    // Collapsing the docked rail flips `docked` (the toggle reports it through
    // `aria-pressed`) AND drives the rail's width to 0 — `railToggleCommand`
    // dispatches both on one `region.update`, and `sidebarWidth()` must reflect
    // the dispatched size.
    await page.locator('[data-testid="sidebar-toggle"]').click()
    await expect(page.locator('[data-testid="sidebar-toggle"]')).toHaveAttribute("aria-pressed", "false")
    // Collapsing holds: the Show-Sidebar affordance rendering under the still
    // cursor must NOT re-peek the rail (the peek is muted until the pointer
    // leaves the corner), so the width settles at 0 without moving the mouse.
    await expect.poll(railWidth, { timeout: 10_000 }).toBe(0)

    await page.getByRole("button", { name: "Show Sidebar" }).click()
    await expect.poll(railWidth, { timeout: 10_000 }).toBe(260)
    await expect(page.locator('[data-testid="sidebar-toggle"]')).toBeVisible()
    await expect(page.locator('[data-testid="sidebar-toggle"]')).toHaveAttribute("aria-pressed", "true")
  })

  test("hot-zone peek expands an unpinned collapsed sidebar; leaving the rail auto-collapses it", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "peek" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const rail = page.locator('[data-testid="rail-sidebar"]')
    const railWidth = () => rail.evaluate((el) => parseFloat((el as HTMLElement).style.width) || 0)
    const railPinned = () => rail.evaluate((el) => el.getAttribute("data-pinned") !== null)

    await expect.poll(railWidth, { timeout: 10_000 }).toBe(260)

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

  test("drag-resizing the sidebar handle changes width live and persists across reload", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
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

  test("mobile drawer opens via the opener, scrim-closes, and closes on session select", async ({ page }) => {
    // Picking a session both navigates and closes the drawer, but through separate owners:
    // `activateSession` navigates, and `onSessionSelect` only dismisses the drawer.
    await page.setViewportSize({ width: 390, height: 844 })
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "drawer" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const opener = page.locator('[data-testid="mobile-sidebar-opener"]')
    const scrim = page.locator('[data-testid="mobile-sidebar-scrim"]')

    await expect(opener).toBeVisible({ timeout: 10_000 })
    await expect(opener).toHaveAttribute("aria-expanded", "false")
    await expect(scrim).toHaveCount(0)

    await opener.click()
    await expect(scrim).toBeVisible({ timeout: 5_000 })
    await expect(opener).toHaveAttribute("aria-expanded", "true")

    // Tapping the scrim (right of the 280px drawer) closes it.
    await scrim.click({ position: { x: 340, y: 400 } })
    await expect(scrim).toHaveCount(0)
    await expect(opener).toHaveAttribute("aria-expanded", "false")

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
