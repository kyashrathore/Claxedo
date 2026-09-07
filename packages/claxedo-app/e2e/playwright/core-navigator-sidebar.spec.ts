/**
 * The `appearance.navigatorPlacement` preference: the Files / Changes / Processes
 * navigator as a sidebar beside the rail, the workspace panel opening at full view over
 * the pane column, the focused session floating over it, and the two-step reveal a
 * floating session keeps its history behind: the whole transcript sits collapsed under a
 * peek strip (`session-transcript-peek`, count = every visible turn), and once peeked the
 * history window still holds only the last turn, with the in-timeline
 * `timeline-previous-messages` row counting the turns above it. The collapsed transcript
 * is `max-height: 0`, so its virtualized rows do not exist in the DOM until the peek.
 *
 * The classic panel's rendered width is the panel's own `defaultWidth()` (70% of the
 * column) rather than the layout state's 520px, so the classic assertions are on the
 * shape (a px panel narrower than `main`, the overlay inside it) and not on a number.
 *
 * The preference lives in `settings.v3` (`appearance.navigatorPlacement`, default
 * `"panel"`) and is the only thing that survives a reload here; the sidebar's own tab and
 * width persist in `claxedo.state.v5`, which the seed below never writes. A seeded blob
 * skips the Settings dialog for the scenarios whose subject is not the dialog; the
 * scenario that IS about the dialog drives the real Select.
 *
 * Every session route is overridden after `installMockRuntime` (Playwright matches the
 * most recently registered route first) with four settled turns, because the floating
 * window opens at one turn and the reveal row exists only when there is history behind
 * it. Every pattern ends in `**` or has a `?**` twin: without one Playwright demands an
 * exact end-of-URL match and the app's `?directory=` suffix makes it miss silently.
 *
 * The Changes list reads the OpenCode `/file/status` route, which the shared mock answers
 * empty; the Review tab reads the workspace-runtime `/api/wr/diff/vcs` routes, which the
 * shared mock drives against an EMPTY git backend. Both are overridden here from one
 * fixture so the file the user clicks in Changes is the file the review focuses.
 *
 * The rail reads `/api/control/session-list` (loopback spelling `/api/claxedo/session-list`),
 * which the shared mock answers EMPTY; one row for `SESSION_ID` is served here in the
 * shape `core-sidebar-tree.spec.ts` uses so the rail oracle has a row to name.
 *
 * A Changes click carries `intent: "review"`, which `review-workspace.tsx`'s focus effect
 * reads only AFTER `onFocusConsumed` has cleared the request it belongs to, so the intent
 * reads as undefined and a file tab opens instead of the Review tab. That is the same in
 * classic placement. The one scenario asserting the Review contract is red until that is
 * fixed; every other scenario asserts the panel state the click produced instead.
 */
import { expect, test, type Page, type TestInfo } from "@playwright/test"
import { sessionListRoute } from "../helpers/contracts/session-list"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectNavigatorSidebar, expectNavigatorSidebarAbsent, expectRailRowVisible } from "../helpers/rail-oracle"
import { captureEvidence } from "../helpers/visual-evidence"

const DIR = "/tmp/e2e-core-navigator-sidebar"
const PROJECT_ID = "proj_core_navigator_sidebar"
const SESSION_ID = "ses_core_navigator_sidebar_mock"
const SPEC = "core-navigator-sidebar"
const TURNS = 4
const FOCUS_FILE = "src/index.ts"

/** The full-view panel and the classic px panel are far apart, so a few px of border
 * or subpixel rounding can never blur the two. */
const WIDTH_TOLERANCE = 4
/** `minWidth` in `workspace-panel.tsx`: the narrowest px panel the classic layout renders. */
const CLASSIC_PANEL_MIN_WIDTH = 360

type NavigatorPlacement = "panel" | "sidebar"

const SEEDED_STATUS = [
  { path: FOCUS_FILE, status: "modified", added: 1, removed: 1 },
  { path: "src/util.ts", status: "added", added: 2, removed: 0 },
] as const

const SEEDED_DIFFS = [
  {
    file: FOCUS_FILE,
    status: "modified",
    additions: 1,
    deletions: 1,
    before: "export const ready = false\n",
    after: "export const ready = true\n",
    patch: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const ready = false\n+export const ready = true\n",
  },
  {
    file: "src/util.ts",
    status: "added",
    additions: 2,
    deletions: 0,
    before: "",
    after: "export function noop() {}\nexport const two = 2\n",
    patch: "--- /dev/null\n+++ b/src/util.ts\n@@ -0,0 +1,2 @@\n+export function noop() {}\n+export const two = 2\n",
  },
]

async function seedProject(page: Page, opts: { dir: string; navigatorPlacement?: NavigatorPlacement }) {
  await page.addInitScript(
    ([dir, placement]: [string, NavigatorPlacement | undefined]) => {
      // No `localStorage.clear()`: init scripts re-run on `page.reload()`, and the
      // reload scenario asserts on what the page itself persisted.
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
      // Written only when absent so a value the page persisted survives the reload's
      // re-run of this script.
      if (placement && localStorage.getItem("settings.v3") === null) {
        localStorage.setItem("settings.v3", JSON.stringify({ appearance: { navigatorPlacement: placement } }))
      }
    },
    [opts.dir, opts.navigatorPlacement] as [string, NavigatorPlacement | undefined],
  )
}

function seededSessionRow() {
  return {
    id: SESSION_ID,
    slug: SESSION_ID,
    projectID: PROJECT_ID,
    directory: DIR,
    title: "navigator sidebar session",
    version: "2",
    time: { created: Date.now(), updated: Date.now() },
    summary: { additions: 0, deletions: 0, files: 0 },
    config: {
      harness: { type: "opencode", model: "big-pickle", status: "ready", ready: true },
      model: { providerID: "opencode", modelID: "big-pickle" },
      provider: { id: "opencode", model: "big-pickle" },
      agent: "build",
    },
  }
}

function seededTurnRows(count: number) {
  const rows: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
  for (let i = 1; i <= count; i++) {
    const n = String(i).padStart(2, "0")
    const uid = `msg_user_${n}`
    const aid = `msg_assistant_${n}`
    const created = Date.now() - (count - i + 1) * 60_000
    rows.push({
      info: { id: uid, sessionID: SESSION_ID, role: "user", time: { created }, agent: "build", model: { providerID: "opencode", modelID: "big-pickle" } },
      parts: [{ id: `${uid}_text`, sessionID: SESSION_ID, messageID: uid, type: "text", text: `navigator sidebar history message ${i}` }],
    })
    rows.push({
      info: {
        id: aid,
        sessionID: SESSION_ID,
        role: "assistant",
        time: { created: created + 500, completed: created + 1500 },
        parentID: uid,
        agent: "build",
        providerID: "opencode",
        modelID: "big-pickle",
        mode: "code",
        path: { cwd: DIR, root: DIR },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ id: `${aid}_text`, sessionID: SESSION_ID, messageID: aid, type: "text", text: `Reply ${i}. A short acknowledgement for turn ${i}.` }],
    })
  }
  return rows
}

/** The last seeded user turn's text, the one a floating session keeps on screen. */
const LAST_TURN_TEXT = `navigator sidebar history message ${TURNS}`

async function installSeededWorkspace(page: Page, opts: { navigatorPlacement?: NavigatorPlacement } = {}) {
  await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, workspaceId: PROJECT_ID, projectName: "navigator-sidebar" })
  await seedProject(page, { dir: DIR, navigatorPlacement: opts.navigatorPlacement })

  const sessionRow = seededSessionRow()
  const listBody = JSON.stringify([sessionRow])
  const sessionBody = JSON.stringify(sessionRow)
  const messageBody = JSON.stringify({ messages: seededTurnRows(TURNS), maxEventOrdinal: 0 })
  const json = (body: string) => ({ status: 200, contentType: "application/json", body })

  await page.route("**/session", (route) => (route.request().method() === "GET" ? route.fulfill(json(listBody)) : route.fallback()))
  await page.route("**/session?**", (route) => (route.request().method() === "GET" ? route.fulfill(json(listBody)) : route.fallback()))
  // Bound to the session row only: a trailing `**` would also swallow `permission-mode`
  // and every other sub-resource the composer fetches on mount.
  await page.route(`**/session/${SESSION_ID}`, (route) => route.fulfill(json(sessionBody)))
  await page.route(`**/session/${SESSION_ID}?**`, (route) => route.fulfill(json(sessionBody)))
  await page.route(`**/session/${SESSION_ID}/message**`, (route) => route.fulfill(json(messageBody)))

  await page.route(sessionListRoute, (route) => {
    const url = new URL(route.request().url())
    const limit = Number(url.searchParams.get("limit") ?? "5") || 5
    return route.fulfill(json(JSON.stringify({
      view: { scope: url.searchParams.get("scope") ?? "workspace", groupBy: "none", sort: "updated_desc", limit },
      items: [{
        type: "session",
        sessionRef: SESSION_ID,
        sessionId: SESSION_ID,
        title: sessionRow.title,
        directory: DIR,
        projectId: PROJECT_ID,
        createdAt: sessionRow.time.created,
        updatedAt: sessionRow.time.updated,
        tags: [],
        attachments: [],
      }],
      totalKnown: 1,
    })))
  })

  await page.route("**/file/status**", (route) => route.fulfill(json(JSON.stringify(SEEDED_STATUS))))
  await page.route("**/api/wr/diff/vcs**", (route) => {
    const url = new URL(route.request().url())
    const pathname = url.pathname.replace(/^\/workspaces\/[^/]+/, "")
    if (pathname === "/api/wr/diff/vcs") return route.fulfill(json(JSON.stringify(SEEDED_DIFFS)))
    if (pathname === "/api/wr/diff/vcs/file") {
      const file = url.searchParams.get("file")
      const match = SEEDED_DIFFS.find((diff) => diff.file === file)
      return match ? route.fulfill(json(JSON.stringify(match))) : route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
    }
    return route.fallback()
  })
}

async function gotoSession(page: Page) {
  await page.goto(`/s/${SESSION_ID}`, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="rail-sidebar"]')).toBeVisible({ timeout: 20_000 })
  await expect(sessionRoot(page)).toHaveAttribute("data-session-visible-user-count", String(TURNS), { timeout: 20_000 })
}

function sessionRoot(page: Page) {
  return page.locator(`[data-testid="session-page-root"][data-session-id="${SESSION_ID}"]`)
}

function sessionPane(page: Page) {
  return page.locator("[data-workbench-content][data-pane-id]").filter({
    has: page.locator(`[data-testid="session-content"][data-session-id="${SESSION_ID}"]`),
  })
}

function envcardShell(page: Page) {
  return page.locator(`.session-envcard-shell[data-session-id="${SESSION_ID}"]`)
}

function panelShell(page: Page) {
  return page.locator('[data-testid="workspace-panel-shell"]')
}

function workbenchColumn(page: Page) {
  return page.locator('[data-testid="workbench-column"]')
}

function timelineScroller(page: Page) {
  return sessionRoot(page).locator('[data-scrollable]:has([data-slot="session-turn-message-content"])').first()
}

function previousMessagesRow(page: Page) {
  return sessionRoot(page).locator('button[data-testid="timeline-previous-messages"]')
}

function transcriptPeek(page: Page) {
  return sessionRoot(page).locator('button[data-testid="session-transcript-peek"]')
}

function collapsedTranscript(page: Page) {
  return sessionRoot(page).locator('[data-session-transcript-collapsed="true"]')
}

function composerEditor(page: Page) {
  return sessionRoot(page).locator('[data-component="prompt-input"]')
}

/** Width of the single `role="main"` landmark, the column the panel covers at full view. */
async function mainWidth(page: Page) {
  const box = await page.getByRole("main").boundingBox()
  expect(box, 'role="main" has no box').not.toBeNull()
  return box!.width
}

async function panelWidth(page: Page) {
  const box = await panelShell(page).boundingBox()
  expect(box, "workspace panel shell has no box").not.toBeNull()
  return box!.width
}

/** Drives the real Settings → General → Appearance Select, as a user would. */
async function setNavigatorPlacement(page: Page, placement: NavigatorPlacement) {
  const label = placement === "sidebar" ? "Sidebar" : "Workspace panel"
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  const dialog = page.locator('[data-slot="dialog-container"]').last()
  await expect(dialog).toBeVisible({ timeout: 10_000 })

  const trigger = dialog.locator('[data-action="settings-navigator-placement"] [data-slot="select-select-trigger"]')
  await trigger.click()
  await page.locator('[data-slot="select-select-item"]').filter({ hasText: label }).first().click()
  await expect(trigger).toContainText(label)

  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden({ timeout: 5_000 })
}

async function persistedNavigatorPlacement(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("settings.v3")
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || !("appearance" in parsed)) return undefined
    const appearance = parsed.appearance
    if (!appearance || typeof appearance !== "object" || !("navigatorPlacement" in appearance)) return undefined
    return appearance.navigatorPlacement
  })
}

/** Clicks `path` in the sidebar's Changes list. The list is the sidebar's, never the
 * panel overlay's, so a click that opened the overlay instead would fail here. */
async function clickChangedFileInSidebar(page: Page, path: string) {
  const sidebar = await expectNavigatorSidebar({ page })
  await sidebar.locator('[role="tab"][data-tab="changes"]').click()
  await expect(sidebar).toHaveAttribute("data-tab", "changes")
  const list = sidebar.locator('[data-testid="workspace-changed-file-list"]')
  await expect(list).toBeVisible({ timeout: 15_000 })
  await list.locator(`button[data-file-tree-path="${path}"]`).click()
}

/** The panel is open at full view: it covers the `role="main"` column, the pane column is
 * the floating host, and no navigator overlay sits inside the panel. */
async function expectPanelAtFullView(page: Page) {
  const panel = panelShell(page)
  await expect(panel).toHaveAttribute("data-state-open", "true", { timeout: 15_000 })
  await expect(panel).toHaveAttribute("data-open", "true", { timeout: 15_000 })
  await expect(panel).toHaveAttribute("data-shell-settled", "true", { timeout: 15_000 })
  await expect(workbenchColumn(page)).toHaveAttribute("data-floating-host", "", { timeout: 15_000 })
  await expect.poll(async () => Math.abs((await panelWidth(page)) - (await mainWidth(page))), { timeout: 15_000 }).toBeLessThan(WIDTH_TOLERANCE)
  await expect(panel.locator('[data-testid="workspace-navigator-overlay"]')).toHaveCount(0)
}

/** The click landed as a review-mode, Changes-navigator panel request. */
async function expectPanelInReviewForChanges(page: Page) {
  const panel = panelShell(page)
  await expect(panel).toHaveAttribute("data-state-mode", "review", { timeout: 15_000 })
  await expect(panel).toHaveAttribute("data-state-navigator", "changes")
  await expect(panel).toHaveAttribute("data-state-workspace-dir", DIR)
}

/** The Review tab is the selected workspace tab and `path` is the focused diff in it. */
async function expectReviewFocused(page: Page, path: string) {
  const panel = panelShell(page)
  await expect(panel.locator('[data-slot="workspace-tab"][data-workspace-tab-id="review"]')).toHaveAttribute("data-selected", "true", { timeout: 15_000 })
  await expect(panel.locator('[data-testid="review-pane-root"]')).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator(`[data-component="session-review"] [data-review-file="${path}"]`)).toBeVisible({ timeout: 15_000 })
}

/** Opens the classic panel from the floating chrome's toggle, then selects `navigator`
 * in the panel's own L2 trio: the trio has no home outside the panel column. */
async function openClassicPanelNavigator(page: Page, navigator: "Files" | "Changes" | "Processes") {
  const toggle = page.locator('[data-testid="workbench-shell-header"] [data-testid="workspace-panel-toggle"]')
  await expect(toggle).toHaveAttribute("aria-label", "Open workspace panel")
  await toggle.click()
  const panel = panelShell(page)
  await expect(panel).toHaveAttribute("data-open", "true", { timeout: 15_000 })
  await panel.getByRole("button", { name: `Open ${navigator}` }).click()
}

async function expectSessionFloating(page: Page) {
  await expect(sessionPane(page)).toHaveAttribute("data-pane-presentation", "floating", { timeout: 15_000 })
  await expect(envcardShell(page)).toHaveAttribute("data-session-presentation", "floating", { timeout: 15_000 })
}

async function expectSessionDocked(page: Page) {
  await expect(sessionPane(page)).toHaveAttribute("data-pane-presentation", "docked", { timeout: 15_000 })
  await expect(envcardShell(page)).toHaveAttribute("data-session-presentation", "docked", { timeout: 15_000 })
}

function lastTurnContent(page: Page) {
  return sessionRoot(page).locator('[data-slot="session-turn-message-content"]', { hasText: LAST_TURN_TEXT })
}

async function expectScrolledToEnd(page: Page) {
  const scroller = timelineScroller(page)
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), { timeout: 15_000 })
    .toBeLessThan(20)
}

/** The video is written on context close, so its path is the one durable pointer this
 * spec can leave for a reviewer; attached to the report beside the evidence PNGs. */
async function attachVideoPath(page: Page, testInfo: TestInfo) {
  const path = await page.video()?.path()
  if (path) await testInfo.attach("video-path", { body: path, contentType: "text/plain" })
}

test.describe("core navigator sidebar placement @core", () => {
  // Each scenario is a cold `/s/:id` navigation plus panel motion; some add a reload.
  test.beforeEach(() => {
    test.slow()
  })

  test("default placement keeps the classic rail and mounts no navigator sidebar", async ({ page }) => {
    await installSeededWorkspace(page)
    await gotoSession(page)

    await expectRailRowVisible({ page, sessionId: SESSION_ID })
    await expectNavigatorSidebarAbsent({ page })
    expect(await persistedNavigatorPlacement(page)).not.toBe("sidebar")
  })

  test("Settings → Appearance → Sidebar mounts the navigator beside an unchanged rail and survives a reload", async ({ page }) => {
    await installSeededWorkspace(page)
    await gotoSession(page)
    await expectNavigatorSidebarAbsent({ page })

    await setNavigatorPlacement(page, "sidebar")

    // Changes is the persisted default tab of a fresh `claxedo.state.v5`.
    await expectNavigatorSidebar({ page, tab: "changes", evidence: { spec: SPEC, scenario: "sidebar-mounted" } })
    await expectRailRowVisible({ page, sessionId: SESSION_ID })
    await expect.poll(() => persistedNavigatorPlacement(page)).toBe("sidebar")

    await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    expect(await persistedNavigatorPlacement(page)).toBe("sidebar")
    await expectNavigatorSidebar({ page, tab: "changes" })
    await expectRailRowVisible({ page, sessionId: SESSION_ID })
  })

  test("a Changes click opens the panel at full view over a floating session whose history collapses to the last turn until revealed", async ({ page }, testInfo) => {
    await installSeededWorkspace(page, { navigatorPlacement: "sidebar" })
    await gotoSession(page)
    await expectSessionDocked(page)
    await expect(panelShell(page)).toHaveCount(0)

    const sidebar = await expectNavigatorSidebar({ page, tab: "changes" })
    const list = sidebar.locator('[data-testid="workspace-changed-file-list"]')
    await expect(list.locator("button[data-file-tree-path]")).toHaveCount(SEEDED_STATUS.length, { timeout: 15_000 })
    for (const file of SEEDED_STATUS) await expect(list.locator(`button[data-file-tree-path="${file.path}"]`)).toBeVisible()

    await clickChangedFileInSidebar(page, FOCUS_FILE)
    await expectPanelAtFullView(page)
    await expectPanelInReviewForChanges(page)
    await expectSessionFloating(page)
    await captureEvidence({ page, spec: SPEC, scenario: "full-view-open" })

    // The floating composer is the same PromptInput node, reachable over the panel.
    const editor = composerEditor(page)
    await expect(editor).toBeVisible()
    await editor.click()
    await expect(editor).toBeFocused()
    await page.keyboard.type("x")
    await expect(editor).toContainText("x")
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.press("Backspace")
    await expect(editor).not.toContainText("x")

    // Floating collapses the whole transcript behind the peek strip, whose count is every
    // visible turn, while the history window itself holds only the last turn.
    const root = sessionRoot(page)
    await expect(root).toHaveAttribute("data-session-rendered-user-count", "1", { timeout: 15_000 })
    await expect(root).toHaveAttribute("data-session-visible-user-count", String(TURNS))
    const peek = transcriptPeek(page)
    await expect(peek).toBeVisible({ timeout: 15_000 })
    await expect(peek).toHaveAttribute("data-count", String(TURNS))
    await expect(peek).toHaveAttribute("aria-expanded", "false")
    await expect(collapsedTranscript(page)).toHaveCount(1)
    await expect(previousMessagesRow(page)).toHaveCount(0)

    // Peeking shows the last turn and the row that counts the history above it.
    await peek.click()
    await expect(peek).toHaveAttribute("aria-expanded", "true")
    await expect(collapsedTranscript(page)).toHaveCount(0)
    await expect(lastTurnContent(page)).toBeVisible({ timeout: 15_000 })
    await expect(root).toHaveAttribute("data-session-rendered-user-count", "1")
    const row = previousMessagesRow(page)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).toHaveAttribute("data-count", String(TURNS - 1))
    await captureEvidence({ page, spec: SPEC, scenario: "transcript-peeked" })

    await row.click()
    await expect(row).toHaveCount(0, { timeout: 15_000 })
    await expect(root).toHaveAttribute("data-session-rendered-user-count", String(TURNS), { timeout: 15_000 })
    await expect(lastTurnContent(page)).toBeVisible()
    await expectScrolledToEnd(page)
    await captureEvidence({ page, spec: SPEC, scenario: "previous-messages-revealed" })
    await attachVideoPath(page, testInfo)
  })

  test("restore docks the session beside a px-width panel; close and reopen returns to full view; the header trio drives the sidebar tab", async ({ page }, testInfo) => {
    await installSeededWorkspace(page, { navigatorPlacement: "sidebar" })
    await gotoSession(page)
    await clickChangedFileInSidebar(page, FOCUS_FILE)
    await expectPanelAtFullView(page)
    await expectSessionFloating(page)

    const panel = panelShell(page)
    const l1 = panel.locator('[data-testid="workspace-panel-l1-header"]')
    await l1.getByRole("button", { name: "Restore workspace panel width" }).click()
    await expect(l1.getByRole("button", { name: "Maximize workspace panel" })).toBeVisible({ timeout: 15_000 })
    await expect(workbenchColumn(page)).not.toHaveAttribute("data-floating-host", "", { timeout: 15_000 })
    await expect.poll(async () => (await mainWidth(page)) - (await panelWidth(page)), { timeout: 15_000 }).toBeGreaterThan(WIDTH_TOLERANCE)
    await expectSessionDocked(page)
    // Docked again, the peek strip is gone and the window reopens at its full initial
    // size: every seeded turn, no row above it.
    await expect(transcriptPeek(page)).toHaveCount(0, { timeout: 15_000 })
    await expect(collapsedTranscript(page)).toHaveCount(0)
    await expect(sessionRoot(page)).toHaveAttribute("data-session-rendered-user-count", String(TURNS), { timeout: 15_000 })
    await expect(previousMessagesRow(page)).toHaveCount(0)
    await expect(lastTurnContent(page)).toBeVisible({ timeout: 15_000 })
    await captureEvidence({ page, spec: SPEC, scenario: "restored-docked" })

    // The L1 toggle is the only one visible while the panel is open.
    await l1.locator('[data-testid="workspace-panel-toggle"]').click()
    await expect(panel).toHaveAttribute("data-open", "false", { timeout: 15_000 })

    // Full view is the preset's base, so a reopen ignores the restored px width.
    await clickChangedFileInSidebar(page, "src/util.ts")
    await expectPanelAtFullView(page)
    await expectPanelInReviewForChanges(page)
    await expectSessionFloating(page)

    // The panel's L2 trio selects the sidebar's tab in this placement instead of an overlay.
    await panel.getByRole("button", { name: "Open Processes" }).click()
    await expectNavigatorSidebar({ page, tab: "processes" })
    await expect(panel.locator('[data-testid="workspace-navigator-overlay"]')).toHaveCount(0)
    await attachVideoPath(page, testInfo)
  })

  test("switching back to Workspace panel unmounts the sidebar and the header trio opens the classic panel with its overlay", async ({ page }) => {
    await installSeededWorkspace(page, { navigatorPlacement: "sidebar" })
    await gotoSession(page)
    await expectNavigatorSidebar({ page, tab: "changes" })

    await setNavigatorPlacement(page, "panel")
    await expectNavigatorSidebarAbsent({ page })
    await expectRailRowVisible({ page, sessionId: SESSION_ID })
    await expect.poll(() => persistedNavigatorPlacement(page)).toBe("panel")

    await openClassicPanelNavigator(page, "Changes")
    const panel = panelShell(page)
    await expect(panel).toHaveAttribute("data-state-open", "true", { timeout: 15_000 })
    await expect(panel).toHaveAttribute("data-shell-settled", "true", { timeout: 15_000 })
    await expect(panel).toHaveAttribute("data-state-navigator", "changes")
    // A px panel beside the column, never the full-view cover.
    await expect.poll(() => panelWidth(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(CLASSIC_PANEL_MIN_WIDTH)
    await expect.poll(async () => (await mainWidth(page)) - (await panelWidth(page)), { timeout: 15_000 }).toBeGreaterThan(WIDTH_TOLERANCE)
    await expect(workbenchColumn(page)).not.toHaveAttribute("data-floating-host", "")
    await expect(workbenchColumn(page)).toHaveCSS("margin-right", /^[1-9]\d*px$/)
    await expect(panel.locator('[data-testid="workspace-navigator-overlay"][data-navigator="files"]')).toHaveAttribute("data-open", "true", { timeout: 15_000 })
    await expectSessionDocked(page)
  })

  test("a Changes click focuses the clicked file in the Review tab, from the sidebar and from the classic overlay alike", async ({ page }) => {
    await installSeededWorkspace(page, { navigatorPlacement: "sidebar" })
    await gotoSession(page)

    await clickChangedFileInSidebar(page, FOCUS_FILE)
    await expectPanelAtFullView(page)
    await expectReviewFocused(page, FOCUS_FILE)

    await setNavigatorPlacement(page, "panel")
    await expectNavigatorSidebarAbsent({ page })
    const overlay = panelShell(page).locator('[data-testid="workspace-navigator-overlay"][data-navigator="files"]')
    if ((await overlay.getAttribute("data-open").catch(() => null)) !== "true") {
      await panelShell(page).getByRole("button", { name: "Open Changes" }).click()
    }
    await expect(overlay).toHaveAttribute("data-open", "true", { timeout: 15_000 })
    await overlay.locator(`button[data-file-tree-path="src/util.ts"]`).click()
    await expectReviewFocused(page, "src/util.ts")
  })

})
