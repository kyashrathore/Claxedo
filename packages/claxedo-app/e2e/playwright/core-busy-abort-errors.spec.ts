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
 *      `"failed"` stage (5 minutes) is real-time-impractical for a CI-speed mocked
 *      spec — pinned as `test.fixme`, see findings. BOTH the pending/long test AND
 *      the failed-stage test are `test.fixme` as of this task: the pending/long one
 *      hits a confirmed, separate app bug (two `Session()` page instances stay
 *      mounted after first send; `[data-testid="session-status-stage"]` never
 *      renders in that state even though the underlying dispatcher state is
 *      correct) — see the fixme'd test's own comment and this task's findings.
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
import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { installMockRuntime, type MockEvent, type MockRuntimeHandles } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-busy-abort-errors"
const SESSION_ID = "ses_core_busy_abort_errors"

/** CONFIRMED SHARED-MOCK GAP (this task's investigation, verified via a full
 * request-log capture): every session created through this spec's flow lands
 * on the `/w/<dir>/session/<id>` route shape, and for THAT shape the app's
 * live-event consumer (`src/context/global-sdk.tsx`) reads
 * `GET /api/wr/events` (confirmed via `page.on("request")` — behavior 2's
 * passing run shows repeated `GET .../api/wr/events`, NEVER
 * `/global/event`), not the plain `/global/event`/`/event` endpoints
 * `installMockRuntime`'s `emit()` feeds. `installMockRuntime` only mounts
 * `/api/wr/events` (`relayEventHandler`) when the caller passes a `cloud:
 * {...}` option — this spec's local-only tests never do, so `mock.emit(...)`
 * is silently a NO-OP for every session here: the event is queued into a bus
 * nothing ever drains. This is why driveTurn's own automatic events (busy
 * ack, message deltas, idle) never reconcile anything either — every
 * "passing" test in this file (behaviors 2, 3, 7) does so via the REST
 * reconciliation fallback (`requestAcceptedPromptRefresh`/
 * `ACCEPTED_PROMPT_REFRESH_ATTEMPT_DELAYS_MS`, session-controller.ts) or via
 * DOM/network state that never depended on SSE delivery, NOT via genuine SSE
 * delivery. Recommended shared-helper fix: always mount the `/api/wr/events`
 * + `/api/wr/runtime-events` relay handlers on the primary origin (not only
 * behind `options.cloud`), sharing the SAME `EventBus`/`emit` used for
 * `/global/event`, so `mock.emit()` reaches local sessions too — see this
 * task's findings.
 *
 * Bridges around the gap SPEC-LOCALLY (not editing mock-runtime.ts): mounts
 * `/api/wr/events` + `/api/wr/runtime-events` with an independent minimal
 * event bus, reusing `installMockRuntime`'s exact wire envelope
 * (`{directory, payload}` per SSE `data:` line) so the app's consumer parses
 * it identically. Returns an `emit` with the SAME signature as
 * `installMockRuntime`'s, for drop-in use in tests that need SSE delivery to
 * a local (non-cloud) session. */
function installWorkspaceRuntimeEventsBridge(page: Page) {
  const pending: Array<{ directory: string; payload: MockEvent }> = []
  let waiter: (() => void) | undefined
  const emit = (payload: MockEvent, directory: string = DIR) => {
    pending.push({ directory, payload })
    const resolve = waiter
    waiter = undefined
    resolve?.()
  }
  const drain = async (idleTimeoutMs: number) => {
    if (pending.length === 0) {
      await Promise.race([
        new Promise<void>((resolve) => {
          waiter = resolve
        }),
        new Promise<void>((resolve) => setTimeout(resolve, idleTimeoutMs)),
      ])
    }
    return pending.splice(0, pending.length)
  }
  const body = (batch: Array<{ directory: string; payload: MockEvent }>) => {
    if (batch.length === 0) return ": heartbeat\n\n"
    return batch.map(({ directory, payload }) => `data: ${JSON.stringify({ directory, payload })}\n\n`).join("")
  }
  const handler = async (route: Route) => {
    const type = route.request().resourceType()
    if (type !== "fetch" && type !== "xhr") return route.continue()
    // Matches installMockRuntime's own sseIdleTimeoutMs — keeps this bridge's
    // reconnect cadence identical to the shared mock's proven-working one
    // rather than guessing at a different value.
    const batch = await drain(4_000)
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: body(batch) }).catch(() => {})
  }
  return Promise.all([
    page.route("**/api/wr/events**", handler),
    page.route("**/api/wr/runtime-events**", handler),
  ]).then(() => ({ emit }))
}

/** Companion to `installWorkspaceRuntimeEventsBridge`: for tests that need
 * driveTurn's own (mock-runtime.ts-internal, Node-side) reply to reach the
 * app, driveTurn's automatic events are ALSO no-ops for the same reason (they
 * go through `mock.emit()`, which only feeds `/global/event`). driveTurn's
 * effects on the mock's in-memory `messages` array are real regardless (pure
 * server-side state), so this polls the ALREADY-correctly-mocked
 * `GET /session/:id/message` endpoint (via `page.evaluate` + `fetch`, so it
 * goes through the SAME page.route interception the app itself uses — a
 * Node-side `page.request` call would bypass routing entirely) until the
 * assistant message settles, then relays its final content through the
 * bridge so the app's DOM catches up immediately instead of waiting on the
 * REST-reconciliation fallback's slow backoff
 * (`ACCEPTED_PROMPT_REFRESH_ATTEMPT_DELAYS_MS` sums to ~28s, longer than the
 * oracle's 20s window). */
async function relaySettledReplyOverBridge(
  page: Page,
  bridge: { emit: MockRuntimeHandles["emit"] },
  opts: { sessionId: string; directory: string; timeoutMs?: number },
) {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
  while (Date.now() < deadline) {
    const rows = await page.evaluate(
      async ([sessionId, directory]) => {
        const res = await fetch(`http://127.0.0.1:3001/session/${sessionId}/message?directory=${encodeURIComponent(directory)}&limit=80`)
        if (!res.ok) return null
        return (await res.json()) as Array<{
          info: { id: string; role: string; time?: { completed?: number }; error?: unknown; [key: string]: unknown }
          parts: Array<{ type: string; text?: string }>
        }>
      },
      [opts.sessionId, opts.directory] as const,
    )
    const assistant = rows?.find((r) => r.info.role === "assistant")
    if (assistant && (assistant.info.time?.completed || assistant.info.error)) {
      const relay = () => {
        const textPart = assistant.parts.find((p) => p.type === "text")
        if (textPart?.text) {
          bridge.emit({
            type: "message.part.updated",
            properties: {
              sessionID: opts.sessionId,
              part: { id: `${assistant.info.id}_text`, sessionID: opts.sessionId, messageID: assistant.info.id, type: "text", text: textPart.text },
              time: Date.now(),
            },
          })
        }
        bridge.emit({
          type: "message.updated",
          properties: { sessionID: opts.sessionId, info: assistant.info as never },
        })
        bridge.emit({ type: "session.idle", properties: { sessionID: opts.sessionId } })
      }
      // Re-emit a few times over ~2.5s instead of once: a single emission
      // can land mid- a reconnect-backoff window on the bridge's SSE
      // endpoint (see installWorkspaceRuntimeEventsBridge) and be delayed
      // well past this call's return; repeating a few times is cheap
      // (idempotent — the app converges to the same final state) and makes
      // eventual delivery, not a lucky single delivery, the thing this
      // relies on.
      relay()
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 600))
        relay()
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

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

/** Not covered by the shared mock (mock-runtime.ts has no `/session/*​/abort` route) —
 * registered locally per e2e/INVARIANTS.md authoring rule #1's spirit (extend, don't
 * hand-roll a parallel mock) would mean editing the shared helper, which this task's
 * ground rules forbid; this is a spec-local addition of a route the shared mock is
 * simply missing. See findings. */
async function registerAbortRoute(page: Page) {
  const state = { count: 0 }
  await page.route("**/session/*/abort**", async (route) => {
    const type = route.request().resourceType()
    if (type !== "fetch" && type !== "xhr") return route.continue()
    state.count += 1
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  })
  return state
}

/** Neutralizes the shared mock's bulk `/session/status` route. This is a verified,
 * reproducible SHARED-MOCK BUG (confirmed via captured trace network logs from a real
 * failing run, then isolated in a minimal standalone Playwright repro — not a
 * load-flake guess), not an app defect: `installMockRuntime` registers
 * `page.route("**​/session/status", ...)` (mock-runtime.ts, bulk status handler,
 * intending to answer `{[SESSION_ID]:{type:"idle"}}`) — but Playwright's glob
 * matching treats a pattern with no trailing wildcard as requiring the URL to END at
 * that literal segment. The real app ALWAYS calls this endpoint with a query string
 * (`/session/status?directory=...` or `...&harness=opencode`, confirmed in this
 * spec's own captured trace.zip), which that pattern never matches. The request falls
 * through to installMockRuntime's LATER-registered, more-permissive catch-all
 * `page.route("**​/session/*", ...)` (matches "status" as if it were a session ID)
 * instead, which returns a full `sessionRow()` object — NOT a `Record<string,
 * SessionStatus>` map. The app's `fetchSessionMeta`/`syncSessionMeta`
 * (`src/session/store/session-controller.ts:339-397,413-437`) then reads
 * `server = status[sessionID]` from that wrong shape, gets `undefined`, and
 * `mergeBusySessionStatus` (`src/session/store/session-store.ts:7-14`) — whose "keep
 * local busy" guard additionally never fires here because `syncSessionMeta`'s
 * `activeEvidence` (`isSessionTurnActive({permissions, questions})`, no `status`
 * passed) doesn't consider local busy state either — falls through to
 * `syncSessionMeta`'s `?? idleSessionStatus` fallback (session-controller.ts:396),
 * forcibly dispatching `session.status: idle` (source "server") almost immediately
 * after every send, regardless of the turn's real state. This is why EVERY test in
 * this file that checked the submit control's `stop` icon shortly after send failed
 * identically (`Received: "arrow-up"`, polled the full 15s) whether the turn was
 * naturally progressing (behaviors 1/4/6) or artificially silenced via
 * `silencePromptAsync` (behaviors 3/5). The correct shared-mock fix is changing
 * mock-runtime.ts's pattern to `"**​/session/status**"` (matches the query string) —
 * see this task's findings. `mock-runtime.ts` may not be edited in this pooled phase,
 * so this is applied spec-locally: registered AFTER installMockRuntime with the
 * CORRECT glob (trailing `**`) so it actually intercepts the request (verified by the
 * same standalone repro) and never resolves it, starving every reconciliation path
 * that flows through this endpoint for the scenarios that need busy state to survive
 * more than a few milliseconds past send. */
async function neutralizeStatusPoll(page: Page) {
  await page.route("**/session/status**", () => {
    // Intentionally never fulfilled/continued — any resolved response (even the
    // mock's intended `{[SESSION_ID]:{type:"idle"}}}`, which — per the bug above —
    // never actually gets served anyway) is itself a premature reconciliation. See
    // the comment above for the full mechanism.
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

/** Spec-local mitigation for a genuine wall-clock race documented in
 * `e2e/INVARIANTS.md` and this file's own comments (a "shared pooled box"
 * that can run this suite alongside sibling load): `session-status-
 * dispatcher.ts`'s escalation ladder arms real `setTimeout`s the instant an
 * optimistic non-idle status is set and only clears them on the NEXT
 * server-source `session.status` write (session-status-dispatcher.ts:74-98).
 * The mock's own automatic busy ack would normally provide that clear within
 * ~`timings.busy` ms of send, but — per `installWorkspaceRuntimeEventsBridge`'s
 * doc comment — `mock.emit()` never reaches a local session's live-event
 * consumer at all, so NEITHER driveTurn's automatic ack NOR a naive manual
 * `mock.emit()` would ever clear these timers; this MUST go through the
 * bridge. Periodically re-emitting a server-source status event — busy, or
 * (for behavior 6) the same retry status the test just asserted — repeatedly
 * clears the escalation timers per the dispatcher's own documented contract,
 * without changing anything the test observes. */
function keepSessionStatusAlive(
  bridge: { emit: MockRuntimeHandles["emit"] },
  status: { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number },
  intervalMs = 5_000,
) {
  const tick = () => bridge.emit({ type: "session.status", properties: { sessionID: SESSION_ID, status } })
  // Fire once immediately, not just on the first interval tick: if the test's
  // own setup (send + DOM-poll assertions) already ate a large chunk of the
  // 20s pending budget under contention before this helper is even called,
  // waiting a further `intervalMs` for the first clear could itself lose the
  // race. An immediate tick establishes the clear as early as this helper is
  // invoked; the interval only needs to cover the REMAINING budget.
  tick()
  const timer = setInterval(tick, intervalMs)
  return () => clearInterval(timer)
}

test.describe("core busy / abort / errors @core", () => {
  // This shared box runs several sibling e2e suites concurrently; page loads and
  // reactive updates can lag well beyond a quiet-machine budget. Every assertion
  // below is a real DOM-state poll (never waitForTimeout as the sole guard), so a
  // longer ceiling only affects how long a genuinely stuck state takes to be
  // reported, not correctness.
  test.describe.configure({ timeout: 120_000 })
  test("Thinking renders while busy, then gives way to the visible reply — behavior 1", async ({ page }) => {
    const bridge = await installWorkspaceRuntimeEventsBridge(page)
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      // delta bumped from 1200ms: on this pooled box, the Thinking-visible assertion
      // below can itself take many seconds to resolve under sibling-suite contention,
      // and driveTurn's own timers run on real (Node-side) wall-clock time regardless
      // of how slow the browser is — a short delta let the turn complete for real
      // (genuine session.idle) before the "stop" icon assertion ever got a turn to
      // run, which is not a load-flake to retry around but an assertion-ordering gap
      // this test needs a wide enough busy window to not hit.
      timingsMs: { busy: 60, pending: 150, delta: 15_000, completed: 300, idle: 150 },
    })
    // See neutralizeStatusPoll's doc comment: without this, the shared mock's bulk
    // /session/status route (mismatched glob, falls through to a different handler)
    // reconciles this turn to idle almost immediately after send, well before this
    // test's "stop" icon assertion below runs.
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "busy abort errors turn one thinking"
    await sendPrompt(page, input, promptText)

    // See keepSessionStatusAlive's doc comment: this turn is deliberately held
    // busy for ~15s to observe the stop icon, which is long enough for the
    // escalation ladder's "pending" stage (20s) to win a race against real
    // machine contention. Started immediately after send.
    const stopKeepAlive = keepSessionStatusAlive(bridge, { type: "busy" })
    try {
      await expect(page.locator(SELECTORS.thinkingRow), "Thinking row never appeared while busy").toBeVisible({
        timeout: 20_000,
      })
      await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })

      // See relaySettledReplyOverBridge's doc comment: driveTurn's own SSE
      // delivery is a no-op for this session shape, so relay its (real,
      // Node-side, in-memory) completion through the bridge once it settles.
      void relaySettledReplyOverBridge(page, bridge, { sessionId: SESSION_ID, directory: DIR })
      await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    } finally {
      stopKeepAlive()
    }
    await expect(page.locator(SELECTORS.thinkingRow)).toHaveCount(0)
    expect(mock.requests.promptCount).toBe(1)
  })

  test("stale-busy: completed reply stays visible and status reconciles without user action — behavior 2 (PERMANENT)", async ({
    page,
  }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
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
    const abortState = await registerAbortRoute(page)
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
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

    // Behavior 3: status flips to ready IMMEDIATELY (client-optimistic, before the
    // network abort call resolves) — a deterministic DOM-state wait, not a sleep.
    await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
    await expect.poll(() => abortState.count, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    expect(promptState.count).toBe(1)
  })

  test("an aborted assistant message renders an Interrupted divider at its position — behavior 5", async ({ page }) => {
    const abortState = await registerAbortRoute(page)
    const bridge = await installWorkspaceRuntimeEventsBridge(page)
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
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
    await expect.poll(() => abortState.count, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    const userID = promptState.lastMessageID
    expect(userID, "mock never recorded the user messageID").toBeTruthy()
    const assistantID = "msg_assistant_manual_abort"
    const now = Date.now()
    // See installWorkspaceRuntimeEventsBridge's doc comment: `mock.emit()` is
    // a no-op for this session's route shape — this manual event MUST go
    // through the bridge to ever reach the app.
    bridge.emit({
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
          modelID: "big-pickle",
          error: { name: "MessageAbortedError", data: { message: "Aborted by user" } },
        },
      },
    })
    bridge.emit({ type: "session.idle", properties: { sessionID: SESSION_ID } })

    const dividerLabel = page.locator('[data-slot="compaction-part-label"]').filter({ hasText: "Interrupted" })
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
    const abortState = await registerAbortRoute(page)
    const bridge = await installWorkspaceRuntimeEventsBridge(page)
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      // delta kept short: with `keepSessionStatusAlive` (via the bridge)
      // holding the busy/"stop" icon deterministically for as long as this
      // test needs it, driveTurn's own (Node-side, mock-runtime-internal)
      // completion timing no longer needs to outlast the test's own probe
      // steps — driveTurn's automatic events are inert for this session
      // shape anyway (see installWorkspaceRuntimeEventsBridge's doc
      // comment), so nothing observes them until
      // `relaySettledReplyOverBridge` explicitly relays the final content.
      // Keeping delta short instead just gives that relay less to wait for,
      // comfortably inside the oracle's 20s window measured from when it is
      // called (near the END of this test, after both "stop" icon checks).
      timingsMs: { busy: 60, pending: 150, delta: 1_500, completed: 300, idle: 150 },
    })
    // See neutralizeStatusPoll's doc comment.
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "enter on blank composer must not abort"
    await sendPrompt(page, input, promptText)
    // See keepSessionStatusAlive's doc comment (behavior 1's test): this turn
    // is deliberately held busy for ~20s to allow the double "stop" icon
    // check, wide enough for the escalation ladder to win a contention race.
    // Started immediately after send for the same reason as behavior 1.
    const stopKeepAlive = keepSessionStatusAlive(bridge, { type: "busy" })
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
    expect(abortState.count, "Enter-on-blank must not call session.abort").toBe(0)
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })

    // The turn was never disturbed: it completes normally afterward (oracle).
    // See relaySettledReplyOverBridge's doc comment (behavior 1's test).
    try {
      void relaySettledReplyOverBridge(page, bridge, { sessionId: SESSION_ID, directory: DIR })
      await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    } finally {
      stopKeepAlive()
    }
  })

  test("a retry/ACP-recovery status renders the retry banner, then the turn recovers and completes — behavior 6", async ({
    page,
  }) => {
    const bridge = await installWorkspaceRuntimeEventsBridge(page)
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      // delta bumped from 1500ms — see behavior 1's test for why: the manually
      // emitted retry event below must land on the turn while it is still active
      // (not yet naturally settled), which needs a busy window that survives
      // contention-induced lag before this test gets around to emitting it.
      timingsMs: { busy: 60, pending: 150, delta: 15_000, completed: 300, idle: 150 },
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
    // See installWorkspaceRuntimeEventsBridge's doc comment: `mock.emit()` is
    // a no-op for this session's route shape.
    bridge.emit({
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: retryStatus },
    })
    // See keepSessionStatusAlive's doc comment (behavior 1's test). Behavior 6
    // additionally re-emits the SAME retry status (not busy) so the
    // escalation ladder's "pending" stage — which would otherwise overwrite
    // this exact message with its own synthetic retry text — never gets a
    // chance to win the race under contention. Started IMMEDIATELY after the
    // manual emit above (not after the assertions below) — the "pending"
    // stage can fire before the very first content-check assertion gets a
    // turn to run under contention, so the keep-alive must already be
    // ticking by the time these checks start polling, not after.
    const retryKeepAlive = keepSessionStatusAlive(bridge, retryStatus)

    try {
      const retryBanner = page.locator(SELECTORS_retry.banner)
      await expect(retryBanner, "retry banner never rendered on status:retry").toBeVisible({ timeout: 20_000 })
      await expect(page.locator(SELECTORS_retry.message)).toContainText("Reconnecting to the ACP client")

      // The turn still recovers and completes normally — oracle proves it end
      // to end. See relaySettledReplyOverBridge's doc comment (behavior 1's
      // test).
      void relaySettledReplyOverBridge(page, bridge, { sessionId: SESSION_ID, directory: DIR })
      await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    } finally {
      retryKeepAlive()
    }
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
      errorMidTurn: errorEnvelope,
      timingsMs: { busy: 40, pending: 80, delta: 200, completed: 80, idle: 30 },
    })
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await sendPrompt(page, input, "trigger a mid-turn error")

    const errorCard = page.locator(".error-card")
    await expect(errorCard, "error card never rendered").toBeVisible({ timeout: 20_000 })
    await expect(errorCard).toContainText("overloaded_error: The server is overloaded, please retry later.")

    // Submit control returns to ready even though no assistant text ever rendered —
    // both the SSE session.error path and the REST reconciliation path
    // (conversationHasAssistantMessage sees `error`) drive this.
    await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 20_000 })
    expect(mock.requests.promptCount).toBe(1)

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
      const abortState = await registerAbortRoute(page)
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
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
      await expect.poll(() => abortState.count, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    },
  )

  test.fixme(
    "escalation ladder reaches the failed/unresponsive stage with Cancel and Retry — behavior 8",
    async () => {
      // OPTIMISTIC_STATUS_FAILURE_MS = 5 * 60_000 (src/session/store/
      // session-status-dispatcher.ts:15) — reaching the "failed" stage in real time
      // costs five minutes of wall-clock per attempt, which is impractical for a
      // CI-speed mocked spec (this file's own 60s default test timeout, and the
      // suite's overall runtime budget, both rule it out). The mechanism itself is
      // exercised identically to the "pending"/"long" stages proven above
      // (`dispatchSessionStatusTimeoutStage`, session-status-dispatcher.ts:168-182) —
      // only the wall-clock distance differs. Reaching this deterministically would
      // need either (a) a test-only scale-down knob on
      // OPTIMISTIC_STATUS_{REDISPATCH,PENDING,LONG,FAILURE}_MS gated by an env var, or
      // (b) driving the whole page with Playwright's `page.clock` installed before
      // first navigation (risky here: it would also freeze the mock's own SSE
      // reconnect backoff timer, which is real browser-side setTimeout — see
      // mock-runtime.ts "How streaming works" — requiring careful interleaved
      // fastForward/drain choreography this spec does not attempt). See this task's
      // findings for a recommendation.
    },
  )
})
