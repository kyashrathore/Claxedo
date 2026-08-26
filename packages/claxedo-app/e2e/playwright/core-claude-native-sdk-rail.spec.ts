/**
 * SPEC: Rail sidebar — the `claude` NATIVE-SDK harness
 *
 * PURPOSE — every existing rail proof is written against either the built-in
 * opencode harness or `codex-acp`. This file pins the three rail behaviours a
 * user actually gets from the NATIVE-SDK (`claude`) harness, which reaches the
 * renderer over a DIFFERENT set of wire events. Each scenario below was first
 * captured from a real, running `claxedo-server` on 2026-08-06 by tapping
 * `GET /api/wr/events?workspaceId=…` with curl while driving a real session —
 * the payloads here are those captured frames verbatim, not invented shapes.
 *
 * WHY THE EXISTING PROOFS DON'T COVER THIS
 *   `core-terminal.spec.ts`'s status-dot scenarios (behaviors 8/9) deliver
 *   `agent.lifecycle` with `emitClaxedoEvent()`, i.e. the DEV-only direct
 *   `window.__claxedoEmitTestEvent` seam, which hands the event straight to the
 *   bus and bypasses the SSE fetch, the stream-target selection and the frame
 *   parser entirely. Those scenarios therefore stay green even when NOTHING is
 *   delivered to a real user — which is exactly the state the app shipped in.
 *   Everything here goes through `mock.emitFlat()`, which is served only to a
 *   workspace-scoped `**\/api\/wr\/events**` request. The first scenario boots
 *   at `/` and enters the project client-side, so it fails if the app remains
 *   subscribed to the central stream alone.
 *
 * WIRE FACTS captured from the real server (see each scenario for the frame)
 *   1. Session creation publishes `session.lifecycle` `creating` then `created`,
 *      the latter carrying `info.title` = the PLACEHOLDER `"New Session"`.
 *   2. The server later replaces that placeholder with a title derived from the
 *      first prompt (`fallbackSessionTitle`, session-title.ts:12 — a greeting
 *      maps to "Greeting", a leading "please/can you/..." is stripped, and
 *      anything over 72 chars is truncated; it is NOT an LLM summary), and
 *      publishes `session.updated` for the change (`runtime.ts:282-288`,
 *      `method:"auto-title"`). That frame used to be dropped by
 *      `bridgeLifecycleEvent` (workspace-runtime `routes/session.ts`) and now
 *      is forwarded verbatim — see the A2 scenario for the before/after
 *      measurements.
 *   3. A native-SDK CHAT turn publishes `agent.lifecycle` Busy/Idle with
 *      `tabId` set to the SESSION id and NO `terminalId` field at all.
 *   4. `GET /session/status` never lists a native-SDK session, not even while
 *      that session is demonstrably mid-turn (measured: absent across a 30s
 *      poll at 1s cadence while the agent was streaming a reply).
 *
 * Facts 3 and 4 are both true and neither is a defect — recorded here because
 * together they look exactly like a broken status dot and are not. The chat
 * row's dot is driven by `session.status`/`session.idle` SSE dispatched into
 * `shellDataKeys.sessionId(id,"status")`; `agent.lifecycle` feeds the TERMINAL
 * map, and the REST status map is not the dot's source. Verified live: a
 * BACKGROUND native-SDK session held `data-sidebar-status="working"` across 14
 * consecutive 1s samples for its whole turn. A terminal running Claude Code
 * delivers too — its rail row retitles itself to "Claude: <last reply>", which
 * only `agentLifecycleTitle` does, and only from a delivered `agent.lifecycle`.
 */

import { sessionListRoute } from "../helpers/contracts/session-list"
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"

const DIR = "/tmp/e2e-claude-native-sdk-rail"
const PROJECT_ID = "proj_claude_native_sdk"
const SESSION_ID = "ses_claude_native_sdk_mock"
const WORKSPACE_ID = "ws_claude_native_sdk"

type FixtureSession = { sessionId: string; title: string; createdAt: number; updatedAt: number }

/**
 * Minimal stand-in for the paginated `session-list` the rail rows render from.
 * Deliberately a local copy rather than an import: `installSessionTreeFixtures`
 * in core-sidebar-tree.spec.ts is file-private, and duplicating ~30 lines is
 * cheaper than widening that file's surface for one neighbour.
 *
 * `setSessions` models the SERVER's view of the world, so a scenario can move
 * the server's title (which really does change) independently of whatever the
 * client has cached — that gap IS the bug in scenario 2.
 */
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
    tags: [],
    attachments: [],
  })

  await page.route(sessionListRoute, async (route) => {
    const url = new URL(route.request().url())
    const limit = Number(url.searchParams.get("limit") ?? "5") || 5
    const items = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        view: { scope: url.searchParams.get("scope") ?? "workspace", groupBy: "none", sort: "updated_desc", limit },
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
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
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
 * `.first()` is load-bearing, not laziness. A session announced by a
 * `session.lifecycle` frame that carries `info.workspaceID` (which the real
 * native-SDK frame does) renders TWICE — once from the project section with
 * `data-session-ref="<id>"`, once from a workspace section with
 * `data-session-ref="workspace:<wsId>:session:<id>"` — because the
 * control-plane list row and the event-derived row resolve to different
 * sections. That duplication is a real, separate defect (filed separately);
 * pinning it here would conflate it with the title/dot behaviours these
 * scenarios exist to prove, and either row rendering the dot/title correctly
 * is the outcome a user needs.
 */
const sessionRow = (page: Page, id: string) =>
  page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${id}"]`).first()

test.describe("rail — claude native-SDK harness @core", () => {
  /**
   * CONTROL, expected GREEN. Proves the create half of the pipeline still works
   * for the native-SDK harness AND that this file's fixtures/transport are
   * wired correctly — without it, a red result below could just mean the
   * harness never booted, which would make the two red proofs worthless.
   *
   * Frame captured verbatim from the real server (curl tap, 2026-08-06); note
   * `info.title` is the placeholder the server really sends at this point.
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

    mock.emitFlat({
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
   * BUG A2 (FIXED) — the auto-title reaching the rail without a reload.
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
   *
   * After the fix, verified live in the running app with no reload:
   *   t+46.3s  row appears as "Untitled session" at index 0
   *   t+52.4s  row reads "Say LIVEFIX and nothing else."
   *
   * Reproduced live on 2026-08-06: `GET /session/:id` reported
   * `"title":"Reply with exactly the word SIDEBARPROBE and nothing else."`
   * while the rail row still read "Untitled session", and a page reload was
   * the only thing that ever fixed it.
   *
   * The scenario gives the app EVERY signal the real server actually emits for
   * a completed turn — Busy, then Idle — with the server-side title already
   * moved underneath. It deliberately does NOT emit a title-carrying event,
   * because no such event exists on the wire; inventing one here would test a
   * fix rather than the behaviour. The assertion is the user-visible outcome
   * (row shows the real title), which leaves the fix free to be either a new
   * event or a refetch on turn-settle.
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
    const fixtures = await installSessionListFixture(page, { dir: DIR, projectId: PROJECT_ID, sessions: [] })
    await seedProjectAtHome(page, DIR)
    await openTreeFromHome(page)

    const id = "ses_claude_title"
    const now = Date.now()
    // A NEWER neighbour, so the session under test does not start at the top.
    // The reconcile must therefore re-ORDER the list, not merely rewrite the
    // row's text — the two failures shipped together and a test that seeds a
    // single row can only ever catch the text half.
    fixtures.setSessions([
      { sessionId: "ses_claude_neighbour", title: "Neighbour", createdAt: now, updatedAt: now + 60_000 },
      { sessionId: id, title: "New Session", createdAt: now, updatedAt: now },
    ])
    mock.emitFlat({
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

    // QUIESCE before moving the server's title. Without this the scenario
    // passes for the WRONG reason: `session.lifecycle created` invalidates the
    // session-list, and that refetch is still in flight when the assertion
    // above resolves — so a title changed immediately after would be picked up
    // by the create-invalidation's own refetch rather than by anything
    // reacting to the turn. Measured: the test went green with this wait
    // absent and red with it present, against unchanged app code.
    await page.waitForTimeout(3_000)

    mock.emitFlat({ type: "agent.lifecycle", tabId: id, workspaceId: WORKSPACE_ID, sessionId: id, eventType: "Busy" })

    // NOTE the fixture is deliberately NOT updated: `/api/control/session-list`
    // keeps serving the "New Session" placeholder for the rest of the scenario.
    //
    // That inversion is what makes this test BITE. The obvious version — move
    // the fixture's title and emit the event — passes even with the event
    // mutated to a bogus type, because the mocked environment refetches the
    // session-list on its own (verified by mutation: renaming the frame to
    // `session.updated.MUTANT` still passed in 11s). Holding the fixture at the
    // old title means a refetch actively RE-ASSERTS the placeholder, so the new
    // title can only come from the event's own reconciliation
    // (`reconcileUpdatedSessionListQueryData`). Mutate the frame and this goes
    // red — which is the property a regression guard has to have.
    const newTitle = "Say TITLEPROBE and nothing else."

    // The frame that announces it, copied verbatim off `/api/wr/events` after
    // the bridge fix (`workspace-runtime/src/routes/session.ts`,
    // `bridgeLifecycleEvent`). Before that fix this frame did not exist on the
    // wire at all and the rail kept the placeholder until an unrelated refetch
    // happened to land — so emitting it here IS the regression guard: delete
    // the bridge and this scenario goes red.
    mock.emitFlat({
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
          // Newer than the neighbour, so `updated_desc` must put this row first.
          time: { created: now, updated: now + 120_000 },
        },
      },
    })

    mock.emitFlat({ type: "agent.lifecycle", tabId: id, workspaceId: WORKSPACE_ID, sessionId: id, eventType: "Idle" })

    await expect(row.locator('[data-slot="session-navigation-title"]')).toHaveText(newTitle, { timeout: 20_000 })

    // …and the row must MOVE. `reconcileUpdatedSessionListRows` used to rewrite
    // `updatedAt` in place with no re-sort, so an auto-titled session kept its
    // original index while claiming a brand-new timestamp — seen live as a
    // 30-second-old "Greeting" sitting at position 6 under rows 12-29 minutes
    // older. Asserted on the FIRST rendered row rather than on a nth-match, so
    // the failure message names whichever row wrongly outranks it.
    await expect(page.locator('[data-testid="rail-sidebar-session-row"]').first()).toHaveAttribute(
      "data-session-id",
      id,
      { timeout: 20_000 },
    )
  })

  /**
   * The status dot for a native-SDK chat session, driven by the signal that
   * actually drives it: `session.status` / `session.idle`.
   *
   * CORRECTION worth keeping, because it cost real time: an earlier version of
   * this scenario emitted `agent.lifecycle` and asserted the dot, on the theory
   * that the dot was broken for this harness. It is not. `agent.lifecycle` is
   * simply not the chat row's input — it feeds the TERMINAL status map
   * (`agent-status-listener.ts:164`, `terminalId || tabId`) — so that test was
   * red against working software. Two observations that looked like evidence
   * were both dead ends: injecting `agent.lifecycle` on the bus produced no dot
   * (correct, wrong signal), and `GET /session/status` never lists a native-SDK
   * session (also true, and also not the mechanism — the SSE frame dispatches
   * straight into `shellDataKeys.sessionId(id,"status")`).
   *
   * Verified live afterwards: a BACKGROUND native-SDK session held
   * `data-sidebar-status="working"` across 14 consecutive 1s samples for the
   * whole of its turn, then settled.
   *
   * The value this keeps over behaviour 4 in core-sidebar-tree.spec.ts is
   * harness coverage: that one runs the default opencode harness and this one
   * pins the same contract for `claude-sdk`.
   */
  test("a native-SDK session's rail row tracks working -> done as session.status/idle land", async ({ page }) => {
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

    const id = "ses_claude_dot"
    const now = Date.now()
    fixtures.setSessions([{ sessionId: id, title: "Dot probe", createdAt: now, updatedAt: now }])
    mock.emitFlat({
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
        title: "Dot probe",
        version: "local",
        time: { created: now, updated: now },
      },
      ts: now,
    })

    const row = sessionRow(page, id)
    await expect(row).toBeVisible({ timeout: 15_000 })
    // Idle rows render a relative-time label and no dot at all.
    await expect(row.locator("[data-sidebar-status]")).toHaveCount(0)

    // `busy` is the only status the dot's "working" branch reads besides
    // `retry` (`sessionSurfaceStatus`, surface-status.ts:28). The mock's live
    // status map is moved in step with each frame so the SSE dispatch and the
    // sidebar's batched `client.session.status()` reconciliation cannot
    // disagree — the same discipline behaviour 4 documents.
    mock.setSessionStatus(id, { type: "busy" })
    mock.emit({ type: "session.status", properties: { sessionID: id, status: { type: "busy" } } })
    await expect(row.locator('[data-sidebar-status="working"]')).toHaveCount(1, { timeout: 20_000 })

    // The dot lives in the LEFT indent gutter, not on the right in place of the
    // timestamp. Both halves are asserted because the old layout satisfied the
    // first check above just as well: what changed is WHERE it renders and that
    // the timestamp is no longer sacrificed to show it.
    await expect(row.locator('[data-slot="navigation-row-glyph"] [data-sidebar-status="working"]')).toHaveCount(1)
    await expect(row.locator('[data-slot="session-navigation-time"]')).toHaveText(/\S/)
    const dotX = await row.locator("[data-sidebar-status]").evaluate((el) => el.getBoundingClientRect().left)
    const titleX = await row
      .locator('[data-slot="session-navigation-title"]')
      .evaluate((el) => el.getBoundingClientRect().left)
    expect(dotX).toBeLessThan(titleX)

    // Settling clears the session from the live map: the real route reports
    // idle by OMITTING the key, never by sending `{type:"idle"}`.
    mock.setSessionStatus(id)
    mock.emit({ type: "session.idle", properties: { sessionID: id } })
    // Never focused in this spec, so a settled turn is "done" (unseen), not idle.
    await expect(row.locator('[data-sidebar-status="done"]')).toHaveCount(1, { timeout: 20_000 })
  })
})
