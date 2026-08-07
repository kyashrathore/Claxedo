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
import type { SessionHarness } from "../../../agent-sdk-runtime/src"
import { normalizeHarnessIdentity } from "../../../agent-sdk-runtime/src/harness-types"
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
import { sessionStatusResponseBody, type LiveSessionStatus } from "./contracts/session-status"
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
  /**
   * The permission mode this turn asked to run under.
   *
   * Recorded because the FIRST turn can only be governed this way — the session
   * is created by the prompt itself, so there is no session to write a mode to
   * beforehand. A spec asserts on this rather than on the picker's label, since
   * a picker can relabel itself while nothing reaches the runtime.
   */
  permissionMode?: string
}

/** A recorded, contract-validated `POST /session`. */
export type SessionCreateRequest = {
  /** The `x-claxedo-draft-id` header, validated against the server's own pattern. */
  draftId: string | undefined
  /** The request body, including the complete initial session config. */
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
  /**
   * Every API request (`resourceType` fetch/xhr) that reached the END of this page's
   * route chain without any handler fulfilling it — i.e. every request that ESCAPED
   * the mock and went to the real network.
   *
   * WHY THIS EXISTS AS A REAL LIST NOW. It was declared and initialised but never
   * written to by anything, so `core-boot-deep-links-home`'s
   * `expect(mock.requests.unhandled).toEqual([])` — the suite's only "did anything
   * escape?" tripwire — passed vacuously from the day it was written.
   *
   * An escape has two failure modes and NEITHER is loud, which is why four route
   * families sat escaped for so long:
   *   1. SAME-ORIGIN — the VITE DEV SERVER answers the SPA's `index.html` at **HTTP
   *      200**. `badResponses` (>=400 only) never flags it, the JSON parse throws, and
   *      every caller that wraps the fetch in `.catch(() => [])` degrades to an empty
   *      result indistinguishable from a genuinely empty answer.
   *   2. CENTRAL ORIGIN (`VITE_CLAXEDO_SERVER_URL`, 127.0.0.1:3001) — nothing is
   *      listening at all, so the fetch REJECTS. Callers without a catch propagate
   *      that rejection and silently abort whatever bootstrap they were part of. This
   *      is strictly worse than mode 1 and was the harder one to spot: it made
   *      `core-first-prompt-local` behavior 5 assert a surface the app only reaches
   *      when its session inventory fails to load.
   *
   * The four, all now mocked below: `POST /session/:id/abort`, the `/find` + `/file`
   * browser surface, `GET /api/wr/diff/vcs/file`, and `GET /api/control/sessions` —
   * the last of which this list found itself, on its first honest run.
   *
   * FORMAT is `"<METHOD> <origin><pathname>"`. The query string is dropped so the list
   * is stable across runs (directories, session ids and cache-busters all live there);
   * the ORIGIN is kept, deliberately, because a request that escapes to a third party
   * (Clerk, a CDN) is a different finding from one that escapes to the app's own
   * origin, and a pathname-only record cannot tell a filter which is which.
   *
   * NOT recorded: documents, scripts, stylesheets, images and fonts. The SPA's own
   * asset graph is served by the dev server BY DESIGN and is not an escape — the
   * `api()` gate (fetch/xhr only) is what draws that line.
   */
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
  /**
   * `POST /session/:id/abort` — one per request, counted the moment it is RECEIVED
   * (before `holdAbort`'s gate, so a held-open abort still increments here).
   *
   * The mock had no abort route at all, so `core-busy-abort-errors` and
   * `core-composer-modes` each hand-rolled their own — a standing violation of
   * e2e/INVARIANTS.md authoring rule 1, and one that made them disagree about the
   * response (`200 {}` vs `204` empty; the real route answers 200 with an
   * `AbortResult`). Both spec-local copies are deleted in favour of this.
   */
  abortCount: number
  /** Validated `POST /session/:id/permissions/:permId` decisions, in order. */
  permissionResponses: PermissionResponseValue[]
  /**
   * Every `PUT /session/:id/permission-mode`, in order.
   *
   * The point of recording these is that a picker CAN change its own label
   * without anything reaching the runtime — which is the exact failure this
   * feature shipped with twice. A spec asserts on this array, not on the
   * trigger text.
   */
  permissionModeWrites: { modeId: string }[]
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

export type MockRuntimeSubagentRow = {
  subagentKey: string
  revision: number
  mode?: "foreground" | "background"
  status?: "pending" | "running" | "paused" | "interrupted" | "completed" | "failed" | "killed"
  label?: string
  subagentType?: string
  description?: string
  providerId?: string
  providerKind?: string
  childSessionId?: string
  transcript?: { kind: "live" | "file" | "messages" | "none"; ref?: string }
  toolCallEdges?: Array<{ toolCallId: string; role: "spawn" | "interaction"; revision: number }>
}

export type MockRuntimeChildSession = {
  id: string
  parentId: string
  title: string
  prompt: string
  reply: string
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
  /**
   * Starts with one completed turn in an already-created session. Use this for
   * rail-entry/revisit scenarios: creating the session in the same renderer
   * also seeds its transient harness store, masking cold session hydration.
   */
  existingSession?: { prompt: string; reply?: string }
  /** Durable host rows returned by `GET /session/:parent/subagents`. */
  subagents?: Record<string, MockRuntimeSubagentRow[]>
  /** Read-only child Sessions available to subagent open/navigation scenarios. */
  childSessions?: MockRuntimeChildSession[]
  /** Parent-scope authorization used by the canonical runtime-event SSE route. */
  runtimeEventAuthorizeParent?: (parentSessionId: string) => boolean
  /** Per-harness model catalog for the composer's model popover. */
  harnessModels?: Partial<Record<Harness, HarnessModelOption[]>>
  /** Readiness state the harness config endpoint reports. */
  harnessReadiness?: HarnessReadiness
  harnessReadinessError?: string
  /**
   * Seed for the LIVE session map `GET /session/status` answers — keyed by session id,
   * for any session the spec models, not just the mock's own `sessionId`. Mutable at
   * runtime via `handles.setSessionStatus`, so a spec can drive a row busy and settle it
   * again while its SSE frames land.
   *
   * Only live statuses are representable: the real route's map holds `busy`/`retry`/
   * `recovering` and NOTHING else — an idle session is an ABSENT key on both server
   * paths, and every client already reads absence as idle. See
   * `./contracts/session-status.ts` for the two implementations and the citations.
   */
  sessionStatuses?: Record<string, LiveSessionStatus>
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
  /**
   * `POST /session/:id/abort` RECORDS the request (see `requests.abortCount`) but
   * withholds its response until `handles.releaseAbort()` is called.
   *
   * This is what makes "status reconciles optimistically BEFORE the network responds"
   * (core-busy-abort-errors behavior 3) falsifiable instead of decorative: with an
   * immediately-200 abort there is no window in which the network has not answered
   * yet, so an assertion made after the click proves nothing about optimism. With the
   * response held open, the submit control can only leave "stop" via the client-side
   * write in `createPromptAbort`
   * (`src/features/session/composer/ui/submit-abort.ts` — `setPromptSessionStatus
   * ({status: idle, source: "server"})` runs BEFORE `client.session.abort()` is even
   * called).
   *
   * Release before the test ends so the page tears down cleanly.
   */
  holdAbort?: boolean
  /**
   * What the mock workspace's file-browser surface (`/find/file`, `/find`,
   * `/file`, `/file/content`) reports. Defaults to `DEFAULT_WORKSPACE_FILES` — a
   * tiny but REAL tree, because the alternative default (empty everything) makes a
   * regression in any file-browser surface indistinguishable from the steady
   * state. Pass `[]` for a genuinely empty workspace.
   */
  workspaceFiles?: { path: string; content: string }[]
  /** Initial config persistence fails during `POST /session`, and later config PATCHes also return 500. */
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
   * Manually inject an event onto the global SSE stream WITHOUT the
   * `{directory, payload}` envelope `emit()` always wraps events in. Real
   * `claxedoBus`-originated events (e.g. `session.lifecycle`, see
   * `packages/claxedo-server/src/opencode/compat-routes/events.ts`) are
   * written to the wire flat/unwrapped — `ClaxedoEventsProvider`'s
   * `isClaxedoEvent` guard (`packages/claxedo-app/src/providers/
   * claxedo-events.tsx`) requires a top-level `.type` and silently drops
   * anything wrapped in `{directory, payload}`. Use this for events consumed
   * via `useClaxedoEvents()`; use `emit()` for opencode-SDK-shaped events
   * consumed via `globalSDK.event`.
   */
  emitFlat: (payload: MockEvent) => void
  /**
   * Releases a `holdAbort: true` abort response. A no-op when `holdAbort` is unset
   * (the abort answered immediately) and idempotent, so a `finally` can call it
   * unconditionally.
   */
  releaseAbort: () => void
  /**
   * Moves a session in or out of the LIVE map `GET /session/status` answers, for ANY
   * session id the spec models — not only the mock's own `sessionId`.
   *
   * Pass `undefined` (or nothing) to settle the session: the real route drops the key
   * entirely rather than reporting `{type:"idle"}`, so this does the same. Keep it in
   * step with the `session.status`/`session.idle` frames you emit — the sidebar
   * reconciles every row against this route on a batched poll, and it is the ONLY
   * source of a row's status after a reload, when no SSE frame replays the live state.
   */
  setSessionStatus: (sessionId: string, status?: LiveSessionStatus) => void
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
//   (`src/app/providers/global-sdk/provider.tsx:652` and `:507`) both parse
//   `id:` lines via `sseJsonStream` and send `Last-Event-ID` on every
//   reconnect — they get exact per-reader resume (`seq > cursor`). The compat
//   loop reaches THIS route because `authFetch` rewrites `/global/event` to
//   `/api/wr/events` (`signedRuntimeEventInput`, src/platform/api/api.ts:185).
// - `ClaxedoEventsProvider` (`src/app/integrations/claxedo-events.tsx`, its
//   inline reader loop) resumes the same way: it reads `id:` lines (:508-509)
//   and sends `Last-Event-ID` (:461). It is NOT a reader that wrapped frames
//   pass through harmlessly — `normalizeClaxedoStreamEvent` (:158-169) unwraps
//   `{directory, payload}` and applies the payload, so directory events
//   (permission / question / message) DO reach the shell caches through it.
//   Serving it a full log re-upserts requests the user already answered and
//   resurrects their docks; its own cursor is what prevents that.
// - A reader's FIRST connection is cursor-less and is served the full log
//   once. Harmless here: a spec's page has applied nothing at that point.
//   NOTE this is a deliberate divergence from the real handler
//   (`packages/workspace-runtime/src/routes/runtime-events.ts`), which serves
//   a cursor-less connection NOTHING from its replay buffer — it resumes such
//   a connection at "now" and bootstraps its cursor with an opening heartbeat
//   frame. The mock keeps full-log-on-first-connect because specs emit before
//   the app has finished booting and rely on catching up.
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

/**
 * The mock workspace's files, as served by `/find/file`, `/find`, `/file` and
 * `/file/content` (see `MockRuntimeOptions.workspaceFiles`).
 *
 * Deliberately NOT empty. Callers of these routes wrap them in `.catch(() => [])`,
 * so an empty (or escaping-to-the-dev-server) answer degrades silently into
 * "the workspace happens to have no files" rather than into a visible failure —
 * which is how a whole-origin routing gap once stayed invisible here. The fixture
 * carries a README with an `# H1` heading and a source file with a `TODO` line so
 * both content shapes are exercised.
 */
export const DEFAULT_WORKSPACE_FILES: { path: string; content: string }[] = [
  { path: "README.md", content: "# Mock Runtime\n\nA fixture workspace served by e2e/helpers/mock-runtime.ts.\n" },
  { path: "package.json", content: "{\n  \"name\": \"mock-runtime-fixture\"\n}\n" },
  { path: "src/index.ts", content: "// TODO: replace the fixture entrypoint\nexport const ready = true\n" },
  { path: "src/util.ts", content: "export function noop() {}\n" },
]

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

function sessionHarnessFor(harness: Harness) {
  const identity = normalizeHarnessIdentity(harness)
  if (!identity) throw new Error(`Invalid mock harness identity: ${harness}`)
  return identity
}

function sameSessionHarness(current: SessionHarness, requested: SessionHarness) {
  return current.id === requested.id
    && current.access === requested.access
    && (requested.connection === undefined
      || JSON.stringify(current.connection ?? null) === JSON.stringify(requested.connection))
}

export function providerCatalogIndex(input: {
  all: Array<{ id: string; name: string; models: Record<string, unknown> }>
  connected: string[]
  default: Record<string, string>
}) {
  const connected = new Set(input.connected)
  return {
    all: input.all.map((provider) => {
      const modelID = input.default[provider.id]
      return {
        id: provider.id,
        name: provider.name,
        models: connected.has(provider.id) && modelID && provider.models[modelID]
          ? { [modelID]: provider.models[modelID] }
          : {},
      }
    }),
    connected: input.connected,
    default: input.default,
  }
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
  let savedModel: { providerID: string; modelID: string } | null | undefined
  let savedAgent: string | null | undefined
  let savedVariant: string | null | undefined
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
    abortCount: 0,
    permissionResponses: [],
    permissionModeWrites: [],
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

  // The LIVE half of `GET /session/status`, modelled the way the server models it: a
  // map of the sessions that are currently busy/retrying/recovering. Settling a session
  // DELETES its key rather than storing idle — see `./contracts/session-status.ts`.
  const liveSessionStatuses = new Map<string, LiveSessionStatus>(Object.entries(options.sessionStatuses ?? {}))
  const setSessionStatus = (sessionId: string, status?: LiveSessionStatus) => {
    if (status) liveSessionStatuses.set(sessionId, status)
    else liveSessionStatuses.delete(sessionId)
  }

  // `holdAbort`'s gate. `releaseAbort` is handed back on the handles and is safe to
  // call when the gate was never armed, or twice.
  let releaseAbort = () => {}
  const abortGate = options.holdAbort
    ? new Promise<void>((resolve) => {
        releaseAbort = resolve
      })
    : undefined

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
  const emitFlat = (payload: MockEvent) => {
    flatWrReplay.push({ payload, until: Date.now() + FLAT_WR_REPLAY_WINDOW_MS })
    fanout.emitFlat(payload)
  }

  // NOTE: there is deliberately no wrapped-frame counterpart to `flatWrReplay`.
  // One existed (`emitDurable`/`wrappedWrReplay`) on the premise that a wrapped
  // frame emitted while the app's `/api/wr/events` consumer sits between
  // connections is DROPPED. It is not: `EventBus` is an append-only log and a
  // reconnect resumes at the reader's own `Last-Event-ID`, so such a frame is
  // delivered late (by the reader's reconnect delay), never lost. Nothing used
  // the escape hatch and it has been removed. If a spec needs a wrapped frame
  // applied promptly, wait for the consumer rather than duplicating the frame.

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
    const model = savedModel === undefined
      ? { providerID: providerIdFor(harness), modelID: harnessModel().id }
      : savedModel
    return {
      harness: sessionHarnessFor(harness),
      ...(model ? { model } : {}),
      agent: savedAgent === undefined ? "build" : savedAgent,
      ...(savedVariant === undefined ? {} : { variant: savedVariant }),
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

  function childSessionRow(child: MockRuntimeChildSession) {
    return {
      ...sessionRow(child.title),
      id: child.id,
      slug: child.id,
      parentID: child.parentId,
      title: child.title,
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

  function childMessages(child: MockRuntimeChildSession): MockMessageRow[] {
    const model = harnessModel()
    const userID = `${child.id}_user`
    const assistantID = `${child.id}_assistant`
    return [
      {
        info: {
          id: userID,
          sessionID: child.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: providerIdFor(harness), modelID: model.id },
        },
        parts: [textPart(child.id, userID, child.prompt)],
      },
      {
        info: {
          id: assistantID,
          sessionID: child.id,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          parentID: userID,
          agent: "build",
          providerID: providerIdFor(harness),
          modelID: model.id,
          mode: "code",
          path: { cwd: DIR, root: DIR },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [textPart(child.id, assistantID, child.reply)],
      },
    ]
  }

  if (options.existingSession) {
    const model = harnessModel()
    const userID = "msg_existing_user"
    const assistantID = "msg_existing_assistant"
    const assistant = assistantMessagePending({
      id: assistantID,
      parentID: userID,
      agent: "build",
      providerID: providerIdFor(harness),
      modelID: model.id,
    })
    assistant.info.time.completed = Date.now()
    assistant.parts = [textPart(SESSION_ID, assistantID, options.existingSession.reply ?? "existing reply")]
    messages = [
      userMessage({
        id: userID,
        text: options.existingSession.prompt,
        agent: "build",
        providerID: providerIdFor(harness),
        modelID: model.id,
      }),
      assistant,
    ]
    sessionCreated = true
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
    // The SSE frame and the LIVE `GET /session/status` map are two halves of the
    // same fact and have to move together — see `setSessionStatus`'s own note.
    // Emitting `busy` while the status route still reports the session settled
    // makes the mock contradict itself, and the app is right to believe the
    // route: it reconciles against it and drops back to idle. That is what made
    // `staleBusy` unrepresentable — the turn it models as "server said busy and
    // never said idle" was being settled by the mock's own status route a beat
    // later, so the composer lost its Stop button while the session was, by the
    // scenario's own terms, still running.
    setSessionStatus(SESSION_ID, { type: "busy" })
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

    // Deliberately NOT settled in the live map either: a stale-busy server is one
    // that never reports the turn finished by ANY route, which is the whole point
    // of the scenario. Settling here would reproduce the contradiction above.
    if (options.staleBusy) return // idle deliberately never sent

    await wait(timings.idle + (options.delayedIdleMs ?? 0))
    setSessionStatus(SESSION_ID)
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
  let cloudSavedModel: { providerID: string; modelID: string } | null | undefined
  let cloudSavedAgent: string | null | undefined
  let cloudSavedVariant: string | null | undefined
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
    const model = cloudSavedModel === undefined
      ? { providerID: providerIdFor(cloudHarness), modelID: cloudHarnessModel().id }
      : cloudSavedModel
    return {
      harness: sessionHarnessFor(cloudHarness),
      ...(model ? { model } : {}),
      agent: cloudSavedAgent === undefined ? "build" : cloudSavedAgent,
      ...(cloudSavedVariant === undefined ? {} : { variant: cloudSavedVariant }),
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
  //
  // THE TERMINAL CATCH-ALL MUST STAY FIRST. Playwright resolves route handlers
  // LAST-REGISTERED-FIRST, and `route.fallback()` defers to the next-earlier
  // matching handler — so a catch-all registered BEFORE every other route in this
  // file is the chain's final link, reached only when nothing above it fulfilled
  // the request. That is precisely the definition of "escaped the mock", which is
  // what `requests.unhandled` is for (see its doc comment on
  // `MockRuntimeRequests`). Registering it anywhere else silently inverts the
  // meaning: a catch-all registered LAST would intercept everything first and
  // record every single request as unhandled.
  //
  // Corollary for spec authors: routes a spec registers BEFORE calling
  // `installMockRuntime` sit earlier in the chain than this recorder and will be
  // recorded as unhandled even though they do handle the request. Register
  // spec-local routes AFTER `installMockRuntime` — which is also the only order
  // that lets them take precedence over the shared mock, so it was already the
  // documented convention.
  //
  // The shape (record, then `route.fallback()`) follows the 598/599-sentinel
  // catch-alls that `core-cloud-offline-roles.spec.ts` and
  // `core-cloud-provisioning.spec.ts` already run locally; this is the shared
  // version of the same idea, minus the sentinel status (the point here is to let
  // the request through and REPORT it, not to fail it — a hard failure would
  // change app behavior and mask the very degradation being measured).
  // ------------------------------------------------------------------------

  await page.route("**/*", async (route) => {
    if (api(route)) {
      const url = new URL(route.request().url())
      requests.unhandled.push(`${route.request().method()} ${url.origin}${url.pathname}`)
    }
    await route.fallback()
  })

  await page.route("**/health", (r) => (api(r) ? json(r, { healthy: true }) : r.continue()))

  await page.route("**/api/claxedo/bootstrap**", (r) =>
    api(r)
      ? json(r, {
          healthy: true,
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
          project: [localProjectRow(), ...(cloud ? [cloudProjectRow()] : [])],
          provider: providerCatalogIndex(providerResponse()),
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
  // Broadest first: `**/event?**` also matches `.../global/event?…`, so registering it
  // LAST (Playwright matches most-recently-registered-first) would have left the
  // `/global/event` line permanently unreachable. Inert here — both point at the same
  // handler, which dispatches on pathname itself — but the ordering is written the
  // right way round so the shadowing guard has nothing to allowlist.
  await page.route("**/event?**", eventStreamHandler)
  await page.route("**/global/event?**", eventStreamHandler)

  // Sessions on the /w/<dir>/session/<id> route shape consume live events from
  // GET /api/wr/events (see src/app/providers/global-sdk/provider.tsx), NOT
  // /global/event. Without these mounts on the primary origin, emit() is a
  // silent no-op for local sessions and specs only pass via the REST
  // reconciliation fallback (confirmed in core-busy-abort-errors' request-log
  // investigation). Same bus and wire envelope as /global/event, so cloud()
  // re-registration on the relay origin remains behavior-identical.
  //
  // FLAT frames get an extra short replay window on top of the log. History:
  // `EventBus` USED to be a work-queue whose `drain()` handed each event to
  // exactly one connection, which is fatal on this route because TWO app
  // consumers poll it concurrently — ClaxedoEventsProvider's central stream
  // (the only consumer that understands flat frames) AND global-sdk's compat
  // stream, since `authFetch` rewrites `/global/event` to `/api/wr/events`
  // (`signedRuntimeEventInput`, src/platform/api/api.ts:185), which parses flat
  // frames into a directory:"global" envelope where `session.lifecycle` matches
  // no reducer (verified: this is where behavior-15's event was disappearing;
  // the compat loop's ~250ms reconnect cadence out-polls ClaxedoEventsProvider's
  // ~2s cadence, so it won the queue race nearly every time). `EventBus` is now
  // an append-only log with per-reader cursor resume, which fixes the race for
  // every frame — but flat frames are still stripped from the log delivery and
  // served from `flatWrReplay` (`FLAT_WR_REPLAY_WINDOW_MS`, declared next to
  // `emitFlat`) so they carry no `id:` and cannot advance a reader's cursor.
  // Duplicate delivery to ClaxedoEventsProvider is safe for every flat event
  // this mock carries — `session.lifecycle` created applies idempotently
  // (cache/inventory upserts by id) and the compat consumer drops flat frames
  // entirely.
  const wrEventsHandler = async (route: Route) => {
    if (!api(route)) return route.continue()
    const request = route.request()
    const url = new URL(request.url())
    const workspaceScoped = url.pathname.startsWith("/workspaces/") ||
      url.searchParams.has("directory") ||
      request.headers()["x-opencode-directory"]?.startsWith("workspace:") === true
    const batch = await busWrEvents.drain(sseIdleTimeoutMs, lastEventIdOf(route))
    const now = Date.now()
    // Flat lifecycle frames originate on a workspace runtime stream. The bare
    // central `/api/wr/events` stream carries central events only; replaying a
    // workspace frame there makes a central-only client look correctly wired.
    const replays = workspaceScoped ? flatWrReplay.filter((entry) => entry.until > now) : []
    // Log-delivered flat copies are dropped in favor of the replay list so a
    // reader does not see the same frame twice in one body. Replay frames
    // deliberately carry NO `id:` line — they must not advance an
    // id-tracking reader's cursor.
    const body =
      sseBody(batch.filter((entry) => !entry.flat)) +
      replays.map((entry) => `data: ${JSON.stringify(entry.payload)}\n\n`).join("")
    await route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => {})
  }
  const wrRuntimeEventsHandler = async (route: Route) => {
    if (!api(route)) return route.continue()
    const parentSessionId = new URL(route.request().url()).searchParams.get("parentSessionId")
    if (parentSessionId && options.runtimeEventAuthorizeParent && !options.runtimeEventAuthorizeParent(parentSessionId)) {
      return json(route, { error: "Forbidden" }, 403)
    }
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

  // GET /api/control/sessions — the FLAT session inventory on the control plane
  // (`controlSessionListUrl`, src/platform/runtime/agent/workspace-control-routes.ts:76-85),
  // read by `fetchLocalControlSessions`
  // (src/features/session/data/sync/inventory-source.ts:449-457). Distinct route from
  // `/api/control/session-list` above (the rail sidebar's grouped view), and it was
  // escaping the mock entirely — found by `requests.unhandled` the first time that list
  // was actually populated.
  //
  // It degraded silently rather than loudly, which is why nothing caught it: the escape
  // is answered by the Vite dev server with `index.html` at **200**, so `res.ok` passes,
  // and the very next line is `await res.json().catch(() => ({ sessions: [] }))` — the
  // HTML parse failure is swallowed into an empty inventory indistinguishable from a
  // workspace that genuinely has no sessions.
  //
  // CONTRACT (claxedo-server/src/deployments/hosted-shared/hosted-app.ts:486-503): `{ sessions: [...] }`. The
  // EMPTY body is not a stub here — it is the route's own answer on this exact request:
  // `fetchLocalControlSessions` sends no `workspaceId`, and the handler's first line is
  // `if (!workspaceId || !services.authority?.listSessions) return c.json({ sessions: [] })`.
  await page.route("**/api/control/sessions**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/api/control/sessions") return r.fallback()
    return json(r, { sessions: [] })
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
  /**
   * Permission modes, per harness — the shape the real runtime serves from its
   * static tables (Claude/Codex/Cursor), from the live agent (ACP), or not at
   * all (opencode has rules, not modes).
   *
   * Mirrored here rather than proxied because these lists are exactly what the
   * picker renders, so a spec asserting on the rows is asserting on this table.
   * `permissionModeWrites` records every PUT so a spec can prove a selection
   * reached the runtime instead of only changing a label.
   */
  const MODES_BY_HARNESS: Record<string, { modes: { id: string; name: string; level?: string }[]; unsupported?: string }> = {
    opencode: { modes: [], unsupported: "opencode has no permission modes of its own" },
    claude: {
      modes: [
        { id: "default", name: "Default", level: "ask" },
        { id: "acceptEdits", name: "Accept edits", level: "auto" },
        { id: "auto", name: "Auto" },
        { id: "plan", name: "Plan" },
        { id: "dontAsk", name: "Don't ask" },
        { id: "bypassPermissions", name: "Bypass permissions", level: "full" },
      ],
    },
    codex: {
      modes: [
        { id: "read-only", name: "Read only", level: "ask" },
        { id: "workspace-write", name: "Workspace write", level: "auto" },
        { id: "untrusted", name: "Untrusted" },
        { id: "full-access", name: "Full access", level: "full" },
      ],
    },
    cursor: {
      modes: [
        { id: "review", name: "Review each call", level: "ask" },
        { id: "auto-review", name: "Auto-review", level: "auto" },
        { id: "unsandboxed", name: "Unsandboxed", level: "full" },
      ],
    },
    /**
     * ACP agents advertise on session/new, so a DRAFT is answered from the
     * runtime's recorded tables (`ACP_KNOWN_MODES`) — the agents' OWN ids and
     * names, captured from the live binaries.
     *
     * These used to be three rungs Claxedo named itself ("Ask for everything"
     * and friends). Mirroring the real tables matters more than it looks: a spec
     * asserting on rows is asserting on THIS object, so a fixture carrying a
     * vocabulary the runtime no longer produces would keep passing while the
     * product showed something else entirely.
     *
     * Note each vendor's ACP list differs from its SDK list above — same product,
     * two transports, genuinely different surfaces.
     */
    "claude-acp": {
      modes: [
        { id: "auto", name: "Auto", level: "auto" },
        { id: "default", name: "Manual", level: "ask" },
        { id: "acceptEdits", name: "Accept Edits" },
        { id: "plan", name: "Plan Mode" },
        { id: "dontAsk", name: "Don't Ask" },
        { id: "bypassPermissions", name: "Bypass Permissions", level: "full" },
      ],
    },
    "codex-acp": {
      modes: [
        { id: "read-only", name: "Read-only", level: "ask" },
        { id: "agent", name: "Agent", level: "auto" },
        { id: "agent-full-access", name: "Agent (full access)", level: "full" },
      ],
    },
    "cursor-acp": {
      modes: [
        { id: "agent", name: "Agent", level: "auto" },
        { id: "plan", name: "Plan" },
        { id: "ask", name: "Ask", level: "ask" },
      ],
    },
  }
  const modeTableFor = (harness: string) => {
    if (harness === "opencode") return MODES_BY_HARNESS.opencode!
    // Each ACP agent has its own table now, so no `-acp` fallback: an unknown one
    // must surface as a missing fixture rather than silently borrow another
    // agent's modes, which is the exact bug this feature exists to prevent.
    if (harness.endsWith("-acp")) {
      const table = MODES_BY_HARNESS[harness]
      if (!table) throw new Error(`mock-runtime: no permission modes recorded for ${harness}`)
      return table
    }
    return MODES_BY_HARNESS[harness.replace(/-sdk|-app-server$/, "")] ?? MODES_BY_HARNESS.opencode!
  }
  const modeState = (harness: string) => {
    const table = modeTableFor(harness)
    const current = requests.permissionModeWrites.at(-1)?.modeId
      ?? table.modes.find((mode) => mode.level === "auto")?.id
    return {
      modes: table.modes,
      ...(table.unsupported ? { unsupported: table.unsupported } : {}),
      ...(current ? { currentModeId: current } : {}),
      appliesFrom: harness === "cursor-sdk" ? "next-session" : "next-turn",
    }
  }
  // Directory-scoped: what a DRAFT asks for.
  //
  // `harness`, NOT `options.harness`: the mutable binding is the whole reason
  // `harness` is a `let` (see its declaration) — it tracks the in-app switch via
  // `POST /api/claxedo/agent-config/harness`. Reading the frozen install option
  // here meant a draft that switched harness kept reporting the ORIGINAL
  // harness's permission modes forever, so a real per-harness-modes regression
  // could not fail this mock.
  await page.route("**/permission/modes**", (r) => (api(r) ? json(r, modeState(harness)) : r.continue()))
  await page.route("**/session/*/permission-mode**", async (route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() === "PUT") {
      const body = JSON.parse(route.request().postData() || "{}") as { modeId?: string }
      if (body.modeId) requests.permissionModeWrites.push({ modeId: body.modeId })
    }
    // `harness`, not `options.harness` — same reason as the directory-scoped route above.
    return json(route, modeState(harness))
  })

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

  // Onboarding reads the sandbox driver catalog on every boot to decide whether
  // the cloud steps apply at all. The default is "no provider configured", which
  // is the honest zero state: a local-only machine has no cloud, so setup is the
  // two required steps. Specs that exercise the cloud steps override this.
  await page.route("**/api/workspace/drivers**", (r) =>
    api(r)
      ? json(r, {
        default_driver: "daytona",
        drivers: [{ id: "daytona", label: "Daytona", fields: [], configured: false, source: "local", default: true }],
      })
      : r.continue(),
  )

  // Remote access left the setup flow (it needs a sign-in), but the controller
  // still reports availability for the home-surface card.
  await page.route("**/api/claxedo/remote-access**", (r) =>
    api(r)
      ? json(r, {
        enabled: false,
        hostedSignedIn: false,
        relayConfigured: false,
        deviceLoginConfigured: false,
        secondDeviceOpen: false,
      })
      : r.continue(),
  )

  // `/vcs/file` is checked BEFORE `/vcs` — `endsWith("/vcs")` is false for
  // `/api/wr/diff/vcs/file`, but the ordering is written explicitly anyway because
  // getting it backwards is silent: the app would receive `[]` where it expects an
  // object. That single-file endpoint used to fall through this handler entirely
  // (it matched none of the three suffixes, so `body === undefined` and the request
  // escaped to the dev server's `index.html`), and the relay-origin copy further
  // below actively answered `[]` for it — its `else` branch is unconditional.
  //
  // CONTRACT (workspace-runtime/src/routes/diff.ts:142-168 → `filePatchDiff`,
  // workspace-files/diff.ts:505-527): 200 with `Partial<FileDiff> & { file: string }`.
  // A file with no diff to show is `{ file, patch: "" }` — the function's own final
  // return — NOT an empty array and NOT an absent body. `file` echoes the `file`
  // query param, which the route requires (400 `file_required` without it).
  function diffBody(url: URL): unknown {
    const pathname = url.pathname
    if (pathname.endsWith("/refs")) return { branches: [], tags: [], recent: [] }
    if (pathname.endsWith("/targets")) return {}
    if (pathname.endsWith("/vcs/file")) return { file: url.searchParams.get("file") ?? "", patch: "" }
    if (pathname.endsWith("/vcs")) return []
    return undefined
  }
  /** The cloud/relay lanes have no fallthrough of their own — an unknown diff path there
   * previously became `[]`, the WRONG shape for three of the four endpoints. Empty
   * `/vcs`-style is still the least-surprising default, but it is now the default only
   * for paths the suffix table does not name. */
  const relayDiffBody = (url: URL) => diffBody(url) ?? []
  await page.route("**/api/wr/diff/**", (r) => {
    if (!api(r)) return r.continue()
    const body = diffBody(new URL(r.request().url()))
    if (body === undefined) return r.fallback()
    return json(r, body)
  })

  // ------------------------------------------------------------------------
  // File browser / search surface on the PRIMARY origin.
  //
  // These were mocked only on the cloud lane (`${base}/file**`, `${base}/find**`,
  // registered inside `if (cloud)`), so on the primary origin they escaped to the
  // dev server. Their callers wrap each request in `.catch(() => [])`, so the
  // escape presented as "the workspace happens to be empty" rather than as a
  // failure.
  //
  // CONTRACTS, all read from the routes the app actually talks to
  // (claxedo-server/src/opencode/compat-routes/index.ts:67-89, which delegate to
  // opencode-compat-file-browser.ts; workspace-runtime/src/routes/file.ts:55-108 is
  // the same surface behind the relay and agrees on every shape):
  //   GET /find/file    -> string[] of workspace-RELATIVE paths (globSearch)
  //   GET /find         -> GrepMatch[] : { path:{text}, lines:{text}, line_number,
  //                        absolute_offset, submatches:[{match:{text},start,end}] }
  //   GET /file         -> { name, path, absolute, type:"file"|"directory", ignored }[]
  //   GET /file/content -> { type:"text", content } (or a base64 `binary` variant)
  //   GET /file/status  -> [] here; the fixture has no VCS state
  //   GET /file/all     -> { paths: string[] }
  //   GET /find/symbol  -> [] — the real handler is itself a stub (opencode-compat.ts:75)
  // ------------------------------------------------------------------------
  const workspaceFiles = options.workspaceFiles ?? DEFAULT_WORKSPACE_FILES
  const workspaceFilePaths = workspaceFiles.map((file) => file.path)
  /** Mirrors `globSearch`/`searchWorkspaceFiles`: substring match, case-insensitive, capped. */
  const findFiles = (url: URL) => {
    const query = (url.searchParams.get("query") ?? "").trim().toLowerCase()
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 200)
    return workspaceFilePaths.filter((path) => !query || path.toLowerCase().includes(query)).slice(0, limit)
  }
  /** Mirrors `grepSearch`: real regex over the fixture's contents, 1-based line numbers, capped at 10. */
  const findText = (url: URL) => {
    const pattern = url.searchParams.get("pattern") ?? ""
    if (!pattern.trim()) return []
    let expression: RegExp
    try {
      expression = new RegExp(pattern, "g")
    } catch {
      return []
    }
    const out: {
      path: { text: string }
      lines: { text: string }
      line_number: number
      absolute_offset: number
      submatches: { match: { text: string }; start: number; end: number }[]
    }[] = []
    for (const file of workspaceFiles) {
      let offset = 0
      let lineNumber = 0
      for (const line of file.content.split("\n")) {
        lineNumber += 1
        const submatches = Array.from(line.matchAll(expression)).map((hit) => ({
          match: { text: hit[0] },
          start: hit.index,
          end: hit.index + hit[0].length,
        }))
        if (submatches.length > 0) {
          out.push({
            path: { text: file.path },
            lines: { text: line },
            line_number: lineNumber,
            absolute_offset: offset,
            submatches,
          })
          if (out.length >= 10) return out
        }
        offset += line.length + 1
      }
    }
    return out
  }
  /** Mirrors `directoryEntriesBody`: one level of the fixture tree, directories first. */
  const listDirectory = (url: URL) => {
    const requested = (url.searchParams.get("path") ?? "").replace(/^\/+|\/+$/g, "")
    const prefix = requested ? `${requested}/` : ""
    const names = new Map<string, "file" | "directory">()
    for (const path of workspaceFilePaths) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (!rest) continue
      const slash = rest.indexOf("/")
      names.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? "file" : "directory")
    }
    return [...names]
      .map(([name, type]) => ({
        name,
        path: `${prefix}${name}`,
        absolute: `${DIR}/${prefix}${name}`,
        type,
        ignored: name.startsWith(".") || name === "node_modules",
      }))
      .sort((left, right) =>
        left.type !== right.type ? (left.type === "directory" ? -1 : 1) : left.name.localeCompare(right.name),
      )
  }
  const fileBrowserHandler = (r: Route) => {
    if (!api(r)) return r.continue()
    const url = new URL(r.request().url())
    // The relay/loopback lane addresses the SAME runtime routes under a
    // `/workspaces/:workspaceId` prefix (see the DUAL-ORIGIN note in the cloud
    // block below), so strip it and dispatch on the runtime path. This lets the
    // cloud lane reuse this handler instead of its old `${base}/file** -> []`
    // stub, which answered an ARRAY for `/file/content` — where the client expects
    // `{type, content}`.
    switch (url.pathname.replace(/^\/workspaces\/[^/]+/, "")) {
      case "/find/file":
        return json(r, findFiles(url))
      case "/find/symbol":
        return json(r, [])
      case "/find":
        return json(r, findText(url))
      case "/file":
        return json(r, listDirectory(url))
      case "/file/content": {
        const requested = (url.searchParams.get("path") ?? "").replace(/^\/+/, "")
        const match = workspaceFiles.find((file) => file.path === requested)
        // CONTRACT: an unreadable path is NOT an error here — `fileContentBody`'s
        // catch returns `{type:"text", content:""}` (opencode-compat-file-browser.ts:75-80).
        return json(r, { type: "text", content: (match?.content ?? "").trim() })
      }
      case "/file/status":
        return json(r, [])
      case "/file/all":
        return json(r, { paths: workspaceFilePaths })
      default:
        return r.fallback()
    }
  }
  // Both a bare and a `?**` glob per path family: Playwright anchors the end of a
  // glob, so `**/find` alone never matches the app's real `GET /find?pattern=…`
  // (the same gap already documented for `/provider` and `/config` above).
  await page.route("**/find", fileBrowserHandler)
  await page.route("**/find?**", fileBrowserHandler)
  await page.route("**/find/**", fileBrowserHandler)
  await page.route("**/file", fileBrowserHandler)
  await page.route("**/file?**", fileBrowserHandler)
  await page.route("**/file/**", fileBrowserHandler)

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

  // "**" after /status is required: the app requests /session/status?directory=…, and a
  // bare "**/session/status" pattern never matches a query string — the request would
  // fall past this route entirely. That is necessary but was NOT sufficient: the
  // `**/session/*` catch-all below is registered later and so out-matched this route
  // even with the wildcard, which is the shadowing its own comment now records.
  //
  // The body is the LIVE map, built through `sessionStatusResponseBody` so it can only
  // ever carry the shape the real route produces — see `./contracts/session-status.ts`
  // for both server implementations. It used to be a fixed `{[SESSION_ID]:
  // {type:"idle"}}`: one hardcoded id, in an idle-VALUED shape neither server path can
  // emit (idle is an absent key on the wire). A spec rendering rows from its own
  // fixture ids therefore had no entry for them and no way to model one, so no scenario
  // could put a fixture row into a live state at all — half of what parked
  // `core-sidebar-tree`'s behavior-4 status-dot scenario. (The other half: this route
  // was being SHADOWED by the `**/session/*` catch-all near the bottom of this file and
  // never ran at all — see the exclusion there.) Specs now seed
  // `options.sessionStatuses` and/or drive `handles.setSessionStatus` per session id;
  // sessions absent from the map read as idle everywhere, exactly as on the wire.
  await page.route("**/session/status**", (r) =>
    api(r) ? json(r, sessionStatusResponseBody(Object.fromEntries(liveSessionStatuses))) : r.continue(),
  )

  const handleSessionList = async (route: Route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() === "POST") {
      requests.createSessionCount += 1
      const url = route.request().url()
      // CONTRACT: validated against the real route (see
      // e2e/helpers/contracts/session-create.ts). The draft-id header is checked the
      // way `parseDraftId` checks it — a malformed id is a hard 400 server-side, so
      // it must not pass silently here; the body carries the complete initial config.
      const draftId = parseDraftIdHeader(route.request().headers(), url)
      const body = parseSessionCreateRequest(route.request().postDataJSON?.() ?? undefined, url)
      requests.createSessionBodies.push({ draftId, body })
      if (options.configPatchFailure && Object.keys(body).some((key) => ["harness", "model", "agent", "variant"].includes(key))) {
        return json(route, { error: { code: "session_create_failed", message: "config unavailable" } }, 500)
      }
      const createModel = body.model && typeof body.model === "object" && !Array.isArray(body.model)
        ? body.model as Record<string, unknown>
        : undefined
      if (body.model === null) savedModel = null
      if (typeof createModel?.providerID === "string" && typeof createModel.id === "string") {
        savedModel = { providerID: createModel.providerID, modelID: createModel.id }
      }
      if (typeof body.agent === "string" || body.agent === null) savedAgent = body.agent
      if (typeof body.variant === "string" || body.variant === null) savedVariant = body.variant
      if (!("variant" in body) && typeof createModel?.variant === "string") savedVariant = createModel.variant
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
    return json(route, [
      ...(sessionCreated ? [sessionRow(textOf(messages[0]?.parts) || "")] : []),
      ...(options.childSessions ?? []).map(childSessionRow),
    ])
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
      const update = parseSessionConfigPatch(body, url)
      requests.configPatchBodies.push({ body: update })
      const currentHarness = sessionHarnessFor(harness)
      if (options.configPatchFailure) {
        // Deliberately NOT the route's 409: this option simulates an adapter/transport
        // blowup, which really can surface as a 500. The route's own 409 harness-switch
        // failure is enforced by the canonical identity check below.
        return json(route, { error: "could not save session config" }, 500)
      }
      if (update.harness && !sameSessionHarness(currentHarness, update.harness)) {
        return json(
          route,
          sessionConfigPatchHarnessSwitchBody({
            currentHarnessId: currentHarness.id,
            requestedHarnessId: update.harness.id,
            transport: currentHarness.id,
          }),
          SESSION_CONFIG_PATCH_HARNESS_SWITCH_STATUS,
        )
      }
      if (update.model !== undefined) savedModel = update.model
      if (update.agent !== undefined) savedAgent = update.agent
      if (update.variant !== undefined) savedVariant = update.variant
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
      ...(typeof body?.permissionMode === "string" ? { permissionMode: body.permissionMode } : {}),
    })

    messages = [...messages, userMessage({ id: userID, text, agent, providerID, modelID })]
    // CONTRACT: the real route returns 204 with an empty body on every success path.
    await route.fulfill({ ...SESSION_PROMPT_SUCCESS })

    // Fire-and-forget: the staged event sequence runs on its own clock, independent
    // of this route handler's lifecycle.
    void driveTurn({ userID, assistantID, text, agent, providerID, modelID, turn: requests.promptCount })
  })

  // POST /session/:id/abort — the route the mock never had.
  //
  // CONTRACT (workspace-runtime/src/routes/session-core.ts:769-782): the handler
  // returns `c.json(result)` — HTTP 200 with the adapter's `AbortResult`
  // (`agent-sdk-runtime/src/adapter-contract.ts:20-22`), i.e.
  // `{ ok: true, status: "cancelled" | "already_idle" }` on success. The two
  // spec-local copies this replaces answered `200 {}` (core-busy-abort-errors) and
  // `204` empty (core-composer-modes) — neither is a shape the real server emits,
  // and their disagreement went unnoticed because nothing reads the body: the app
  // awaits and discards it (`submit-abort.ts:49`).
  //
  // "cancelled", not "already_idle": every spec that exercises this has a genuinely
  // in-flight turn. `already_idle` is the adapter's answer when the lifecycle had no
  // live turn to cancel (`sdk-runtime-adapter.ts:458`); a mock that returned it
  // unconditionally would misdescribe every scenario in the suite.
  await page.route("**/session/*/abort**", async (route) => {
    if (!api(route)) return route.continue()
    if (!new URL(route.request().url()).pathname.match(/\/session\/[^/]+\/abort$/)) return route.fallback()
    if (route.request().method() !== "POST") return route.fallback()
    // Counted on RECEIPT, before the gate: a held-open abort has still reached the
    // network, and proving exactly that is what `holdAbort` exists for.
    requests.abortCount += 1
    if (abortGate) await abortGate
    return json(route, { ok: true, status: "cancelled" })
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

  await page.route("**/session/*/subagents**", (r) => {
    if (!api(r)) return r.continue()
    const parentSessionId = decodeURIComponent(new URL(r.request().url()).pathname.split("/").at(-2) ?? "")
    return json(r, options.subagents?.[parentSessionId] ?? [])
  })

  await page.route("**/session/*/message**", (r) => {
    if (!api(r)) return r.continue()
    const sessionId = decodeURIComponent(new URL(r.request().url()).pathname.split("/").at(-2) ?? "")
    const child = options.childSessions?.find((row) => row.id === sessionId)
    return json(r, child ? childMessages(child) : messages)
  })

  await page.route("**/session/*", (r) => {
    if (!api(r)) return r.continue()
    const pathname = new URL(r.request().url()).pathname
    if (!pathname.match(/^\/session\/[^/]+$/)) return r.fallback()
    // `/session/status` is a BULK STATUS MAP, not a session whose id happens to be
    // "status" — but it is shaped `/session/<one-segment>`, so it satisfies the regex
    // above and this catch-all, registered LAST, out-prioritised the dedicated
    // `**/session/status**` route several hundred lines up (Playwright matches routes
    // most-recently-registered-first). Every `client.session.status()` call in every
    // spec was therefore answered with a SESSION ROW. Nothing failed loudly because
    // every consumer indexes the response by session id
    // (`statuses[sessionID] ?? {type:"idle"}`) and a session row has no such key, so the
    // garbage read as "everything idle" — which is also why the dedicated route's own
    // comment about falling through to this catch-all describes a bug that was still
    // live, and why `core-sidebar-tree`'s behavior-4 status-dot scenario could not be
    // written at all. Hand it back so the real handler gets it.
    if (pathname.endsWith("/session/status")) return r.fallback()
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
    const sessionId = decodeURIComponent(pathname.split("/").at(-1) ?? "")
    const child = options.childSessions?.find((row) => row.id === sessionId)
    return json(r, child ? childSessionRow(child) : sessionRow(textOf(messages[0]?.parts) || ""))
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
    await page.route(`${base}/permission**`, (r) => {
      // `/permission/modes` is NOT this handler's, and the trailing `**` would
      // otherwise take it. Playwright matches routes LAST-REGISTERED-FIRST, and
      // this cloud-lane glob is registered after `**/permission/modes**` above —
      // so without this guard it shadows it and serves `[]`, an ARRAY, where the
      // app expects a `HarnessModeReport` object. The composer then reads `modes`
      // off an array and the whole cloud lane renders its error boundary.
      if (!new URL(r.request().url()).pathname.endsWith("/permission")) return r.fallback()
      return json(r, [])
    })
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
    // Same suffix table as the primary-origin handler above, `/vcs/file` included.
    // The `else` branch here used to be an unconditional `[]`, so this lane
    // answered an ARRAY for the single-file patch endpoint where the app expects
    // `{ file, patch }`.
    await page.route(`${base}/api/wr/diff/**`, (r) => json(r, relayDiffBody(new URL(r.request().url()))))

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

    // Same live-map contract as the local lane (`./contracts/session-status.ts`) and the
    // same `liveSessionStatuses` state, so `handles.setSessionStatus` drives whichever
    // lane a spec models. This used to answer `{[CLOUD_SESSION_ID]:{type:"idle"}}` once
    // the session existed — an idle-VALUED entry no server path can emit; every consumer
    // decoded it exactly as it decodes the absent key it is now, so the shape changed
    // and the behavior did not.
    await page.route(`${base}/session/status**`, (r) =>
      json(r, sessionStatusResponseBody(Object.fromEntries(liveSessionStatuses))),
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
      if (route.request().method() === "PATCH") {
        const url = route.request().url()
        const update = parseSessionConfigPatch(route.request().postDataJSON(), url)
        const currentHarness = sessionHarnessFor(cloudHarness)
        if (update.harness && !sameSessionHarness(currentHarness, update.harness)) {
          return json(
            route,
            sessionConfigPatchHarnessSwitchBody({
              currentHarnessId: currentHarness.id,
              requestedHarnessId: update.harness.id,
              transport: currentHarness.id,
            }),
            SESSION_CONFIG_PATCH_HARNESS_SWITCH_STATUS,
          )
        }
        if (update.model !== undefined) cloudSavedModel = update.model
        if (update.agent !== undefined) cloudSavedAgent = update.agent
        if (update.variant !== undefined) cloudSavedVariant = update.variant
        const saved = cloudSessionConfig()
        assertSessionConfigPatchResponse(saved, url)
        return json(route, saved, SESSION_CONFIG_PATCH_SUCCESS_STATUS)
      }
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
    // local lane's own `"**/session/*"` catch-all, INCLUDING that catch-all's one
    // real collision: `/session/status` is a bulk status map, not a session whose id
    // is "status", and it is `/session/<one-segment>` shaped so this pattern swallows
    // it. Registered later than `${base}/session/status**` above, so without the
    // hand-back below every cloud `client.session.status()` read was answered with a
    // SESSION ROW — the exact defect the local lane carried. Kept in step with
    // `mock-route-shadowing.ts`'s allowlist, which pins this expression.
    await page.route(`${base}/session/*`, (r) => {
      if (!api(r)) return r.continue()
      if (new URL(r.request().url()).pathname.endsWith("/session/status")) return r.fallback()
      return json(r, cloudSessionRow())
    })
    // Same shared handler as the primary origin — it strips the `/workspaces/:id`
    // prefix itself. These used to answer `[]` for EVERY path under `/file` and
    // `/find`, which is the right shape for `/find/file` and `/file` but the wrong
    // one for `/file/content` (`{type, content}`) and `/file/all` (`{paths}`).
    await page.route(`${base}/file**`, fileBrowserHandler)
    await page.route(`${base}/find**`, fileBrowserHandler)

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
    await page.route(`${relayOrigin}/api/wr/diff/**`, (r) => json(r, relayDiffBody(new URL(r.request().url()))))
    await page.route(`${relayOrigin}/api/wr/events`, relayEventHandler)
    await page.route(`${relayOrigin}/api/wr/runtime-events`, relayEventHandler)
  }

  return {
    requests,
    emit,
    emitFlat,
    releaseAbort: () => releaseAbort(),
    setSessionStatus,
    session: { id: SESSION_ID, dir: DIR, projectId: PROJECT_ID },
  }
}
