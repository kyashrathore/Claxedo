/**
 * SPEC: Multi-turn local sessions — reload recovery, prompt history, and send failure
 *       recovery
 *
 * PURPOSE — everything that has to keep working once a session has more than one turn:
 * sending a second/third message without disturbing earlier ones, reloading the browser
 * mid-conversation without duplicating or losing anything, recalling and editing
 * previously-sent prompts from history, and cleanly recovering the composer when a send
 * fails outright. This spec owns the session's LIFE AFTER the first turn; the first turn
 * itself (draft → first send → session creation) is `core-first-prompt-local`'s territory.
 *
 * STATE MODEL —
 *   Timeline/messages: server-authoritative. `GET /session/:id/message` is the source of
 *     truth; the client optimistically renders the user's own turn immediately
 *     (`addRegisteredConversationMessage`, `src/shell/chat/conversation-registry.ts`) and
 *     reconciles against the server row once it arrives. A reload re-fetches
 *     `/session`, `/session/:id`, and `/session/:id/message` fresh — nothing about
 *     already-sent turns lives only in memory, so reload must reproduce the exact same
 *     rows with no duplication (`src/session/store/session-controller.ts`
 *     `syncCompatSession`, which calls `hydrateConversationPage`).
 *   History window: only a bounded number of recent turns are rendered at once.
 *     `createSessionHistoryWindow` (`src/pages/session/history-window.ts`) keeps
 *     `turnStart`/`turnInit=4`/`turnBatch=8`/`turnScrollThreshold=200` state that is
 *     PURELY client-side (not persisted, reset on session switch); it slices
 *     `visibleUserMessages()` (all turns the client has fetched) down to
 *     `renderedUserMessages()` (what's actually mounted in the DOM). Scrolling near the
 *     top either (a) reveals more of the already-fetched turns for free
 *     (`backfillTurns`, pure client-side re-slicing) or, once every fetched turn is
 *     already rendered and the server has more (`historyMore()` — a cursor-based flag
 *     driven by the `x-next-cursor` response header on `/session/:id/message`), (b)
 *     fetches an older page (`fetchOlderMessages` → `sessionController.loadMore`).
 *     Rendered/visible counts are exposed for tests as
 *     `data-session-rendered-user-count` / `data-session-visible-user-count` on
 *     `[data-testid="session-page-root"]` (`src/pages/session.tsx`).
 *   Prompt history (ArrowUp/ArrowDown recall): two independent, GLOBAL (not per-session)
 *     stacks persisted to `localStorage` via `Persist.global` —
 *     `opencode.global.dat:prompt-history` (normal mode) and
 *     `opencode.global.dat:prompt-history-shell` (shell mode) — written by
 *     `createPromptHistoryController` (`src/components/prompt-input/history-controller.ts`).
 *     Every submit attempt calls `input.addToHistory(currentPrompt, userMode)`
 *     (`src/components/prompt-input/submit.ts:295`) BEFORE the network call — so an entry
 *     is recorded even if the dispatch later fails. Which stack is read/written is
 *     selected by the composer's CURRENT mode (`normal` vs `shell`) at the moment of
 *     ArrowUp/ArrowDown, not by the mode the entry was originally sent in. Navigation
 *     state (`historyIndex`, `savedPrompt` — the in-progress draft captured the moment
 *     history navigation starts) lives in component-local Solid store, not persisted;
 *     only the entries themselves survive reload.
 *   Composer draft (text + image attachments + context items): scoped per
 *     `(directory, sessionId)` (`promptViewScope`), held in the `usePrompt()` context
 *     store. On successful dispatch it's cleared (`clearInput`); on a THROWN dispatch —
 *     failed `POST /session/:id/prompt_async` — it is fully restored byte-for-byte
 *     (`restoreInput`, `restoreCommentItems`) by `rollbackPromptDispatch`
 *     (`src/session/submit/send.ts:58-67`), along with removing the optimistic user row
 *     (`removeSubmittedPrompt`) that had already been added to the timeline.
 *
 * ANATOMY —
 *   `[data-claxedo]` — shell root.
 *   `[role="textbox"][aria-label*="Ask anything"]` — composer editor (contenteditable).
 *   `[data-action="prompt-submit"]` — send/stop button (`data-icon="stop"` while busy).
 *   `[data-slot="session-turn-message-content"]` — a user turn's rendered content.
 *   `[data-slot="session-turn-assistant-content"]` — an assistant turn's rendered
 *     content (oracle target).
 *   `[data-testid="session-page-root"]` — carries `data-session-visible-user-count`
 *     (all fetched user turns) and `data-session-rendered-user-count` (currently
 *     windowed/mounted subset) as plain string-integer attributes
 *     (`src/pages/session.tsx:1341-1342`).
 *   `input[type="file"]` (hidden) — the composer's image-attachment file input
 *     (`src/components/prompt-input/frame.tsx:230-241`); attachments render as
 *     `<img alt="<filename>">` thumbnails via `PromptImageAttachments`
 *     (`src/components/prompt-input/image-attachments.tsx`) once added.
 *   `[data-slot="toast-title"]` — toast title text (`packages/ui/src/components/toast.tsx`).
 *   `[data-scrollable]` — the message timeline's scroll viewport
 *     (`packages/ui/src/components/scroll-view.tsx`); the one that also contains
 *     `[data-slot="session-turn-message-content"]` rows is the message list's own
 *     scroller (there can be other `[data-scrollable]` regions elsewhere on the page).
 *
 * BEHAVIORS —
 *   1. A second prompt sent in an already-created local session dispatches and renders
 *      its own assistant reply (oracle) without disturbing the first turn's rendered
 *      content; the timeline ends with exactly 2 user rows + 2 assistant rows and no
 *      duplicated text.
 *   2. Reloading a session with existing turns re-renders every prior turn exactly once
 *      (zero duplicate rows), issues no new `POST /session` (the same server session is
 *      reused, `createSessionCount` stays at 1), and shows no runaway request growth once
 *      the app has settled (no endpoint keeps re-firing after initial load — no polling
 *      storm).
 *   3. A third prompt sent after reload dispatches into the SAME (reused) session and its
 *      reply renders via the oracle; the session is still not re-created.
 *   4. `ArrowUp`/`ArrowDown` at an empty, caret-at-start composer recalls previously-
 *      submitted normal-mode prompts in LIFO order (most-recently-sent first), exactly
 *      restoring each entry's text; continuing past the oldest entry with `ArrowDown`
 *      returns to (and never leaves stuck on) a state that contains neither recalled
 *      entry's text (the pre-navigation draft is restored).
 *   5. The recalled prompt text is fully editable, not read-only — appending text and
 *      resubmitting (`Enter`) fires a new, independent turn carrying the edited text. This
 *      is the "edit a previously sent message" affordance: there is no separate Edit
 *      button on a sent user row (`UserActions` in
 *      `packages/session-ui/src/components/message-part.tsx:174-177` only exposes
 *      `fork`/`revert`) — recall-then-edit via history IS the mechanism.
 *   6. Prompt history is persisted to `localStorage`
 *      (`opencode.global.dat:prompt-history`) and survives a reload: `ArrowUp`
 *      immediately after reload still recalls prompts that were sent before the reload.
 *   7. Shell-mode history (entered via `!` at cursor position 0,
 *      `src/components/prompt-input/editor-keymap.ts:66-73`) is tracked in an independent
 *      stack (`opencode.global.dat:prompt-history-shell`) from normal-mode history;
 *      navigating history while in shell mode never surfaces a normal-mode entry, and a
 *      fresh normal-mode composer never surfaces a shell entry.
 *   8. A forced `prompt_async` dispatch failure removes the optimistic user row that was
 *      added before the request settled, restores the exact composer state that was in
 *      flight (text AND any image attachment) back into the composer, and shows an error
 *      toast (`prompt.toast.promptSendFailed.title` = "Failed to send prompt"). The user
 *      can immediately resubmit the restored content by pressing Send again — there is no
 *      dedicated "Retry" action/button (`showSendFailed` passes no `actions`,
 *      `packages/ui/src/components/toast.tsx:108-116`); the restored composer plus its own
 *      Send control IS the retry affordance, and that retry succeeds as an ordinary new
 *      turn.
 *   9. When a session has more turns than the initial render window (`turnInit = 4` user
 *      turns worth of rows), scrolling the timeline up to within `turnScrollThreshold`
 *      (200px) of the top reveals the remaining, already-fetched-but-windowed-out turns
 *      (`backfillTurns`) without duplicating any row, and the scroll position is adjusted
 *      to preserve the pre-reveal visual anchor (`preserveScroll` in
 *      `src/pages/session/history-window.ts`) rather than jumping.
 *
 * INVARIANTS — completed assistant content is never hidden by stale busy state (#2 in
 *   e2e/INVARIANTS.md) — every reply proven here, including ones re-proven after reload,
 *   goes through the shared oracle; the selected harness (opencode, fixed for this spec)
 *   owns the submit payload at every stage per invariant #1, though the harness matrix
 *   itself is `core-harness-ownership-local`'s territory.
 *
 * HARNESS NOTES — none; like the pilot, this spec fixes the harness to `opencode` (the
 *   mock's default) to keep multi-turn/reload/history mechanics isolated from harness
 *   selection, which `core-harness-ownership-local` and `core-harness-ownership-cloud`
 *   own.
 *
 * OUT OF SCOPE — first turn / session creation (`core-first-prompt-local`); harness
 *   switching, model/effort controls (`core-harness-ownership-local`,
 *   `core-model-effort-agent-controls`); busy/abort/escalation UI
 *   (`core-busy-abort-errors`); @-mention popover mechanics, drag-drop/paste attachment
 *   UX, slash commands (`core-composer-modes` — this spec only needs ONE attachment and
 *   zero @-mentions to prove the RESTORE mechanism, not the full attach/mention UX);
 *   revert/fork and the `SessionComposerRegion` `followup`-dock "edit queued message"
 *   prop (`src/pages/session/composer/session-composer-region.tsx:35-40` — note: as of
 *   this writing `followup` is never actually passed by `src/pages/session.tsx`, so that
 *   queued-followup edit path is unreachable from the live UI today; see this spec's
 *   findings) belong to `core-session-actions`; server-side network-fetched pagination
 *   (`historyMore()` / `x-next-cursor` / `sessionController.loadMore`) is NOT exercised
 *   here — behavior 9 exercises the purely-client-side `backfillTurns` windowing path,
 *   which is the only "load older" path the shared mock's non-paginated
 *   `/session/:id/message` response can reach; true server-cursor pagination would need a
 *   spec-owned mock extension and is left as a finding.
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, expectTurnCounts, expectNoDuplicateRows, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-turns-reload-recovery"
const SESSION_ID = "ses_core_turns_reload_recovery"

// The mock's DEFAULT opencode model is the `big-pickle` placeholder
// (`signed-workspace-model.ts` `SIGNED_WORKSPACE_DEFAULT_MODEL`), which the app
// deliberately filters out of `firstConnectedModelInfo`/`selectRuntimeModel`
// (`src/features/session/composer/model-strategy.ts`) so it can never be picked
// as a real default — composer submit stays blocked with "Choose a model to
// continue" (`no-model`, `submit-block-reason.ts`) until a real model is
// connected. Every send in this spec needs a real, non-placeholder model
// available, matching the pattern `core-first-prompt-local.spec.ts` already
// uses for its own send test.
const HARNESS_MODELS = { opencode: [{ id: "gpt-5", name: "GPT-5" }] }

// A 1x1 transparent PNG, inlined so this spec makes zero filesystem/network calls for
// its attachment fixture.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  // `addInitScript` re-runs on EVERY navigation the page makes, including `page.reload()` —
  // not just the first `page.goto()`. An unconditional `localStorage.clear()` here would
  // wipe out exactly the localStorage-backed state (prompt history,
  // `opencode.global.dat:prompt-history`) this spec's reload-survival tests (behaviors 6,7)
  // exist to prove persists across reload, defeating the scenario on every reload. Guard the
  // clear behind a same-origin sentinel so it fires once, at the very first load, and every
  // later reload in the same test only re-asserts the `__OPENCODE__` window global (which a
  // reload legitimately does wipe, being in-memory) without touching localStorage again.
  await page.addInitScript((d: string) => {
    if (!localStorage.getItem("__e2e_seeded__")) {
      localStorage.clear()
      localStorage.setItem("__e2e_seeded__", "1")
    }
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
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

function composer(page: Page) {
  // NOT role+accessible-name: the composer's aria-label is
  // `promptDesignPlaceholder()` (src/session-client/composer/role-gate.ts:14-18), which
  // changes to the shell placeholder text ("Enter shell command...") once shell mode is
  // entered (`!` at cursor 0) — a role/name locator captured before the mode switch would
  // stop matching on every subsequent interaction and hang until timeout. `data-component`
  // is on the same contenteditable node (src/components/prompt-input/frame.tsx:190) and is
  // mode-independent, so this locator stays valid across normal/shell transitions.
  return page.locator('[data-component="prompt-input"]').last()
}

function submitControl(page: Page) {
  return page.locator(SELECTORS.submitControl).last()
}

async function sendAndProve(page: Page, text: string, replyText: string) {
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
  await submitControl(page).click()
  await expectAssistantReplyVisible(page, replyText)
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

async function composerCleanText(page: Page) {
  const raw = (await composer(page).textContent()) ?? ""
  return raw.replace(/​/g, "").trim()
}

/**
 * The anchor element's position within the SCROLLABLE CONTENT (i.e.
 * `rect.top` relative to the scroller PLUS the scroller's own `scrollTop`),
 * not its viewport-relative `boundingBox()`. `preserveScroll` (src/pages/
 * session/history-window.ts) only promises to cancel out the height added
 * ABOVE the anchor by newly-revealed turns — it makes no promise about (and
 * should not try to cancel) scrollTop movement the user's OWN wheel gesture
 * causes in the same tick. A viewport-relative bounding box conflates both,
 * so a real, correctly-compensated reveal still shows a `boundingBox().y`
 * delta equal to whatever the last wheel tick itself scrolled (confirmed
 * empirically: ~400px, matching a single `mouse.wheel(0, -400)`) even
 * though the anchor's actual position within the scrollable content never
 * moved. This offset is scroll-position-independent, so it isolates exactly
 * what `preserveScroll` is responsible for.
 */
async function anchorOffsetWithinScroller(scroller: Locator, anchor: Locator) {
  const scrollerHandle = await scroller.elementHandle()
  const anchorHandle = await anchor.elementHandle()
  if (!scrollerHandle || !anchorHandle) return null
  return scrollerHandle.evaluate(
    (scrollerEl, anchorEl) =>
      (anchorEl as HTMLElement).getBoundingClientRect().top -
      (scrollerEl as HTMLElement).getBoundingClientRect().top +
      (scrollerEl as HTMLElement).scrollTop,
    anchorHandle,
  )
}

test.describe("core turns, reload recovery, history & send-failure recovery (local) @core", () => {
  test("2nd/3rd sends survive reload with zero duplicate rows, the same session, and a bounded request pattern — behaviors 1,2,3", async ({
    page,
  }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: HARNESS_MODELS })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    // Turn 1 creates the session.
    await sendAndProve(page, "core turns first message", "ack 1: core turns first message")
    await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID), { timeout: 20_000 })
    expect(mock.requests.createSessionCount).toBe(1)

    // Behavior 1: turn 2 renders its own reply; turn 1's content is untouched.
    await sendAndProve(page, "core turns second message", "ack 2: core turns second message")
    await expectAssistantReplyVisible(page, "ack 1: core turns first message")
    await expectTurnCounts(page, { user: 2, assistant: 2 })
    await expectNoDuplicateRows(page)
    expect(mock.requests.createSessionCount).toBe(1)

    // Behavior 2: reload — track raw request traffic from this point so we can prove
    // no endpoint keeps re-firing once the app has settled (a real signal, not a
    // fixed-sleep guess — see e2e/INVARIANTS.md authoring rule #3).
    const seen = new Map<string, number>()
    page.on("request", (request) => {
      const type = request.resourceType()
      if (type !== "fetch" && type !== "xhr") return
      const url = new URL(request.url())
      if (url.pathname === "/event" || url.pathname === "/global/event" || url.pathname.endsWith("/health")) return
      const key = `${request.method()} ${url.pathname}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    })

    await page.reload()
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expectAssistantReplyVisible(page, "ack 1: core turns first message")
    await expectAssistantReplyVisible(page, "ack 2: core turns second message")
    await expectTurnCounts(page, { user: 2, assistant: 2 })
    await expectNoDuplicateRows(page)
    expect(mock.requests.createSessionCount).toBe(1) // reload never re-creates the session

    const afterSettle = new Map(seen)
    // Settle buffer alongside the real per-endpoint delta assertion below (never the
    // sole guard — e2e/INVARIANTS.md authoring rule #3).
    await page.waitForTimeout(2_500)
    for (const [key, before] of afterSettle) {
      const after = seen.get(key) ?? 0
      expect(
        after - before,
        `${key} kept firing after settle (before=${before}, after=${after}) — looks like a request-storm/polling loop`,
      ).toBeLessThanOrEqual(2)
    }

    // Behavior 3: a 3rd send after reload dispatches into the SAME session.
    await sendAndProve(page, "core turns third message", "ack 3: core turns third message")
    await expectTurnCounts(page, { user: 3, assistant: 3 })
    await expectNoDuplicateRows(page)
    expect(mock.requests.createSessionCount).toBe(1)
    expect(mock.requests.promptCount).toBe(3)
  })

  test("ArrowUp/ArrowDown recall sent prompts in LIFO order and the recalled text can be edited and resent — behaviors 4,5", async ({
    page,
  }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: HARNESS_MODELS })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await sendAndProve(page, "core turns history alpha", "ack 1: core turns history alpha")
    await sendAndProve(page, "core turns history beta", "ack 2: core turns history beta")

    const input = composer(page)
    await input.click()

    // Behavior 4: LIFO recall — most recently sent prompt first.
    await input.press("ArrowUp")
    await expect(input).toContainText("core turns history beta")
    await expect(input).not.toContainText("core turns history alpha")

    await input.press("ArrowUp")
    await expect(input).toContainText("core turns history alpha")
    await expect(input).not.toContainText("core turns history beta")

    await input.press("ArrowDown")
    await expect(input).toContainText("core turns history beta")
    await expect(input).not.toContainText("core turns history alpha")

    await input.press("ArrowDown")
    // Past the newest entry: back to the pre-navigation draft (empty here) — neither
    // recalled entry's text should remain.
    await expect(input).not.toContainText("core turns history alpha")
    await expect(input).not.toContainText("core turns history beta")

    // Behavior 5: recall once more and prove the recalled text is editable+resendable.
    await input.press("ArrowUp")
    await expect(input).toContainText("core turns history beta")
    await input.press("End")
    await input.type(" edited")
    await input.press("Enter")

    await expectAssistantReplyVisible(page, "ack 3: core turns history beta edited")
    await expectTurnCounts(page, { user: 3, assistant: 3 })
    await expectNoDuplicateRows(page)
  })

  test("prompt history is persisted and survives a reload — behavior 6", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: HARNESS_MODELS })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await sendAndProve(page, "core turns persisted before reload", "ack 1: core turns persisted before reload")

    const storedBeforeReload = await page.evaluate(() => localStorage.getItem("opencode.global.dat:prompt-history"))
    expect(storedBeforeReload).toContain("core turns persisted before reload")

    await page.reload()
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expectAssistantReplyVisible(page, "ack 1: core turns persisted before reload")

    const input = composer(page)
    await input.click()
    await input.press("ArrowUp")
    await expect(input).toContainText("core turns persisted before reload")
  })

  test("shell-mode and normal-mode prompt history are independent stacks — behavior 7", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: HARNESS_MODELS })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await sendAndProve(page, "core turns normal history entry", "ack 1: core turns normal history entry")

    const input = composer(page)
    await input.click()
    await input.press("!") // enters shell mode at cursor 0 (editor-keymap.ts:66-73)
    await input.type("core turns shell history entry")
    await input.press("Enter")
    await expect.poll(() => mock.requests.shellCount, { timeout: 10_000 }).toBe(1)
    // Shell dispatch never produces an assistant reply in this mock (no SSE events are
    // queued for it) — intentionally no oracle claim is made about this send; only its
    // history side effect is under test here.

    // Re-enter shell mode (a successful shell send resets mode to "normal") and confirm
    // ArrowUp recalls the SHELL entry, not the normal one.
    await input.click()
    await input.press("!")
    await input.press("ArrowUp")
    await expect(input).toContainText("core turns shell history entry")
    await expect(input).not.toContainText("core turns normal history entry")

    // Reload for a clean, empty, normal-mode composer, then confirm ArrowUp in normal
    // mode never surfaces the shell entry (both stacks persist independently). The
    // composer's DRAFT (text + mode) is itself intentionally persisted across reload
    // (see this spec's STATE MODEL — "draft text+chips survive reload"), so reloading
    // with the just-recalled shell text still sitting in the box would legitimately
    // restore that exact shell-mode draft rather than a clean composer — Escape (exits
    // shell mode, editor-keymap.ts:83-88) + clearing the text is required first to get
    // the "clean, empty, normal-mode" baseline this assertion actually needs.
    await input.press("Escape")
    await input.fill("")
    await page.reload()
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    const inputAfterReload = composer(page)
    await inputAfterReload.click()
    await inputAfterReload.press("ArrowUp")
    await expect(inputAfterReload).toContainText("core turns normal history entry")
    await expect(inputAfterReload).not.toContainText("core turns shell history entry")

    const normalHistory = await page.evaluate(() => localStorage.getItem("opencode.global.dat:prompt-history"))
    const shellHistory = await page.evaluate(() => localStorage.getItem("opencode.global.dat:prompt-history-shell"))
    expect(normalHistory).toContain("core turns normal history entry")
    expect(normalHistory).not.toContain("core turns shell history entry")
    expect(shellHistory).toContain("core turns shell history entry")
  })

  test("a forced dispatch failure restores composer text + attachment, toasts, and a resend succeeds — behavior 8", async ({
    page,
  }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: HARNESS_MODELS })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    // First send succeeds normally and creates the session.
    await sendAndProve(page, "core turns dispatch failure setup", "ack 1: core turns dispatch failure setup")

    // Layer a fail-once override on top of the shared mock's prompt_async route. Playwright
    // runs the most-recently-registered matching route first; calling route.fallback()
    // hands control back to installMockRuntime's own handler, so only THIS one attempt is
    // forced to fail — the shared mock's real dispatch/turn-driving logic is reused for
    // every other attempt, per e2e/INVARIANTS.md authoring rule #1 (extend, don't hand-roll
    // a parallel mock).
    let forceFailure = false
    let forcedFailureCount = 0
    await page.route("**/session/*/prompt_async**", async (route) => {
      const url = new URL(route.request().url())
      if (!/^\/session\/[^/]+\/prompt_async$/.test(url.pathname)) return route.fallback()
      if (!forceFailure) return route.fallback()
      forceFailure = false
      forcedFailureCount += 1
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "dispatch failed" }) })
    })

    const input = composer(page)
    const failingText = "core turns dispatch failure message"
    await input.click()
    await input.fill(failingText)
    await expect(input).toContainText(failingText, { timeout: 10_000 })

    // `.last()`, not `.first()`: two `input[type="file"]` nodes exist in the DOM (the
    // active composer's own hidden file input plus an inactive/off-screen duplicate
    // composer instance's) — `.first()` non-deterministically attached the file to
    // whichever renders first in DOM order, which is not reliably the visible composer,
    // leaving `attach.png` attached-but-not-rendered where the test could see it. Every
    // other composer-scoped locator in this spec already uses `.last()` for the same
    // reason (see `composer()`/`submitControl()` above) — this was the one that didn't.
    const fileInput = page.locator('input[type="file"]').last()
    await fileInput.setInputFiles({ name: "attach.png", mimeType: "image/png", buffer: Buffer.from(PNG_1X1_BASE64, "base64") })
    await expect(page.getByAltText("attach.png")).toBeVisible({ timeout: 10_000 })

    forceFailure = true
    await submitControl(page).click()

    // The forced 500 is the real, deterministic signal that the failure round-trip has
    // actually happened (never a bare sleep — e2e/INVARIANTS.md authoring rule #3).
    await expect.poll(() => forcedFailureCount, { timeout: 10_000 }).toBe(1)
    await expect
      .poll(() => mock.requests.badResponses.some((entry) => entry.includes("prompt_async")), { timeout: 10_000 })
      .toBe(true)

    // Error toast.
    await expect(page.locator('[data-slot="toast-title"]')).toContainText("Failed to send prompt", { timeout: 10_000 })

    // Optimistic user row removed; still only turn 1 on the timeline.
    await expect(
      page.locator(SELECTORS.userMessageContent).getByText(failingText, { exact: true }),
    ).toHaveCount(0, { timeout: 10_000 })
    await expectTurnCounts(page, { user: 1, assistant: 1 })

    // Composer state restored exactly: text AND the image attachment.
    await expect(input).toContainText(failingText, { timeout: 10_000 })
    await expect(page.getByAltText("attach.png")).toBeVisible({ timeout: 10_000 })

    // Retry affordance: no dedicated Retry button — the restored composer's own Send
    // control resubmits the exact same content, and this time it succeeds.
    await submitControl(page).click()
    await expectAssistantReplyVisible(page, "ack 2: core turns dispatch failure message")
    await expectTurnCounts(page, { user: 2, assistant: 2 })
    await expectNoDuplicateRows(page)
    expect(mock.requests.promptCount).toBe(2) // the forced-failed attempt never reached the real handler
  })

  test.fixme(
    "a forced dispatch failure restores a context-item chip into the composer — behavior 8",
    async () => {
      // Deliberately not implemented: inserting a context-item "chip" (a file/comment
      // reference rendered by PromptContextItems,
      // src/components/prompt-input/context-items.tsx) requires the @-mention popover's
      // file-search wiring (`searchFilesAndDirectories` / `recentFiles`,
      // src/components/prompt-input/popover-controller.ts:29-45,
      // src/session-client/composer/composer.tsx:258,507-508), which the shared
      // e2e/helpers/mock-runtime.ts does not stub (it has no `/find/file`-equivalent
      // route) and which is `core-composer-modes`' territory to build/own. The dispatch-
      // failure ROLLBACK mechanism itself is proven generically by the text+attachment
      // case above — `restoreCommentItems`/`removeCommentItems` in
      // src/components/prompt-input/submit.ts treat every context item uniformly
      // regardless of how it was inserted, so this is a missing test seam, not a known
      // app bug. Revisit once core-composer-modes lands @-mention route stubs that this
      // spec (or a shared helper) can reuse.
    },
  )

  test("scrolling to the top loads older turns without duplicating rows and preserves the scroll anchor — behavior 9", async ({
    page,
  }) => {
    // Shrink the viewport so 6 short turns genuinely overflow the message list — the
    // history window's auto-reveal (scheduleHistoryFill in src/pages/session.tsx) only
    // stays windowed when the content actually overflows the viewport; on a tall/default
    // viewport all 6 turns would fit and get auto-revealed regardless of scroll. 460px
    // (not the more aggressive ~300px) leaves enough headroom under the timeline's
    // `sticky top-0 z-30` session-title bar (`data-session-title`,
    // src/pages/session/message-timeline.tsx) that turns rendered near the top of a short
    // conversation don't land underneath it — an ordinary, real CSS stacking interaction
    // (the sticky header legitimately sits above whatever scrolls under it) that the
    // oracle's geometric hit-test correctly flags as a covering overlay when it happens.
    await page.setViewportSize({ width: 1280, height: 460 })

    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: HARNESS_MODELS })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    const turnCount = 6
    for (let i = 1; i <= turnCount; i++) {
      await sendAndProve(page, `core turns load older message ${i}`, `ack ${i}: core turns load older message ${i}`)
    }
    expect(mock.requests.promptCount).toBe(turnCount)

    // Reload before measuring the window:
    // `initialTurnStart` (src/pages/session/history-window.ts:42) — the thing that
    // actually produces `renderedBefore < turnCount` — is only applied at
    // session-hydrate time, on the `[sessionID, messagesReady]` transition
    // (history-window.ts:199-208), NOT reactively as new turns are appended to an
    // already-open session. Building all 6 turns live (as this test used to do
    // right up to this point, with no reload) never re-engages it:
    // `scheduleHistoryFill` (src/pages/session.tsx:1072-1088) greedily sets
    // `turnStart` back to 0 any time the rendered content doesn't yet overflow the
    // viewport, and once every turn currently in existence gets un-windowed,
    // nothing ever re-applies `initialTurnStart` again for the rest of that same
    // continuously-open session — only a fresh hydrate does. Confirmed empirically:
    // without this reload, `data-session-rendered-user-count` was `"6"` (all
    // rendered, no windowing) even at the 460px viewport, so the old
    // `renderedBefore < turnCount` assertion failed before the scroll gesture ever
    // happened.
    //
    // A full `page.reload()`, NOT an in-app SPA hop: this shell is a WORKBENCH —
    // leaving a session for the draft view and coming back is a tab refocus, and
    // the backgrounded tab's whole component tree (including its
    // `createSessionHistoryWindow` instance, whose `sessionID()` never changes)
    // stays mounted the entire time, so no re-entry hydrate ever fires (confirmed
    // empirically: after "New Session" → history-back onto the session URL, the
    // draft tab's empty `session-page-root` was still in the DOM next to the
    // session's, and `data-session-rendered-user-count` stayed "6" — no
    // windowing re-engaged). Only a document reload tears the tab down and
    // re-runs the hydrate transition this behavior depends on — which is also
    // this spec's own theme: reload recovery of an existing conversation.
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    // `.filter({ visible: true })` guards against any backgrounded/stale
    // `session-page-root` coexisting with the live one (the same non-determinism
    // this spec's `.last()` convention exists for, made stricter: only the
    // focused tab's root is visible).
    const root = page.locator('[data-testid="session-page-root"]').filter({ visible: true }).last()
    await expect(root).toHaveAttribute("data-session-visible-user-count", String(turnCount), { timeout: 15_000 })
    // turnInit=4 (src/pages/session/history-window.ts) — the window should be showing
    // fewer than all fetched turns while unscrolled, proving windowing (and overflow) is
    // actually engaged.
    const renderedBefore = Number(await root.getAttribute("data-session-rendered-user-count"))
    expect(renderedBefore).toBeLessThan(turnCount)
    await expectNoDuplicateRows(page)

    // Anchor: the turn currently at the top of the rendered window.
    const anchorText = `core turns load older message ${turnCount - renderedBefore + 1}`
    const anchor = page.locator(SELECTORS.userMessageContent).getByText(anchorText, { exact: true })
    await expect(anchor).toBeVisible({ timeout: 10_000 })
    const scroller = page.locator('[data-scrollable]:has([data-slot="session-turn-message-content"])').first()
    // Content-relative offset, not `boundingBox()` (viewport-relative) — see
    // `anchorOffsetWithinScroller`'s doc comment for why: `preserveScroll` only
    // promises to cancel out height added ABOVE the anchor, not the user's own
    // wheel-driven scrollTop movement, and a viewport-relative box conflates both.
    const offsetBefore = await anchorOffsetWithinScroller(scroller, anchor)
    expect(offsetBefore).not.toBeNull()

    // Real wheel-scroll gesture (not a programmatic scrollTop write, which the app's
    // gesture-tracking treats as non-user and snaps back to bottom — see
    // shouldMarkBoundaryGesture / handleListWheel in src/pages/session/message-timeline.tsx).
    //
    // Stop the INSTANT the reveal has fired (rendered-count flips to `turnCount`), not
    // once `scrollTop` merely crosses some threshold: `turnScrollThreshold` in
    // history-window.ts is 200px, and `onScrollerScroll` reveals everything in ONE
    // shot the first time `scrollTop` dips under it (`turnBatch=8` > the 2 remaining
    // windowed-out turns here) — so continuing to send wheel deltas after that point
    // just keeps physically scrolling the now-taller content further, which has
    // nothing to do with `preserveScroll`'s compensation.
    await scroller.hover()
    for (let attempt = 0; attempt < 30; attempt++) {
      await page.mouse.wheel(0, -400)
      const revealed = await root.getAttribute("data-session-rendered-user-count")
      if (revealed === String(turnCount)) break
    }

    // Behavior 9: the older, previously-windowed-out turns get revealed — a real,
    // deterministic wait on the rendered-count attribute (never a bare sleep).
    await expect(root).toHaveAttribute("data-session-rendered-user-count", String(turnCount), { timeout: 10_000 })
    await expectNoDuplicateRows(page)

    // The DOM row count flips as soon as the prepended turns mount, but
    // `preserveScroll`'s compensating `scrollTop` write (src/pages/session/history-
    // window.ts) can land a frame or two later — a real, deterministic wait for the
    // scroller's scrollTop to stop moving (never a bare sleep) so the anchor measurement
    // below samples the settled layout, not a mid-compensation one.
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel) as HTMLElement | null
        if (!el) return false
        const w = window as typeof window & { __e2eScrollSettle?: { last: number; stable: number } }
        const state = w.__e2eScrollSettle ?? { last: el.scrollTop, stable: 0 }
        if (el.scrollTop === state.last) state.stable += 1
        else {
          state.last = el.scrollTop
          state.stable = 0
        }
        w.__e2eScrollSettle = state
        return state.stable >= 3
      },
      '[data-scrollable]:has([data-slot="session-turn-message-content"])',
      { timeout: 5_000, polling: "raf" },
    )

    // Scroll anchor preserved. The TRUE `preserveScroll` contract
    // (src/pages/session/history-window.ts:77-91): when the reveal prepends
    // content, `scrollTop` is compensated by exactly the scroller's
    // `scrollHeight` growth — i.e. by the height of what got prepended — so the
    // user's viewport does not visually jump. Neither raw coordinate is invariant
    // on its own, and both of this test's earlier formulations were therefore
    // wrong oracles (confirmed empirically, deltas quoted from real runs):
    //   - the anchor's viewport-relative `boundingBox().y` also moves with the
    //     user's OWN pre-reveal wheel scrolling (~400px per tick), which is
    //     legitimate and not the app's to cancel (measured drift 400-792px on a
    //     WORKING app);
    //   - the anchor's content-relative offset GROWS by the prepended height by
    //     definition (measured +330px on a WORKING app) — that growth is the
    //     compensation's INPUT, not an error.
    // The discriminating assertion: after settle, `scrollTop` ≈ prependedHeight
    // + (the trigger-zone scrollTop the wheel left behind, which is < the 200px
    // `turnScrollThreshold` by construction — the reveal only fires below it).
    //   - compensation silently no-ops → scrollTop stays < 200 while
    //     prependedHeight ≈ 330 → fails the lower bound;
    //   - snap to very top → scrollTop 0 → fails the lower bound;
    //   - snap back to bottom (autoscroll resuming) → scrollTop ≈
    //     prependedHeight + oldMaxScroll (≫ +200) → fails the upper bound.
    // Measured BEFORE the oracle-proof nudge below so that intentional,
    // temporary scroll doesn't skew this independent assertion.
    const offsetAfter = await anchorOffsetWithinScroller(scroller, anchor)
    expect(offsetAfter).not.toBeNull()
    const prependedHeight = (offsetAfter ?? 0) - (offsetBefore ?? 0)
    expect(prependedHeight, "revealing older turns must add content above the anchor").toBeGreaterThan(0)
    const scrollTopAfter = await scroller.evaluate((el) => el.scrollTop)
    expect(
      scrollTopAfter,
      "preserveScroll must compensate scrollTop by at least the prepended height (no-op/jump-to-top otherwise)",
    ).toBeGreaterThanOrEqual(prependedHeight - 1)
    expect(
      scrollTopAfter,
      "scrollTop after the reveal must stay within the trigger zone above the compensated position (a bottom snap-back would exceed it)",
    ).toBeLessThan(prependedHeight + 250)
    // And the anchor turn the user was looking at is still on screen.
    await expect(anchor).toBeInViewport()

    // Scrolled all the way to the top, the now-revealed oldest turn can land directly
    // underneath the timeline's `sticky top-0 z-30` session-title bar
    // (`data-session-title`, src/pages/session/message-timeline.tsx) — an ordinary CSS
    // stacking interaction (the sticky header legitimately sits above whatever scrolls
    // under it), not a bug, but one the oracle's geometric hit-test correctly refuses to
    // wave through. A small downward nudge (real wheel gesture, matching this spec's own
    // convention) clears the header before the oracle proof.
    await scroller.hover()
    await page.mouse.wheel(0, 120)

    // The earliest turn (previously hidden entirely) is now genuinely rendered — full
    // oracle proof, not just a count.
    await expectAssistantReplyVisible(page, "ack 1: core turns load older message 1")
  })
})
