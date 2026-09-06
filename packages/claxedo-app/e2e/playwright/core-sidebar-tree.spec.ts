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
 *   15. A session created with a NON-opencode harness (e.g. Codex via ACP)
 *       becomes visible once its `session.lifecycle` "created" event reaches
 *       the client, where an opencode-native session rides the native
 *       `session.created` SSE event instead. Harness/ACP session creation only
 *       ever publishes `session.lifecycle` on `claxedoBus` (aka
 *       `workspaceRuntimeBus`); `streamGlobalEvents`
 *       (`packages/claxedo-local-server/src/shell/events.ts`) — the handler
 *       behind both `/global/event` and the local-mode `/api/wr/events`
 *       fallback, the ONLY stream a local/unsigned workspace ever opens —
 *       must therefore forward `claxedoBus` as well as `globalBus`, written
 *       flat/unwrapped to match the shape `ClaxedoEventsProvider`'s
 *       `isClaxedoEvent` guard requires. Tier M mocks bypass the real server,
 *       so this spec can only pin the frontend half: given a flat
 *       `session.lifecycle` "created" frame, `applySessionInventoryLifecycle`
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
      // No `localStorage.clear()` here: Playwright re-runs `addInitScript`
      // on every navigation within a test, including `page.reload()` — a
      // fresh context already starts with empty storage (this call was a
      // no-op there), but clearing on reload was wiping out whatever the
      // page itself had just persisted (e.g. the "view state survives
      // reload" scenario's own `localStorage.setItem` from a real user
      // interaction), which is exactly what those scenarios exist to prove.
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

  test("project-header body click selects the project's primary workspace — behavior 2", async ({ page }) => {
    // `openOrCreateSession` (src/features/workspaces/actions/workspace-actions.ts)
    // excludes the `"new"` draft sentinel from its reuse check
    // (`existing.sessionId && existing.sessionId !== "new"`), so a
    // project-header body click on a bare draft route routes to
    // `workspaceSessionRoute(workspaceId)` (`/w/<workspaceId>/session`) instead
    // of treating the draft as a reusable session and landing on the malformed
    // `/s/new` dead-end the last assertion below guards against.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "primary" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    const header = page.locator('[data-testid="project-header"]')
    await expect(header).toBeVisible({ timeout: 15_000 })

    // Click the header BODY (x=60 clears the disclosure caret at the far left
    // and lands ahead of the opacity-0 HeaderActions further right) — this fires
    // `onWorkspaceSelect` -> `handleWorkspaceSelect` -> `openOrCreateSession`.
    await header.click({ position: { x: 60, y: 8 } })

    await expect(page).toHaveURL(/\/w\/.+\/session/, { timeout: 15_000 })
    await expect(page).not.toHaveURL(/\/s\/new/)
  })

  test("workspace-header disclosure caret toggles collapse only, never navigates — behavior 1", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(2, { prefix: "ws" }) })
    await seedProject(page, { dir: DIR, view: { group: "workspace" } })
    await openTree(page, DIR)

    const header = page.locator(`[data-testid="workspace-header"][data-workspace-id="${PROJECT_ID}"]`)
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

  test("status dot moves working -> done as session.status/session.idle SSE land — behavior 4", async ({ page }) => {
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
    // the batched `client.session.status()` read in rail-sidebar.tsx.
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

  test("load more paginates in pages of 5, appending without duplicates — behavior 6", async ({ page }) => {
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

  test("load more's done notice replaces the button once every session is loaded — behavior 6", async ({ page }) => {
    // `mergeSessionListResponses` (src/features/session/data/query/session-list.ts)
    // advances an append to the freshly-fetched page's OWN `nextCursor` —
    // including `undefined` once the server reports no further pages — rather
    // than keeping the first-page cursor. So once the final page loads,
    // `nextCursor` clears, `more()` goes falsy, the "Load more" button
    // disappears and `doneLoaded()` fires.
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

  test("view options: Group by restructures the tree; Archived radio changes the fetched set — behavior 7", async ({ page }) => {
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
    await expect(page.locator(`[data-testid="workspace-header"][data-workspace-id="${PROJECT_ID}"]`)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="project-header"]')).toHaveCount(0)

    // The view-options menu stays open across radio selections (a multi-section
    // settings panel, not a close-on-select menu), so there is deliberately no
    // re-open here — re-clicking the trigger would toggle it closed instead.
    fixtures.sessionListRequests.length = 0
    await page.getByRole("menuitemradio", { name: "All" }).click()
    await expect.poll(() => fixtures.sessionListRequests.some((q) => q.includes("archived=all")), { timeout: 10_000 }).toBe(true)
  })

  test("account footer exposes utilities and restores focus across nested panels — behavior 16", async ({ page }) => {
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

  test("view state persists to localStorage across reload; malformed JSON falls back to defaults — behavior 8", async ({ page }) => {
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
    await expect(page.locator(`[data-testid="workspace-header"][data-workspace-id="${PROJECT_ID}"]`)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="project-header"]')).toHaveCount(0)
  })

  test("malformed view JSON is caught and replaced by defaults, not a broken tree — behavior 8", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "malformed" }) })
    await seedProject(page, { dir: DIR, view: "malformed" })
    await openTree(page, DIR)

    // defaultView(): group="project", archived="active" -> project-header tree renders fine.
    await expect(page.locator('[data-testid="project-header"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-testid="workspace-header"]')).toHaveCount(0)
  })

  test("loading/error/empty notices render with stable testids; Retry re-fires the query — behavior 9", async ({ page }) => {
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

  test("archiving the only active session leaves its URL for the project root — behavior 10", async ({ page }) => {
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
    // ever publishes: a `session.lifecycle` "created" event on `claxedoBus`
    // — see BEHAVIORS #15. Injected flat/unwrapped via `emitFlat`, matching
    // the real wire shape `ClaxedoEventsProvider` requires.
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
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "toggle" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    // The `docked`-state half of behavior 13, isolated from the width half the
    // sibling test below owns (which pins the full 260 -> 0 -> 260 transition).
    // The toggle button is rendered only while docked (`Show when={docked()}`
    // in rail-sidebar.tsx), so it disappearing on click IS the state flip.
    const toggle = page.locator('[data-testid="sidebar-toggle"]')
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(toggle).toHaveCount(0)
  })

  test("sidebar-toggle collapses/expands the rail's width — behavior 13", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "sidebar-tree" })
    await installSessionTreeFixtures(page, { dir: DIR, projectId: PROJECT_ID, sessions: makeSessions(1, { prefix: "width" }) })
    await seedProject(page, { dir: DIR })
    await openTree(page, DIR)

    // Read the dispatched inline width (the rail carries a 1px right border, so
    // the bordered client rect never reads exactly 0 when collapsed).
    const railWidth = () =>
      page.locator('[data-testid="rail-sidebar"]').evaluate((el) => parseFloat((el as HTMLElement).style.width) || 0)

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

    await page.getByRole("button", { name: "Show Sidebar" }).click()
    await expect.poll(railWidth, { timeout: 10_000 }).toBe(260)
    await expect(page.locator('[data-testid="sidebar-toggle"]')).toBeVisible()
  })

  test("hot-zone peek expands an unpinned collapsed sidebar; leaving the rail auto-collapses it — behavior 11", async ({ page }) => {
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

  test("drag-resizing the sidebar handle changes width live and persists across reload — behavior 12", async ({ page }) => {
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

  test("mobile drawer opens via the opener, scrim-closes, and closes on session select — behavior 14", async ({ page }) => {
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
