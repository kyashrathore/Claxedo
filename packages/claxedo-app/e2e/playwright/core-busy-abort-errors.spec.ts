/**
 * SPEC: Busy turn lifecycle — thinking, abort, interruption, retry, error, escalation
 *
 * PURPOSE — while an assistant turn is in flight the user needs continuous, truthful
 * feedback about what the runtime is doing (thinking, retrying, erroring, stuck) and a
 * reliable way to stop it. This spec owns everything that happens to a turn AFTER
 * dispatch and BEFORE/INSTEAD OF a clean completion: the busy "Thinking" placeholder,
 * the never-hide-completed-content guarantee (the historically-broken "stale-busy"
 * regression), the two independent ways a turn ends early (Stop click, and the
 * deliberately inert Enter-on-blank guard), the "Interrupted" divider an aborted turn
 * leaves behind, the mid-turn retry/ACP-recovery banner, the error card, and the
 * multi-stage "the server went completely silent" escalation ladder. Clean
 * first-send/reload/history behavior is `core-first-prompt-local` /
 * `core-turns-reload-recovery`; harness selection is `core-harness-ownership-local`.
 *
 * STATE MODEL —
 *   - `session.status` (SDK type `SessionStatus`) is cached in TanStack Query at
 *     `shellDataKeys.sessionId(sessionID, "status")`, written ONLY through
 *     `dispatchSessionStatusEvent` (`src/session/store/session-status-dispatcher.ts:86-98`).
 *     Every write carries a `source: "optimistic" | "server"`. `"optimistic"` writes
 *     happen client-side the instant a prompt is dispatched (`sendPromptRequest`,
 *     `src/session/submit/send.ts:83-87,103-107`) or aborted
 *     (`src/components/prompt-input/submit-abort.ts:40`, BEFORE the network abort call
 *     resolves — abort is itself optimistic/instant). `"server"` writes come from the
 *     `/global/event` SSE stream (`session.status`, `session.idle`, `session.error` —
 *     `applySessionStatusSseEvent`, session-status-dispatcher.ts:120-166) or from a
 *     direct `GET /session/:id/status` response.
 *   - ANY server-source status write — regardless of its value, even another "busy" —
 *     clears the four escalation timers below (session-status-dispatcher.ts:92-97,
 *     "one contract for session-status writes"). This is why the escalation ladder is
 *     normally invisible: a real backend's own busy ack already counts as
 *     reconciliation.
 *   - Escalation ladder: `schedulePromptSessionStatusTimeouts`
 *     (session-status-dispatcher.ts:184-195) arms 4 real `setTimeout`s the moment an
 *     OPTIMISTIC non-idle status is first set: `redispatch`@8s (silent bookkeeping,
 *     `OPTIMISTIC_STATUS_REDISPATCH_MS`), `pending`@20s ("Still working…",
 *     `OPTIMISTIC_STATUS_PENDING_MS`), `long`@45s ("This is taking a while" + Cancel,
 *     `OPTIMISTIC_STATUS_LONG_MS`), `failed`@300s ("unresponsive" + Cancel/Retry,
 *     `OPTIMISTIC_STATUS_FAILURE_MS`). Reaching a stage rewrites `session.status` to a
 *     synthetic `{type:"retry", ...}` for `pending`/`long`/`failed`
 *     (`statusForTimeoutStage`, session-status-dispatcher.ts:284-309) — itself a
 *     "server"-shaped write in the sense that it flows through the SAME status cache,
 *     but it is dispatched WITHOUT clearing the timer chain (`dispatchSessionStatusTimeoutStage`
 *     only advances `stage` bookkeeping, session-status-dispatcher.ts:168-182).
 *   - Independent of the ladder AND of the `session.idle` SSE event, an assistant
 *     message becoming non-empty (parts.length>0) or carrying an `error` is enough for
 *     `requestAcceptedPromptRefresh` (`src/session/store/accepted-prompt-refresh.ts`,
 *     consumed by an effect in `src/session/store/session-controller.ts:806-830`) to
 *     force-resync the session over REST (`syncCompatSession`, retry delays `[0, 600,
 *     1200, 2400, 4000, 8000, 12000]`ms — `ACCEPTED_PROMPT_REFRESH_ATTEMPT_DELAYS_MS`,
 *     session-controller.ts:137) and dispatch a `session.status: idle` (source
 *     "server") the moment `conversationHasAssistantMessage` (session-controller.ts:65-71)
 *     sees content. THIS is the mechanism that reconciles "stale-busy" without user
 *     action, decoupled from the missing `session.idle` SSE event.
 *   - A THIRD, independent reconciliation path also exists: while a turn is active,
 *     `useQuery` at `session-controller.ts:898-932` runs a "get the real status once,
 *     ~60s after the turn went active" poll (`waitForFirstActiveSessionStatusPoll`,
 *     `ACTIVE_SESSION_STATUS_POLL_DELAY_MS=60_000`, session-controller.ts:135,152-161),
 *     then `refetchInterval: ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS` (5s) thereafter.
 *     Its queryFn (`refreshMeta`→`syncSessionMeta`, session-controller.ts:879-896)
 *     hits `GET /session/:id/status` directly — a resolved response of ANY shape
 *     (including an empty one, which the status query's own fallback treats as
 *     `{type:"idle"}`) reconciles the session regardless of message content. The
 *     escalation-ladder scenario below must starve THIS path too (by never letting
 *     `/session/status` resolve at all), not just the other two.
 *   - Timeline "settled" state: `assistantMessageSettled(message)` is
 *     `typeof message.time.completed === "number" || !!message.error`
 *     (`src/pages/session/message-timeline.data.ts:372-374`). `workingTurn(userMessageID)`
 *     (`src/pages/session/message-timeline.tsx:1030-1033`) is
 *     `sessionStatus().type !== "idle" && activeMessageID() === userMessageID &&
 *     !turnSettled(userMessageID)` — note it does NOT require `session.status` to be
 *     idle, only that the turn is unsettled. The assistant-content slot's
 *     `aria-hidden` is exactly `workingTurn(...)` (message-timeline.tsx:1250) — so a
 *     settled message is shown even while `session.status` is still (wrongly) "busy".
 *     This is invariant #2 in `e2e/INVARIANTS.md` and the historically-regressed
 *     behavior this spec exists to pin permanently.
 *   - Composer busy/"stoppable" state is a SEPARATE derivation that does NOT consult
 *     message settlement at all: `working` in `src/session-client/composer/composer.tsx:324-328`
 *     is `status()?.type === "busy" || status()?.type === "retry"` (or
 *     `sessionController.activeTurn()`, `src/session/store/session-controller.ts:606-614`,
 *     which computes the identical thing from `isSessionTurnActive`). This is why the
 *     stale-busy reconciliation above matters for the SUBMIT CONTROL specifically —
 *     without it, the submit button would stay stuck on the "stop" icon forever even
 *     though the reply is visible.
 *   - Interrupted-turn state lives entirely in the assistant `Message.error` field:
 *     `{name: "MessageAbortedError"}` is the sentinel `Timeline.constructMessageRows`
 *     (message-timeline.data.ts:153) looks for to split the turn's parts around an
 *     "Interrupted" divider; any OTHER `error.name` becomes a plain error card
 *     instead (message-timeline.data.ts:155).
 *
 * ANATOMY —
 *   `[data-slot="session-turn-thinking"]` — the busy placeholder row; visible when
 *     `isActive && status==="busy" && !settled && !error` for the active turn
 *     (message-timeline.data.ts:229-241), independent of whether any part has
 *     streamed yet unless `showReasoningSummaries` is on.
 *   `[data-slot="session-turn-assistant-content"]` — assistant reply container;
 *     `aria-hidden` mirrors `workingTurn(...)` (see STATE MODEL). Proven only via
 *     `expectAssistantReplyVisible` (e2e/helpers/turn-oracle.ts).
 *   `[data-action="prompt-submit"]` — the single send/stop button;
 *     `data-icon="stop"` while `working()` is true (submit-control.tsx:46); clicking it
 *     while busy AND the composer is blank routes through `handleSubmit` →
 *     `admitPromptSubmission` → `"abort-active"` → `abort()`
 *     (src/components/prompt-input/submit.ts:292,
 *     src/session-client/commands/prompt-machine.ts:85-94).
 *   `[data-slot="session-turn-compaction"]` — the shared wrapper for BOTH the
 *     "Session compacted" and "Interrupted" turn dividers (message-timeline.tsx:1227-1242
 *     — same data-slot regardless of `label`); the child
 *     `[data-slot="compaction-part-label"]` (packages/session-ui/src/components/message-part.tsx:1579-1591)
 *     carries the actual text ("Interrupted" / "Session compacted") and is the only
 *     reliable way to distinguish the two.
 *   `[data-slot="session-turn-retry"]` / `[data-slot="session-turn-retry-message"]` /
 *     `[data-slot="session-turn-retry-info"]` — the retry/ACP-recovery banner
 *     (packages/session-ui/src/components/session-retry.tsx via
 *     `src/components/session/claxedo-session-retry.tsx`), rendered when
 *     `isActive && sessionStatus().type === "retry"` (message-timeline.data.ts:243) with
 *     `show` gated to the active turn's user message.
 *   `.error-card` (a `Card variant="error"` with no dedicated data-slot, inside
 *     `[data-slot="session-turn-message-container"]`) — renders `unwrapErrorMessage(...)`
 *     of any assistant `error` whose `name !== "MessageAbortedError"`
 *     (message-timeline.data.ts:262-272,316-361); JSON-envelope error bodies
 *     (`{"error":{"type":...,"message":...}}`, optionally double-JSON-encoded) unwrap to
 *     `"<type>: <message>"`.
 *   `[data-testid="session-status-stage"][data-stage="pending"|"long"|"failed"]` — the
 *     escalation ladder banner mounted beside the submit control
 *     (src/claxedo-ui/components/session-status-stage.tsx); hidden for
 *     `undefined`/`"redispatch"`. `[data-action="session-status-cancel"]` calls the same
 *     `abort()` as the Stop button; `[data-action="session-status-retry"]` (only at
 *     `"failed"`, only if a retry callback was supplied) re-submits the last prompt.
 *
 * BEHAVIORS —
 *   1. While a turn is busy, `[data-slot="session-turn-thinking"]` is visible; once the
 *      turn settles it disappears and the reply renders (oracle).
 *   2. PERMANENT, never `test.skip`: "stale-busy" — the assistant message reaches
 *      `time.completed` but the `session.idle` SSE event is never sent. The reply is
 *      still visibly rendered (DOM+geometric+evidence) and the submit control returns
 *      to ready WITHOUT any user action, reconciled by the REST-polling mechanism in
 *      STATE MODEL, not by the missing SSE event.
 *   3. Clicking the submit control while busy (its `data-icon` is `"stop"`) aborts the
 *      turn: `session.status` flips to idle IMMEDIATELY (optimistic, before any network
 *      response), a `POST /session/:id/abort` fires, and the submit control returns to
 *      ready without waiting on that network round trip.
 *   4. Pressing Enter on a BLANK composer while a turn is busy is an intentional no-op:
 *      it neither submits nor aborts (`editor-keymap.ts:175-181`'s
 *      `if (deps.working() && deps.blank()) return` guard, pinned by
 *      `editor-keymap.test.ts:211-235`'s "busy-blank guards" case) — the turn continues
 *      completely undisturbed and eventually completes normally (oracle). NOTE: this
 *      contradicts the plan's prose ("Enter-on-blank-composer aborts"); this test pins
 *      the behavior actually implemented in source — see this task's findings.
 *   5. When an assistant message in a turn carries `error.name === "MessageAbortedError"`,
 *      an "Interrupted" divider (`[data-slot="compaction-part-label"]` text
 *      "Interrupted") renders at that message's position in the turn.
 *   6. A `session.status: {type:"retry", message, ...}` event while a turn is active
 *      renders the retry/ACP-recovery banner with that message; the turn can still
 *      recover and complete normally afterward (oracle).
 *   7. An assistant message error whose `name !== "MessageAbortedError"` renders an
 *      error card (`.error-card`) with the JSON-envelope error unwrapped to
 *      `"<type>: <message>"`, and the submit control returns to ready.
 *   8. Escalation ladder: when the optimistic busy status is never confirmed by ANY
 *      server-source event (no SSE `session.status`/`session.idle`, no assistant
 *      content ever appearing over REST), `[data-testid="session-status-stage"]`
 *      progresses `"pending"` ("Still working…") at ~20s then `"long"` ("This is
 *      taking a while" + Cancel) at ~45s; clicking Cancel at `"long"` aborts the turn
 *      (status flips to idle, the banner disappears) exactly like the Stop button. The
 *      `"failed"` stage would otherwise take 5 minutes of real wall clock, so a second
 *      test reaches it by scaling ONLY the four escalation delays through the
 *      dispatcher's gated `__claxedoStatusTimerScale` hook; at that terminal stage BOTH
 *      Cancel and Retry are offered. BOTH tests run LIVE (neither is `test.fixme`): the
 *      two app defects that once forced them to be skipped — a duplicate `Session()`
 *      mount surviving the first send, and a non-reactive `statusStage` read in the
 *      composer — are fixed; see the pending/long test's own comment for the fixes.
 *
 * INVARIANTS — (see e2e/INVARIANTS.md #2, verbatim here because this spec is its
 *   primary owner) Once an assistant message's `time.completed` is set or it carries
 *   an `error`, the turn is settled and its content slot renders regardless of what
 *   `session.status` is doing — the "stale-busy" scenario (behavior 2) is PERMANENT,
 *   never skipped. Submit gating (INVARIANTS.md #4): the submit control's `data-icon`
 *   is the single source of truth for busy vs ready; this spec never asserts readiness
 *   via `waitForTimeout`, only via the control's actual attribute or a testid's
 *   presence.
 *
 * HARNESS NOTES — this spec fixes the harness to `opencode` (the default). Retry
 *   banners are described in the plan as "ACP-recovery" because ACP harnesses are the
 *   most common real-world source of `status:"retry"`, but the mechanism itself is
 *   harness-agnostic (a plain `session.status` SSE event) — per-harness retry shapes
 *   are not this spec's concern.
 *
 * OUT OF SCOPE — first-send/reload/history/dispatch-failure-retry
 *   (`core-first-prompt-local`, `core-turns-reload-recovery`); harness-specific abort
 *   capability gating (`core-harness-ownership-local` behavior 7); permission/question
 *   docks (`core-docks`); tool-part rendering, diff summaries
 *   (`core-timeline-rendering-scroll`).
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-busy-abort-errors"
const SESSION_ID = "ses_core_busy_abort_errors"

// MODEL PINNING — the reason is NOT what earlier copies of this comment claimed.
// The mock's default opencode model is `big-pickle-1` (`BIG_PICKLE`,
// mock-runtime.ts:476), a real versioned id. The submit block matches ONLY the bare
// pair `opencode` + `big-pickle` (`isSignedWorkspaceDefaultModel`,
// src/features/session/composer/signed-workspace-model.ts:18-20), so the mock default
// is already submit-ready and pinning is NOT required to dispatch. Pinning here is for
// DETERMINISM — a named model the assertions can match — not to unblock submit.
const PIN_MODELS = { opencode: [{ id: "gpt-5", name: "GPT-5" }] }

// SSE DELIVERY — no spec-local bridge exists (or is needed) here. A previous revision
// of this file carried one, justified by a "CONFIRMED SHARED-MOCK GAP" claiming
// `installMockRuntime` only mounts `/api/wr/events` behind its `cloud: {...}` option and
// that `mock.emit()` was therefore a silent no-op for this spec's local sessions. That
// claim is FALSE against the current helper: mock-runtime.ts mounts
// `**/api/wr/events**` and `**/api/wr/runtime-events**` UNCONDITIONALLY on the primary
// origin (mock-runtime.ts:1191-1192), fed by the shared `FanoutBus` that `emit()` writes
// to; the `if (cloud)` block only begins at mock-runtime.ts:1637 and adds the
// relay-origin/workspace-prefixed copies on top. `/w/<dir>/session/<id>` is exactly the
// route shape that channel serves.
//
// The bridge was actively HARMFUL: it registered its own `**/api/wr/events**` handler
// AFTER `installMockRuntime`, and Playwright resolves routes last-registered-first, so it
// SHADOWED the working shared channel. driveTurn's real events (busy ack → message
// deltas → completed → idle) could then never reach the app, which is what forced the
// companion `relaySettledReplyOverBridge` Node-side re-emit workaround. Both are gone;
// behaviors 1, 4 and 6 now exercise genuine SSE-driven completion through the shared
// mock, matching e2e/INVARIANTS.md authoring rule #1 ("shared helpers only").

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

async function openDraftPrompt(page: Page, dir: string): Promise<Locator> {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

/** `POST /session/:id/abort` is now owned by the shared mock — `mock.requests.abortCount`
 * counts it and `installMockRuntime({ holdAbort: true })` + `mock.releaseAbort()` provide
 * the held-open response behavior 3 needs. The spec-local `registerAbortRoute` that used
 * to live here was a standing violation of e2e/INVARIANTS.md authoring rule 1, and it
 * answered `200 {}` where the real route answers 200 with an `AbortResult`
 * (`{ ok, status }`, workspace-runtime session-core.ts:769-782); `core-composer-modes`
 * had a third, `204`-answering copy. All three are gone. */

/** Starves the bulk `/session/status` endpoint for the scenarios that need an optimistic
 * busy status to outlive the first-fold hydrate.
 *
 * This is NOT a workaround for a mock bug — though the history here is worth keeping
 * straight, because two revisions of this comment have now been wrong in opposite
 * directions. The first asserted a "verified, reproducible SHARED-MOCK BUG": that
 * `installMockRuntime` registered `page.route("**​/session/status", ...)` without a
 * trailing wildcard, so the app's `?directory=…` request fell through to the
 * `**​/session/*` catch-all and got a session row. The second declared that FALSE on the
 * grounds that the wildcard was present. The wildcard WAS present — and the request was
 * still being answered with a session row, because the catch-all is registered later and
 * Playwright matches most-recently-registered-first. The catch-all now hands
 * `/session/status` back (see its comment in mock-runtime.ts), so the route finally
 * serves a real status map: by default an EMPTY one, since an idle session is an absent
 * key on the wire (e2e/helpers/contracts/session-status.ts). Every consumer decodes an
 * absent key exactly as it decoded the unusable session row — as idle — so nothing in
 * this spec's behavior moved.
 *
 * The reason to starve it is simpler and is a property of the SCENARIO, not a defect:
 * that idle answer is itself a server-source reconciliation.
 * `syncSessionMeta` (`src/features/session/store/session-controller.ts:333-397`) reads
 * `status[sessionID]` and dispatches `session.status` from it (falling back to
 * `idleSessionStatus`, :390), so as soon as the hydrate resolves the turn is declared
 * idle regardless of how busy it really is. Tests that must OBSERVE busy state
 * (behaviors 1/3/4/5/6) or that simulate a server which never answers anything
 * (behavior 8) therefore leave this route unresolved; tests that only care about the
 * settled end state (behaviors 2/7) do not register it at all. */
async function neutralizeStatusPoll(page: Page) {
  await page.route("**/session/status**", () => {
    // Intentionally never fulfilled/continued — any resolved response, including the
    // mock's empty (= all idle) status map, is a premature reconciliation for these
    // scenarios. See the comment above.
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
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
  await page.locator(SELECTORS.submitControl).last().click()
  // The composer's busy/"stop" indicator is derived from `sessionController`,
  // which returns `activeTurn()===false` unconditionally while the route's
  // sessionID is still "new"/undefined (session-controller.ts:606-614) — so
  // every busy assertion below is only meaningful once the URL has actually
  // moved onto the created session's route (mirrors core-first-prompt-local's
  // behavior 2 wait).
  await expect(page, "URL never moved onto the created session's route").toHaveURL(sessionUrlPattern(SESSION_ID), {
    timeout: 20_000,
  })
}

const submitIcon = (page: Page) => page.locator(SELECTORS.submitControl).last()

/** Confirmed root cause (this task's investigation, verified via request-log
 * instrumentation): `sendPromptRequest` (src/session/submit/send.ts:82-118)
 * registers the outgoing prompt as an abortable "pending prompt"
 * (registerPendingPrompt, send.ts:90-93) BEFORE it awaits
 * `prepareLiveEventsBestEffort` (send.ts:94, bounded to
 * `LIVE_EVENT_READY_TIMEOUT_MS=1_500`ms) and only calls `dispatchPrompt` (the
 * actual `POST .../prompt_async`) after that resolves AND
 * `controller.signal.aborted` is false (send.ts:95-97). If Stop is clicked
 * inside that pre-dispatch window, `createPromptAbort`
 * (src/components/prompt-input/submit-abort.ts:42-47) finds the prompt still
 * "pending", flips status to idle optimistically, calls
 * `queued.abort.abort()`, and returns WITHOUT ever calling
 * `client.session.abort()` over the network — so `sendPromptRequest`'s
 * `dispatchPrompt` is skipped entirely (no `prompt_async` POST EVER fires,
 * confirmed via a full request-log capture). This is arguably correct
 * app behavior (nothing was dispatched yet, so there is nothing to abort
 * server-side) but it races directly against this spec's Thinking-row/"stop"-
 * icon checks, which are satisfied by the OPTIMISTIC status alone and can
 * both be true before `prepareLiveEventsBestEffort` resolves — especially
 * on a fast machine. Waiting for the mock to have actually RECEIVED the
 * dispatch (`promptState.count`) before clicking Stop removes the race and
 * matches what behaviors 3/5/8 actually intend to test: aborting an
 * already-dispatched turn. See this task's findings for the recommended
 * shared-helper-level fix (a `dispatchReceived` handle on
 * `silencePromptAsync`'s return value). */
async function waitForDispatchReceived(promptState: { count: number }) {
  await expect.poll(() => promptState.count, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
}

// ESCALATION-LADDER KEEP-ALIVE — deliberately absent. A previous revision periodically
// re-emitted a server-source `session.status` to keep the escalation timers
// (`schedulePromptSessionStatusTimeouts`, pending@20s) from firing during long busy
// windows, because the shadowing SSE bridge meant driveTurn's own busy ack never reached
// the app. With the bridge gone that ack IS delivered (~`timings.busy` ms after dispatch)
// and clears the timer chain per the dispatcher's own contract — the timers only re-arm
// on a fresh OPTIMISTIC non-idle write, i.e. on the next send. Re-adding a keep-alive
// would also fight the oracle's "submit control back to ready" layer, since a late tick
// can re-assert busy after `session.idle` has already landed.

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
    // See neutralizeStatusPoll's doc comment: without this the mock's (correct)
    // `/session/status` idle answer reconciles this turn moments after send, well
    // before this test's "stop" icon assertion below runs.
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "busy abort errors turn one thinking"
    await sendPrompt(page, input, promptText)

    await expect(page.locator(SELECTORS.thinkingRow), "Thinking row never appeared while busy").toBeVisible({
      timeout: 20_000,
    })
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })

    // Genuine SSE-driven completion: driveTurn's busy ack, message deltas, completed
    // and idle events all arrive over installMockRuntime's `/api/wr/events` channel —
    // no spec-local relay, no REST-reconciliation fallback standing in for it.
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
    // exact claim the historical regression broke. `session.idle` is NEVER sent by
    // this mock (staleBusy:true); reconciliation instead comes from the REST-polling
    // mechanism in STATE MODEL, which this assertion proves end to end.
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
    // See neutralizeStatusPoll's doc comment.
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await sendPrompt(page, input, "abort this turn please")
    await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible({ timeout: 20_000 })
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
    // See waitForDispatchReceived's doc comment: the Thinking row/"stop" icon
    // are satisfied by the OPTIMISTIC status alone, which can be true before
    // the app has actually dispatched `prompt_async` — clicking Stop inside
    // that window aborts the still-pending dispatch locally without ever
    // calling the network abort endpoint (arguably correct, since nothing
    // was sent yet). Wait for the mock to have actually received the
    // dispatch so this test exercises "abort an already-dispatched turn",
    // matching its own stated intent.
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
    // See neutralizeStatusPoll's doc comment.
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await sendPrompt(page, input, "please stop before you answer")
    await expect(page.locator(SELECTORS.thinkingRow), "pending assistant row never registered").toBeVisible({
      timeout: 20_000,
    })
    // See waitForDispatchReceived's doc comment (behavior 3's test).
    await waitForDispatchReceived(promptState)

    await submitIcon(page).click()
    await expect.poll(() => mock.requests.abortCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    const userID = promptState.lastMessageID
    expect(userID, "mock never recorded the user messageID").toBeTruthy()
    const assistantID = "msg_assistant_manual_abort"
    const now = Date.now()
    // `mock.emit()` now reaches this local session directly: mock-runtime.ts mounts
    // the `/api/wr/events` SSE channel on the primary origin (the endpoint the app's
    // live-event consumer reads for the `/w/<dir>/session/<id>` route shape via the
    // `/global/event`→`/api/wr/events` rewrite), and the shared FanoutBus fans this
    // event out to it — the same proven path core-docks uses for its
    // permission/todo/status events. The prior bespoke SSE bridge is obsolete.
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

    // The redesigned timeline (dev-docs/CODEX_TIMELINE_DESIGN.md §3.6,
    // CLAXEDO_ERROR_PROPOSAL.md) renders the interrupted-turn divider — a
    // `TimelineRow.TurnDivider` with `label: "interrupted"`
    // (message-timeline.data.ts:355-359) — using the duration-aware copy
    // "You stopped after {duration}" (`ui.message.interruptedDuration`,
    // ui/src/i18n/en.ts:183 → message-timeline.tsx:1476-1478) whenever a
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
    // See neutralizeStatusPoll's doc comment.
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "enter on blank composer must not abort"
    await sendPrompt(page, input, promptText)
    await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible({ timeout: 20_000 })
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
    // See waitForDispatchReceived's doc comment (behavior 3's test): the
    // Thinking row/"stop" icon are satisfied by the OPTIMISTIC status alone,
    // which can be true before the ORIGINAL send has actually dispatched
    // `prompt_async` — probing the blank-Enter no-op guard before that
    // happens tests "Enter races the send" rather than this behavior's own
    // intent ("Enter does nothing to an already-busy turn").
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

    // The turn was never disturbed: it completes normally afterward (oracle), driven by
    // driveTurn's own SSE events over the shared mock's `/api/wr/events` channel.
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
      // `dispatchSessionStatusEvent(idle)`, session-controller.ts:795-797. Asserting the
      // banner inside the pre-assistant-row stretch keeps the injected status and the
      // mocked server's state consistent with each other; `delta` is then short so the
      // turn still settles well inside the oracle's own 20s window.
      timingsMs: { busy: 60, pending: 5_000, delta: 2_000, completed: 300, idle: 150 },
    })
    // See neutralizeStatusPoll's doc comment.
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
    // `mock.emit()` reaches this local session over installMockRuntime's
    // unconditionally-mounted `/api/wr/events` channel — the same path driveTurn's own
    // events take, and the same path behavior 5's abort event uses.
    //
    // It is emitted on a poll rather than once because the FIRST emit lands DURING the
    // consumer's reconnect gap, not because it is lost. An instrumented run showed the
    // emit issued immediately after the Thinking row appears leaves the banner absent for
    // ~2.5s, while a re-emit ~2s later applies within 500ms and sticks — and the earlier
    // reading of that as "the frame was dropped" was wrong. Nothing drops it: the mock's
    // `EventBus` is an append-only log and `ClaxedoEventsProvider` reconnects with its own
    // `Last-Event-ID`, so the frame is delivered on the next connection. What the poll is
    // actually absorbing is claxedo-app's ~2s reconnect floor
    // (`app/providers/claxedo-events-reconnect.ts`) plus the 2s session-switch quiet window
    // the draft→session navigation arms (`platform/runtime/session-switch.ts`) — i.e. a
    // LATENCY property of the consumer's reconnect policy, NOT app behavior and NOT what
    // this behavior asserts. Re-emitting is harmless for this frame (`session.status` is a
    // state assignment: applying "retry" twice equals applying it once). The poll stops
    // emitting the moment the banner exists, and nothing re-emits during the oracle below,
    // so this can never mask the oracle's "submit control back to ready" layer.
    const retryBanner = page.locator(SELECTORS_retry.banner)
    await expect
      .poll(
        async () => {
          mock.emit({ type: "session.status", properties: { sessionID: SESSION_ID, status: retryStatus } })
          return await retryBanner.count()
        },
        { timeout: 20_000, intervals: [500], message: "retry banner never rendered on status:retry" },
      )
      .toBeGreaterThan(0)
    await expect(retryBanner).toBeVisible()
    await expect(page.locator(SELECTORS_retry.message)).toContainText("Reconnecting to the ACP client")

    // The turn still recovers and completes normally — the oracle proves it end to end,
    // driven by driveTurn's real completion events rather than a spec-local relay.
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

    // The redesigned session-error surface (dev-docs/CLAXEDO_ERROR_PROPOSAL.md T1:
    // "Un-gate the recovery card from turn 0") renders EVERY non-abort turn error as
    // the FirstTurnRecoveryCard, not the legacy bare `.error-card` (which is now only
    // a dead fallback at message-timeline.tsx:1577, unreachable because
    // `sessionRecoveryClass` — first-turn-recovery.ts:32 — always returns a class,
    // "unknown" at worst). The JSON envelope still unwraps to "<type>: <message>" and
    // is shown in the card's collapsed raw-detail (first-turn-recovery-card.tsx
    // RawDetail); this error classifies as "unknown" (matches none of the credential/
    // session/harness/model/workspace regexes).
    const errorCard = page.getByTestId("first-turn-recovery-card")
    await expect(errorCard, "recovery/error card never rendered").toBeVisible({ timeout: 20_000 })
    await expect(errorCard).toHaveAttribute("data-recovery-class", "unknown")
    await expect(errorCard).toContainText("overloaded_error: The server is overloaded, please retry later.")

    // Submit control returns to ready even though no assistant text ever rendered —
    // both the SSE session.error path and the REST reconciliation path
    // (conversationHasAssistantMessage sees `error`) drive this.
    await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 20_000 })
    expect(mock.requests.promptCount).toBe(1)

    const original = mock.requests.promptBodies[0]
    await errorCard.getByRole("button", { name: "Try again" }).click()

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

  test(
    "escalation ladder: a genuinely silent server surfaces pending then long, and Cancel aborts — behavior 8",
    async ({ page }) => {
      // FIXED APP BUGS (was test.fixme) — two independent defects:
      // 1. Duplicate Session() mount: after the first send from a draft
      //    composer, the submitting draft content stayed at sessionId "new"
      //    forever (route-intent matches contents by (directory, sessionId),
      //    so navigating to the created session's route minted a DUPLICATE
      //    content while the draft went pane-less/stashed with a live
      //    Session() instance). Fixed in `src/session/submit/handoff.ts`
      //    (`applyCreatedSessionTargetEffects`): the focused submitting draft
      //    surface is retargeted in place (meta.patch "new" → created id)
      //    BEFORE navigating, so the route reuses the same content — pinned by
      //    the "retargeted in place" unit test in handoff.test.ts.
      // 2. Non-reactive stage read: `SessionStatusStage` never rendered even
      //    though `session-status-dispatcher.ts`'s query-cache stage
      //    progressed correctly — the composer's `statusStage` memo read
      //    `promptSessionStatusStage` (a plain getQueryData snapshot with no
      //    observer) so escalation-timer writes never re-rendered anything.
      //    Fixed in `src/session-client/composer/composer.tsx` via
      //    `subscribePromptSessionStatusMeta` (dispatcher-owned query-cache
      //    subscription).
      test.setTimeout(300_000)
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS })
      // Registered AFTER installMockRuntime — see the note in behavior 3's test:
      // Playwright resolves the most-recently-added matching route first.
      await silencePromptAsync(page)

      // Simulate a backend that accepts the dispatch and then goes completely silent:
      // no SSE session.status/session.idle ever (silencePromptAsync above), and
      // /session/status never resolves at all — every reconciliation path documented
      // in STATE MODEL is starved, which is the only way the optimistic escalation
      // timers survive long enough to become visible (see STATE MODEL: any
      // server-source status event, including the mock's normal early busy ack,
      // otherwise clears them within milliseconds of every send). See
      // neutralizeStatusPoll's doc comment for the concrete ~1.5s "first-fold hydrate"
      // path this starves (the one this task's investigation traced precisely); the
      // ~60s ACTIVE_SESSION_STATUS_POLL path is a second, slower one this also starves.
      await neutralizeStatusPoll(page)

      await seedOneProject(page, DIR)
      const input = await openDraftPrompt(page, DIR)
      await input.click()
      await input.fill("is anyone still there")
      await page.locator(SELECTORS.submitControl).last().click()
      await expect(page, "URL never moved onto the created session's route").toHaveURL(sessionUrlPattern(SESSION_ID), {
        timeout: 20_000,
      })

      // Busy is entered optimistically and never confirmed — Thinking renders and
      // stays, matching behavior 1's mechanism under total silence.
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
      // 5 * 60_000 of real wall-clock (session-status-dispatcher.ts:15), impractical
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

      // Cancel the first (silent) turn to return the composer to ready without a
      // scope change, then resend on the now-stable session route.
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

      // At the terminal stage BOTH controls are offered: Cancel to abort the stuck
      // run and Retry to re-run the last prompt.
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
