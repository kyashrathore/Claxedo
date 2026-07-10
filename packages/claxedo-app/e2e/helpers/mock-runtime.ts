// The shared streaming mock every Tier M (`e2e/playwright/core-*.spec.ts`) spec uses.
// See e2e/INVARIANTS.md ("Authoring rules" #1) — specs must not hand-roll a parallel
// mock; extend this file instead.
//
// The route inventory below was harvested from `e2e-legacy/first-prompt-local.spec.ts`
// and `e2e-legacy/first-prompt-cloud.spec.ts` (provider list, session create,
// prompt_async, message, global/event + event SSE, agent-config harness/options,
// session/status, and — for cloud — the relay-origin `/api/wr/*` catch-all).
//
// CRITICAL DIFFERENCE from the legacy mock: replies stream as SEPARATE SSE events —
// `session.status busy` -> `message.updated`(pending) -> `message.part.delta`* ->
// `message.updated`(completed) -> `session.idle` — delivered on genuinely separate
// ticks, never pre-completed, never instant idle. See "How streaming works" below for
// why (Playwright's `route.fulfill` cannot drip a body over time, so we use the app's
// own SSE-reconnect loop as the delivery mechanism).
import type { Page, Route } from "@playwright/test"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Harness =
  | "opencode"
  | "claude-acp"
  | "codex-acp"
  | "cursor-acp"
  | "claude-sdk"
  | "codex-app-server"
  | "cursor-sdk"
  | "pi"

export type HarnessModelOption = { id: string; name: string }

export type HarnessReadiness = "ready" | "polling" | "error"

export type SessionStatusEvent =
  | { type: "session.status"; properties: { sessionID: string; status: { type: "busy" } | { type: "idle" } | { type: "retry"; attempt: number; message: string; next: number } } }
  | { type: "session.idle"; properties: { sessionID: string } }
  | { type: "session.error"; properties: { sessionID: string } }

export type MockEvent =
  | SessionStatusEvent
  | { type: "message.updated"; properties: { sessionID: string; info: MockMessageInfo } }
  | { type: "message.part.delta"; properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string } }
  | { type: "message.part.updated"; properties: { sessionID: string; part: MockPart; time: number } }
  | { type: "permission.asked"; properties: Record<string, unknown> }
  | { type: "permission.replied"; properties: Record<string, unknown> }
  | { type: "question.asked"; properties: Record<string, unknown> }
  | { type: "question.replied"; properties: Record<string, unknown> }
  | { type: "todo.updated"; properties: Record<string, unknown> }
  | { type: "server.connected"; properties: Record<string, unknown> }
  | { type: string; properties?: unknown }

export type MockMessageInfo = {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  agent?: string
  model?: { providerID: string; modelID: string }
  providerID?: string
  modelID?: string
  parentID?: string
  mode?: string
  path?: { cwd: string; root: string }
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  error?: { name: string; data: { message: string } }
}

export type MockPart = { id: string; sessionID: string; messageID: string; type: "text"; text: string }

export type MockMessageRow = { info: MockMessageInfo; parts: MockPart[] }

export type PromptBody = {
  messageID?: string
  /** The assistant message id driveTurn replies with for this prompt (`${userID}_r`). */
  assistantID: string
  text: string
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
}

export type ConfigPatchBody = { body: unknown }

export type MockRuntimeRequests = {
  console: string[]
  failed: string[]
  badResponses: string[]
  unhandled: string[]
  createSessionCount: number
  opencodeSessionCreateCount: number
  harnessSessionCreateCount: number
  promptCount: number
  promptBodies: PromptBody[]
  shellCount: number
  slashCount: number
  configPatchCount: number
  configPatchBodies: ConfigPatchBody[]
  harnessOptionsCount: number
  harnessPostCount: number
}

export type MockRuntimeOptions = {
  dir?: string
  sessionId?: string
  projectId?: string
  projectName?: string
  /** The harness this session is created/locked with. Defaults to "opencode". */
  harness?: Harness
  /** Per-harness model catalog for the composer's model popover. */
  harnessModels?: Partial<Record<Harness, HarnessModelOption[]>>
  /** Readiness state the harness config endpoint reports. */
  harnessReadiness?: HarnessReadiness
  harnessReadinessError?: string
  /**
   * Number of `POST /api/claxedo/agent-config/harness` calls that should still report
   * "applying" before flipping to the final `harnessReadiness` — models the
   * "Connecting" pill / composer-fade-while-polling window.
   */
  harnessPollingTurns?: number
  /** Assistant reply text builder. Defaults to `ack <n>: <prompt text>` (legacy vocabulary). */
  replyText?: (turn: number, promptText: string) => string
  /** Message is marked `time.completed` but `session.idle` is never sent. */
  staleBusy?: boolean
  /** Extra delay (ms) inserted before `session.idle`, after the message completes. */
  delayedIdleMs?: number
  /** Emits `session.error` (and marks the assistant message `error`) instead of completing normally. */
  errorMidTurn?: boolean | string
  /** `POST /session/:id/prompt_async` returns 500 instead of dispatching. */
  dispatchFailure?: boolean
  /** `PATCH /session/:id/config` returns a non-2xx. */
  configPatchFailure?: boolean
  /** Stage timings, in ms, all optional — sane defaults keep specs fast. */
  timingsMs?: { busy?: number; pending?: number; delta?: number; completed?: number; idle?: number }
  /** When set, additionally mounts the relay-origin `/api/wr/*` catch-all for cloud specs. */
  cloud?: { workspaceId: string; relayOrigin: string }
}

export type MockRuntimeHandles = {
  requests: MockRuntimeRequests
  /** Manually inject an event onto the global SSE stream (permission/question/todo/etc). */
  emit: (payload: MockEvent, directory?: string) => void
  /**
   * Manually inject an event onto the global SSE stream WITHOUT the
   * `{directory, payload}` envelope `emit()` always wraps events in. Real
   * `claxedoBus`-originated events (e.g. `session.lifecycle`, see
   * `packages/claxedo-server/src/routes/opencode-compat-events.ts`) are
   * written to the wire flat/unwrapped — `ClaxedoEventsProvider`'s
   * `isClaxedoEvent` guard (`packages/claxedo-app/src/providers/
   * claxedo-events.tsx`) requires a top-level `.type` and silently drops
   * anything wrapped in `{directory, payload}`. Use this for events consumed
   * via `useClaxedoEvents()`; use `emit()` for opencode-SDK-shaped events
   * consumed via `globalSDK.event`.
   */
  emitFlat: (payload: MockEvent) => void
  session: { id: string; dir: string; projectId: string }
}

// ---------------------------------------------------------------------------
// How streaming works
// ---------------------------------------------------------------------------
//
// Playwright's `route.fulfill()` cannot drip a body over time — the full response body
// must be known at the moment `fulfill()` is called. The app's global-event consumer
// (`src/context/global-sdk.tsx`) reads `/global/event` via `fetch` + a streaming
// `ReadableStream` reader, and — critically — RECONNECTS on stream end with a fixed
// ~250ms backoff (`RECONNECT_DELAY_MS`) that resets to the floor whenever the previous
// connection delivered at least one event (`failures = becameReady ? 0 : failures + 1`).
//
// So: each SSE "connection" here BLOCKS (does not call route.fulfill) until at least one
// event is pending, then fulfills with the queued batch and ends the stream — which
// causes the app to reconnect ~250ms later for the next batch. Staging `emit()` calls a
// beat apart (see `stage()` below) yields genuinely separate SSE deliveries without
// requiring a true persistent connection, which Playwright does not support.

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

type PendingEvent = { directory: string; payload: MockEvent; flat?: boolean }

// BROADCAST semantics, not a drain-once work queue. A route this bus backs
// (e.g. `/api/wr/events`) can be polled by SEVERAL independent, concurrently
// reconnecting readers at once — `ClaxedoEventsProvider`'s central stream AND
// global-sdk's `sseJsonStream` (its `/global/event` request gets rewritten to
// `/api/wr/events` for workspace routes by `apiFetchUrl`, src/utils/api.ts:
// 200-205). A single shared queue makes delivery a lottery: whichever
// reader's blocked `drain()` call happens to be waiting when `emit()` fires
// steals the WHOLE batch, so the other reader's next reconnect finds nothing
// pending and silently misses the event — this is the exact mechanism behind
// core-docks' flaky `permission.replied` delivery (proven via a monkey-patched
// `JSON.parse` stack trace: the event's frame pointed at the wrong consumer).
//
// Fix (ported from the reference `ClaxedoEventBus` in
// `e2e/playwright/core-terminal.spec.ts:184-231`, its own writeup of the same
// class of bug): every event is broadcast to a small set of PERSISTENT
// per-connection "slots", not to one shared queue and not to ephemeral
// per-request channels either — Playwright's `route.fulfill()` can't drip a
// body over time, so each SSE "connection" here is a brand-new HTTP request
// per reconnect, and a channel torn down between two of a reader's OWN
// reconnects would silently drop anything emitted during that gap. `drain()`
// instead claims whichever existing slot is currently idle (or creates a new
// one if every existing slot is mid-drain), so a slot's unclaimed backlog
// survives across its own reader's reconnects while still giving each
// independent concurrent reader its own copy of every event — real
// multi-client SSE fan-out semantics.
type EventSlot = { pending: PendingEvent[]; waiters: Array<() => void>; busy: boolean }

class EventBus {
  private slots: EventSlot[] = []

  private broadcast(event: PendingEvent) {
    for (const slot of this.slots) {
      slot.pending.push(event)
      const waiters = slot.waiters
      slot.waiters = []
      for (const resolve of waiters) resolve()
    }
  }

  emit(directory: string, payload: MockEvent) {
    this.broadcast({ directory, payload })
  }

  /** See `MockRuntimeHandles.emitFlat` — broadcasts an unwrapped SSE frame. */
  emitFlat(payload: MockEvent) {
    this.broadcast({ directory: "", payload, flat: true })
  }

  /** One call = one HTTP connection: claims an idle slot (or makes a new one), drains only that slot's queue. */
  async drain(idleTimeoutMs: number) {
    const slot =
      this.slots.find((s) => !s.busy) ??
      (() => {
        const created: EventSlot = { pending: [], waiters: [], busy: false }
        this.slots.push(created)
        return created
      })()
    slot.busy = true
    try {
      if (slot.pending.length === 0) {
        await Promise.race([
          new Promise<void>((resolve) => slot.waiters.push(resolve)),
          wait(idleTimeoutMs),
        ])
      }
      const batch = slot.pending
      slot.pending = []
      return batch
    } finally {
      slot.busy = false
    }
  }
}

// The app can hold several SSE consumers at once (/global/event for the global
// store, /api/wr/events for workspace-routed sessions, the relay origin for
// cloud). Each ROUTE GROUP gets its own `EventBus` channel here (so, e.g.,
// events meant for `/api/wr/events` never leak into `/global/event`), and
// emit()/emitFlat() fan out to every channel. Within a single channel/route,
// the slot-broadcast semantics on `EventBus` itself (see above) additionally
// handle the case where that ONE route is polled by several independent
// concurrent readers at once (e.g. `/api/wr/events` is read by both
// `ClaxedoEventsProvider` and global-sdk's compat stream) — each reader gets
// its own copy of every event instead of racing to steal a shared queue.
class FanoutBus {
  private channels: EventBus[] = []

  channel(): EventBus {
    const bus = new EventBus()
    this.channels.push(bus)
    return bus
  }

  emit(directory: string, payload: MockEvent) {
    for (const channel of this.channels) channel.emit(directory, payload)
  }

  emitFlat(payload: MockEvent) {
    for (const channel of this.channels) channel.emitFlat(payload)
  }
}

function sseBody(batch: PendingEvent[]) {
  if (batch.length === 0) return ": heartbeat\n\n"
  return batch
    .map(({ directory, payload, flat }) => `data: ${JSON.stringify(flat ? payload : { directory, payload })}\n\n`)
    .join("")
}

// ---------------------------------------------------------------------------
// Fixtures (legacy "big-pickle" vocabulary kept so pre-migration selectors still work)
// ---------------------------------------------------------------------------

export const BIG_PICKLE: HarnessModelOption = { id: "big-pickle", name: "Big Pickle" }

const DEFAULT_HARNESS_MODELS: Record<Harness, HarnessModelOption[]> = {
  opencode: [BIG_PICKLE],
  "claude-acp": [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }],
  "codex-acp": [{ id: "gpt-5.2-codex", name: "GPT-5.2 Codex" }],
  "cursor-acp": [{ id: "cursor-auto", name: "Cursor Auto" }],
  "claude-sdk": [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }],
  "codex-app-server": [{ id: "gpt-5.5", name: "GPT-5.5" }],
  "cursor-sdk": [{ id: "cursor-auto", name: "Cursor Auto" }],
  pi: [{ id: "virtual", name: "Virtual" }],
}

function providerIdFor(harness: Harness): string {
  return harness === "opencode" ? "opencode" : harness
}

function defaultReplyText(turn: number, promptText: string) {
  return `ack ${turn}: ${promptText}`
}

function api(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr"
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return []
      if (!("type" in part) || part.type !== "text") return []
      if (!("text" in part) || typeof (part as { text?: unknown }).text === "undefined") return []
      return [(part as { text: string }).text]
    })
    .join("\n")
    .trim()
}

// ---------------------------------------------------------------------------
// installMockRuntime
// ---------------------------------------------------------------------------

export async function installMockRuntime(page: Page, options: MockRuntimeOptions = {}): Promise<MockRuntimeHandles> {
  const DIR = options.dir ?? "/tmp/e2e-mock-runtime"
  const SESSION_ID = options.sessionId ?? "ses_mock_runtime"
  const PROJECT_ID = options.projectId ?? "proj_mock_runtime"
  const PROJECT_NAME = options.projectName ?? "mock-runtime"
  // `let`, not `const`: a client-driven draft-harness switch (`POST
  // /api/claxedo/agent-config/harness {type}`, see `switchDraftHarness` in
  // `src/claxedo-ui/context/harness-switcher.ts`) must be reflected in every
  // subsequent read (model/options/capabilities/status) for the rest of the test —
  // otherwise the manual-switch path (behavior 1's test, the one case that doesn't
  // pre-seed `installMockRuntime({harness})`) sees a stale harness forever. The
  // hydrate GET path (behaviors 2-9, which DO pre-seed) never sends a body, so this
  // reassignment is a no-op for every other scenario in this file.
  let harness = options.harness ?? "opencode"
  const harnessModels = { ...DEFAULT_HARNESS_MODELS, ...options.harnessModels }
  const replyTextFn = options.replyText ?? defaultReplyText
  const timings = {
    busy: options.timingsMs?.busy ?? 20,
    pending: options.timingsMs?.pending ?? 40,
    delta: options.timingsMs?.delta ?? 40,
    completed: options.timingsMs?.completed ?? 40,
    idle: options.timingsMs?.idle ?? 30,
  }

  const requests: MockRuntimeRequests = {
    console: [],
    failed: [],
    badResponses: [],
    unhandled: [],
    createSessionCount: 0,
    opencodeSessionCreateCount: 0,
    harnessSessionCreateCount: 0,
    promptCount: 0,
    promptBodies: [],
    shellCount: 0,
    slashCount: 0,
    configPatchCount: 0,
    configPatchBodies: [],
    harnessOptionsCount: 0,
    harnessPostCount: 0,
  }

  const fanout = new FanoutBus()
  const busGlobal = fanout.channel() // /global/event + /event
  // /api/wr/events and /api/wr/runtime-events are DIFFERENT app consumers
  // (ClaxedoEventsProvider's claxedoBus stream vs global-sdk's runtime event
  // stream) that can be connected CONCURRENTLY. They must not share one
  // EventBus: `drain()` hands the entire pending batch to whichever route's
  // blocked connection resolves first, so a shared queue turns delivery into
  // a lottery — observed concretely as `emitFlat()`'d `session.lifecycle`
  // events (consumable only by ClaxedoEventsProvider on /api/wr/events)
  // vanishing into the /api/wr/runtime-events consumer, which discards
  // non-envelope frames (core-sidebar-tree behavior 15's initial failure).
  // Same reasoning as the FanoutBus class comment above — one queue per
  // consumer route, emit()/emitFlat() fan out to all.
  const busWrEvents = fanout.channel() // /api/wr/events (primary origin)
  const busWrRuntime = fanout.channel() // /api/wr/runtime-events (primary origin)
  const busRelay = fanout.channel() // cloud relay origin mounts
  let messages: MockMessageRow[] = []
  let sessionCreated = false
  let harnessPollCount = 0

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      requests.console.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on("pageerror", (error) => requests.console.push(`pageerror: ${error.message}`))
  page.on("requestfailed", (request) => {
    requests.failed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
  })
  page.on("response", (response) => {
    if (response.status() >= 400) {
      requests.badResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`)
    }
  })

  const emit = (payload: MockEvent, directory: string = DIR) => fanout.emit(directory, payload)
  // See `wrEventsHandler` below for why flat frames additionally enter a
  // replay list: /api/wr/events is polled by two different app consumers and
  // must broadcast flat frames to all of them, not queue them to one.
  const FLAT_WR_REPLAY_WINDOW_MS = 6_000
  const flatWrReplay: Array<{ payload: MockEvent; until: number }> = []
  const emitFlat = (payload: MockEvent) => {
    flatWrReplay.push({ payload, until: Date.now() + FLAT_WR_REPLAY_WINDOW_MS })
    fanout.emitFlat(payload)
  }

  // Seed the "connected" handshake so the very first /global/event connection resolves
  // immediately instead of idling out.
  emit({ type: "server.connected", properties: {} }, "global")

  function harnessModel() {
    return harnessModels[harness]?.[0] ?? BIG_PICKLE
  }

  function harnessStatusPayload() {
    if (options.harnessReadiness === "error") {
      return { status: "error" as const, ready: false, error: options.harnessReadinessError ?? "harness unavailable" }
    }
    if (options.harnessReadiness === "polling") {
      const pollingTurns = options.harnessPollingTurns ?? 2
      const applying = harnessPollCount < pollingTurns
      return applying ? { status: "applying" as const, ready: false } : { status: "ready" as const, ready: true }
    }
    return { status: "ready" as const, ready: true }
  }

  function sessionConfig() {
    const model = harnessModel()
    if (harness === "opencode") {
      return {
        harness: { type: "opencode", model: model.id, status: "ready", ready: true },
        model: { providerID: "opencode", modelID: model.id },
        provider: { id: "opencode", model: model.id },
        agent: "build",
      }
    }
    return {
      harness: { type: harness, model: model.id, ...harnessStatusPayload() },
      model: { providerID: providerIdFor(harness), modelID: model.id },
      provider: { id: providerIdFor(harness), model: model.id },
      agent: "build",
    }
  }

  function providerResponse() {
    // Always advertise the ACTIVE harness's provider/model — including
    // "opencode" and "pi" themselves, which are real provider ids in this
    // vocabulary (see BIG_PICKLE.providerID === "opencode" in the legacy
    // fixtures this mock's vocabulary matches). Omitting the active harness
    // here starves the composer of any selectable model and the submit
    // control never leaves its disabled state — this was a real pilot bug,
    // not a hypothetical: keep it fixed.
    const activeProviderID = providerIdFor(harness)
    const activeModels = harnessModels[harness] ?? [harnessModel()]
    return {
      all: [
        {
          id: activeProviderID,
          name: harness,
          env: [],
          models: Object.fromEntries(
            activeModels.map((m) => [
              m.id,
              {
                id: m.id,
                name: m.name,
                release_date: "2026-01-01",
                attachment: true,
                reasoning: true,
                temperature: true,
                tool_call: true,
                limit: { context: 200000, output: 8192 },
                cost: { input: 0, output: 0 },
                options: {},
              },
            ]),
          ),
        },
      ],
      default: { [activeProviderID]: harnessModel().id },
      connected: [activeProviderID],
    }
  }

  function sessionRow(title = "") {
    return {
      id: SESSION_ID,
      slug: SESSION_ID,
      projectID: PROJECT_ID,
      directory: DIR,
      title,
      version: "2",
      time: { created: Date.now(), updated: Date.now() },
      summary: { additions: 0, deletions: 0, files: 0 },
      config: sessionConfig(),
    }
  }

  function textPart(sessionID: string, messageID: string, text: string): MockPart {
    return { id: `${messageID}_text`, sessionID, messageID, type: "text", text }
  }

  function userMessage(input: { id: string; text: string; agent: string; providerID: string; modelID: string }): MockMessageRow {
    return {
      info: {
        id: input.id,
        sessionID: SESSION_ID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent,
        model: { providerID: input.providerID, modelID: input.modelID },
      },
      parts: [textPart(SESSION_ID, input.id, input.text)],
    }
  }

  function assistantMessagePending(input: { id: string; parentID: string; agent: string; providerID: string; modelID: string }): MockMessageRow {
    return {
      info: {
        id: input.id,
        sessionID: SESSION_ID,
        role: "assistant",
        time: { created: Date.now() },
        parentID: input.parentID,
        agent: input.agent,
        providerID: input.providerID,
        modelID: input.modelID,
        mode: "code",
        path: { cwd: DIR, root: DIR },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    }
  }

  // ------------------------------------------------------------------------
  // Turn driver — runs the busy -> pending message -> deltas -> completed ->
  // idle sequence over real ticks, per the "How streaming works" note above.
  // ------------------------------------------------------------------------
  async function driveTurn(input: { userID: string; assistantID: string; text: string; agent: string; providerID: string; modelID: string; turn: number }) {
    await wait(timings.busy)
    emit({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "busy" } } })

    await wait(timings.pending)
    const assistantRow = assistantMessagePending({
      id: input.assistantID,
      parentID: input.userID,
      agent: input.agent,
      providerID: input.providerID,
      modelID: input.modelID,
    })
    messages = [...messages, assistantRow]
    emit({ type: "message.updated", properties: { sessionID: SESSION_ID, info: assistantRow.info } })

    const fullText = replyTextFn(input.turn, input.text)
    if (options.errorMidTurn) {
      await wait(timings.delta)
      const errorMessage = typeof options.errorMidTurn === "string" ? options.errorMidTurn : "mock runtime error mid-turn"
      messages = messages.map((row) =>
        row.info.id === input.assistantID
          ? { ...row, info: { ...row.info, time: { ...row.info.time, completed: Date.now() }, error: { name: "MockError", data: { message: errorMessage } } } }
          : row,
      )
      emit({
        type: "message.updated",
        properties: {
          sessionID: SESSION_ID,
          info: messages.find((row) => row.info.id === input.assistantID)!.info,
        },
      })
      emit({ type: "session.error", properties: { sessionID: SESSION_ID } })
      return
    }

    // Stream the reply as a couple of delta chunks, then a final full-text
    // part.updated so end state is correct even if delta accumulation in the
    // client under test is not exercised by a given assertion.
    const midpoint = Math.max(1, Math.floor(fullText.length / 2))
    const chunks = [fullText.slice(0, midpoint), fullText.slice(midpoint)]
    const partID = `${input.assistantID}_text`
    let accumulated = ""
    for (const chunk of chunks) {
      await wait(timings.delta / chunks.length)
      accumulated += chunk
      emit({
        type: "message.part.delta",
        properties: { sessionID: SESSION_ID, messageID: input.assistantID, partID, field: "text", delta: chunk },
      })
    }
    const finalPart = textPart(SESSION_ID, input.assistantID, accumulated)
    messages = messages.map((row) => (row.info.id === input.assistantID ? { ...row, parts: [finalPart] } : row))
    emit({ type: "message.part.updated", properties: { sessionID: SESSION_ID, part: finalPart, time: Date.now() } })

    await wait(timings.completed)
    messages = messages.map((row) =>
      row.info.id === input.assistantID ? { ...row, info: { ...row.info, time: { ...row.info.time, completed: Date.now() } } } : row,
    )
    emit({
      type: "message.updated",
      properties: { sessionID: SESSION_ID, info: messages.find((row) => row.info.id === input.assistantID)!.info },
    })

    if (options.staleBusy) return // idle deliberately never sent

    await wait(timings.idle + (options.delayedIdleMs ?? 0))
    emit({ type: "session.idle", properties: { sessionID: SESSION_ID } })
  }

  // ------------------------------------------------------------------------
  // Route registration
  // ------------------------------------------------------------------------

  await page.route("**/health", (r) => (api(r) ? json(r, { healthy: true }) : r.continue()))

  await page.route("**/api/claxedo/bootstrap**", (r) =>
    api(r)
      ? json(r, {
          healthy: true,
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
          project: [{ id: PROJECT_ID, worktree: DIR, name: PROJECT_NAME, time: { created: Date.now(), updated: Date.now() } }],
          provider: providerResponse(),
          provider_auth: { [providerIdFor(harness)]: [{ type: "api", label: "API key" }] },
          config: { provider: { id: providerIdFor(harness), model: harnessModel().id }, agent: { id: "build" } },
        })
      : r.continue(),
  )

  const sseIdleTimeoutMs = 4000
  const eventStreamHandler = async (route: Route) => {
    if (!api(route)) return route.continue()
    const url = new URL(route.request().url())
    if (url.pathname !== "/global/event" && url.pathname !== "/event") return route.fallback()
    const batch = await busGlobal.drain(sseIdleTimeoutMs)
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: sseBody(batch) }).catch(() => {})
  }
  await page.route("**/global/event?**", eventStreamHandler)
  await page.route("**/event?**", eventStreamHandler)

  // Sessions on the /w/<dir>/session/<id> route shape consume live events from
  // GET /api/wr/events (see src/context/global-sdk.tsx), NOT /global/event.
  // Without these mounts on the primary origin, emit() is a silent no-op for
  // local sessions and specs only pass via the REST reconciliation fallback
  // (confirmed in core-busy-abort-errors' request-log investigation). Same bus
  // and wire envelope as /global/event, so cloud() re-registration on the
  // relay origin remains behavior-identical.
  // BROADCAST semantics for flat frames on /api/wr/events. The real server's
  // /api/wr/events is a fan-out SSE stream: every open connection receives
  // every event. This mock's EventBus is a work-QUEUE: `drain()` hands each
  // event to exactly one connection. That difference is fatal for flat
  // (claxedoBus-shaped) frames, because TWO DIFFERENT app consumers poll this
  // one route concurrently: ClaxedoEventsProvider's central stream (the only
  // consumer that understands flat frames) AND global-sdk's compat stream —
  // `authFetch` rewrites `/global/event` to `/api/wr/events`
  // (`signedRuntimeEventInput`, src/utils/api.ts) — which parses flat frames
  // into a directory:"global" envelope where `session.lifecycle` matches no
  // reducer (verified: this is where behavior-15's event was disappearing;
  // the compat loop's ~250ms reconnect cadence out-polls ClaxedoEventsProvider's
  // ~2s cadence, so it won the queue race nearly every time). Fix: flat
  // frames are REPLAYED to every /api/wr/events response for a short window
  // (`FLAT_WR_REPLAY_WINDOW_MS`/`flatWrReplay`, declared next to `emitFlat`)
  // instead of being consumed by the first drainer. Duplicate delivery to
  // ClaxedoEventsProvider is safe for every flat event this mock carries —
  // `session.lifecycle` created applies idempotently (cache/inventory
  // upserts by id) and the compat consumer drops flat frames entirely.
  const wrEventsHandler = async (route: Route) => {
    if (!api(route)) return route.continue()
    const batch = await busWrEvents.drain(sseIdleTimeoutMs)
    const now = Date.now()
    const replays = flatWrReplay.filter((entry) => entry.until > now)
    // Queue-delivered flat copies are dropped in favor of the replay list so
    // the drain-winner does not see the same frame twice in one body.
    const body = sseBody(batch.filter((entry) => !entry.flat)) +
      replays.map((entry) => `data: ${JSON.stringify(entry.payload)}\n\n`).join("")
    await route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => {})
  }
  const wrRuntimeEventsHandler = async (route: Route) => {
    if (!api(route)) return route.continue()
    const batch = await busWrRuntime.drain(sseIdleTimeoutMs)
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: sseBody(batch) }).catch(() => {})
  }
  await page.route("**/api/wr/events**", wrEventsHandler)
  await page.route("**/api/wr/runtime-events**", wrRuntimeEventsHandler)

  await page.route("**/path**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/path") return r.fallback()
    return json(r, { worktree: DIR })
  })

  await page.route("**/agent**", (r) => {
    if (!api(r)) return r.continue()
    if (!["/agent", "/app/agents"].includes(new URL(r.request().url()).pathname)) return r.fallback()
    return json(r, [{ id: "build", name: "build", description: "Build agent" }])
  })

  await page.route("**/provider", (r) => (api(r) ? json(r, providerResponse()) : r.continue()))
  await page.route("**/provider/auth", (r) => (api(r) ? json(r, {}) : r.continue()))

  await page.route("**/config", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/config") return r.fallback()
    return json(r, { provider: { id: providerIdFor(harness), model: harnessModel().id }, agent: { id: "build" } })
  })

  await page.route("**/project**", (r) => {
    if (!api(r)) return r.continue()
    if (!["/project", "/experimental/project"].includes(new URL(r.request().url()).pathname)) return r.fallback()
    return json(r, [{ id: PROJECT_ID, worktree: DIR, name: PROJECT_NAME, time: { created: Date.now(), updated: Date.now() } }])
  })

  await page.route("**/mcp**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/mcp") return r.fallback()
    return json(r, {})
  })
  await page.route("**/lsp**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/lsp") return r.fallback()
    return json(r, [])
  })
  await page.route("**/vcs**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/vcs") return r.fallback()
    return json(r, {})
  })
  await page.route("**/command**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/command") return r.fallback()
    return json(r, [{ name: "build", description: "Build command" }])
  })
  await page.route("**/permission**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/permission") return r.fallback()
    return json(r, [])
  })
  await page.route("**/question**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/question") return r.fallback()
    return json(r, [])
  })

  await page.route("**/api/workspace/resolve**", (r) =>
    api(r) ? json(r, { workspaceId: `local-${SESSION_ID}`, directory: DIR, kind: "local", status: "ready" }) : r.continue(),
  )

  await page.route("**/api/wr/diff/**", (r) => {
    if (!api(r)) return r.continue()
    const pathname = new URL(r.request().url()).pathname
    const body = pathname.endsWith("/refs")
      ? { branches: [], tags: [], recent: [] }
      : pathname.endsWith("/targets")
      ? {}
      : pathname.endsWith("/vcs")
      ? []
      : undefined
    if (body === undefined) return r.fallback()
    return json(r, body)
  })

  await page.route("**/api/claxedo/agent-config/harness/options**", (r) => {
    if (!api(r)) return r.continue()
    requests.harnessOptionsCount += 1
    const model = harnessModel()
    return json(r, {
      source: "runner",
      stale: false,
      options: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: model.id,
          selectOptions: harnessModels[harness] ?? [model],
        },
      ],
    })
  })

  await page.route("**/api/claxedo/agent-config/harness**", async (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/api/claxedo/agent-config/harness") return r.fallback()
    requests.harnessPostCount += 1
    if (r.request().method() === "POST") {
      harnessPollCount += 1
      let body: { type?: string } | undefined
      try {
        body = r.request().postDataJSON()
      } catch {
        body = undefined
      }
      if (body?.type && body.type in harnessModels) harness = body.type as Harness
    }
    const model = harnessModel()
    const status = harnessStatusPayload()
    return json(
      r,
      harness === "opencode" ? { type: "opencode", ok: true } : { type: harness, model: model.id, ok: true, ...status },
    )
  })

  await page.route("**/api/claxedo/agent-config/agents**", (r) =>
    api(r) ? json(r, [{ id: "build", name: "build", mode: "primary" }]) : r.continue(),
  )
  await page.route("**/api/claxedo/agent-config/commands**", (r) =>
    api(r) ? json(r, [{ name: "build", description: "Build command" }]) : r.continue(),
  )

  // "**" after /status is required: the app requests /session/status?directory=…,
  // and a bare "**/session/status" pattern never matches a query string — requests
  // then fall through to the **/session/** catch-all and get a session row instead
  // of a status map, corrupting busy/idle logic in every consumer spec.
  await page.route("**/session/status**", (r) =>
    api(r) ? json(r, { [SESSION_ID]: { type: "idle" } }) : r.continue(),
  )

  const handleSessionList = async (route: Route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() === "POST") {
      requests.createSessionCount += 1
      const sessionHarness = new URL(route.request().url()).searchParams.get("harness")
      if (sessionHarness && sessionHarness !== "opencode") requests.harnessSessionCreateCount += 1
      else requests.opencodeSessionCreateCount += 1
      sessionCreated = true
      messages = []
      return json(route, sessionRow(""))
    }
    return json(route, sessionCreated ? [sessionRow(textOf(messages[0]?.parts) || "")] : [])
  }
  await page.route("**/session", handleSessionList)
  await page.route("**/session?**", handleSessionList)
  await page.route("**/experimental/session", handleSessionList)
  await page.route("**/experimental/session?**", handleSessionList)

  await page.route("**/session/*/config**", async (route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() === "PATCH") {
      requests.configPatchCount += 1
      let body: unknown
      try {
        body = route.request().postDataJSON()
      } catch {
        body = undefined
      }
      requests.configPatchBodies.push({ body })
      if (options.configPatchFailure) {
        return json(route, { error: "could not save session config" }, 500)
      }
      return json(route, { ok: true })
    }
    return json(route, sessionConfig())
  })

  await page.route("**/session/*/todo**", (r) => (api(r) ? json(r, []) : r.continue()))

  await page.route("**/session/*/capabilities**", (r) =>
    api(r)
      ? json(r, {
          transport: harness,
          abort: true,
          reconnect: true,
          replay: true,
          permissions: true,
          questions: true,
          todos: true,
          commands: true,
          fork: true,
          revert: true,
          unrevert: true,
          configOptions: harness !== "opencode" && harness !== "pi",
        })
      : r.continue(),
  )

  await page.route("**/session/*/prompt_async**", async (route) => {
    if (!api(route)) return route.continue()
    if (options.dispatchFailure) {
      return json(route, { error: "dispatch failed" }, 500)
    }
    requests.promptCount += 1
    const body = route.request().postDataJSON() as {
      messageID?: string
      parts?: unknown
      agent?: string
      model?: { providerID?: string; modelID?: string }
      variant?: string
    }
    const text = textOf(body?.parts) || `message ${requests.promptCount}`
    const userID = body?.messageID || `msg_user_${requests.promptCount}`
    const providerID = body?.model?.providerID || providerIdFor(harness)
    const modelID = body?.model?.modelID || harnessModel().id
    const agent = body?.agent || "build"
    // Production convention (workspace-runtime/src/session/service.ts
    // `mkAssistantId`): the assistant reply's id is `${userMessageId}_r`. The
    // app's REST reconciliation (`conversationHasAssistantMessage` via
    // `assistantMessageIdForUserMessage`, the mechanism that clears a
    // stale-busy submit control without SSE) matches by EXACTLY this id — a
    // synthetic id here silently disables that entire path for every spec.
    const assistantID = `${userID}_r`
    requests.promptBodies.push({
      messageID: body?.messageID,
      assistantID,
      text,
      agent: body?.agent,
      providerID: body?.model?.providerID,
      modelID: body?.model?.modelID,
      variant: body?.variant,
    })

    messages = [...messages, userMessage({ id: userID, text, agent, providerID, modelID })]
    await route.fulfill({ status: 204, body: "" })

    // Fire-and-forget: the staged event sequence runs on its own clock, independent
    // of this route handler's lifecycle.
    void driveTurn({ userID, assistantID, text, agent, providerID, modelID, turn: requests.promptCount })
  })

  await page.route("**/session/*/shell**", async (route) => {
    if (!api(route)) return route.continue()
    const url = new URL(route.request().url())
    if (!url.pathname.match(/^\/session\/[^/]+\/shell$/)) return route.fallback()
    requests.shellCount += 1
    return route.fulfill({ status: 204, body: "" })
  })

  await page.route("**/session/*/command**", async (route) => {
    if (!api(route)) return route.continue()
    const url = new URL(route.request().url())
    if (!url.pathname.match(/^\/session\/[^/]+\/command$/)) return route.fallback()
    requests.slashCount += 1
    return route.fulfill({ status: 204, body: "" })
  })

  await page.route("**/session/*/message**", (r) => (api(r) ? json(r, messages) : r.continue()))

  await page.route("**/session/*", (r) => {
    if (!api(r)) return r.continue()
    if (!new URL(r.request().url()).pathname.match(/^\/session\/[^/]+$/)) return r.fallback()
    return json(r, sessionRow(textOf(messages[0]?.parts) || ""))
  })

  // --------------------------------------------------------------------
  // Cloud: mount the same handlers again under the relay-origin catch-all.
  // Best-effort scaffolding for specs 11-14 — the relay envelope (auth
  // headers, workspaceId scoping) is not yet fully modeled; refine there.
  // --------------------------------------------------------------------
  if (options.cloud) {
    const { workspaceId, relayOrigin } = options.cloud
    await page.route(`${relayOrigin}/api/wr/health`, (r) => json(r, { healthy: true }))
    await page.route(`${relayOrigin}/api/wr/harness-config-options`, (r) => {
      const model = harnessModel()
      return json(r, {
        source: "runner",
        stale: false,
        options: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: model.id, selectOptions: harnessModels[harness] ?? [model] }],
      })
    })
    await page.route(`${relayOrigin}/api/wr/diff/**`, (r) => {
      const pathname = new URL(r.request().url()).pathname
      const body = pathname.endsWith("/refs") ? { branches: [], tags: [], recent: [] } : pathname.endsWith("/targets") ? {} : []
      return json(r, body)
    })
    const relayEventHandler = async (route: Route) => {
      const batch = await busRelay.drain(sseIdleTimeoutMs)
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: sseBody(batch) }).catch(() => {})
    }
    await page.route(`${relayOrigin}/api/wr/events`, relayEventHandler)
    await page.route(`${relayOrigin}/api/wr/runtime-events`, relayEventHandler)
    await page.route(`**/api/workspace/resolve**`, (r) =>
      json(r, { workspaceId, directory: DIR, kind: "cloud", relayUrl: relayOrigin, status: "ready" }),
    )
  }

  return {
    requests,
    emit,
    emitFlat,
    session: { id: SESSION_ID, dir: DIR, projectId: PROJECT_ID },
  }
}
