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
import {
  assistantIdForUserMessage,
  parseSessionPromptRequest,
  SESSION_PROMPT_SUCCESS,
} from "./contracts/session-prompt"
import {
  assertSessionCreateResponse,
  parseDraftIdHeader,
  parseSessionCreateRequest,
  SESSION_CREATE_STATUS,
} from "./contracts/session-create"
import {
  assertSessionConfigPatchResponse,
  parseSessionConfigPatch,
  sessionConfigPatchHarnessSwitchBody,
  SESSION_CONFIG_PATCH_HARNESS_SWITCH_STATUS,
  SESSION_CONFIG_PATCH_SUCCESS_STATUS,
} from "./contracts/session-config"
import { HARNESS_POST_SUCCESS, parseHarnessConfigRequest } from "./contracts/agent-config-harness"
import { parseSessionCommandRequest, SESSION_COMMAND_SUCCESS } from "./contracts/session-command"
import {
  parseQuestionRejectRequest,
  parseQuestionReplyRequest,
  parseSessionPermissionRequest,
  SESSION_INTERACTION_SUCCESS,
  type PermissionResponseValue,
  type QuestionReplyBody,
} from "./contracts/session-interactions"

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
  | {
      type: "session.status"
      properties: {
        sessionID: string
        status: { type: "busy" } | { type: "idle" } | { type: "retry"; attempt: number; message: string; next: number }
      }
    }
  | { type: "session.idle"; properties: { sessionID: string } }
  | { type: "session.error"; properties: { sessionID: string } }

export type MockEvent =
  | SessionStatusEvent
  | { type: "message.updated"; properties: { sessionID: string; info: MockMessageInfo } }
  | {
      type: "message.part.delta"
      properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string }
    }
  | { type: "message.part.updated"; properties: { sessionID: string; part: MockPart; time: number } }
  | { type: "permission.asked"; properties: Record<string, unknown> }
  | { type: "permission.replied"; properties: Record<string, unknown> }
  | { type: "question.asked"; properties: Record<string, unknown> }
  | { type: "question.replied"; properties: Record<string, unknown> }
  | { type: "todo.updated"; properties: Record<string, unknown> }
  | { type: "server.connected"; properties: Record<string, unknown> }
  // Catch-all: covers both `{type, properties}`-wrapped OpenCode-shaped events
  // AND flat unwrapped ClaxedoEvent payloads (e.g. `session.lifecycle`) that
  // carry their fields at the top level instead of nested under `properties`
  // — see emitFlat()/ClaxedoEventsProvider's flat-event parsing.
  | ({ type: string; properties?: unknown } & Record<string, unknown>)

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
  sessionID?: string
  messageID?: string
  /** The assistant message id driveTurn replies with for this prompt (`${userID}_r`). */
  assistantID: string
  text: string
  agent?: string
  providerID?: string
  modelID?: string
  variant?: string
}

/** A recorded, contract-validated `POST /session`. */
export type SessionCreateRequest = {
  /** The `x-claxedo-draft-id` header, validated against the server's own pattern. */
  draftId: string | undefined
  /** The request body; `{}` when the client sent none (which is the normal case). */
  body: Record<string, unknown>
}

export type ConfigPatchBody = { body: unknown }

/**
 * One `PATCH /session/:sessionID` — the SESSION ROW route, distinct from
 * `PATCH /session/:sessionID/config` (recorded as `configPatchBodies`).
 *
 * Two different features write here and nothing else does: renaming/archiving a
 * session (`{ title }` / `{ time: { archived } }`, `session-actions.tsx` +
 * `message-timeline.tsx`) and delivering an opencode permission ruleset
 * (`{ permission }`, `src/features/session/permission/apply.ts`). Recording the whole
 * body plus a pre-narrowed `permission` lets a spec assert on the ruleset without
 * re-deriving the shape, and lets a NEGATIVE spec ("this harness must not write") assert
 * on `length === 0` rather than on a count that a title rename could also move.
 */
export type SessionUpdateBody = {
  /** Path segment, decoded — `PATCH /session/<id>`. */
  sessionID: string
  /** The raw body; `{}` when the client sent none or sent unparseable JSON. */
  body: Record<string, unknown>
  /**
   * `body.permission` when it is an array of rule-shaped objects, else `undefined`.
   * Pre-narrowed rather than cast at the assertion site so a body that carries
   * `permission` in the WRONG shape (an object map, the pre-5fd3a5b9 design) reads as
   * absent here instead of type-asserting its way into a passing test.
   */
  permission: { permission: string; pattern: string; action: string }[] | undefined
}

export type MockRuntimeRequests = {
  console: string[]
  failed: string[]
  badResponses: string[]
  unhandled: string[]
  createSessionCount: number
  /**
   * One entry per `POST /session`, in order — the validated draft-id header and body.
   * Previously only the COUNT was recorded, so no spec could assert what the client
   * actually asked for at creation time (which draft it belonged to, what title or
   * harness/model config it carried). See e2e/helpers/contracts/session-create.ts.
   */
  createSessionBodies: SessionCreateRequest[]
  opencodeSessionCreateCount: number
  harnessSessionCreateCount: number
  promptCount: number
  promptBodies: PromptBody[]
  /** Validated `POST /session/:id/permissions/:permId` decisions, in order. */
  permissionResponses: PermissionResponseValue[]
  /** Validated `POST /question/:id/reply` bodies, in order. */
  questionReplies: QuestionReplyBody[]
  /** `POST /question/:id/reject` count. */
  questionRejectCount: number
  shellCount: number
  slashCount: number
  configPatchCount: number
  configPatchBodies: ConfigPatchBody[]
  /** One entry per `PATCH /session/:sessionID` (the session ROW), in order. */
  sessionUpdateBodies: SessionUpdateBody[]
  harnessOptionsCount: number
  harnessPostCount: number
  /**
   * GET probes of `/api/claxedo/agent-config/harness`, counted separately from
   * `harnessPostCount` (which counts BOTH verbs). A GET immediately after a switch POST
   * is the observable signature of `fetchHarnessStatus` running — the fallback that was
   * unreachable while the POST answered with a full status payload.
   */
  harnessGetCount: number
  /** `POST /workspaces/:workspaceId/session` — cloud/relay-lane session creation (see `MockRuntimeOptions.cloud`). */
  cloudSessionCreateCount: number
  /** Per-request draft id + body for the cloud lane, same contract as `createSessionBodies`. */
  cloudSessionCreateBodies: SessionCreateRequest[]
  /** `POST /workspaces/:workspaceId/session/:id/prompt_async`. */
  cloudPromptCount: number
  cloudPromptBodies: PromptBody[]
  /** `GET /workspaces/:workspaceId/api/wr/harness-config-options?harness=<type>`. */
  cloudHarnessOptionsCount: number
  cloudHarnessOptionsHarnesses: string[]
}

export type MockRuntimeOptions = {
  dir?: string
  sessionId?: string
  projectId?: string
  projectName?: string
  /** Optional signed identity for the local worktree project row. */
  workspaceId?: string
  /** Optional workspace aliases merged into the local worktree project row. */
  workspaces?: Record<
    string,
    {
      id?: string
      workspaceId?: string
      kind?: string
      directory?: string
      workspace_name?: string
      available?: boolean
    }
  >
  /** The harness this session is created/locked with. Defaults to "opencode". */
  harness?: Harness
  /** Per-harness model catalog for the composer's model popover. */
  harnessModels?: Partial<Record<Harness, HarnessModelOption[]>>
  /** Readiness state the harness config endpoint reports. */
  harnessReadiness?: HarnessReadiness
  harnessReadinessError?: string
  /**
   * Extra session ids to report as `idle` from `GET /session/status`, alongside the
   * mock's own `sessionId`. Specs that render rows from their OWN fixture ids (rather
   * than the one modelled session) need this — without it those rows have no status
   * entry at all, which is what blocks `core-sidebar-tree`'s behavior-4 status-dot
   * test. Ids not listed here are deliberately ABSENT from the map, not idle.
   */
  statusSessionIds?: string[]
  /**
   * Number of `POST /api/claxedo/agent-config/harness` calls that should still report
   * "applying" before flipping to the final `harnessReadiness` — models the
   * "Connecting" pill / composer-fade-while-polling window.
   */
  harnessPollingTurns?: number
  /**
   * Number of GET probes of `/api/claxedo/agent-config/harness` after which a
   * `harnessReadiness: "polling"` harness FLIPS to ready — models a slow harness
   * that finally settles under the client's bounded re-probe loop (as opposed to
   * `harnessPollingTurns`, which only advances on POST switches). Absent (default)
   * = GET probes never settle it, preserving every existing spec's behavior.
   */
  harnessGetPollSettleAfter?: number
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
  /** `PATCH /session/:id/config` returns a non-2xx (500 — a simulated adapter/transport blowup). */
  configPatchFailure?: boolean
  /**
   * `PATCH /session/:id/config` answers the route's REAL harness-switch rejection:
   * 409 + the `unsupported_operation` envelope. Distinct from `configPatchFailure`.
   *
   * The client sends `harness.type` on every config save
   * (`submit-transport.ts:186-193`), so the real server evaluates `sameSessionHarness`
   * on EVERY patch — but the mock accepted any harness, leaving the guard that
   * enforces "a harness is locked once the session is created" (e2e/INVARIANTS.md
   * cross-cutting invariant #1) with zero e2e coverage.
   */
  configPatchHarnessSwitchFailure?: boolean
  /** Stage timings, in ms, all optional — sane defaults keep specs fast. */
  timingsMs?: { busy?: number; pending?: number; delta?: number; completed?: number; idle?: number }
  /**
   * When set, additionally mounts a full cloud/relay-lane workspace-runtime session
   * (connection mint, `/workspaces/:workspaceId/...` session/prompt/message/config/
   * capabilities/provider/harness-config-options, plus the relay event stream) so an
   * oracle-verified send can be driven through the SAME shared mock used for local
   * sessions. `relayOrigin` may be the primary origin itself or a distinct fictitious
   * origin (`https://relay.<spec>.test`) — the connection mint's `relayUrl` response is
   * what the app actually follows (`workspaceRelayConnection`,
   * `src/utils/workspace-relay-connection.ts:352`: `${relayUrl}/workspaces/:id<path>`),
   * so either works as long as `relayOrigin` is what's passed here.
   */
  cloud?: {
    workspaceId: string
    relayOrigin: string
    /** Project row id for the cloud workspace's OWN top-level project entry. Defaults to `proj_cloud_<workspaceId>`. */
    projectId?: string
    /** Project row display name. Defaults to `cloud-<workspaceId>`. */
    projectName?: string
    /** Harness the cloud session is created/locked with. Defaults to "opencode" — independent of the local lane's `options.harness`. */
    harness?: Harness
  }
}

export type MockRuntimeHandles = {
  requests: MockRuntimeRequests
  /** Manually inject an event onto the global SSE stream (permission/question/todo/etc). */
  emit: (payload: MockEvent, directory?: string) => void
  /**
   * `emit` for an IDEMPOTENT STATE frame that must survive the app's
   * `/api/wr/events` consumer being mid-reconnect — notably across the
   * draft→session navigation, where a plain `emit` is deterministically dropped
   * (measured 5/5; see the `emitDurable` implementation comment). Safe only for
   * frames that can be applied twice with the same result (`session.status`,
   * `session.idle`); NEVER for accumulating frames like `message.part.delta`.
   */
  emitDurable: (payload: MockEvent, directory?: string) => void
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
// Fix: real multi-client SSE broadcast semantics, implemented the way an
// actual SSE server implements them — an append-only per-channel EVENT LOG
// with monotonic sequence ids written as SSE `id:` lines, resumed
// per-connection from the client's own `Last-Event-ID` header. This follows
// the INTENT of the reference `ClaxedoEventBus` in
// `e2e/playwright/core-terminal.spec.ts:184-231` (each independent reader
// gets its own copy of every event, and a reader's backlog survives its own
// reconnect gap) but keys reader continuity on the client's own cursor
// instead of the reference's heuristic idle-slot claiming. The slot port was
// tried first and empirically still flaked in core-docks: with readers on
// very different reconnect cadences (global-sdk's compat loop ~250ms vs
// ClaxedoEventsProvider ~2s) their connections rarely overlap, so both
// readers ping-pong on one slot while a copy broadcast into the other slot
// strands past the assertion window (observed as the Deny test's
// permission.replied never clearing the dock); claiming backlogged slots
// first un-strands but REORDERS (a stale permission.asked redelivered after
// its permission.replied re-opens the dock). Cursor resume has neither
// failure mode: no loss, no duplication, no reordering, per reader.
//
// Reader inventory for the cursor split (verified in source):
// - global-sdk's compat loop AND its runtime-events loop
//   (`src/context/global-sdk.tsx:561,706`) both parse `id:` lines via
//   `sseJsonStream` and send `Last-Event-ID` on every reconnect — they get
//   exact per-reader resume (`seq > cursor`).
// - `ClaxedoEventsProvider` (`src/providers/claxedo-events.tsx`, its inline
//   reader loop) ignores `id:` lines and never sends `Last-Event-ID` — a
//   cursor-less connection is served the FULL wrapped log every time. That
//   is safe precisely because of what this consumer does with frames: its
//   `isClaxedoEvent` guard requires a top-level `.type`, so every
//   `{directory, payload}`-wrapped frame is silently dropped; the only
//   frames it consumes are FLAT ones, which the `/api/wr/events` handler
//   serves through the separate idempotent replay-window mechanism
//   (`flatWrReplay`) — full-log redelivery of wrapped frames to this reader
//   is a no-op by construction. An id-tracking reader's FIRST connection is
//   also cursor-less and gets the full log once — correct: a fresh page has
//   applied nothing yet.
type LoggedEvent = { seq: number; directory: string; payload: MockEvent; flat?: boolean }

class EventBus {
  private log: LoggedEvent[] = []
  private seq = 0
  private waiters: Array<() => void> = []

  private append(event: PendingEvent) {
    this.seq += 1
    this.log.push({ seq: this.seq, ...event })
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  emit(directory: string, payload: MockEvent) {
    this.append({ directory, payload })
  }

  /** See `MockRuntimeHandles.emitFlat` — appends an unwrapped SSE frame. */
  emitFlat(payload: MockEvent) {
    this.append({ directory: "", payload, flat: true })
  }

  /**
   * One call = one HTTP connection. `lastEventId` is the connection's own
   * SSE `Last-Event-ID` header (the client's cursor): serve every event with
   * `seq > lastEventId`, blocking until one exists or `idleTimeoutMs`
   * elapses (heartbeat). Cursor-less connections (`undefined`) are served
   * from seq 0 — the full log — see the reader-inventory comment above.
   */
  async drain(idleTimeoutMs: number, lastEventId?: number): Promise<LoggedEvent[]> {
    const cursor = Number.isFinite(lastEventId) ? (lastEventId as number) : 0
    if (!this.log.some((entry) => entry.seq > cursor)) {
      await Promise.race([new Promise<void>((resolve) => this.waiters.push(resolve)), wait(idleTimeoutMs)])
    }
    return this.log.filter((entry) => entry.seq > cursor)
  }
}

// The app can hold several SSE consumers at once (/global/event for the global
// store, /api/wr/events for workspace-routed sessions, the relay origin for
// cloud). Each ROUTE GROUP gets its own `EventBus` channel here (so, e.g.,
// events meant for `/api/wr/events` never leak into `/global/event`, and a
// `Last-Event-ID` cursor from one route is only ever resumed against that
// same route's log), and emit()/emitFlat() fan out to every channel. Within a
// single channel/route, the cursor-resume semantics on `EventBus` itself (see
// above) handle the case where that ONE route is polled by several
// independent concurrent readers at once (e.g. `/api/wr/events` is read by
// both `ClaxedoEventsProvider` and global-sdk's compat stream) — each reader
// resumes from its own cursor instead of racing to steal a shared queue.
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

/** The connection's own cursor, from its SSE `Last-Event-ID` request header (Playwright lowercases header names). */
function lastEventIdOf(route: Route): number | undefined {
  const raw = route.request().headers()["last-event-id"]
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

// Every event frame carries its sequence as an SSE `id:` line so id-tracking
// readers (global-sdk's sseJsonStream) build the cursor they resume with.
function sseBody(batch: LoggedEvent[]) {
  if (batch.length === 0) return ": heartbeat\n\n"
  return batch
    .map(
      ({ seq, directory, payload, flat }) =>
        `id: ${seq}\ndata: ${JSON.stringify(flat ? payload : { directory, payload })}\n\n`,
    )
    .join("")
}

// ---------------------------------------------------------------------------
// Fixtures
//
// The opencode house model's id is "big-pickle-1" (a real, versioned, servable
// model id), NOT the bare "big-pickle" — the app reserves the exact pair
// `opencode/big-pickle` as the pre-provisioning PLACEHOLDER (see
// `signed-workspace-model.ts`: "has no serving path and must never make the
// composer submit-ready"). `firstConnectedModelInfo` filters that exact id out,
// so a catalog whose only model IS the bare placeholder resolves to NO concrete
// model and the composer stays stuck on "Select model". A real provisioned
// workspace serves a real model id; the mock must too. Display name stays
// "Big Pickle" (the house brand).
// ---------------------------------------------------------------------------

export const BIG_PICKLE: HarnessModelOption = { id: "big-pickle-1", name: "Big Pickle" }

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
  const localProjectRow = () => ({
    id: PROJECT_ID,
    worktree: DIR,
    name: PROJECT_NAME,
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.workspaces ? { workspaces: options.workspaces } : {}),
    time: { created: Date.now(), updated: Date.now() },
  })
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
    createSessionBodies: [],
    opencodeSessionCreateCount: 0,
    harnessSessionCreateCount: 0,
    promptCount: 0,
    promptBodies: [],
    permissionResponses: [],
    questionReplies: [],
    questionRejectCount: 0,
    shellCount: 0,
    slashCount: 0,
    configPatchCount: 0,
    configPatchBodies: [],
    sessionUpdateBodies: [],
    harnessOptionsCount: 0,
    harnessPostCount: 0,
    harnessGetCount: 0,
    cloudSessionCreateCount: 0,
    cloudSessionCreateBodies: [],
    cloudPromptCount: 0,
    cloudPromptBodies: [],
    cloudHarnessOptionsCount: 0,
    cloudHarnessOptionsHarnesses: [],
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
  let harnessGetPollCount = 0

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      // The originating URL is appended because `message.text()` alone is not
      // origin-attributable, which forced `core-boot-deep-links-home`'s behavior-1
      // filter to drop EVERY "Failed to load resource" line from ANY origin just to
      // silence one known-noisy one. Consumers match by prefix (`startsWith
      // ("pageerror:")`) or substring, so the suffix is additive — but it now lets a
      // filter say "from this origin" instead of "anywhere".
      const url = message.location().url
      requests.console.push(`${message.type()}: ${message.text()}${url ? ` @ ${url}` : ""}`)
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
  /** Wrapped-frame counterpart of `flatWrReplay`; fed only by `emitDurable`. */
  const wrappedWrReplay: Array<{ payload: MockEvent; directory: string; until: number }> = []
  const emitFlat = (payload: MockEvent) => {
    flatWrReplay.push({ payload, until: Date.now() + FLAT_WR_REPLAY_WINDOW_MS })
    fanout.emitFlat(payload)
  }

  /**
   * `emit` for a frame that must survive the consumer being mid-reconnect.
   *
   * MEASURED (core-busy-abort-errors behavior 6, 5/5 deterministic): a wrapped
   * `session.status` frame emitted immediately after the draft→session navigation is
   * NEVER applied — the app's `/api/wr/events` consumer is between connections across
   * that transition, so the frame lands in the log but the reader that would have
   * drained it is gone. The identical frame re-emitted ~2s later applies within 500ms
   * and sticks. Specs worked around it by polling and re-emitting.
   *
   * This mirrors `flatWrReplay` for WRAPPED frames — but it is deliberately OPT-IN
   * rather than applied to every `emit`, because replay copies carry no `id:` line and
   * therefore do not advance a reader's cursor: a reader can legitimately see the same
   * frame twice. That is harmless for STATE frames (`session.status`, `session.idle` —
   * applying "busy" twice is identical to applying it once) and actively CORRUPTING
   * for accumulating ones (`message.part.delta` would double the text). Only pass
   * idempotent state frames here; use plain `emit` for everything else.
   */
  const emitDurable = (payload: MockEvent, directory: string = DIR) => {
    wrappedWrReplay.push({ payload, directory, until: Date.now() + FLAT_WR_REPLAY_WINDOW_MS })
    fanout.emit(directory, payload)
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
      // A slow harness that settles once the client's bounded re-probe loop has
      // GET-polled it enough times. Absent knob = never settles via GET.
      if (options.harnessGetPollSettleAfter !== undefined && harnessGetPollCount >= options.harnessGetPollSettleAfter) {
        return { status: "ready" as const, ready: true }
      }
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

  function userMessage(input: {
    id: string
    text: string
    agent: string
    providerID: string
    modelID: string
  }): MockMessageRow {
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

  function assistantMessagePending(input: {
    id: string
    parentID: string
    agent: string
    providerID: string
    modelID: string
  }): MockMessageRow {
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
  async function driveTurn(input: {
    userID: string
    assistantID: string
    text: string
    agent: string
    providerID: string
    modelID: string
    turn: number
  }) {
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
      const errorMessage =
        typeof options.errorMidTurn === "string" ? options.errorMidTurn : "mock runtime error mid-turn"
      messages = messages.map((row) =>
        row.info.id === input.assistantID
          ? {
              ...row,
              info: {
                ...row.info,
                time: { ...row.info.time, completed: Date.now() },
                error: { name: "MockError", data: { message: errorMessage } },
              },
            }
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
      row.info.id === input.assistantID
        ? { ...row, info: { ...row.info, time: { ...row.info.time, completed: Date.now() } } }
        : row,
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
  // Cloud/relay-lane state and turn driver — independent of the local lane
  // above (separate session id, harness, and message list), only mounted
  // when `options.cloud` is set. Mirrors `driveTurn`/`userMessage`/
  // `assistantMessagePending` above rather than generalizing them: those are
  // exercised by every local-lane spec in this suite, and threading a
  // sessionID/directory parameter through them for the cloud lane's benefit
  // is a needless risk to that already-proven surface.
  // ------------------------------------------------------------------------
  const cloud = options.cloud
  const CLOUD_WORKSPACE_ID = cloud?.workspaceId ?? ""
  const CLOUD_PROJECT_ID = cloud?.projectId ?? `proj_cloud_${CLOUD_WORKSPACE_ID}`
  const CLOUD_PROJECT_NAME = cloud?.projectName ?? `cloud-${CLOUD_WORKSPACE_ID}`
  const CLOUD_SESSION_ID = `ses_cloud_${CLOUD_WORKSPACE_ID}`
  let cloudHarness: Harness = cloud?.harness ?? "opencode"
  let cloudMessages: MockMessageRow[] = []
  let cloudSessionCreated = false

  function cloudHarnessModel() {
    return harnessModels[cloudHarness]?.[0] ?? BIG_PICKLE
  }

  // Cloud/user-hosted drafts never touch the local readiness POST/polling
  // endpoint (`STATE MODEL` in core-harness-ownership-cloud.spec.ts) — status
  // is unconditionally "ready" the instant a harness is picked, so there is
  // no draft-time "applying"/"error" state to model here.
  function cloudSessionConfig() {
    const model = cloudHarnessModel()
    if (cloudHarness === "opencode") {
      return {
        harness: { type: "opencode", model: model.id, status: "ready", ready: true },
        model: { providerID: "opencode", modelID: model.id },
        provider: { id: "opencode", model: model.id },
        agent: "build",
      }
    }
    return {
      harness: { type: cloudHarness, model: model.id, status: "ready", ready: true },
      model: { providerID: providerIdFor(cloudHarness), modelID: model.id },
      provider: { id: providerIdFor(cloudHarness), model: model.id },
      agent: "build",
    }
  }

  function cloudProviderResponse() {
    const activeProviderID = providerIdFor(cloudHarness)
    const activeModels = harnessModels[cloudHarness] ?? [cloudHarnessModel()]
    return {
      all: [
        {
          id: activeProviderID,
          name: cloudHarness,
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
      default: { [activeProviderID]: cloudHarnessModel().id },
      connected: [activeProviderID],
    }
  }

  function cloudSessionRow() {
    return {
      id: CLOUD_SESSION_ID,
      slug: CLOUD_SESSION_ID,
      projectID: CLOUD_PROJECT_ID,
      directory: CLOUD_WORKSPACE_ID,
      title: textOf(cloudMessages[0]?.parts) || "",
      version: "2",
      time: { created: Date.now(), updated: Date.now() },
      summary: { additions: 0, deletions: 0, files: 0 },
      config: cloudSessionConfig(),
    }
  }

  /** The cloud workspace's OWN top-level project row (self-referencing `workspaces` map)
   * so the empty-draft header's project `<Select>` can navigate local <-> cloud
   * client-side (core-harness-ownership-cloud behavior 5's same-pane leak-guard test). */
  function cloudProjectRow() {
    return {
      id: CLOUD_PROJECT_ID,
      worktree: CLOUD_WORKSPACE_ID,
      name: CLOUD_PROJECT_NAME,
      sandboxes: [CLOUD_WORKSPACE_ID],
      workspaces: {
        [CLOUD_WORKSPACE_ID]: {
          id: CLOUD_WORKSPACE_ID,
          kind: "cloud" as const,
          workspace_name: "main",
          directory: CLOUD_WORKSPACE_ID,
          available: true,
        },
      },
      time: { created: Date.now(), updated: Date.now() },
    }
  }

  function cloudUserMessage(input: {
    id: string
    text: string
    agent: string
    providerID: string
    modelID: string
  }): MockMessageRow {
    return {
      info: {
        id: input.id,
        sessionID: CLOUD_SESSION_ID,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent,
        model: { providerID: input.providerID, modelID: input.modelID },
      },
      parts: [textPart(CLOUD_SESSION_ID, input.id, input.text)],
    }
  }

  function cloudAssistantMessagePending(input: {
    id: string
    parentID: string
    agent: string
    providerID: string
    modelID: string
  }): MockMessageRow {
    return {
      info: {
        id: input.id,
        sessionID: CLOUD_SESSION_ID,
        role: "assistant",
        time: { created: Date.now() },
        parentID: input.parentID,
        agent: input.agent,
        providerID: input.providerID,
        modelID: input.modelID,
        mode: "code",
        path: { cwd: CLOUD_WORKSPACE_ID, root: CLOUD_WORKSPACE_ID },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    }
  }

  // Same "busy -> pending message -> deltas -> completed -> idle" staged sequence as
  // `driveTurn`, over the same real ticks, but for the cloud lane's session/messages.
  // Reply text convention (`cloud ack <n>: <text>`) matches
  // `core-cloud-provisioning.spec.ts`'s own proven `installCloudRuntimeMock` — kept
  // identical so specs asserting on it (this file's cloud lane included) share one
  // vocabulary. Delivered via the SAME `emit()` as the local lane: `emit()` fans out
  // through `FanoutBus` to every channel, `busRelay` included, so whichever concrete SSE
  // route ends up mattering for a given app code path already carries the event.
  async function driveCloudTurn(input: {
    userID: string
    assistantID: string
    text: string
    agent: string
    providerID: string
    modelID: string
    turn: number
  }) {
    // Every `emit()` call below passes `CLOUD_WORKSPACE_ID` explicitly as the SSE
    // envelope's `directory` — `emit()` defaults that param to the LOCAL lane's `DIR`,
    // which is wrong here and matters: the proven reference mock
    // (`core-cloud-provisioning.spec.ts`'s `installCloudRuntimeMock`) always emits cloud
    // session events with `directory: WORKSPACE_ID`, and the client's
    // `eventDirectoryForLiveSession`/live-session routing keys off this field.
    await wait(timings.busy)
    emit(
      { type: "session.status", properties: { sessionID: CLOUD_SESSION_ID, status: { type: "busy" } } },
      CLOUD_WORKSPACE_ID,
    )

    await wait(timings.pending)
    const assistantRow = cloudAssistantMessagePending({
      id: input.assistantID,
      parentID: input.userID,
      agent: input.agent,
      providerID: input.providerID,
      modelID: input.modelID,
    })
    cloudMessages = [...cloudMessages, assistantRow]
    emit(
      { type: "message.updated", properties: { sessionID: CLOUD_SESSION_ID, info: assistantRow.info } },
      CLOUD_WORKSPACE_ID,
    )

    const fullText = `cloud ack ${input.turn}: ${input.text}`
    const midpoint = Math.max(1, Math.floor(fullText.length / 2))
    const chunks = [fullText.slice(0, midpoint), fullText.slice(midpoint)]
    const partID = `${input.assistantID}_text`
    let accumulated = ""
    for (const chunk of chunks) {
      await wait(timings.delta / chunks.length)
      accumulated += chunk
      emit(
        {
          type: "message.part.delta",
          properties: {
            sessionID: CLOUD_SESSION_ID,
            messageID: input.assistantID,
            partID,
            field: "text",
            delta: chunk,
          },
        },
        CLOUD_WORKSPACE_ID,
      )
    }
    const finalPart = textPart(CLOUD_SESSION_ID, input.assistantID, accumulated)
    cloudMessages = cloudMessages.map((row) =>
      row.info.id === input.assistantID ? { ...row, parts: [finalPart] } : row,
    )
    emit(
      { type: "message.part.updated", properties: { sessionID: CLOUD_SESSION_ID, part: finalPart, time: Date.now() } },
      CLOUD_WORKSPACE_ID,
    )

    await wait(timings.completed)
    cloudMessages = cloudMessages.map((row) =>
      row.info.id === input.assistantID
        ? { ...row, info: { ...row.info, time: { ...row.info.time, completed: Date.now() } } }
        : row,
    )
    emit(
      {
        type: "message.updated",
        properties: {
          sessionID: CLOUD_SESSION_ID,
          info: cloudMessages.find((row) => row.info.id === input.assistantID)!.info,
        },
      },
      CLOUD_WORKSPACE_ID,
    )

    await wait(timings.idle)
    emit({ type: "session.idle", properties: { sessionID: CLOUD_SESSION_ID } }, CLOUD_WORKSPACE_ID)
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
          project: [localProjectRow(), ...(cloud ? [cloudProjectRow()] : [])],
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
    const batch = await busGlobal.drain(sseIdleTimeoutMs, lastEventIdOf(route))
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
    const batch = await busWrEvents.drain(sseIdleTimeoutMs, lastEventIdOf(route))
    const now = Date.now()
    const replays = flatWrReplay.filter((entry) => entry.until > now)
    const wrappedReplays = wrappedWrReplay.filter((entry) => entry.until > now)
    // Log-delivered flat copies are dropped in favor of the replay list so a
    // reader does not see the same frame twice in one body. Replay frames
    // deliberately carry NO `id:` line — they must not advance an
    // id-tracking reader's cursor.
    const body =
      sseBody(batch.filter((entry) => !entry.flat)) +
      replays.map((entry) => `data: ${JSON.stringify(entry.payload)}\n\n`).join("") +
      // Same no-`id:` rule as the flat replays above: these must not advance an
      // id-tracking reader's cursor. See `emitDurable` for why this is opt-in.
      wrappedReplays
        .map((entry) => `data: ${JSON.stringify({ directory: entry.directory, payload: entry.payload })}\n\n`)
        .join("")
    await route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => {})
  }
  const wrRuntimeEventsHandler = async (route: Route) => {
    if (!api(route)) return route.continue()
    const batch = await busWrRuntime.drain(sseIdleTimeoutMs, lastEventIdOf(route))
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: sseBody(batch) }).catch(() => {})
  }
  await page.route("**/api/wr/events**", wrEventsHandler)
  await page.route("**/api/wr/runtime-events**", wrRuntimeEventsHandler)

  // GET /api/control/session-list (`src/utils/workspace-control-routes.ts`
  // `controlSessionNavigationListUrl`) backs the rail sidebar's session list
  // (`rail-sidebar.tsx`'s `globalSessionList` query) — a claxedo-server-native
  // endpoint entirely distinct from the OpenCode `/session` API this file mocks
  // above. Without a default here the sidebar shows "Could not load sessions."
  // for every spec that never registers its own override. Default to an empty,
  // well-shaped list (safe: specs that need rows register a page.route AFTER
  // calling installMockRuntime, which wins per Playwright's last-registered-first
  // matching — see core-boot-deep-links-home.spec.ts's installSessionListMock,
  // the pattern this default is modeled on).
  await page.route("**/api/control/session-list**", (route) => {
    if (!api(route)) return route.continue()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        view: { scope: "global", groupBy: "none", sort: "updated_desc", limit: 50 },
        items: [],
        totalKnown: 0,
      }),
    })
  })

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
  await page.route("**/provider?**", (r) => (api(r) ? json(r, providerResponse()) : r.continue()))
  await page.route("**/provider/auth", (r) => (api(r) ? json(r, {}) : r.continue()))
  await page.route("**/provider/auth?**", (r) => (api(r) ? json(r, {}) : r.continue()))

  // Bare-path glob only (no query-string wildcard): Playwright's glob-to-regex
  // anchors the pattern's end, so `**/config` alone does NOT match the app's real
  // `GET /config?directory=...` calls (same class of gap already documented for
  // `/provider` above) — those fall through unmocked to a real backend that
  // doesn't exist in this harness, producing ERR_CONNECTION_REFUSED on every
  // config-scoped fetch. Mirror the `/provider` fix above: an explicit `?**` variant.
  const configHandler = (r: import("@playwright/test").Route) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/config") return r.fallback()
    return json(r, { provider: { id: providerIdFor(harness), model: harnessModel().id }, agent: { id: "build" } })
  }
  await page.route("**/config", configHandler)
  await page.route("**/config?**", configHandler)

  await page.route("**/project**", (r) => {
    if (!api(r)) return r.continue()
    if (!["/project", "/experimental/project"].includes(new URL(r.request().url()).pathname)) return r.fallback()
    return json(r, [localProjectRow(), ...(cloud ? [cloudProjectRow()] : [])])
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

  // Permission / question MUTATION routes. These had no shared handler at all — only
  // the two always-empty GET stubs above — so `core-docks.spec.ts` hand-rolled its own
  // (`installDockMutationRoutes`, and it says so in a comment at :243-248). That is a
  // standing violation of e2e/INVARIANTS.md authoring rule #1 ("Do not hand-roll a
  // parallel mock ... extend the shared helper instead"). These are the shared,
  // contract-validated versions; see e2e/helpers/contracts/session-interactions.ts.
  //
  // A spec that registers its own route for these paths still wins (Playwright resolves
  // last-registered-first), so adopting these is opt-in and core-docks is unaffected
  // until it deletes its local copies.
  await page.route("**/session/*/permissions/*", async (route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() !== "POST") return route.fallback()
    // Throws on ANY value that is not exactly "once" | "always" | "reject". That
    // strictness is the point: the server maps every unrecognised value — a typo, a
    // rename, a missing body — onto `deny` with HTTP 200 and no error, so an ALLOW
    // silently becomes a DENY (session-core.ts:834-835).
    requests.permissionResponses.push(
      parseSessionPermissionRequest(route.request().postDataJSON?.() ?? undefined, route.request().url()),
    )
    return json(route, SESSION_INTERACTION_SUCCESS.body, SESSION_INTERACTION_SUCCESS.status)
  })

  await page.route("**/question/*/reply", async (route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() !== "POST") return route.fallback()
    requests.questionReplies.push(
      parseQuestionReplyRequest(route.request().postDataJSON?.() ?? undefined, route.request().url()),
    )
    return json(route, SESSION_INTERACTION_SUCCESS.body, SESSION_INTERACTION_SUCCESS.status)
  })

  await page.route("**/question/*/reject", async (route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() !== "POST") return route.fallback()
    parseQuestionRejectRequest(route.request().postDataJSON?.() ?? undefined, route.request().url())
    requests.questionRejectCount += 1
    return json(route, SESSION_INTERACTION_SUCCESS.body, SESSION_INTERACTION_SUCCESS.status)
  })

  await page.route("**/api/workspace/resolve**", (r) =>
    api(r)
      ? json(r, { workspaceId: `local-${SESSION_ID}`, directory: DIR, kind: "local", status: "ready" })
      : r.continue(),
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
      let body: unknown
      try {
        body = r.request().postDataJSON()
      } catch {
        body = undefined
      }
      // CONTRACT: validated against the real claxedo-server handler (see
      // e2e/helpers/contracts/agent-config-harness.ts). The validator CALLS the real
      // exported `normalizeHarnessIdentity`/`harnessKey`, so the accepted harness-id
      // vocabulary cannot drift from the server's. The old inline `{ type?: string }`
      // cast ignored `binary`, `sessionId`, `directory`, and `workspaceId` entirely.
      parseHarnessConfigRequest(body, r.request().url())
      // Selection still keys off the RAW posted string, not the validator's canonical
      // `activeType`. That is deliberate: `harnessModels` is keyed by the app's legacy
      // ids (`claude-sdk`, `codex-app-server`, `cursor-sdk`) while the real server
      // normalizes and echoes canonical ones (`claude`, `codex`, `cursor`) — see
      // `HARNESS_CONTRACT_DIVERGENCES.legacyKeyEcho`. Switching this fixture to the
      // canonical key is a real behavior change for every harness spec, so it is
      // recorded there rather than smuggled in here.
      const postedType = (body as { type?: unknown } | undefined)?.type
      if (typeof postedType === "string" && postedType in harnessModels) harness = postedType as Harness
      // CONTRACT: the real switch endpoint returns `{ ok: true }` and NOTHING else
      // (agent-config-harness-routes.ts:202 and :211 — both the per-session and the
      // global-config branch). This fixture used to answer with a full harness-status
      // payload, which the client feeds straight into `decodeHarnessState` →
      // `applyPostedStatus`; that let every harness spec watch a switch settle
      // (including settle to ERROR) directly off the POST — a path production can
      // never take. Harness state now settles the way it really does: through the GET
      // below, reached via `fetchHarnessStatus`.
      return json(r, HARNESS_POST_SUCCESS.body, HARNESS_POST_SUCCESS.status)
    }
    // Count GET probes so `harnessGetPollSettleAfter` can settle a slow
    // polling harness under the client's bounded re-probe loop.
    harnessGetPollCount += 1
    requests.harnessGetCount += 1
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
  // The map covers SESSION_ID plus any ids the spec declares via
  // `statusSessionIds`. It used to be hardcoded to SESSION_ID alone, which meant a
  // spec whose rows use its own fixture ids (e.g. `core-sidebar-tree`'s `ses_status_*`)
  // got NO status entry for them — the reason that spec's behavior-4 status-dot test
  // is still `test.fixme`. Unknown ids stay absent rather than defaulting to idle, so
  // a spec cannot accidentally assert against a status the server never reported.
  await page.route("**/session/status**", (r) =>
    api(r)
      ? json(
          r,
          Object.fromEntries(
            [SESSION_ID, ...(options.statusSessionIds ?? [])].map((id) => [id, { type: "idle" }]),
          ),
        )
      : r.continue(),
  )

  const handleSessionList = async (route: Route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() === "POST") {
      requests.createSessionCount += 1
      const url = route.request().url()
      // CONTRACT: validated against the real route (see
      // e2e/helpers/contracts/session-create.ts). The draft-id header is checked the
      // way `parseDraftId` checks it — a malformed id is a hard 400 server-side, so
      // it must not pass silently here; the body is optional (the app sends none).
      const draftId = parseDraftIdHeader(route.request().headers(), url)
      const body = parseSessionCreateRequest(route.request().postDataJSON?.() ?? undefined, url)
      requests.createSessionBodies.push({ draftId, body })
      const sessionHarness = new URL(url).searchParams.get("harness")
      if (sessionHarness && sessionHarness !== "opencode") requests.harnessSessionCreateCount += 1
      else requests.opencodeSessionCreateCount += 1
      sessionCreated = true
      messages = []
      // CONTRACT: 201, not the `json()` default of 200 — the real route is
      // `c.json(normalizeSession(...), 201)`. The response shape is asserted too so
      // this fixture cannot drift away from what the route actually returns.
      const created = sessionRow("")
      assertSessionCreateResponse(created, url)
      return json(route, created, SESSION_CREATE_STATUS)
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
      const url = route.request().url()
      // CONTRACT: validated against the real PATCH route (see
      // e2e/helpers/contracts/session-config.ts). The body used to be recorded as an
      // opaque `unknown`, so a half-filled `model` — which `promptModel`
      // (session-config.ts:74) drops SILENTLY server-side — read as a successful save.
      let body: unknown
      try {
        body = route.request().postDataJSON()
      } catch {
        body = undefined
      }
      requests.configPatchBodies.push({ body: parseSessionConfigPatch(body, url) })
      if (options.configPatchFailure) {
        // Deliberately NOT the route's 409: this option simulates an adapter/transport
        // blowup, which really can surface as a 500. The route's own 409 harness-switch
        // failure is a separate path — see `configPatchHarnessSwitchFailure` below.
        return json(route, { error: "could not save session config" }, 500)
      }
      if (options.configPatchHarnessSwitchFailure) {
        // CONTRACT: the route's ONE self-generated failure. The client sends
        // `harness.type` on EVERY save (submit-transport.ts:186-193), so the real
        // server runs `sameSessionHarness` on every PATCH and answers a mismatch with
        // this exact 409 envelope. Nothing exercised it before.
        return json(
          route,
          sessionConfigPatchHarnessSwitchBody({
            currentHarnessId: harness,
            requestedHarnessId: String(
              (body as { harness?: { type?: unknown; id?: unknown } } | undefined)?.harness?.id
                ?? (body as { harness?: { type?: unknown } } | undefined)?.harness?.type
                ?? "unknown",
            ),
            transport: "local",
          }),
          SESSION_CONFIG_PATCH_HARNESS_SWITCH_STATUS,
        )
      }
      // CONTRACT: the real route returns the full `SessionConfig`
      // (`c.json(config)`, session-core.ts:571) — NOT `{ ok: true }`. The old
      // acknowledgement was doubly wrong: it is the wrong shape, and its `ok` key
      // collides with the FAILURE envelope's `ok` discriminant, so a client branching
      // on `body.ok` looked correct by accident.
      const saved = sessionConfig()
      assertSessionConfigPatchResponse(saved, url)
      return json(route, saved, SESSION_CONFIG_PATCH_SUCCESS_STATUS)
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
    // CONTRACT: validated against the REAL server's `SessionPromptBody`
    // (`@claxedo/workspace-runtime/routes`) instead of a locally re-declared shape.
    // A body the real route could not consume now throws here rather than being
    // silently accepted — see e2e/helpers/contracts/session-prompt.ts for why.
    const body = parseSessionPromptRequest(route.request().postDataJSON(), route.request().url())
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
    const assistantID = assistantIdForUserMessage(userID)
    requests.promptBodies.push({
      sessionID: decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? ""),
      messageID: body?.messageID,
      assistantID,
      text,
      agent: body?.agent,
      providerID: body?.model?.providerID,
      modelID: body?.model?.modelID,
      variant: body?.variant,
    })

    messages = [...messages, userMessage({ id: userID, text, agent, providerID, modelID })]
    // CONTRACT: the real route returns 204 with an empty body on every success path.
    await route.fulfill({ ...SESSION_PROMPT_SUCCESS })

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
    // CONTRACT: see e2e/helpers/contracts/session-command.ts. The body was never
    // inspected here, and the response was `204` with an empty body while the real
    // route returns `c.json({ ok: true })` — HTTP 200 (session-core.ts:712).
    parseSessionCommandRequest(route.request().postDataJSON?.() ?? undefined, route.request().url())
    return route.fulfill({ ...SESSION_COMMAND_SUCCESS })
  })

  await page.route("**/session/*/message**", (r) => (api(r) ? json(r, messages) : r.continue()))

  await page.route("**/session/*", (r) => {
    if (!api(r)) return r.continue()
    const pathname = new URL(r.request().url()).pathname
    if (!pathname.match(/^\/session\/[^/]+$/)) return r.fallback()
    // CONTRACT: `PATCH /session/:id` answers with the normalized session row, same as
    // the GET (`c.json(normalizeSession(session, directory))`, workspace-runtime
    // `routes/session-core.ts:546`) — so the shared `sessionRow()` fixture below is the
    // right response for both verbs and only the RECORDING differs.
    if (r.request().method() === "PATCH") {
      let raw: unknown
      try {
        raw = r.request().postDataJSON()
      } catch {
        raw = undefined
      }
      const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
      const rules = body.permission
      const isRule = (value: unknown): value is { permission: string; pattern: string; action: string } =>
        !!value
        && typeof value === "object"
        && typeof (value as { permission?: unknown }).permission === "string"
        && typeof (value as { pattern?: unknown }).pattern === "string"
        && typeof (value as { action?: unknown }).action === "string"
      requests.sessionUpdateBodies.push({
        sessionID: decodeURIComponent(pathname.split("/").at(-1) ?? ""),
        body,
        permission: Array.isArray(rules) && rules.length > 0 && rules.every(isRule) ? rules : undefined,
      })
    }
    return json(r, sessionRow(textOf(messages[0]?.parts) || ""))
  })

  // --------------------------------------------------------------------
  // Cloud: mount a full relay-lane workspace-runtime session (connection
  // mint + `/workspaces/:workspaceId/...` session/prompt/message/config/
  // capabilities/provider/harness-config-options + event streams), proven
  // against `core-cloud-provisioning.spec.ts`'s own spec-local
  // `installCloudRuntimeMock` (oracle-verified send through this exact
  // route shape).
  //
  // DUAL-ORIGIN routing — a relay-backed workspace's requests reach the
  // runtime via TWO different origins depending on which transport the
  // environment resolves, and BOTH must be intercepted identically:
  //   1. RELAY origin (`${relayUrl}/workspaces/:id<path>`,
  //      `workspaceRelayConnection`, `src/utils/workspace-relay-connection.ts`)
  //      — used by the post-send session controller and by any environment
  //      whose central base is NOT loopback.
  //   2. LOOPBACK local-proxy form (`${serverUrl}/workspaces/:id<path>`,
  //      `createWorkspaceRuntimeRequest`, `workspace-runtime-request.ts:223`)
  //      — used by the DRAFT-time harness-config transport
  //      (`workspaceHarnessTransport` picks `transport: "loopback"` whenever
  //      `centralTransportForServer(base) === "loopback"`,
  //      `harness-config-runtime.ts:89`, and `preferRelayOnLoopback` stays
  //      false) and by the workspace event subscription, whenever the central
  //      base is loopback (e.g. `http://127.0.0.1:3001` in local CI). The
  //      draft never knows `relayOrigin` at all — it proxies through the
  //      loopback server's own `/workspaces/:id/...` path prefix.
  // The `base` glob below therefore matches ANY origin (`**/workspaces/:id`),
  // so the SAME handler counts/serves whichever origin actually receives the
  // traffic — the recorded counters are the SUM across both lanes, which is
  // exactly what the ownership assertions require (they must hold regardless
  // of the environment's transport choice). `relayOrigin` is a distinct
  // fictitious origin or the primary origin; either matches this glob.
  // The bare (un-prefixed) `${relayOrigin}/api/wr/*` routes further below
  // are kept for existing callers that relied on them directly.
  // --------------------------------------------------------------------
  if (cloud) {
    const { workspaceId, relayOrigin } = cloud
    // Origin-agnostic prefix: matches both the relay origin
    // (`${relayOrigin}/workspaces/:id/...`) and the loopback local-proxy form
    // (`${serverUrl}/workspaces/:id/...`) — see DUAL-ORIGIN note above.
    const base = `**/workspaces/${workspaceId}`

    // Connection mint — `GET /api/workspace/:id/connection[/refresh]` on the PRIMARY
    // origin (never relay-prefixed: the client doesn't know the relay origin until
    // this resolves). Always reports the workspace ready/minted — the 4-step
    // provisioning pipeline itself is `core-cloud-provisioning.spec.ts`'s own concern,
    // out of scope here.
    await page.route(`**/api/workspace/${workspaceId}/connection**`, (r) =>
      api(r)
        ? json(r, {
            access: "cloud",
            backing: "cloud-vm",
            workspaceId,
            role: "owner",
            relayUrl: relayOrigin,
            runtimeAccessToken: `rat_${workspaceId}`,
            tokenExpiresAt: Date.now() + 120_000,
          })
        : r.continue(),
    )

    // Lifecycle checkpoints — `GET /api/workspace/:id/checkpoints` on the PRIMARY
    // origin (workspace-panel.tsx via workspaceCheckpointsUrl). Unhandled it falls
    // through to the real backend, whose 500 body is thrown raw by the client's
    // request helper and crashes the route's suspense boundary into the global
    // error view. An empty snapshot is the correct steady state for a freshly
    // minted mock workspace.
    await page.route(`**/api/workspace/${workspaceId}/checkpoints**`, (r) =>
      api(r) ? json(r, { worktrees: [] }) : r.continue(),
    )

    // Resolve must discriminate by workspaceId/directory — a blanket catch-all here
    // would also answer the LOCAL directory's own resolve (mounted earlier, above)
    // with cloud info, breaking any spec exercising both lanes in one page (e.g. the
    // same-pane local -> cloud draft navigation in core-harness-ownership-cloud
    // behavior 5).
    await page.route(`**/api/workspace/resolve**`, (r) => {
      if (!api(r)) return r.continue()
      const url = new URL(r.request().url())
      const q = url.searchParams.get("workspaceId") ?? url.searchParams.get("directory") ?? ""
      if (q !== workspaceId && !q.includes(workspaceId)) return r.fallback()
      return json(r, {
        workspaceId,
        projectID: CLOUD_PROJECT_ID,
        projectId: CLOUD_PROJECT_ID,
        directory: workspaceId,
        kind: "cloud",
        status: "ready",
      })
    })

    await page.route(`${base}/vcs**`, (r) => json(r, {}))
    await page.route(`${base}/mcp**`, (r) => json(r, {}))
    await page.route(`${base}/lsp**`, (r) => json(r, []))
    await page.route(`${base}/agent**`, (r) =>
      json(r, [{ id: "build", name: "build", description: "Build agent", mode: "primary" }]),
    )
    await page.route(`${base}/app/agents**`, (r) =>
      json(r, [{ id: "build", name: "build", description: "Build agent" }]),
    )
    await page.route(`${base}/command**`, (r) => json(r, [{ name: "build", description: "Build command" }]))
    await page.route(`${base}/permission**`, (r) => json(r, []))
    await page.route(`${base}/question**`, (r) => json(r, []))
    await page.route(`${base}/provider`, (r) => json(r, cloudProviderResponse()))
    await page.route(`${base}/provider?**`, (r) => json(r, cloudProviderResponse()))
    await page.route(`${base}/provider/auth`, (r) => json(r, {}))
    await page.route(`${base}/provider/auth?**`, (r) => json(r, {}))
    await page.route(`${base}/api/wr/health`, (r) => json(r, { healthy: true }))
    // Worktree admission on the cloud draft-submit path
    // (prepareWorkspaceSessionWorktree, src/platform/runtime/cloud/workspace-runtime-store.ts):
    // submit-directory.ts POSTs /api/wr/worktrees after the draft workspace resolves
    // and ABORTS the submit without sending the prompt when the admission fails or
    // returns an invalid record — so this lane must answer with a well-formed
    // worktree (path + branch + baseCommit), matching core-cloud-provisioning's
    // proven inline mock.
    await page.route(`${base}/api/wr/worktrees**`, (r) => {
      if (r.request().method() !== "POST") return json(r, { worktrees: [] })
      return json(r, {
        worktree: { path: workspaceId, branch: "main", baseCommit: "e2e-base-commit" },
      })
    })
    await page.route(`${base}/api/wr/harness-config-options**`, (r) => {
      const url = new URL(r.request().url())
      const type = (url.searchParams.get("harness") as Harness | null) ?? cloudHarness
      requests.cloudHarnessOptionsCount += 1
      requests.cloudHarnessOptionsHarnesses.push(type)
      const model = harnessModels[type]?.[0] ?? BIG_PICKLE
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
            selectOptions: harnessModels[type] ?? [model],
          },
        ],
      })
    })
    await page.route(`${base}/api/wr/diff/**`, (r) => {
      const pathname = new URL(r.request().url()).pathname
      const body = pathname.endsWith("/refs")
        ? { branches: [], tags: [], recent: [] }
        : pathname.endsWith("/targets")
          ? {}
          : []
      return json(r, body)
    })

    const relayEventHandler = async (route: Route) => {
      const batch = await busRelay.drain(sseIdleTimeoutMs, lastEventIdOf(route))
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: sseBody(batch) }).catch(() => {})
    }
    // `/api/wr/events` + `/api/wr/runtime-events` are the primary channel
    // (`ClaxedoEventsProvider`'s workspace target, `claxedo-events.tsx`); `/global/event`
    // + `/event` are mounted too as a defensive fallback for `global-sdk.tsx`'s classic
    // loop, matching `core-cloud-provisioning.spec.ts`'s proven mock — all four drain
    // the SAME `busRelay` channel, which (post slot-broadcast fix above) safely
    // broadcasts one copy to each concurrently-connected reader.
    await page.route(`${base}/api/wr/events**`, relayEventHandler)
    await page.route(`${base}/api/wr/runtime-events**`, relayEventHandler)
    await page.route(`${base}/global/event**`, relayEventHandler)
    await page.route(`${base}/event**`, relayEventHandler)

    await page.route(`${base}/session/status**`, (r) =>
      json(r, cloudSessionCreated ? { [CLOUD_SESSION_ID]: { type: "idle" } } : {}),
    )

    const handleCloudSessionList = async (route: Route) => {
      if (!api(route)) return route.continue()
      if (route.request().method() === "POST") {
        requests.cloudSessionCreateCount += 1
        // CONTRACT: same binding as the local lane — the relay forwards to the SAME
        // workspace-runtime route, so the cloud lane must not drift into accepting a
        // draft id or body the local lane rejects.
        const url = route.request().url()
        const draftId = parseDraftIdHeader(route.request().headers(), url)
        const body = parseSessionCreateRequest(route.request().postDataJSON?.() ?? undefined, url)
        requests.cloudSessionCreateBodies.push({ draftId, body })
        const sessionHarness = new URL(url).searchParams.get("harness")
        if (sessionHarness && sessionHarness in harnessModels) cloudHarness = sessionHarness as Harness
        cloudSessionCreated = true
        cloudMessages = []
        const created = cloudSessionRow()
        assertSessionCreateResponse(created, url)
        return json(route, created, SESSION_CREATE_STATUS)
      }
      return json(route, cloudSessionCreated ? [cloudSessionRow()] : [])
    }
    await page.route(`${base}/session`, handleCloudSessionList)
    await page.route(`${base}/session?**`, handleCloudSessionList)

    await page.route(`${base}/session/*/config**`, async (route) => {
      if (!api(route)) return route.continue()
      if (route.request().method() === "PATCH") return json(route, { ok: true })
      return json(route, cloudSessionConfig())
    })
    await page.route(`${base}/session/*/capabilities**`, (r) =>
      json(r, {
        transport: cloudHarness,
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
        configOptions: cloudHarness !== "opencode" && cloudHarness !== "pi",
      }),
    )
    await page.route(`${base}/session/*/todo**`, (r) => json(r, []))
    await page.route(`${base}/session/*/message**`, (r) => json(r, cloudMessages))
    await page.route(`${base}/session/*/prompt_async**`, async (route) => {
      if (!api(route)) return route.continue()
      requests.cloudPromptCount += 1
      // CONTRACT: same real-server binding as the local lane above. The relay
      // forwards this body to the same `workspace-runtime` route, so the cloud lane
      // must not be allowed to drift into accepting a shape the local lane rejects.
      const body = parseSessionPromptRequest(route.request().postDataJSON(), route.request().url())
      const text = textOf(body?.parts) || `cloud message ${requests.cloudPromptCount}`
      const userID = body?.messageID || `msg_cloud_user_${requests.cloudPromptCount}`
      const providerID = body?.model?.providerID || providerIdFor(cloudHarness)
      const modelID = body?.model?.modelID || cloudHarnessModel().id
      const agent = body?.agent || "build"
      const assistantID = assistantIdForUserMessage(userID)
      requests.cloudPromptBodies.push({
        messageID: body?.messageID,
        assistantID,
        text,
        agent: body?.agent,
        providerID: body?.model?.providerID,
        modelID: body?.model?.modelID,
        variant: body?.variant,
      })

      cloudMessages = [...cloudMessages, cloudUserMessage({ id: userID, text, agent, providerID, modelID })]
      await route.fulfill({ ...SESSION_PROMPT_SUCCESS })

      void driveCloudTurn({ userID, assistantID, text, agent, providerID, modelID, turn: requests.cloudPromptCount })
    })
    // Single `*` (not `**`) matches exactly one path segment, so this never collides
    // with the `/session/*/config|capabilities|todo|message|prompt_async` routes
    // above (those have an extra `/`-delimited segment) — same convention as the
    // local lane's own `"**/session/*"` catch-all.
    await page.route(`${base}/session/*`, (r) => (api(r) ? json(r, cloudSessionRow()) : r.continue()))
    await page.route(`${base}/file**`, (r) => json(r, []))
    await page.route(`${base}/find**`, (r) => json(r, []))

    // Bare (un-prefixed) relay routes kept for existing callers that mount `cloud`
    // without exercising the full session lane above (e.g. specs asserting only on
    // `/api/wr/events` delivery to a workspace-scoped pane).
    await page.route(`${relayOrigin}/api/wr/health`, (r) => json(r, { healthy: true }))
    await page.route(`${relayOrigin}/api/wr/harness-config-options`, (r) => {
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
    await page.route(`${relayOrigin}/api/wr/diff/**`, (r) => {
      const pathname = new URL(r.request().url()).pathname
      const body = pathname.endsWith("/refs")
        ? { branches: [], tags: [], recent: [] }
        : pathname.endsWith("/targets")
          ? {}
          : []
      return json(r, body)
    })
    await page.route(`${relayOrigin}/api/wr/events`, relayEventHandler)
    await page.route(`${relayOrigin}/api/wr/runtime-events`, relayEventHandler)
  }

  return {
    requests,
    emit,
    emitDurable,
    emitFlat,
    session: { id: SESSION_ID, dir: DIR, projectId: PROJECT_ID },
  }
}
