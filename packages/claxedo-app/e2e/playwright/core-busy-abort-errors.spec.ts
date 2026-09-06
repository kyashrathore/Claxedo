/**
 * Busy turn lifecycle: the Thinking placeholder, Stop/abort, the interrupted divider, the
 * mid-turn retry banner, the error card, and the optimistic-status escalation ladder.
 * Clean first-send/reload/history behavior is `core-first-prompt-local` /
 * `core-turns-reload-recovery`; harness selection is `core-harness-ownership-local`. The
 * harness here is fixed to `opencode`, but a retry status is a plain `session.status` SSE
 * event and is harness-agnostic.
 *
 * Facts these tests lean on (`session-status-dispatcher.ts`, `session-controller.ts`,
 * `message-timeline.data.ts`, under src/features/session):
 *   - Every `session.status` write carries `source: "optimistic" | "server"`, and ANY
 *     server-source write — whatever its value, even another "busy" — clears the
 *     escalation timers. A real backend's own busy ack is therefore already a
 *     reconciliation, which is why the ladder is normally invisible and why the ladder
 *     scenarios have to starve every status producer at once.
 *   - The ladder arms four real `setTimeout`s when an optimistic non-idle status is first
 *     set: redispatch 8s (silent bookkeeping), pending 20s ("Still working…"), long 45s
 *     ("This is taking a while" + Cancel), failed 300s ("unresponsive" + Cancel/Retry).
 *     Reaching a stage rewrites `session.status` to a synthetic `{type:"retry"}` without
 *     clearing the timer chain.
 *   - Two reconciliation paths run beside the SSE stream: accepted-prompt refresh on
 *     delays `[0, 600, 1200, 2400, 4000, 8000, 12000]`ms, and an active-turn poll of the
 *     bulk `/session/status` map that first fires ~60s after the turn goes active. In that
 *     map an absent session key is the wire representation of idle.
 *   - A turn is settled once its assistant message has `time.completed` or an `error`. The
 *     content slot's `aria-hidden` is `workingTurn(...)`, which does NOT require
 *     `session.status` to be idle — so a settled reply stays rendered while the status is
 *     still wrongly "busy" (e2e/INVARIANTS.md #2, the "stale-busy" regression this spec
 *     pins permanently). The composer's busy/"stoppable" state is a separate derivation
 *     that ignores settlement entirely: `status.type === "busy" || "retry"`.
 *   - `error.name === "MessageAbortedError"` is the sentinel that splits a turn around the
 *     interrupted divider; any other `error.name` renders an error surface instead.
 *   - `[data-slot="session-turn-compaction"]` wraps BOTH the "Session compacted" and the
 *     interrupted dividers; only the child `[data-slot="compaction-part-label"]` carries
 *     text that tells them apart.
 *   - Enter on a blank composer while busy is an intentional no-op — `editor-keymap.ts`
 *     returns early on `deps.working() && deps.blank()`, pinned by its "busy-blank guards"
 *     unit case — so it neither submits nor aborts.
 *
 * Submit gating (e2e/INVARIANTS.md #4): the submit control's `data-icon` is the single
 * source of truth for busy vs ready, so readiness is never asserted via `waitForTimeout`.
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, ensureComposerModelSelected, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-busy-abort-errors"
const SESSION_ID = "ses_core_busy_abort_errors"

// The mock's default opencode model is already submit-ready, so pinning is not needed to
// dispatch; it is here so the assertions have a named model to match.
const PIN_MODELS = { opencode: [{ id: "gpt-5", name: "GPT-5" }] }

const SELECTORS_retry = {
  banner: '[data-slot="session-turn-retry"]',
  message: '[data-slot="session-turn-retry-message"]',
} as const

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
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

async function openDraftPrompt(page: Page, dir: string): Promise<Locator> {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

/** Leaves the bulk `/session/status` request permanently unanswered.
 *
 * Answering it is itself a server-source reconciliation: `syncSessionMeta` reads
 * `status[sessionID]` out of that map and dispatches `session.status` from it, falling
 * back to idle when the key is absent — and an idle session IS an absent key on the wire.
 * So the moment the first-fold hydrate resolves, the turn is declared idle no matter how
 * busy it really is. Scenarios that must observe busy state, or that simulate a server
 * which never answers anything, leave the route unresolved; scenarios that only assert the
 * settled end state do not register it at all. */
async function neutralizeStatusPoll(page: Page) {
  await page.route("**/session/status**", () => {
    // Intentionally never fulfilled or continued — any resolved response, including the
    // mock's empty (= all idle) status map, is a premature reconciliation here.
  })
}

/** Bypasses the shared mock's driveTurn entirely (204-accepts the dispatch but never
 * emits any follow-up SSE events) so a busy turn stays busy until the test itself
 * intervenes — removes the race between "does the test click Stop/inject an event
 * before driveTurn's own timers fire" and this shared, sometimes heavily contended,
 * machine's actual wall-clock speed. Used by scenarios that need a turn to stay busy
 * indefinitely (behaviors 3, 5, 8) rather than "busy for long enough". */
async function silencePromptAsync(page: Page) {
  const state: { count: number; lastMessageID?: string } = { count: 0 }
  await page.route("**/session/*/prompt_async**", async (route) => {
    const type = route.request().resourceType()
    if (type !== "fetch" && type !== "xhr") return route.continue()
    state.count += 1
    try {
      const body = route.request().postDataJSON() as { messageID?: string }
      state.lastMessageID = body?.messageID
    } catch {
      // ignore — best-effort capture only
    }
    await route.fulfill({ status: 204, body: "" })
  })
  return state
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

async function sendPrompt(page: Page, input: Locator, text: string) {
  await ensureComposerModelSelected(page)
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
  await page.locator(SELECTORS.submitControl).last().click()
  // The composer's busy/"stop" indicator is derived from `sessionController`,
  // which returns `activeTurn()===false` unconditionally while the route's
  // sessionID is still "new"/undefined (session-controller.ts) — so
  // every busy assertion below is only meaningful once the URL has actually
  // moved onto the created session's route (mirrors core-first-prompt-local's
  // behavior 2 wait).
  await expect(page, "URL never moved onto the created session's route").toHaveURL(sessionUrlPattern(SESSION_ID), {
    timeout: 20_000,
  })
}

const submitIcon = (page: Page) => page.locator(SELECTORS.submitControl).last()

/** `sendPromptRequest` registers the outgoing prompt as an abortable pending prompt
 * BEFORE it awaits `prepareLiveEventsBestEffort` (bounded to 1.5s), and only POSTs
 * `prompt_async` once that resolves and the controller was not aborted meanwhile. Stop
 * clicked inside that pre-dispatch window finds the prompt still pending, flips status to
 * idle optimistically, aborts locally and returns WITHOUT ever calling the network abort —
 * no `prompt_async` POST fires at all. The Thinking row and the "stop" icon are satisfied
 * by the optimistic status alone, so both can already be true inside that window,
 * especially on a fast machine. Waiting until the mock has actually received the dispatch
 * is what makes a test exercise "abort an already-dispatched turn". */
async function waitForDispatchReceived(promptState: { count: number }) {
  await expect.poll(() => promptState.count, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
}

test.describe("core busy / abort / errors @core", () => {
  // This shared box runs several sibling e2e suites concurrently; page loads and
  // reactive updates can lag well beyond a quiet-machine budget. Every assertion
  // below is a real DOM-state poll (never waitForTimeout as the sole guard), so a
  // longer ceiling only affects how long a genuinely stuck state takes to be
  // reported, not correctness.
  test.describe.configure({ timeout: 120_000 })
  test("Thinking renders while busy, then gives way to the visible reply — behavior 1", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      // A wide `delta` sizes the REAL busy window (driveTurn's own timers run on
      // Node-side wall clock regardless of how slow the browser is): busy state ends
      // when the first assistant content lands, at roughly `busy + pending + delta/2`,
      // so 12s leaves ~6s for the Thinking-row/"stop"-icon assertions to resolve under
      // sibling-suite contention while still letting the whole turn settle well inside
      // the oracle's own 20s window.
      timingsMs: { busy: 60, pending: 150, delta: 12_000, completed: 300, idle: 150 },
    })
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "busy abort errors turn one thinking"
    await sendPrompt(page, input, promptText)

    await expect(page.locator(SELECTORS.thinkingRow), "Thinking row never appeared while busy").toBeVisible({
      timeout: 20_000,
    })
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })

    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    await expect(page.locator(SELECTORS.thinkingRow)).toHaveCount(0)
    expect(mock.requests.promptCount).toBe(1)
  })

  test("stale-busy: completed reply stays visible and status reconciles without user action — behavior 2 (PERMANENT)", async ({
    page,
  }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      staleBusy: true,
      timingsMs: { busy: 40, pending: 80, delta: 300, completed: 80, idle: 30 },
    })
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "stale busy regression reply must stay visible"
    await sendPrompt(page, input, promptText)

    // The oracle's three layers include "submit control back to ready" — this is the
    // exact claim the historical regression broke. `session.idle` is never sent by
    // this mock; the canonical live-status route settles after message completion,
    // and accepted-prompt reconciliation must observe that producer without user action.
    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    expect(mock.requests.promptCount).toBe(1)
  })

  test("Stop click aborts the turn and status reconciles optimistically before the network responds — behavior 3", async ({
    page,
  }) => {
    // `holdAbort` — the abort response is withheld until `mock.releaseAbort()` below, so
    // the "BEFORE the network responds" half of this behavior is actually under test
    // rather than assumed (see MockRuntimeOptions.holdAbort's doc comment).
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      holdAbort: true,
    })
    // Registered AFTER installMockRuntime: Playwright resolves the most-recently-added
    // matching route first, so this must come after the shared mock's own
    // prompt_async handler to actually take precedence over it.
    const promptState = await silencePromptAsync(page)
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await sendPrompt(page, input, "abort this turn please")
    await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible({ timeout: 20_000 })
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
    await waitForDispatchReceived(promptState)

    await submitIcon(page).click()

    // Order matters, and is the whole point of behavior 3: first prove the abort request
    // has genuinely reached the network (count incremented) — its response is still being
    // held open by the route's gate — and only THEN assert the submit control is back to
    // ready. Inside that window the only thing that could have moved the control is the
    // client-optimistic `session.status: idle` write, never the round trip.
    await expect.poll(() => mock.requests.abortCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    await expect(
      submitIcon(page),
      "submit control did not return to ready while the abort response was still held open",
    ).not.toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
    expect(promptState.count).toBe(1)

    // Let the held response resolve so the page tears down cleanly and the abort's own
    // follow-up reconciliation is not left permanently pending.
    mock.releaseAbort()
  })

  test("an aborted assistant message renders an Interrupted divider at its position — behavior 5", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS })
    // Registered AFTER installMockRuntime — see the note in the previous test.
    const promptState = await silencePromptAsync(page)
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await sendPrompt(page, input, "please stop before you answer")
    await expect(page.locator(SELECTORS.thinkingRow), "pending assistant row never registered").toBeVisible({
      timeout: 20_000,
    })
    await waitForDispatchReceived(promptState)

    await submitIcon(page).click()
    await expect.poll(() => mock.requests.abortCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    const userID = promptState.lastMessageID
    expect(userID, "mock never recorded the user messageID").toBeTruthy()
    const assistantID = "msg_assistant_manual_abort"
    const now = Date.now()
    mock.emit({
      type: "message.updated",
      properties: {
        sessionID: SESSION_ID,
        info: {
          id: assistantID,
          sessionID: SESSION_ID,
          role: "assistant",
          time: { created: now, completed: now },
          parentID: userID!,
          agent: "build",
          providerID: "opencode",
          modelID: "gpt-5",
          error: { name: "MessageAbortedError", data: { message: "Aborted by user" } },
        },
      },
    })
    mock.emit({ type: "session.idle", properties: { sessionID: SESSION_ID } })

    // The redesigned timeline renders the interrupted-turn divider — a
    // `TimelineRow.TurnDivider` with `label: "interrupted"`
    // (message-timeline.data.ts) — using the duration-aware copy
    // "You stopped after {duration}" (`ui.message.interruptedDuration`,
    // ui/src/i18n/en.ts → message-timeline.tsx) whenever a
    // duration is derivable. The aborted assistant message carries a
    // `time.completed`, so `durationMs` resolves (to 0s here) and this variant
    // is used; the bare "Interrupted" (`ui.message.interrupted`) only appears
    // when no duration can be computed. Either way it is the interrupted
    // divider this behavior asserts, at the aborted message's position.
    const dividerLabel = page.locator('[data-slot="compaction-part-label"]').filter({ hasText: /You stopped after/ })
    await expect(dividerLabel, "Interrupted divider never rendered").toBeVisible({ timeout: 20_000 })
    await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 20_000 })

    // Evidence for a non-oracle claim: this turn intentionally never produces
    // assistant reply text, so we capture the divider directly instead of routing
    // through expectAssistantReplyVisible (which requires assistant text to exist).
    await dividerLabel.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: "test-results/evidence/core-busy-abort-errors/interrupted-divider-at-abort-part-index.png",
    })
  })

  test("Enter on a blank composer while busy is an intentional no-op — behavior 4", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      // This test has the longest probe sequence in the file (two "stop" icon checks
      // separated by the blank-Enter probe and its request-count assertions), and the
      // busy window it needs is REAL now that driveTurn's events are delivered: busy
      // survives until the first assistant content lands, at ~`busy + pending + delta/2`
      // = ~8s here, with the whole turn settling ~16.5s after dispatch — still inside the
      // oracle's 20s window measured from its call site near the END of this test.
      timingsMs: { busy: 60, pending: 150, delta: 16_000, completed: 300, idle: 150 },
    })
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "enter on blank composer must not abort"
    await sendPrompt(page, input, promptText)
    await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible({ timeout: 20_000 })
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
    await waitForDispatchReceived({ get count() { return mock.requests.promptCount } })

    // Composer is cleared on submit — confirm it is genuinely blank before probing
    // the guard, then press Enter while the turn is still busy.
    await expect(input).toHaveText("", { timeout: 20_000 })
    await input.click()
    await page.keyboard.press("Enter")

    // Neither submit nor abort fired: bounded request counts, proven via the mock's
    // request log (never waitForTimeout as the sole guard of this negative).
    await page.waitForTimeout(400)
    expect(mock.requests.promptCount, "Enter-on-blank must not submit a second prompt").toBe(1)
    expect(mock.requests.abortCount, "Enter-on-blank must not call session.abort").toBe(0)
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })

    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
  })

  test("a retry/ACP-recovery status renders the retry banner, then the turn recovers and completes — behavior 6", async ({
    page,
  }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      // `pending` sizes the window in which the injected retry status is the whole
      // truth: driveTurn only creates the assistant message row after `busy + pending`,
      // and once that row carries content the app's own REST reconciliation dispatches
      // `session.status: idle` (source "server") — `conversationHasAssistantMessage` →
      // `dispatchSessionStatusEvent(idle)`, session-controller.ts. Asserting the
      // banner inside the pre-assistant-row stretch keeps the injected status and the
      // mocked server's state consistent with each other; `delta` is then short so the
      // turn still settles well inside the oracle's own 20s window.
      //
      // 10s (not 5s): suite-load cold reconnect often spends ~2s on the events reconnect
      // floor plus ~2s on the draft→session quiet window before the first retry emit can
      // stick. Under that latency a 5s pending window expires before the banner poll sees
      // a rendered row, even though the same scenario is green in isolation.
      timingsMs: { busy: 60, pending: 10_000, delta: 2_000, completed: 300, idle: 150 },
    })
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "recover after an ACP retry"
    await sendPrompt(page, input, promptText)
    await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible({ timeout: 20_000 })

    const retryStatus = {
      type: "retry" as const,
      attempt: 1,
      message: "Reconnecting to the ACP client",
      next: Date.now() + 2_000,
    }
    // Emitted on a poll rather than once because the FIRST emit lands DURING the
    // consumer's reconnect gap, not because it is lost. An instrumented run showed the
    // emit issued immediately after the Thinking row appears leaves the banner absent for
    // ~2.5s, while a re-emit ~2s later applies within 500ms and sticks. Nothing drops the
    // frame: the mock's `EventBus` is an append-only log and `ClaxedoEventsProvider`
    // reconnects with its own `Last-Event-ID`. What the poll absorbs is claxedo-app's ~2s
    // reconnect floor (`app/providers/claxedo-events-reconnect.ts`) plus the 2s
    // session-switch quiet window the draft→session navigation arms
    // (`platform/runtime/session-switch.ts`) — a latency property of the consumer's
    // reconnect policy, not app behavior. Re-emitting is harmless for this frame
    // (`session.status` is a state assignment: applying "retry" twice equals applying it
    // once). The poll stops emitting the moment the banner exists, and nothing re-emits
    // during the oracle below, so this can never mask the oracle's "submit control back to
    // ready" layer.
    const retryBanner = page.locator(SELECTORS_retry.banner)
    // The message is asserted INSIDE the poll: the banner only lives for the
    // pre-assistant-row stretch (`pending`), and on a starved CI runner the
    // poll can first see it near the end of that window — a separate
    // toBeVisible afterwards then races the banner's own removal and fails on
    // an already-proven render.
    await expect
      .poll(
        async () => {
          mock.emit({ type: "session.status", properties: { sessionID: SESSION_ID, status: retryStatus } })
          if ((await retryBanner.count()) === 0) return ""
          return await page.locator(SELECTORS_retry.message).textContent() ?? ""
        },
        { timeout: 20_000, intervals: [500], message: "retry banner never rendered on status:retry" },
      )
      .toContain("Reconnecting to the ACP client")

    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    expect(mock.requests.promptCount).toBe(1)
  })

  test("a non-abort assistant error renders an error card with the JSON envelope unwrapped — behavior 7", async ({
    page,
  }) => {
    const errorEnvelope = JSON.stringify({
      error: { type: "overloaded_error", message: "The server is overloaded, please retry later." },
    })
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      errorMidTurn: errorEnvelope,
      timingsMs: { busy: 40, pending: 80, delta: 200, completed: 80, idle: 30 },
    })
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await sendPrompt(page, input, "trigger a mid-turn error")

    // Every non-abort turn error renders as the FirstTurnRecoveryCard, not the legacy bare
    // `.error-card` — that fallback is unreachable because `sessionRecoveryClass`
    // (first-turn-recovery.ts) always returns a class, "unknown" at worst. The JSON
    // envelope still unwraps to "<type>: <message>" and is shown in the card's collapsed
    // raw detail; this error classifies as "unknown" because it matches none of the
    // credential/session/harness/model/workspace regexes.
    // Keep this locator pinned to the original failed turn. Resending creates a
    // second legitimate failed turn and therefore a second recovery card.
    const errorCard = page.getByTestId("first-turn-recovery-card").first()
    await expect(errorCard, "recovery/error card never rendered").toBeVisible({ timeout: 20_000 })
    await expect(errorCard).toHaveAttribute("data-recovery-class", "unknown")
    await expect(errorCard).toContainText("overloaded_error: The server is overloaded, please retry later.")

    // Submit control returns to ready even though no assistant text ever rendered —
    // both the SSE session.error path and the REST reconciliation path
    // (conversationHasAssistantMessage sees `error`) drive this.
    await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 20_000 })
    expect(mock.requests.promptCount).toBe(1)

    const original = mock.requests.promptBodies[0]
    await errorCard.getByRole("button", { name: "Resend last prompt" }).click()

    await expect.poll(() => mock.requests.promptCount, {
      timeout: 15_000,
      message: "first-turn recovery did not resubmit the failed prompt",
    }).toBe(2)
    expect(mock.requests.createSessionCount).toBe(1)
    expect(mock.requests.promptBodies[1]?.sessionID).toBe(SESSION_ID)
    expect(mock.requests.promptBodies[1]?.sessionID).toBe(original?.sessionID)
    expect(mock.requests.promptBodies[1]?.text).toBe(original?.text)

    await errorCard.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: "test-results/evidence/core-busy-abort-errors/error-card-json-envelope-unwrapped.png",
    })
  })

  test("a persisted turn-admission conflict renders compact status text instead of an error card", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      errorMidTurn: "Session is already processing a message",
      timingsMs: { busy: 40, pending: 80, delta: 200, completed: 80, idle: 30 },
    })
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await sendPrompt(page, input, "replay a persisted turn admission conflict")

    const status = page.getByTestId("turn-admission-status-message")
    await expect(status).toBeVisible({ timeout: 20_000 })
    await expect(status).toContainText("Message wasn’t sent")
    await expect(status).toContainText("The previous message was still finishing. Try again.")
    await expect(page.getByTestId("first-turn-recovery-card")).toHaveCount(0)
    await expect(page.locator(".error-card")).toHaveCount(0)
    await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 20_000 })
    expect(mock.requests.promptCount).toBe(1)
  })

  test(
    "escalation ladder: a genuinely silent server surfaces pending then long, and Cancel aborts — behavior 8",
    async ({ page }) => {
      test.setTimeout(300_000)
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS })
      // Registered AFTER installMockRuntime — see the note in behavior 3's test:
      // Playwright resolves the most-recently-added matching route first.
      await silencePromptAsync(page)

      // Simulate a backend that accepts the dispatch and then goes completely silent: no
      // SSE session.status/session.idle ever (silencePromptAsync above), and
      // /session/status never resolves at all. Every reconciliation path has to be starved
      // at once, because any server-source status event — including the mock's normal
      // early busy ack — otherwise clears the optimistic escalation timers within
      // milliseconds of every send. Two paths are starved here: the ~1.5s first-fold
      // hydrate (see neutralizeStatusPoll) and the slower ~60s active-turn status poll.
      await neutralizeStatusPoll(page)

      await seedOneProject(page, DIR)
      const input = await openDraftPrompt(page, DIR)
      await sendPrompt(page, input, "is anyone still there")

      await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible({ timeout: 20_000 })

      const stage = page.getByTestId("session-status-stage")
      // OPTIMISTIC_STATUS_PENDING_MS=20s measured from the optimistic-busy-set moment
      // (right after send, above) — not from here — so a generous ceiling absorbs both
      // that head start and this box's contention rather than assuming a tight budget.
      await expect(stage, "pending stage (~20s) never appeared").toBeVisible({ timeout: 90_000 })
      await expect(stage).toHaveAttribute("data-stage", "pending")
      await expect(stage).toContainText("Still working")

      await expect(stage).toHaveAttribute("data-stage", "long", { timeout: 90_000 })
      await expect(stage).toContainText("taking a while")

      await page.locator('[data-action="session-status-cancel"]').click()
      await expect(stage, "escalation banner did not clear after Cancel").toHaveCount(0, { timeout: 15_000 })
      await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
      await expect.poll(() => mock.requests.abortCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    },
  )

  test(
    "escalation ladder reaches the failed/unresponsive stage with Cancel and Retry — behavior 8",
    async ({ page }) => {
      // The "failed" stage otherwise fires at OPTIMISTIC_STATUS_FAILURE_MS =
      // 5 * 60_000 of real wall-clock (session-status-dispatcher.ts), impractical
      // at CI speed. Instead of freezing time (page.clock would also stall the mock's
      // SSE reconnect backoff), we set the dispatcher's gated `__claxedoStatusTimerScale`
      // hook BEFORE first navigation so ONLY the four escalation delays scale down
      // proportionally — order between stages is preserved, so this reaches "failed"
      // through the exact same redispatch→pending→long→failed timer ladder the
      // "pending"/"long" test above proves, just faster. The mock's own backoff timer
      // is untouched.
      const STATUS_TIMER_SCALE = 0.02 // redispatch 160ms · pending 400ms · long 900ms · failed 6s
      await page.addInitScript((scale: number) => {
        ;(window as typeof window & { __claxedoStatusTimerScale?: number }).__claxedoStatusTimerScale = scale
      }, STATUS_TIMER_SCALE)

      test.setTimeout(120_000)
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS })
      const promptState = await silencePromptAsync(page)
      await neutralizeStatusPoll(page)

      await seedOneProject(page, DIR)
      const input = await openDraftPrompt(page, DIR)

      // First send creates the session and moves the URL onto its route. The Retry
      // affordance is only meaningful once the composer's scope is stable: the
      // draft→session handoff replaces the draft ("new-session" variant) composer
      // with the session ("dock" variant) one, and the "last submitted prompt"
      // snapshot that Retry restores lives per composer instance — it is dropped by
      // the instance swap and re-armed by `createPromptInputSubmitRetry`'s `resetKey`
      // effect (`src/features/session/composer/ui/submit-ui-state.ts`, keyed on
      // `composerBootScope`) on every scope change. So we drive the realistic
      // hang→cancel→resend flow: the SECOND send below arms the snapshot on the
      // already-settled session composer.
      await sendPrompt(page, input, "is anyone still there")
      await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 20_000 })
      // The URL moving is NOT the same event as the composer's own scope settling —
      // it is the app-shell route that follows the handoff, and the composer swap can
      // land after it on a slow runner. Assert the composer surface itself has left
      // draft mode (`data-component`, `composer/ui/frame.tsx`, driven by the same
      // `modeSnapshot` memo that feeds `composerBootScope`): without this precondition
      // the second send's Retry snapshot can be armed on the draft instance and then
      // dropped by the swap, leaving the failed-stage banner with Cancel but no Retry.
      await expect(
        page.locator('[data-component="session-new-composer"]'),
        "draft composer never handed off to the session composer",
      ).toHaveCount(0, { timeout: 20_000 })
      await expect(page.locator('[data-component="session-composer"]').last()).toBeVisible({ timeout: 20_000 })
      // See waitForDispatchReceived's doc comment: Stop clicked inside the
      // pre-dispatch window takes the local `takePendingPrompt` short-circuit and the
      // turn's own send pipeline never runs to completion — its late continuation
      // (`sendPromptRequest`'s post-dispatch reconcile, `src/features/session/submit/
      // send.ts`) would then land during the SECOND turn and clear its optimistic
      // status meta, which is what silently deletes the escalation banner mid-ladder.
      // Wait for the mock to have actually received turn one's dispatch so the cancel
      // below is the "abort an already-dispatched turn" path this scenario intends.
      await waitForDispatchReceived(promptState)

      await submitIcon(page).click()
      await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 15_000 })

      await input.click()
      await input.fill("still nothing?")
      // The submit button and the editor are the same form; assert the editor has
      // actually committed the text before submitting, so the click cannot land on an
      // empty composer (a blank submit arms no Retry snapshot and starts no turn).
      await expect(input).toContainText("still nothing?", { timeout: 10_000 })
      await page.locator(SELECTORS.submitControl).last().click()
      await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 20_000 })
      // The escalation ladder below only measures the intended scenario once the
      // second turn has genuinely reached the (silent) server: a turn still inside the
      // pre-dispatch window is optimistically busy but not yet dispatched.
      await expect.poll(() => promptState.count, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)

      const stage = page.getByTestId("session-status-stage")
      // The banner appears (pending/long — proven as a stepped ladder by the
      // sibling behavior-8 test above at real timers) and then reaches the terminal
      // "failed" stage. We assert the terminal stage directly rather than pinning the
      // pending→long transitions here: setup latency (send → thinking) is NOT scaled,
      // so on a slow runner the intermediate stages can already have elapsed before
      // these checks run. "failed" is stable (rank 4, never advances) until Cancel, so
      // this is deterministic regardless of runner speed.
      await expect(stage, "escalation banner never appeared").toBeVisible({ timeout: 30_000 })
      await expect(stage).toHaveAttribute("data-stage", "failed", { timeout: 30_000 })
      await expect(stage).toContainText("unresponsive")

      await expect(page.locator('[data-action="session-status-cancel"]')).toBeVisible()
      await expect(
        page.locator('[data-action="session-status-retry"]'),
        "failed stage offered Cancel but no Retry — the composer's last-submitted snapshot was dropped",
      ).toBeVisible()

      await page.locator('[data-action="session-status-cancel"]').click()
      await expect(stage, "escalation banner did not clear after Cancel").toHaveCount(0, { timeout: 15_000 })
      await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
      await expect.poll(() => mock.requests.abortCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    },
  )
})
