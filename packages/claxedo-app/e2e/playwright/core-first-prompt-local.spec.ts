/**
 * SPEC: First prompt in a new local session
 *
 * PURPOSE — the entry point to the whole product: a user opens a local worktree,
 * types a first message, and gets a visible reply. Every other core-loop spec builds
 * on this working. This spec owns only the FIRST turn of a brand-new local session;
 * multi-turn/reload/history live in `core-turns-reload-recovery`.
 *
 * STATE MODEL — a session starts as a "draft" (no server session yet, `sessionID`
 * conceptually "new", tracked by a `draftId` and keyed by `directory` in the composer's
 * local draft store). On submit: (1) the client optimistically renders the user turn
 * immediately (`addRegisteredConversationMessage`, in `src/components/prompt-input/
 * submit.ts`) before any network round-trip settles; (2) `POST /session` creates the
 * server session (if one does not already exist for this draft); (3) `POST
 * /session/:id/prompt_async` dispatches the turn and returns `204` immediately — it does
 * NOT wait for the assistant reply; (4) the reply arrives asynchronously over
 * `/global/event` SSE as separate events (`session.status busy` → `message.updated`
 * (pending) → `message.part.delta`* → `message.updated` (completed) →
 * `session.idle`); (5) the URL navigates from the draft route to the created session's
 * route once the session exists. Directory attachment lives in the URL's `:dir` segment
 * (base64url-encoded worktree path) plus a `opencode.global.dat:server` localStorage
 * entry that lists known projects; neither the draft text nor the reply depend on
 * anything else surviving reload for THIS spec (reload persistence is
 * `core-turns-reload-recovery`'s territory).
 *
 * ANATOMY —
 *   `[data-claxedo]` — shell root, presence == app painted.
 *   `[role="textbox"][aria-label*="Ask anything"]` — the composer editor.
 *   `[data-action="prompt-submit"]` — send/stop button; `data-icon="stop"` while busy.
 *   `[data-slot="session-turn-message-content"]` — a user turn's rendered content.
 *   `[data-slot="session-turn-assistant-content"]` — an assistant turn's rendered
 *     content; `aria-hidden="true"` while the turn is not yet settled (see
 *     `e2e/INVARIANTS.md` invariant #2).
 *   `[data-slot="session-turn-thinking"]` — the busy/"Thinking" placeholder row.
 *   `[data-testid="empty-draft-session-composer"]` — the workbench-empty draft
 *     composer, rendered only when a fallback directory exists
 *     (`src/app/workbench/rail/rail-workbench-canvas.tsx`); its absence is the
 *     zero-workspace state. That state has TWO settled surfaces: the "No projects
 *     yet. Create one to get started." onboarding placeholder on routes that own no
 *     workbench content (e.g. `/`), and `[data-testid="central-session-content"]`
 *     ("No workspace backing", `src/features/session/ui/content/session-content.tsx`)
 *     on routes that DO own one (e.g. `/s/new`, whose unresolvable session id the
 *     route intent settles into a central session content). Neither offers a composer.
 *
 * BEHAVIORS —
 *   1. Opening a fresh local worktree route renders a draft composer the user can type
 *      into (`[data-claxedo]` visible, textbox reachable and editable).
 *   2. Sending the first message in a new session renders the full session UI: the URL
 *      moves onto the created session's route, and the oracle proves the assistant reply
 *      is visibly rendered (DOM + geometric + evidence — see `e2e/INVARIANTS.md`).
 *   3. After the turn settles, the timeline holds exactly one user row and exactly one
 *      assistant row (no duplication from the optimistic-add / server-reconcile merge).
 *   4. The optimistic user row appears in the DOM before the server round-trip
 *      (`POST /session` + `POST /session/:id/prompt_async`) settles — i.e., typing and
 *      submitting renders the user's own text without waiting on the network.
 *   5. With zero projects ever registered (no directory resolvable anywhere, not even
 *      as a fallback), no route offers a composer and zero sessions are created:
 *      submission is impossible, not merely rejected. A route that owns no workbench
 *      content (`/`) settles on the "No projects yet" onboarding placeholder; the
 *      directory-less draft route (`/s/new`) settles on the central "No workspace
 *      backing" surface. Each surface is asserted on the route where it is the
 *      SETTLED render — the placeholder is only transiently reachable on `/s/new`
 *      (it survives just until the session inventory loads), so asserting it there
 *      passes only on a slow runner. (The code-level reactive guard is
 *      `resolveSubmitDirectory`'s `showMissingWorkspace()` toast in
 *      `src/session/submit/resolve.ts`, gated on `draftId && !projectDirectory`; every
 *      composer surface this app can currently render — including the
 *      workbench-empty `EmptyDraftSessionComposer` — always carries at least a
 *      fallback directory, so that reactive toast is not independently e2e-reachable
 *      today. This test pins the stronger, observable contract the guard exists to
 *      protect: zero workspace ⇒ zero compose surface ⇒ zero session creation. See
 *      inline comment on the test for the full trace.)
 *   6. The draft exposes repository branches, and selecting one creates the first
 *      session in a new worktree based on that exact ref.
 *
 * INVARIANTS — completed assistant content is never hidden by stale busy state (#2 in
 *   e2e/INVARIANTS.md); harness ownership (#1) — this spec locks in the `opencode`
 *   harness path only, the full harness matrix is `core-harness-ownership-local`.
 *
 * HARNESS NOTES — none; this spec fixes harness to `opencode` (the default, no
 *   config-options harness) to keep the first-turn contract isolated from harness
 *   selection concerns, which `core-harness-ownership-local` owns.
 *
 * OUT OF SCOPE — 2nd/3rd sends, reload recovery, prompt history, edit-sent-message,
 *   dispatch-failure retry, scroll-to-top load-older (`core-turns-reload-recovery`);
 *   harness switching (`core-harness-ownership-local`); model/effort/agent controls
 *   (`core-model-effort-agent-controls`); busy/abort/error escalation
 *   (`core-busy-abort-errors`).
 */
import { sessionListRoute } from "../helpers/contracts/session-list"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, expectTurnCounts, expectNoDuplicateRows, SELECTORS } from "../helpers/turn-oracle"

type TitleContinuityProbe = {
  expectedTitle: string
  first?: Element
  seenExpected: boolean
  seenSidebar: boolean
  seenSwitcher: boolean
  violations: string[]
  sample: () => void
  observer?: MutationObserver
  timer?: number
}

type TitleContinuityWindow = typeof window & { __titleContinuityProbe?: TitleContinuityProbe }

const DIR = "/tmp/e2e-core-first-prompt-local"
const SESSION_ID = "ses_core_first_prompt_local"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
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

async function seedNoProjects(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear()
  })
}

async function installPlaceholderSessionList(page: Page) {
  await page.route(sessionListRoute, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      view: { scope: "global", groupBy: "none", sort: "updated_desc", limit: 50 },
      items: [{
        type: "session",
        sessionRef: SESSION_ID,
        sessionId: SESSION_ID,
        title: "Untitled session",
        directory: DIR,
        createdAt: 10,
        updatedAt: 10,
        tags: [],
        attachments: [],
      }],
      totalKnown: 1,
    }),
  }))
}

async function openDraftPrompt(page: Page, dir: string): Promise<Locator> {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

async function startTitleContinuityProbe(page: Page, sessionId: string, expectedTitle: string) {
  await page.evaluate(({ id, expected }) => {
    const target = window as TitleContinuityWindow
    const probe: TitleContinuityProbe = {
      expectedTitle: expected,
      seenExpected: false,
      seenSidebar: false,
      seenSwitcher: false,
      violations: [],
      sample: () => undefined,
    }
    const record = (violation: string) => {
      if (!probe.violations.includes(violation)) probe.violations.push(violation)
    }
    probe.sample = () => {
      const current = document.querySelector("[data-session-title]")
      if (!probe.first && current) probe.first = current
      if (probe.first) {
        if (!current || !probe.first.isConnected) record("header detached")
        if (current && current !== probe.first) record("header replaced")
      }
      const sidebar = document.querySelector(
        `[data-testid="rail-sidebar-session-row"][data-session-id="${id}"] [data-slot="session-navigation-title"]`,
      )
      const switcher = document.querySelector('[data-testid="compact-switcher"] [data-testid="switcher-title"]')
      const titles = [
        current?.querySelector('[data-slot="session-title-child"]'),
        sidebar,
        switcher,
      ].flatMap((element) => element ? [element.textContent?.trim() ?? ""] : [])
      if (!probe.seenExpected && titles.includes(probe.expectedTitle)) probe.seenExpected = true
      if (!probe.seenExpected) return
      if (sidebar) probe.seenSidebar = true
      if (switcher) probe.seenSwitcher = true
      titles.forEach((title) => {
        if (!title) record("a session title became empty")
        if (/^(new|untitled) session$/i.test(title)) record(`a session title regressed to ${title}`)
      })
      if (new Set(titles).size > 1) {
        record(`session title surfaces diverged: ${titles.join(" | ")}`)
      }
    }
    probe.observer = new MutationObserver(probe.sample)
    probe.observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    probe.timer = window.setInterval(probe.sample, 16)
    target.__titleContinuityProbe = probe
    probe.sample()
  }, { id: sessionId, expected: expectedTitle })
}

async function finishTitleContinuityProbe(page: Page) {
  return page.evaluate(() => {
    const target = window as TitleContinuityWindow
    const probe = target.__titleContinuityProbe
    probe?.sample()
    probe?.observer?.disconnect()
    if (probe?.timer !== undefined) clearInterval(probe.timer)
    return {
      seen: !!probe?.first,
      seenExpected: !!probe?.seenExpected,
      seenSidebar: !!probe?.seenSidebar,
      seenSwitcher: !!probe?.seenSwitcher,
      connected: !!probe?.first?.isConnected,
      title: probe?.first?.querySelector('[data-slot="session-title-child"]')?.textContent?.trim() ?? "",
      violations: probe?.violations ?? ["probe missing"],
    }
  })
}

test.describe("core first prompt (local) @core", () => {
  test("draft composer is reachable and editable before any send — behavior 1", async ({ page }) => {
    await seedOneProject(page, DIR)
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })

    const input = await openDraftPrompt(page, DIR)
    await input.click()
    await input.fill("hello, world")
    await expect(input).toContainText("hello, world", { timeout: 10_000 })

    // No send happened yet: zero session/prompt requests, no assistant row.
    await expect(page.locator(SELECTORS.userMessageContent)).toHaveCount(0)
    await expect(page.locator(SELECTORS.assistantContent)).toHaveCount(0)
  })

  test("first send renders the full session UI and the oracle proves the reply — behaviors 2,3,4", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] },
    })
    await installPlaceholderSessionList(page)

    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "core first prompt local turn one"
    await input.click()
    await input.fill(promptText)
    await expect(input).toContainText(promptText, { timeout: 10_000 })

    await startTitleContinuityProbe(page, SESSION_ID, promptText)
    await page.locator(SELECTORS.submitControl).last().click()

    // Behavior 4: the optimistic user row renders before the server round-trip
    // settles. Assert it appears while the create/prompt requests are still the
    // ones we just fired (bounded count), without waiting on a network event —
    // a real network race, not a fixed sleep (INVARIANTS.md authoring rule #3).
    await expect(
      page.locator(SELECTORS.userMessageContent).getByText(promptText, { exact: true }),
    ).toBeVisible({ timeout: 5_000 })

    // Behavior 2: URL moves onto the created session's route.
    await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID), { timeout: 20_000 })
    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)

    // Behavior 2 (oracle): the assistant reply is visibly rendered — DOM +
    // geometric + evidence screenshot, all three layers.
    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)

    // Behavior 3: exactly one user row + one assistant row, no duplication.
    await expectTurnCounts(page, { user: 1, assistant: 1 })
    await expectNoDuplicateRows(page)

    await Promise.all([
      page.locator('[data-session-title] [data-slot="session-title-child"]'),
      page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${SESSION_ID}"] [data-slot="session-navigation-title"]`),
    ].map((title) => expect(title).toHaveText(promptText, { timeout: 10_000 })))

    const sidebarToggle = page.locator('[data-testid="sidebar-toggle"]')
    await expect(sidebarToggle).toBeVisible({ timeout: 10_000 })
    await sidebarToggle.click()
    const switcher = page.locator('[data-testid="compact-switcher"]')
    await expect(switcher).toBeVisible({ timeout: 10_000 })
    await expect(switcher.locator('[data-testid="switcher-title"]')).toHaveText(promptText, { timeout: 10_000 })

    const titleContinuity = await finishTitleContinuityProbe(page)
    expect(titleContinuity).toMatchObject({
      seen: true,
      seenExpected: true,
      seenSidebar: true,
      seenSwitcher: true,
      connected: true,
      violations: [],
    })
    expect(titleContinuity.title).not.toBe("")

    expect(mock.requests.createSessionCount).toBe(1)
    expect(mock.requests.promptBodies[0]?.text).toBe(promptText)
  })

  test("selecting a base branch provisions the first session from that exact ref — behavior 6", async ({ page }) => {
    const branches = ["main", "release/next"]
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      branches,
      currentBranch: "main",
      harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] },
    })
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const branch = page.locator('[data-slot="context-chip-branch"]').filter({ visible: true })
    await expect(branch).toHaveCount(1, { timeout: 20_000 })
    await expect(branch.locator('[data-slot="context-chip-label"]')).toHaveText("main")
    await branch.click()

    const picker = page.locator('[data-context-chip-picker="context-chip-branch"]')
    const rows = picker.locator('[data-slot="list-item"]')
    await expect(rows).toHaveCount(2, { timeout: 20_000 })
    await expect(rows).toHaveText(branches)
    await rows.filter({ hasText: "release/next" }).click()
    await expect(branch.locator('[data-slot="context-chip-label"]')).toHaveText("release/next")

    const workspace = page.locator('[data-slot="context-chip-worktree"]').filter({ visible: true })
    await expect(workspace.locator('[data-slot="context-chip-label"]')).toHaveText("New local worktree")

    const promptText = "start this task from release next"
    await input.fill(promptText)
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.worktreeCreateBodies, { timeout: 15_000 }).toEqual([{
      directory: DIR,
      baseRef: "release/next",
    }])
    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
  })

  test("a directory-less draft offers no compose surface and creates zero sessions — behavior 5", async ({ page }) => {
    // No project ever registered (seedNoProjects clears localStorage entirely) and
    // the mock's bootstrap/project endpoints are overridden below to report zero
    // projects. This is the one app state where NO fallback directory exists at
    // all (`emptyDraftDirectory()` in `src/app/workbench/rail/rail-workbench-
    // canvas.tsx` is undefined), so no surface can render `EmptyDraftSessionComposer`
    // — no composer is offered, so `resolveSubmitDirectory`'s
    // `draftId && !projectDirectory` guard (`src/session/submit/resolve.ts`) can
    // never even be reached: this spec proves the STRONGER, observable contract
    // (zero compose surface, zero session creation) that guard exists to protect.
    // Every OTHER draft surface in this app (including `EmptyDraftSessionComposer`
    // itself) always carries at least a fallback directory, which is why that
    // reactive toast is not independently e2e-reachable — see SPEC BEHAVIORS #5.
    //
    // The zero-workspace state has TWO settled surfaces depending on whether the
    // route owns a workbench content, and each is asserted where it is stable —
    // see the inline (a)/(b) notes below. Asserting the (a) surface on the (b)
    // route is exactly the race this test used to lose.
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await page.route("**/api/claxedo/bootstrap**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          healthy: true,
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: "", directory: "", home: "/tmp" },
          project: [],
          provider: { all: [], default: {}, connected: [] },
          provider_auth: {},
          config: {},
        }),
      }),
    )
    await page.route("**/project**", (route) => {
      const type = route.request().resourceType()
      if (type !== "fetch" && type !== "xhr") return route.continue()
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    })

    await seedNoProjects(page)

    // (a) Shell root — the workbench-empty path. No route surface is owned here
    // (`routeOwnsInitialSurface("/")` is false in `src/app/workbench/state/
    // provider.tsx`, and `receive()` in `route-intent.ts` returns immediately when
    // the intent carries neither a workspaceId nor a sessionId), so the workbench
    // never gains a content and `renderEmpty` is the SETTLED render — the "No
    // projects yet" onboarding placeholder, permanently, not for one frame.
    await page.goto("/")
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("No projects yet. Create one to get started.")).toBeVisible({ timeout: 20_000 })
    // Positive precondition for the two negative assertions below: the onboarding
    // placeholder's own New Project affordance is painted, so "no composer" is a
    // statement about a rendered surface rather than about an unpainted app.
    await expect(page.getByRole("button", { name: "New Project" }).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("empty-draft-session-composer")).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)

    // (b) The directory-less draft route itself, `/s/new`.
    //
    // With ZERO projects registered this route settles on `central-session-content` —
    // `SessionContent`'s "No workspace backing" branch
    // (`src/features/session/ui/content/session-content.tsx:81-88`, reached when
    // `fallbackDirectory()` is absent because the only candidate is the `/workspace`
    // placeholder, which that memo rejects at :62-64). Route intent resolves `"new"`
    // far enough to own a surface, but nothing backs it with a real directory, so the
    // pane is a dead end rather than a composer. This is what SPEC BEHAVIORS #5 above
    // has said all along — "the directory-less draft route (`/s/new`) settles on the
    // central 'No workspace backing' surface … the placeholder is only transiently
    // reachable on `/s/new` (it survives just until the session inventory loads)". The
    // spec block was right and the assertion had drifted away from it; see below for
    // why the drift stayed green.
    //
    // This assertion has now moved THREE times; do not "fix" it by guessing — verify
    // against a real run, as this revision did. The first two moves are recorded
    // below; the third (this one) has a specific, non-obvious cause worth stating,
    // because it means the earlier "settles back on the placeholder" observation was
    // an artifact of a broken mock rather than a change in the app:
    //
    //   `installMockRuntime` did not mock `GET /api/control/sessions`, and the app
    //   addresses it on the CENTRAL origin (`VITE_CLAXEDO_SERVER_URL`,
    //   http://127.0.0.1:3001) where NOTHING is listening under this harness. So the
    //   fetch in `fetchLocalControlSessions`
    //   (`src/features/session/data/sync/inventory-source.ts:449-457`) did not return
    //   an empty inventory — it REJECTED with a connection error, and that rejection
    //   aborted the inventory bootstrap before route intent could resolve `"new"`.
    //   The workbench then never gained a content and `renderEmpty` won. The shared
    //   mock now serves that endpoint the way the real server does
    //   (`{ sessions: [] }`, claxedo-server/src/deployments/hosted-shared/hosted-app.ts:486-503), so the
    //   bootstrap completes and the app reaches its genuine settled surface for this
    //   state. Found by `requests.unhandled`, which had never recorded anything until
    //   it was made real.
    //
    // What is INVARIANT across all three revisions, and is the actual contract
    // behavior 5 exists to pin, is the bottom half: zero compose surface, and zero
    // sessions created. Assert the settled surface positively first so the negatives
    // below cannot pass vacuously.
    await page.goto("/s/new")
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByTestId("central-session-content"),
      "directory-less route never settled on a zero-workspace surface",
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("No workspace backing")).toBeVisible()
    await expect(page.getByRole("button", { name: "New Project" }).first()).toBeVisible()
    await expect(page.getByTestId("empty-draft-session-composer")).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)
    await expect(page.locator(SELECTORS.submitControl)).toHaveCount(0)

    expect(mock.requests.createSessionCount).toBe(0)
    expect(mock.requests.promptCount).toBe(0)
  })
})
