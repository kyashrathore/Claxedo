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
 *     (`src/claxedo-ui/layouts/rail-workbench-canvas.tsx`); its absence, together with
 *     the "No projects yet. Create one to get started." copy, is the zero-workspace
 *     onboarding state.
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
 *      as a fallback), the workbench renders the "No projects yet" onboarding
 *      placeholder instead of any composer, and creates zero sessions: submission is
 *      impossible, not merely rejected. (The code-level reactive guard is
 *      `resolveSubmitDirectory`'s `showMissingWorkspace()` toast in
 *      `src/session/submit/resolve.ts`, gated on `draftId && !projectDirectory`; every
 *      composer surface this app can currently render — including the
 *      workbench-empty `EmptyDraftSessionComposer` — always carries at least a
 *      fallback directory, so that reactive toast is not independently e2e-reachable
 *      today. This test pins the stronger, observable contract the guard exists to
 *      protect: zero workspace ⇒ zero compose surface ⇒ zero session creation. See
 *      inline comment on the test for the full trace.)
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
import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, expectTurnCounts, expectNoDuplicateRows, SELECTORS } from "../helpers/turn-oracle"

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

    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "core first prompt local turn one"
    await input.click()
    await input.fill(promptText)
    await expect(input).toContainText(promptText, { timeout: 10_000 })

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

    expect(mock.requests.createSessionCount).toBe(1)
    expect(mock.requests.promptBodies[0]?.text).toBe(promptText)
  })

  test("a directory-less draft offers no compose surface and creates zero sessions — behavior 5", async ({ page }) => {
    // No project ever registered (seedNoProjects clears localStorage entirely) and
    // the mock's bootstrap/project endpoints are overridden below to report zero
    // projects. This is the one app state where NO fallback directory exists at
    // all (`emptyDraftDirectory()` in `src/claxedo-ui/layouts/rail-workbench-
    // canvas.tsx` is undefined), so the workbench renders its "No projects yet"
    // onboarding placeholder instead of `EmptyDraftSessionComposer` — no composer
    // is offered, so `resolveSubmitDirectory`'s `draftId && !projectDirectory`
    // guard (`src/session/submit/resolve.ts`) can never even be reached: this
    // spec proves the STRONGER, observable contract (zero compose surface, zero
    // session creation) that guard exists to protect. Every OTHER draft surface
    // in this app (including `EmptyDraftSessionComposer` itself) always carries
    // at least a fallback directory, which is why that reactive toast is not
    // independently e2e-reachable — see SPEC BEHAVIORS #5.
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
    await page.goto("/s/new")
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    await expect(page.getByText("No projects yet. Create one to get started.")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("empty-draft-session-composer")).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)

    expect(mock.requests.createSessionCount).toBe(0)
    expect(mock.requests.promptCount).toBe(0)
  })
})
