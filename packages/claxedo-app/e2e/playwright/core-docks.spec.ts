/**
 * SPEC: Session composer docks — permission, question, todo
 *
 * PURPOSE — three surfaces that interrupt/augment the composer while an agent turn is
 * running: (1) the PERMISSION dock, which blocks sending until the user allows or denies
 * a tool the agent wants to run; (2) the QUESTION dock, a multi-step wizard the agent uses
 * to ask the user structured questions before continuing; (3) the TODO dock, a
 * non-blocking progress tray that mirrors the agent's own todo list while it works. All
 * three are rendered by `SessionComposerRegion`
 * (`src/pages/session/composer/session-composer-region.tsx`) and owned by
 * `createSessionComposerState` (`src/pages/session/composer/session-composer-state.ts`).
 *
 * STATE MODEL —
 *   Permission/question requests live in a TanStack Query cache entry keyed
 *   `shellDataKeys.sessionId(sessionID, "requests")` (`{ permissions: PermissionRequest[],
 *   questions: QuestionRequest[] }`), written ONLY by `dispatchSessionRequestsEvent`
 *   (`src/session/store/session-status-dispatcher.ts`). The query itself is `enabled:
 *   false` (`session-composer-state.ts`'s `requestQueries`) — it never fetches on its own;
 *   it exists purely as a cache cell that server-sourced SSE events
 *   (`permission.asked`/`permission.replied`/`question.asked`/`question.replied`/
 *   `question.rejected`, routed through `src/shell/data/directory-event-projector.ts`)
 *   write into via `upsertById`/`removeById`. `permissionRequest()`/`questionRequest()`
 *   (memos in `session-composer-state.ts`) walk the current session's lineage
 *   (`sessionPermissionRequest`/`sessionQuestionRequest` in `./session-request-tree.ts`) to
 *   find the first pending item — including from a CHILD session (bubbling to the
 *   parent's dock is spec 9's territory, not tested here).
 *
 *   `blocked()` = `!!permissionRequest() || !!questionRequest()` for the active session.
 *   `showComposer()` = `!blocked() || child()`. When blocked and not a child session, the
 *   ENTIRE `<Show when={showComposer()}>` subtree — including `PromptInput` itself, not
 *   just a disabled affordance — is removed from the DOM (`session-composer-region.tsx`
 *   lines ~219-348). The permission/question docks are rendered OUTSIDE that gate
 *   (lines ~196-217), so a blocking request replaces the composer surface entirely rather
 *   than merely disabling it.
 *
 *   Deciding a PERMISSION (`decide()` in `session-composer-state.ts`) calls
 *   `usePermission().respond({sessionID, permissionID, response, directory})`, which POSTs
 *   the DEPRECATED `POST /session/{sessionID}/permissions/{permissionID}` endpoint (body
 *   `{response: "once"|"always"|"reject"}`) — NOT the newer `/permission/{id}/reply`. This
 *   call does not locally clear the request from cache; the dock only disappears once a
 *   server-sourced `permission.replied` SSE event removes it
 *   (`directory-event-projector.ts`'s `case "permission.replied"`). `response: "always"`
 *   additionally persists a per-session (and, via a directory-wide toggle elsewhere,
 *   per-directory) auto-accept flag to localStorage
 *   (`Persist.global("permission", ...)`, `src/context/permission.tsx`'s `enable()`).
 *   Every subsequent `permission.asked` SSE event is intercepted by a global listener in
 *   `permission.tsx` and auto-responded (`respondOnce`) BEFORE it can ever reach a render:
 *   `permissionRequest()`'s memo itself filters with `!permission.autoResponds(item,
 *   directory)`, so an auto-respondable permission is invisible even if the cache briefly
 *   contains it.
 *
 *   Deciding a QUESTION (single reply of `answers: QuestionAnswer[]`, one array per
 *   question, or a reject) POSTs `/question/{requestID}/reply` or
 *   `/question/{requestID}/reject`. Unlike permissions, `SessionQuestionDock` clears the
 *   request from the SAME cache cell OPTIMISTICALLY on mutation success
 *   (`clearQuestionRequest()` in `session-question-dock.tsx`) — no server SSE round-trip is
 *   required for the dock to disappear.
 *
 *   In-progress wizard state (current tab, picked answers, custom-answer text/toggle) is
 *   NOT part of that cache cell; it is component-local `solid-js/store` state that is
 *   snapshotted into a SEPARATE, in-memory TanStack Query cache cell
 *   (`sessionQuestionDockQueryKey(requestID)`, `./session-question-cache.ts`) on unmount
 *   (`onCleanup`), UNLESS the wizard was just replied/rejected. It is restored from that
 *   snapshot on the next mount for the same request id. Because
 *   `session-composer-region.tsx` renders the question dock inside `<Show when={...}
 *   keyed>`, ANY identity change of the `questionRequest()` value (a real
 *   navigate-away-and-back, or any cache write that replaces the request object, e.g. a
 *   fresh `question.asked` for the same id) unmounts and remounts the wizard, exercising
 *   this exact snapshot round-trip. The snapshot lives only in the in-memory query client
 *   — it is cleared by `clearSessionQuestionDockSnapshot` on a successful reply/reject and
 *   does not survive a full page reload.
 *
 *   TODO state is a plain `Todo[]` cache cell (`shellDataKeys.sessionId(id, "todo")`),
 *   written by `todo.updated` SSE events. The dock's own OPEN/CLOSED animation state is
 *   local to `createSessionComposerState` and driven by `todoState()`
 *   (`session-composer-state.ts`): `count === 0` → "hide" (never shown); `!live` → "clear"
 *   (dispatches an empty todo list, dropping the whole dock instantly — used on session
 *   switch); `live && !done` → "open"; `live && done` → "close", which delays actually
 *   flipping `store.dock` to `false` by `closeMs` (default 400ms) via `scheduleClose()` —
 *   the auto-collapse-after-completion behavior. `live` = `session.status !== "idle" ||
 *   blocked()`. Separately, `SessionTodoDock`'s `collapsed` prop
 *   (`view.todoCollapsed`, `src/context/layout.tsx`) is a PER-SESSION-VIEW UI preference
 *   (default `false`, i.e. the full checklist), toggled by clicking the header row or its
 *   chevron button, independent of the dock's open/closed lifecycle above. Neither the
 *   dock's open/closed state nor its collapsed preference are asserted to survive reload
 *   by this spec.
 *
 * ANATOMY —
 *   Permission dock: `[data-component="dock-prompt"][data-kind="permission"]`, built by
 *     the shared `DockPrompt` (`packages/session-ui/src/components/dock-prompt.tsx`), with
 *     slots `[data-slot="permission-header"]`/`-body`/`-content`/`-footer`. Inside:
 *     `[data-slot="permission-header-title"]` ("Permission required"),
 *     `[data-slot="permission-hint"]` (tool description, from
 *     `settings.permissions.tool.<permission>.description`, empty/absent if no
 *     translation exists for that permission name), `[data-slot="permission-patterns"]`
 *     (one `<code>` per glob pattern, absent if `patterns` is empty), and
 *     `[data-slot="permission-footer-actions"]` holding three buttons in DOM order Deny /
 *     Allow always / Allow once (accessible names "Deny" / "Allow always" / "Allow once").
 *   Question dock: `[data-component="dock-prompt"][data-kind="question"]`, same DockPrompt
 *     slot convention with `question-*`. Header: `[data-slot="question-header-title"]`
 *     ("N of M questions"), `[data-slot="question-progress"]` with one
 *     `[data-slot="question-progress-segment"][data-active][data-answered]` button per
 *     question (click to jump). Body: `[data-slot="question-text"]`,
 *     `[data-slot="question-hint"]` ("Select one answer" / "Select all answers that
 *     apply"), `[data-slot="question-options"]` containing one
 *     `[data-slot="question-option"][data-picked][role="radio"|"checkbox"]` button per
 *     `QuestionOption` PLUS one ALWAYS-present trailing custom-answer option
 *     (`data-custom="true"`, label "Type your own answer") — this component does not read
 *     `QuestionInfo.custom` at all, so the custom affordance cannot be hidden by the
 *     agent's request. Footer: "Dismiss" (always), "Back" (tab > 0 only), and a
 *     primary/secondary "Next"/"Submit" button (label flips to "Submit" on the last tab).
 *     Keyboard, scoped to the dock root via its own `onKeyDown` (independent of the
 *     composer's own Escape cascade, which is spec 6's territory): ArrowUp/Down/Left/Right
 *     move focus among options + the custom affordance, Home/End jump to first/last,
 *     Escape rejects, Meta/Ctrl+Enter advances (same as clicking Next/Submit). Plain Enter
 *     on a focused option activates it via native `<button>` semantics, not custom code.
 *   Todo dock: `[data-component="session-todo-dock"]`. Header row
 *     `[data-action="session-todo-toggle"]` (click or Enter/Space toggles collapse) with a
 *     progress `<span aria-label="N of M todos completed">`, a
 *     `[data-slot="session-todo-preview"]` (only visibly non-empty while collapsed —
 *     shows the "active" todo: first `in_progress`, else first `pending`, else the last
 *     `completed`, else `todos[0]`), and a
 *     `[data-action="session-todo-toggle-button"][data-collapsed]` chevron. Body
 *     `[data-slot="session-todo-list"][aria-hidden]` contains one
 *     `[data-component="checkbox"][data-state="pending"|"in_progress"|"completed"|
 *     "cancelled"]` row per todo.
 *
 * BEHAVIORS —
 *   1. While a permission (or question) request is pending for the active, non-child
 *      session, the composer's textbox and submit control are entirely absent from the
 *      DOM (not merely disabled) and only the blocking dock is interactable.
 *   2. Deny posts `{response: "reject"}` to `POST /session/:id/permissions/:id`; the dock
 *      disappears and the composer returns only once the server's `permission.replied`
 *      event removes the request from cache.
 *   3. Allow once posts `{response: "once"}` with the same removal contract; an in-flight
 *      turn's reply is unaffected by the dock's open/closed state and is still proven
 *      visible via the oracle once the permission resolves.
 *   4. Allow always posts `{response: "always"}` and additionally persists a per-session
 *      auto-accept flag; a LATER `permission.asked` for the same session is silently
 *      auto-responded and never renders a dock at all.
 *   5. A single-question request renders one tab; picking an option marks it
 *      `data-picked`; the (only, last-tab) button reads "Submit" and posts
 *      `{answers: [[label]]}` to `POST /question/:id/reply`, one array per question in
 *      question order.
 *   6. A multi-question request's Back/Next buttons move between tabs without losing
 *      in-progress answers on either tab; a `multiple: true` question's options toggle
 *      independently (checkbox semantics) rather than replacing the selection (radio
 *      semantics).
 *   7. The "Type your own answer" option is always offered; typing text and committing
 *      (Enter without Shift) sets that tab's answer to the typed text and marks the
 *      custom option picked.
 *   8. Dismiss (button) and Escape (keyboard, scoped to the dock) both call
 *      `question.reject`, posting `POST /question/:id/reject`; the wizard is removed
 *      OPTIMISTICALLY (client-side), independent of any server SSE event.
 *   9. Keyboard focus cycles through options + the custom affordance via
 *      ArrowUp/Down/Left/Right and jumps to the ends via Home/End; Enter on a focused
 *      option activates it.
 *   10. An in-progress wizard's tab index and per-tab answers survive the dock's
 *      component being unmounted and remounted for the SAME request id (the mechanism a
 *      real navigate-away-and-back exercises, via `Show keyed`'s identity-change
 *      remount) — restored from the `session-question-cache.ts` snapshot.
 *   11. The todo dock opens exactly when the todo count is nonzero AND the session is
 *      "live" (busy, or a permission/question is blocking) AND not every todo is done;
 *      toggling the header collapses it to a single active-todo preview line and back.
 *   12. Once every todo reaches a terminal status while the dock is still live, the dock
 *      auto-closes (~400ms later, `scheduleClose`) without user action.
 *
 * INVARIANTS — completed assistant content is never hidden by stale busy state (#2 in
 *   e2e/INVARIANTS.md) — behavior 3 exercises the composer independently of that content
 *   slot. This spec's own additional invariant: auto-responded permissions (behavior 4)
 *   are excluded from `permissionRequest()`'s memo BEFORE render, not merely
 *   hidden/removed after a flash — no dock should ever mount for them.
 *
 * HARNESS NOTES — this spec fixes harness to the mock's default `opencode` path; the
 *   Codex ACP "Permission" fake tool and per-harness question-hidden-while-pending
 *   semantics are spec 10's territory. The shared mock's assistant turn stream
 *   (`driveTurn` in `e2e/helpers/mock-runtime.ts`) is NOT causally gated by permission
 *   resolution the way a real backend would be — behavior 3 is proven as an independently
 *   observable fact (dock resolves; reply is/becomes visible), not as a causal link
 *   between the two, which belongs to the Tier L live specs.
 *
 * OUT OF SCOPE — child-session permission/question bubbling to the parent's dock, and the
 *   revert/followup docks (spec 9); the composer's OWN Escape cascade
 *   (popover→shell→abort→blur, spec 6); todo/permission/question state surviving a full
 *   page reload; per-harness event-shape variance (spec 10); any real backend causally
 *   gating a tool call on a permission decision (Tier L).
 */
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime, type MockRuntimeHandles } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-docks"
const SESSION_ID = "ses_core_docks"

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

async function openDraftPrompt(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  return input
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

async function sendMessage(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
  await page.locator(SELECTORS.submitControl).last().click()
}

// ---------------------------------------------------------------------------
// Permission/question mutation routes — NOT covered by e2e/helpers/mock-runtime.ts
// (it only stubs GET /permission and GET /question as always-empty lists). See
// findings: the deprecated POST /session/:id/permissions/:id (permission decide),
// POST /question/:id/reply, and POST /question/:id/reject endpoints have no shared
// route; harvested shape from e2e-legacy/reload-message-flow.spec.ts.
// ---------------------------------------------------------------------------

type DockRequestCounters = {
  permissionRespond: { count: number; bodies: unknown[] }
  questionReply: { count: number; bodies: unknown[] }
  questionReject: { count: number; bodies: unknown[] }
}

async function installDockMutationRoutes(page: Page, mock: MockRuntimeHandles): Promise<DockRequestCounters> {
  const counters: DockRequestCounters = {
    permissionRespond: { count: 0, bodies: [] },
    questionReply: { count: 0, bodies: [] },
    questionReject: { count: 0, bodies: [] },
  }

  await page.route("**/session/*/permissions/*", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    const match = new URL(route.request().url()).pathname.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/)
    if (!match) return route.fallback()
    const [, sessionID, permissionID] = match
    counters.permissionRespond.count += 1
    counters.permissionRespond.bodies.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
    // Model the real server: the decide POST does not itself clear the request —
    // only a server-sourced permission.replied SSE event does (see SPEC STATE MODEL).
    mock.emit({ type: "permission.replied", properties: { sessionID, requestID: permissionID } })
  })

  await page.route("**/question/*/reply", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    if (!/^\/question\/[^/]+\/reply$/.test(new URL(route.request().url()).pathname)) return route.fallback()
    counters.questionReply.count += 1
    counters.questionReply.bodies.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
  })

  await page.route("**/question/*/reject", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    if (!/^\/question\/[^/]+\/reject$/.test(new URL(route.request().url()).pathname)) return route.fallback()
    counters.questionReject.count += 1
    counters.questionReject.bodies.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
  })

  return counters
}

/**
 * Installs the mock, seeds one project, sends turn 1, and oracle-proves it settled.
 *
 * The opencode harness is pinned to a concrete model (`gpt-5`) rather than the mock
 * default `BIG_PICKLE` placeholder. The reworked composer defers/redirects the
 * first-send when only the `big-pickle` placeholder model is resolved, which lets the
 * legacy `/…/session` → `/w/<workspaceId>` redirect win the race so the create POST
 * targets the resolved-workspace id instead of the draft directory and the mocked
 * session is never created. Pinning a real model matches the canonical send-flow
 * convention in `core-first-prompt-local.spec.ts` and makes the establishing turn
 * deterministic. Callers may still override via `options.harnessModels`.
 */
async function establishSession(page: Page, options: Parameters<typeof installMockRuntime>[1] = {}) {
  const mock = await installMockRuntime(page, {
    dir: DIR,
    sessionId: SESSION_ID,
    harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] },
    ...options,
  })
  const counters = await installDockMutationRoutes(page, mock)

  await seedOneProject(page, DIR)
  await openDraftPrompt(page, DIR)

  await sendMessage(page, "core docks establishing turn")
  await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID), { timeout: 20_000 })
  await expectAssistantReplyVisible(page, "ack 1: core docks establishing turn")

  return { mock, counters }
}

function permissionDock(page: Page) {
  return page.locator('[data-component="dock-prompt"][data-kind="permission"]')
}

function questionDock(page: Page) {
  return page.locator('[data-component="dock-prompt"][data-kind="question"]')
}

function questionOption(page: Page, label: string) {
  return page.locator('[data-slot="question-option"]', { hasText: label })
}

function composerTextbox(page: Page) {
  return page.getByRole("textbox", { name: /Ask anything/i })
}

test.describe("core docks — permission @core", () => {
  test("permission dock blocks the composer; Allow once resolves it and the in-flight turn still completes visibly — behaviors 1,3", async ({
    page,
  }) => {
    const { mock, counters } = await establishSession(page)

    await sendMessage(page, "core docks second turn")

    mock.emit({
      type: "permission.asked",
      properties: {
        id: "perm_allow_once",
        sessionID: SESSION_ID,
        permission: "edit",
        patterns: ["src/**/*.ts"],
        metadata: {},
        always: [],
      },
    })

    await expect(permissionDock(page)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-slot="permission-header-title"]')).toHaveText("Permission required")
    await expect(page.locator('[data-slot="permission-hint"]')).toHaveText(
      "Modify files, including edits, writes, and patches",
    )
    await expect(page.locator('[data-slot="permission-patterns"]')).toContainText("src/**/*.ts")

    // Behavior 1: composer surface, not merely disabled, is entirely absent.
    await expect(composerTextbox(page)).toHaveCount(0)
    await expect(page.locator(SELECTORS.submitControl)).toHaveCount(0)

    await page.getByRole("button", { name: "Allow once", exact: true }).click()

    await expect.poll(() => counters.permissionRespond.count, { timeout: 10_000 }).toBe(1)
    expect(counters.permissionRespond.bodies[0]).toEqual({ response: "once" })

    await expect(permissionDock(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(composerTextbox(page)).toBeVisible({ timeout: 20_000 })

    // Behavior 3: the second turn's reply is proven visible via the oracle, regardless
    // of when it streamed relative to the permission decision (see HARNESS NOTES).
    await expectAssistantReplyVisible(page, "ack 2: core docks second turn")
  })

  test("Deny posts {response: reject} and the dock only clears on the server's permission.replied event — behaviors 1,2", async ({
    page,
  }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "permission.asked",
      properties: {
        id: "perm_deny",
        sessionID: SESSION_ID,
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    })

    await expect(permissionDock(page)).toBeVisible({ timeout: 20_000 })
    await expect(composerTextbox(page)).toHaveCount(0)

    await page.getByRole("button", { name: "Deny", exact: true }).click()

    await expect.poll(() => counters.permissionRespond.count, { timeout: 10_000 }).toBe(1)
    expect(counters.permissionRespond.bodies[0]).toEqual({ response: "reject" })

    await expect(permissionDock(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(composerTextbox(page)).toBeVisible({ timeout: 20_000 })
  })

  test("Allow always persists auto-accept; a later permission for the same session never surfaces a dock — behavior 4", async ({
    page,
  }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "permission.asked",
      properties: {
        id: "perm_always_1",
        sessionID: SESSION_ID,
        permission: "edit",
        patterns: ["src/**/*.ts"],
        metadata: {},
        always: [],
      },
    })
    await expect(permissionDock(page)).toBeVisible({ timeout: 20_000 })

    await page.getByRole("button", { name: "Allow always", exact: true }).click()
    await expect.poll(() => counters.permissionRespond.count, { timeout: 10_000 }).toBe(1)
    expect(counters.permissionRespond.bodies[0]).toEqual({ response: "always" })
    await expect(permissionDock(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(composerTextbox(page)).toBeVisible({ timeout: 20_000 })

    // A second permission for the SAME session is auto-responded by the global
    // listener in src/context/permission.tsx before session-composer-state's own
    // memo would ever surface it — proven by the counter reaching 2 with zero dock
    // mounts in between (not a waitForTimeout-guarded absence).
    mock.emit({
      type: "permission.asked",
      properties: {
        id: "perm_always_2",
        sessionID: SESSION_ID,
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    })

    await expect.poll(() => counters.permissionRespond.count, { timeout: 10_000 }).toBe(2)
    expect(counters.permissionRespond.bodies[1]).toEqual({ response: "once" })
    await expect(permissionDock(page)).toHaveCount(0)
    await expect(composerTextbox(page)).toBeVisible()
  })
})

test.describe("core docks — question wizard @core", () => {
  test("single question: picking an option and Submit posts one answer array — behavior 5", async ({ page }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_single",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "Which approach should I take?",
            header: "Approach",
            options: [
              { label: "Fast", description: "Ship quickly" },
              { label: "Careful", description: "Take more time" },
            ],
            multiple: false,
          },
        ],
      },
    })

    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })
    await expect(composerTextbox(page)).toHaveCount(0)
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("1 of 1 questions")
    await expect(page.locator('[data-slot="question-hint"]')).toHaveText("Select one answer")

    const fast = questionOption(page, "Fast")
    await fast.click()
    await expect(fast).toHaveAttribute("data-picked", "true")

    await page.getByRole("button", { name: "Submit", exact: true }).click()

    await expect.poll(() => counters.questionReply.count, { timeout: 10_000 }).toBe(1)
    expect(counters.questionReply.bodies[0]).toEqual({ answers: [["Fast"]] })

    await expect(questionDock(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(composerTextbox(page)).toBeVisible({ timeout: 20_000 })
  })

  test("multi-question: Back/Next preserve per-tab answers; a multiple:true question toggles independently — behavior 6", async ({
    page,
  }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_multi",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "Continue after reload?",
            header: "Coordination",
            options: [
              { label: "Proceed", description: "Continue the same chat" },
              { label: "Stop", description: "Do not continue" },
            ],
            multiple: false,
          },
          {
            question: "Which areas need review?",
            header: "Review scope",
            options: [
              { label: "Alpha", description: "Area one" },
              { label: "Bravo", description: "Area two" },
              { label: "Charlie", description: "Area three" },
            ],
            multiple: true,
          },
        ],
      },
    })

    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("1 of 2 questions")

    await questionOption(page, "Proceed").click()
    await expect(questionOption(page, "Proceed")).toHaveAttribute("data-picked", "true")

    await page.getByRole("button", { name: "Next", exact: true }).click()
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("2 of 2 questions")
    await expect(page.locator('[data-slot="question-hint"]')).toHaveText("Select all answers that apply")

    await questionOption(page, "Alpha").click()
    await questionOption(page, "Bravo").click()
    await expect(questionOption(page, "Alpha")).toHaveAttribute("data-picked", "true")
    await expect(questionOption(page, "Bravo")).toHaveAttribute("data-picked", "true")
    await expect(questionOption(page, "Charlie")).not.toHaveAttribute("data-picked", "true")

    await page.getByRole("button", { name: "Back", exact: true }).click()
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("1 of 2 questions")
    await expect(questionOption(page, "Proceed")).toHaveAttribute("data-picked", "true")

    await page.getByRole("button", { name: "Next", exact: true }).click()
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("2 of 2 questions")
    await expect(questionOption(page, "Alpha")).toHaveAttribute("data-picked", "true")
    await expect(questionOption(page, "Bravo")).toHaveAttribute("data-picked", "true")

    await page.getByRole("button", { name: "Submit", exact: true }).click()

    await expect.poll(() => counters.questionReply.count, { timeout: 10_000 }).toBe(1)
    expect(counters.questionReply.bodies[0]).toEqual({ answers: [["Proceed"], ["Alpha", "Bravo"]] })
    await expect(questionDock(page)).toHaveCount(0, { timeout: 20_000 })
  })

  test("custom answer: typing and committing sets the tab's answer to the typed text — behavior 7", async ({ page }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_custom",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "How should I proceed?",
            header: "Proceed",
            options: [{ label: "Default", description: "Use the default plan" }],
            multiple: false,
          },
        ],
      },
    })

    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })

    const custom = page.locator('[data-slot="question-option"][data-custom="true"]')
    await expect(custom).toHaveText(/Type your own answer/)
    await custom.click()

    const input = page.locator('[data-slot="question-custom-input"]')
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.fill("Use approach C")
    await input.press("Enter")

    await expect(custom).toHaveAttribute("data-picked", "true")
    await expect(custom).toContainText("Use approach C")

    await page.getByRole("button", { name: "Submit", exact: true }).click()

    await expect.poll(() => counters.questionReply.count, { timeout: 10_000 }).toBe(1)
    expect(counters.questionReply.bodies[0]).toEqual({ answers: [["Use approach C"]] })
  })

  test("Dismiss and Escape both reject the wizard optimistically, no permission SSE round-trip required — behavior 8", async ({
    page,
  }) => {
    const { mock, counters } = await establishSession(page)

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_dismiss",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "Dismiss me via button",
            header: "Dismiss",
            options: [{ label: "One", description: "First" }],
            multiple: false,
          },
        ],
      },
    })
    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })

    await page.getByRole("button", { name: "Dismiss", exact: true }).click()
    await expect.poll(() => counters.questionReject.count, { timeout: 10_000 }).toBe(1)
    await expect(questionDock(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(composerTextbox(page)).toBeVisible({ timeout: 20_000 })

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_escape",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "Dismiss me via Escape",
            header: "Escape",
            options: [{ label: "One", description: "First" }],
            multiple: false,
          },
        ],
      },
    })
    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })

    // The dock auto-focuses its first option on mount; Escape bubbles from that
    // focused element up to the DockPrompt root's own onKeyDown handler.
    await page.keyboard.press("Escape")
    await expect.poll(() => counters.questionReject.count, { timeout: 10_000 }).toBe(2)
    await expect(questionDock(page)).toHaveCount(0, { timeout: 20_000 })
  })

  test("keyboard: Arrow/Home/End move focus among options + custom, Enter activates the focused option — behavior 9", async ({
    page,
  }) => {
    const { mock } = await establishSession(page)

    mock.emit({
      type: "question.asked",
      properties: {
        id: "q_keyboard",
        sessionID: SESSION_ID,
        questions: [
          {
            question: "Pick one",
            header: "Pick",
            options: [
              { label: "One", description: "First" },
              { label: "Two", description: "Second" },
            ],
            multiple: false,
          },
        ],
      },
    })
    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })

    const one = questionOption(page, "One")
    const two = questionOption(page, "Two")
    const custom = page.locator('[data-slot="question-option"][data-custom="true"]')

    await expect(one).toBeFocused({ timeout: 10_000 })

    await page.keyboard.press("ArrowDown")
    await expect(two).toBeFocused({ timeout: 5_000 })

    await page.keyboard.press("ArrowDown")
    await expect(custom).toBeFocused({ timeout: 5_000 })

    await page.keyboard.press("Home")
    await expect(one).toBeFocused({ timeout: 5_000 })

    await page.keyboard.press("End")
    await expect(custom).toBeFocused({ timeout: 5_000 })

    await page.keyboard.press("ArrowUp")
    await expect(two).toBeFocused({ timeout: 5_000 })

    await page.keyboard.press("Enter")
    await expect(two).toHaveAttribute("data-picked", "true")
    await expect(one).not.toHaveAttribute("data-picked", "true")
  })

  test("in-progress answers survive the dock's unmount/remount for the same request id — behavior 10", async ({
    page,
  }) => {
    const { mock } = await establishSession(page)

    const questionProps = {
      id: "q_persist",
      sessionID: SESSION_ID,
      questions: [
        {
          question: "Continue after reload?",
          header: "Coordination",
          options: [
            { label: "Proceed", description: "Continue the same chat" },
            { label: "Stop", description: "Do not continue" },
          ],
          multiple: false,
        },
        {
          question: "Second question",
          header: "Second",
          options: [{ label: "Yep", description: "Confirmed" }],
          multiple: false,
        },
      ],
    }

    mock.emit({ type: "question.asked", properties: questionProps })
    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })

    await questionOption(page, "Proceed").click()
    await page.getByRole("button", { name: "Next", exact: true }).click()
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("2 of 2 questions")

    // Re-emitting the SAME request id as a fresh object replaces the cache entry
    // with a new reference, which forces the `<Show ... keyed>` in
    // session-composer-region.tsx to unmount and remount SessionQuestionDock — the
    // same identity-change remount a real navigate-away-and-back would trigger (see
    // SPEC STATE MODEL). This is the deterministic, single-session-fixture proxy for
    // that behavior in this mocked harness.
    mock.emit({ type: "question.asked", properties: { ...questionProps } })

    await expect(questionDock(page)).toBeVisible({ timeout: 20_000 })
    // The wizard is restored on tab 2 (not reset to tab 1).
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("2 of 2 questions")

    await page.getByRole("button", { name: "Back", exact: true }).click()
    await expect(page.locator('[data-slot="question-header-title"]')).toHaveText("1 of 2 questions")
    await expect(questionOption(page, "Proceed")).toHaveAttribute("data-picked", "true")
  })
})

test.describe("core docks — todo tray @core", () => {
  test("todo dock opens while live+incomplete, collapsed preview shows the active todo, and it auto-closes once done — behaviors 11,12", async ({
    page,
  }) => {
    const { mock } = await establishSession(page)

    mock.emit({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "busy" } } })
    mock.emit({
      type: "todo.updated",
      properties: {
        sessionID: SESSION_ID,
        todos: [
          { content: "Set up scaffold", status: "completed", priority: "low" },
          { content: "Wire the API", status: "in_progress", priority: "medium" },
          { content: "Write tests", status: "pending", priority: "low" },
        ],
      },
    })

    const dock = page.locator('[data-component="session-todo-dock"]')
    await expect(dock).toBeVisible({ timeout: 20_000 })

    const progressLabel = page.locator('[data-action="session-todo-toggle"] span[aria-label]').first()
    await expect(progressLabel).toHaveAttribute("aria-label", "1 of 3 todos completed")

    const list = page.locator('[data-slot="session-todo-list"]')
    await expect(list).toHaveAttribute("aria-hidden", "false")
    await expect(list.locator('[data-component="checkbox"]')).toHaveCount(3)
    await expect(list.locator('[data-component="checkbox"][data-state="in_progress"]')).toContainText("Wire the API")

    // Behavior 11 (collapsed preview): toggle collapse, the preview line takes over.
    await page.locator('[data-action="session-todo-toggle-button"]').click()
    await expect(list).toHaveAttribute("aria-hidden", "true", { timeout: 10_000 })
    const preview = page.locator('[data-slot="session-todo-preview"] [data-component="text-reveal"]')
    await expect(preview).toHaveAttribute("aria-label", "Wire the API", { timeout: 10_000 })

    // Behavior 12: every todo reaches a terminal status while still live -> the dock
    // auto-closes without any user action.
    mock.emit({
      type: "todo.updated",
      properties: {
        sessionID: SESSION_ID,
        todos: [
          { content: "Set up scaffold", status: "completed", priority: "low" },
          { content: "Wire the API", status: "completed", priority: "medium" },
          { content: "Write tests", status: "cancelled", priority: "low" },
        ],
      },
    })

    await expect(dock).toHaveCount(0, { timeout: 10_000 })
  })
})
