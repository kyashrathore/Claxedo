/**
 * The rail sidebar under the `claude` native-SDK harness, which reaches the renderer over a
 * different set of wire events than the opencode and `codex-acp` harnesses the other rail
 * specs run against.
 *
 * Frames are delivered with `mock.emit()`, served only to a workspace-scoped
 * `**\/api\/wr\/events**` request, so the SSE fetch, the stream-target selection and the
 * frame parser are all in the path. The dev-only `window.__claxedoEmitTestEvent` bus seam
 * skips all three and would stay green while nothing reached a real user. The first
 * scenario boots at `/` and enters the project client-side, so it fails if the app never
 * opens the workspace's stream.
 *
 * What the server puts on that wire:
 *   1. creation publishes `session.lifecycle` `creating` then `created`, the latter
 *      carrying `info.title` as the placeholder `"New Session"`;
 *   2. the server then derives a real title from the first prompt (`fallbackSessionTitle`
 *      in session-title.ts — a rule, not an LLM summary) and publishes `session.updated`
 *      with `method: "auto-title"`, forwarded by `bridgeLifecycleEvent` in
 *      workspace-runtime's `routes/session.ts`;
 *   3. a chat turn publishes `agent.lifecycle` Busy/Idle with `tabId` set to the session id
 *      and no `terminalId` at all;
 *   4. `GET /session/status` never lists a native-SDK session, even mid-turn.
 *
 * Facts 3 and 4 together look like a broken status dot and are not. The chat row's dot
 * comes from `session.status`/`session.idle` SSE dispatched into
 * `shellDataKeys.sessionId(id, "status")`; `agent.lifecycle` feeds the terminal status map,
 * and the REST status map is not the dot's source at all.
 */

import { sessionListRoute } from "../helpers/contracts/session-list"
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-claude-native-sdk-rail"
const PROJECT_ID = "proj_claude_native_sdk"
const SESSION_ID = "ses_claude_native_sdk_mock"
const WORKSPACE_ID = "ws_claude_native_sdk"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function openTreeAtDirectory(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="rail-sidebar"]')).toBeVisible({ timeout: 20_000 })
}

type FixtureSession = {
  sessionId: string
  title: string
  createdAt: number
  updatedAt: number
  lastHumanTurnAt?: number
}

/**
 * Minimal stand-in for the paginated `session-list` the rail rows render from. A local copy
 * rather than an import: core-sidebar-tree.spec.ts's equivalent is file-private, and ~30
 * duplicated lines are cheaper than widening that file's surface for one neighbour.
 *
 * `setSessions` models the server's view, so a scenario can move the server's title
 * independently of whatever the client has cached. That gap is the whole subject of the
 * auto-title scenario.
 */
type FixtureSort = "updated_desc" | "created_desc" | "human_turn_desc"

function sortValue(input: string | null): FixtureSort {
  return input === "created_desc" || input === "human_turn_desc" ? input : "updated_desc"
}

function fixtureSortKey(item: FixtureSession, sort: FixtureSort) {
  if (sort === "human_turn_desc") return [item.lastHumanTurnAt ?? 0, item.createdAt]
  if (sort === "created_desc") return [item.createdAt]
  return [item.updatedAt]
}

function compareFixtures(a: FixtureSession, b: FixtureSession, sort: FixtureSort) {
  const left = fixtureSortKey(a, sort)
  const right = fixtureSortKey(b, sort)
  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0
    if (other !== value) return other - value
  }
  return b.sessionId.localeCompare(a.sessionId)
}

async function installSessionListFixture(
  page: Page,
  opts: { dir: string; projectId: string; sessions: FixtureSession[] },
) {
  let sessions = [...opts.sessions]

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
    ...(item.lastHumanTurnAt !== undefined ? { lastHumanTurnAt: item.lastHumanTurnAt } : {}),
    tags: [],
    attachments: [],
  })

  await page.route(sessionListRoute, async (route) => {
    const url = new URL(route.request().url())
    const limit = Number(url.searchParams.get("limit") ?? "5") || 5
    // Answers in the order the CLIENT asked for. A fixture that answered its own
    // order regardless would pass whatever the rail requested, so the order under
    // test would never actually be exercised.
    const sort = sortValue(url.searchParams.get("sort"))
    const items = [...sessions].sort((a, b) => compareFixtures(a, b, sort)).slice(0, limit)
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        view: { scope: url.searchParams.get("scope") ?? "workspace", groupBy: "none", sort, limit },
        items: items.map(toNavRow),
        nextCursor: undefined,
      }),
    })
  })

  return {
    setSessions: (next: FixtureSession[]) => {
      sessions = [...next]
    },
  }
}

async function seedProjectAtHome(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
    }
    localStorage.setItem(
      "claxedo.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: d, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, dir)
}

async function openTreeFromHome(page: Page) {
  await page.goto("/")
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const project = page.locator(`[data-testid="project-group"][data-project-id="${PROJECT_ID}"]`)
  await expect(project).toBeVisible({ timeout: 20_000 })
  // The header action cluster is mounted only after its owner is engaged.
  const header = project.locator('[data-testid="project-header"]')
  await header.hover()
  await header.getByRole("button", { name: /^New session in /, exact: false }).click()
  await expect(page.locator('[data-testid="rail-sidebar"]')).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE_ID}/session`), { timeout: 20_000 })
}

/**
 * `.first()` is load-bearing. A session announced by a `session.lifecycle` frame carrying
 * `info.workspaceID` — which the real native-SDK frame does — renders twice: once from the
 * project section as `data-session-ref="<id>"`, once from a workspace section as
 * `data-session-ref="workspace:<wsId>:session:<id>"`, because the control-plane row and the
 * event-derived row resolve to different sections. That duplication is a separate defect;
 * either row carrying the right title and dot is the outcome these scenarios are about.
 */
const sessionRow = (page: Page, id: string) =>
  page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${id}"]`).first()

test.describe("rail — claude native-SDK harness @core", () => {
  /**
   * The create half of the pipeline, which also proves this file's fixtures and transport
   * are wired: without it a failure below could just mean the harness never booted.
   */
  test("a native-SDK session appears in the rail the moment session.lifecycle 'created' lands", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      projectName: "claude-native-sdk",
      harness: "claude-sdk",
      workspaces: {
        [DIR]: { workspaceId: WORKSPACE_ID, kind: "local", directory: DIR, available: true },
      },
    })
    const fixtures = await installSessionListFixture(page, { dir: DIR, projectId: PROJECT_ID, sessions: [] })
    await seedProjectAtHome(page, DIR)
    await openTreeFromHome(page)

    await expect(page.locator('[data-testid="rail-sidebar-session-row"]')).toHaveCount(0)

    const now = Date.now()
    // The control-plane list has the row as soon as `POST /session` returns,
    // before any event — same ordering the real backend produces.
    fixtures.setSessions([{ sessionId: "ses_claude_new", title: "New Session", createdAt: now, updatedAt: now }])

    mock.emit({
      type: "session.lifecycle",
      phase: "created",
      directory: DIR,
      sessionID: "ses_claude_new",
      workspaceId: WORKSPACE_ID,
      info: {
        id: "ses_claude_new",
        slug: "ses_claude_new",
        projectID: PROJECT_ID,
        workspaceID: WORKSPACE_ID,
        directory: DIR,
        title: "New Session",
        version: "local",
        time: { created: now, updated: now },
      },
      ts: now,
    })

    await expect(sessionRow(page, "ses_claude_new")).toBeVisible({ timeout: 15_000 })
  })

  /**
   * The auto-title reaching the rail with no reload.
   *
   * The defect: `bridgeLifecycleEvent` in workspace-runtime translated a few
   * compat types into `agent.lifecycle` and dropped everything else, so the
   * `session.updated` that the auto-title publishes never reached the workspace
   * stream. Measured before the fix: 0 `session.updated` frames across a full
   * create-and-complete cycle, while every `session.lifecycle`,
   * `agent.lifecycle` and `pty.*` frame arrived. The rail therefore kept
   * "New Session" — in the WRONG sort position, since the row's `updated` was
   * stale too — until some unrelated refetch happened to land (observed
   * self-correcting ~2 minutes later, which is why this reads as intermittent).
   */
  test("a native-SDK session's rail title follows the server once its first turn settles", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      projectName: "claude-native-sdk",
      harness: "claude-sdk",
      workspaces: {
        [DIR]: { workspaceId: WORKSPACE_ID, kind: "local", directory: DIR, available: true },
      },
    })
    const id = "ses_claude_title"
    const now = Date.now()
    // A neighbour the reader spoke to more recently, so the session under test does not
    // start at the top and the order assertions below have something to be wrong about.
    // Seeded before the rail's FIRST list fetch, because the create invalidation that
    // follows does not refetch this section: a neighbour added after it never reaches the
    // screen, and every `.first()` assertion is then trivially about the only row there.
    const neighbour = {
      sessionId: "ses_claude_neighbour",
      title: "Neighbour",
      createdAt: now,
      updatedAt: now + 60_000,
      lastHumanTurnAt: now + 60_000,
    }
    const fixtures = await installSessionListFixture(page, {
      dir: DIR,
      projectId: PROJECT_ID,
      sessions: [neighbour],
    })
    await seedProjectAtHome(page, DIR)
    await openTreeFromHome(page)
    await expect(sessionRow(page, "ses_claude_neighbour")).toBeVisible({ timeout: 15_000 })

    fixtures.setSessions([
      neighbour,
      { sessionId: id, title: "New Session", createdAt: now, updatedAt: now, lastHumanTurnAt: now },
    ])
    mock.emit({
      type: "session.lifecycle",
      phase: "created",
      directory: DIR,
      sessionID: id,
      workspaceId: WORKSPACE_ID,
      info: {
        id,
        slug: id,
        projectID: PROJECT_ID,
        workspaceID: WORKSPACE_ID,
        directory: DIR,
        title: "New Session",
        version: "local",
        time: { created: now, updated: now },
      },
      ts: now,
    })

    const row = sessionRow(page, id)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.locator('[data-slot="session-navigation-title"]')).toHaveText("New Session")

    // Quiesce before moving the server's title. `session.lifecycle created` invalidates the
    // session-list, and that refetch is still in flight when the assertion above resolves,
    // so a title moved immediately after would be picked up by the create-invalidation's
    // own refetch rather than by anything reacting to the turn.
    await page.waitForTimeout(3_000)

    mock.emit({ type: "agent.lifecycle", tabId: id, workspaceId: WORKSPACE_ID, sessionId: id, eventType: "Busy" })

    // The fixture is deliberately left alone: `/api/control/session-list` keeps serving the
    // "New Session" placeholder for the rest of the scenario.
    //
    // Moving the fixture's title too would make this pass on a bogus frame type, because
    // the mocked environment refetches the session-list on its own. Holding the placeholder
    // means a refetch actively re-asserts it, so the new title can only come from the
    // event's own `reconcileUpdatedSessionListQueryData`.
    const newTitle = "Say TITLEPROBE and nothing else."

    // The frame that announces the new title. It reaches the workspace stream only because
    // `bridgeLifecycleEvent` (workspace-runtime `routes/session.ts`) forwards it; drop that
    // and the rail holds the placeholder until an unrelated refetch happens to land.
    mock.emit({
      type: "session.updated",
      directory: DIR,
      workspaceId: WORKSPACE_ID,
      properties: {
        sessionID: id,
        info: {
          id,
          slug: id,
          projectID: PROJECT_ID,
          directory: DIR,
          title: newTitle,
          version: "local",
          // Newer than the neighbour's, so an order keyed on `updated` would put this row
          // first. The reader has not spoken to it, so the rail's order must not.
          time: { created: now, updated: now + 120_000 },
        },
      },
    })

    mock.emit({ type: "agent.lifecycle", tabId: id, workspaceId: WORKSPACE_ID, sessionId: id, eventType: "Idle" })

    await expect(row.locator('[data-slot="session-navigation-title"]')).toHaveText(newTitle, { timeout: 20_000 })

    // …and the row does NOT move. The list orders on when the reader last spoke to a
    // session; a title resolving and a turn settling are the agent's work, and the
    // reported defect is exactly a row moving under the pointer aiming at it.
    // Asserted on the first rendered row so the failure message names whichever row
    // wrongly outranks the neighbour.
    await expect(page.locator('[data-testid="rail-sidebar-session-row"]').first()).toHaveAttribute(
      "data-session-id",
      "ses_claude_neighbour",
      { timeout: 20_000 },
    )

    // And clicking it does not move it either, which is the report in its own words:
    // "as soon as i click second session it moves to first".
    await row.click()
    await expect(page).toHaveURL(new RegExp(id))
    await page.waitForTimeout(2_000)
    await expect(page.locator('[data-testid="rail-sidebar-session-row"]').first()).toHaveAttribute(
      "data-session-id",
      "ses_claude_neighbour",
    )

    // The other half of the requirement — the row DOES move when the reader sends it a
    // message — is not assertable here: this environment never refetches the section after
    // its first fetch, so nothing the fixture reports later reaches the screen. The submit
    // path is the only writer of that stamp and is covered at its own entrypoints in
    // `submit-rail-workspace.test.ts`.
  })

  /**
   * The status dot for a native-SDK chat session, driven by `session.status` /
   * `session.idle` — the only signal that feeds it.
   *
   * `agent.lifecycle` is not the chat row's input: `agent-status-listener.ts` keys it by
   * `terminalId || tabId` into the terminal status map. Asserting the dot off an
   * `agent.lifecycle` frame fails against working software, and the absence of native-SDK
   * sessions from `GET /session/status` is not the mechanism either — the SSE frame
   * dispatches straight into `shellDataKeys.sessionId(id, "status")`.
   *
   * core-sidebar-tree.spec.ts pins the same contract on the default opencode harness; this
   * exists for the `claude-sdk` harness coverage.
   */
  test("a native-SDK session's rail row tracks working -> done as session.status/idle land", async ({ page }) => {
    const targetId = "ses_claude_dot"
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      projectName: "claude-native-sdk",
      harness: "claude-sdk",
      workspaces: {
        [DIR]: { workspaceId: WORKSPACE_ID, kind: "local", directory: DIR, available: true },
      },
    })
    const now = Date.now()
    await installSessionListFixture(page, {
      dir: DIR,
      projectId: PROJECT_ID,
      sessions: [{ sessionId: targetId, title: "Dot probe", createdAt: now, updatedAt: now }],
    })
    await seedProjectAtHome(page, DIR)
    await openTreeAtDirectory(page, DIR)

    const row = sessionRow(page, targetId)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row.locator("[data-sidebar-status]")).toHaveCount(0)

    // Same transport contract as core-sidebar-tree; the harness difference is the mock
    // install above, not a different wire shape for status.
    mock.setSessionStatus(targetId, { type: "busy" })
    mock.emit({ type: "session.status", properties: { sessionID: targetId, status: { type: "busy" } } })
    await expect(row.locator('[data-sidebar-status="working"]')).toHaveCount(1, { timeout: 20_000 })

    await expect(row.locator('[data-slot="navigation-row-glyph"] [data-sidebar-status="working"]')).toHaveCount(1)
    await expect(row.locator('[data-slot="session-navigation-time"]')).toHaveText(/\S/)
    const dotX = await row.locator("[data-sidebar-status]").evaluate((el) => el.getBoundingClientRect().left)
    const titleX = await row
      .locator('[data-slot="session-navigation-title"]')
      .evaluate((el) => el.getBoundingClientRect().left)
    expect(dotX).toBeLessThan(titleX)

    mock.setSessionStatus(targetId)
    mock.emit({ type: "session.idle", properties: { sessionID: targetId } })
    await expect(row.locator('[data-sidebar-status="done"]')).toHaveCount(1, { timeout: 20_000 })
  })
})
