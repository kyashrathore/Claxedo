// The shared streaming mock every Tier M (`e2e/playwright/core-*.spec.ts`) spec uses.
// See e2e/INVARIANTS.md ("Authoring rules" #1) — specs must not hand-roll a parallel
// mock; extend this file instead.
//
// Replies stream as SEPARATE SSE events — `session.status busy` ->
// `message.updated`(pending) -> `message.part.delta`* -> `message.updated`(completed)
// -> `session.idle` — delivered on genuinely separate ticks, never pre-completed,
// never instant idle. See "How streaming works" below for why (Playwright's
// `route.fulfill` cannot drip a body over time, so the app's own SSE-reconnect loop is
// the delivery mechanism).
import type { Page, Route } from "@playwright/test"
import { resolveE2EAuthMode } from "../auth-mode"
import { normalizeHarnessIdentity, type AgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import type { SessionHarness } from "../../../agent-sdk-runtime/src"
import type { SessionMeta } from "../../../claxedo-server-core/src/session/meta/types"
import {
  runtimeEventEnvelope,
  type RuntimeEventEnvelopeInput,
} from "../../../agent-sdk-runtime/src/runtime-event-hub"
import {
  createClientPresentationProjection,
  presentationEventsFromRuntimeEnvelope,
  type ClientPresentationProjection,
} from "../../../agent-event-runtime/src/projections/client-presentation"
import type { ControlPlaneEvent } from "../../../claxedo-server-core/src/platform/runtime/lib/bus"
import {
  assistantIdForUserMessage,
  parseSessionPromptRequest,
  sessionPromptDelivered,
  SESSION_PROMPT_SUCCESS,
} from "./contracts/session-prompt"
import {
  assertSessionCreateResponse,
  parseDraftIdHeader,
  parseSessionCreateRequest,
  SESSION_CREATE_STATUS,
} from "./contracts/session-create"
import {
  parseSessionReservationRequest,
  sessionReservationResponse,
  sessionReservationStatus,
  SESSION_REGISTRATION_RESERVE_PATH,
  type SessionReservationIntent,
} from "./contracts/session-registration"
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
import { sessionNavigationListResponse } from "./contracts/session-list"
import { emptySessionInventoryResponse } from "./contracts/session-inventory"
import fuzzysort from "fuzzysort"
import { workspaceResolveResponse } from "./contracts/workspace-resolve"
import { unconfiguredWorkspaceDriversResponse } from "./contracts/workspace-drivers"
import {
  isWorkspaceListPath,
  workspaceListResponse,
  type ControlPlaneWorkspaceRow,
} from "./contracts/workspace-list"
import { isServiceCatalogPath, serviceCatalogStateResponse } from "./contracts/service-catalog"
import { isOrgListPath, orgListResponse } from "./contracts/org-list"
import {
  runtimeHarnessOptionsResponse,
  type BoundHarnessConfigOption,
} from "./contracts/harness-options"
import { readyRuntimeHealthResponse } from "./contracts/runtime-health"
import {
  activeWorktreeResponse,
  emptyWorktreeListResponse,
  parseWorktreeCreateBody,
  WORKTREE_CREATE_SUCCESS_STATUS,
} from "./contracts/worktrees"
import { driveEmptyRuntimeDiffRoute } from "./contracts/runtime-diff"

import { contractRoute } from "./contracts/contract-route"
import { sseFrame, streamHeartbeat } from "./contracts/sse"

/**
 * The harness vocabulary the APP speaks — the `type` string it posts to
 * `/api/claxedo/agent-config/harness` and reads back from it, and the id it
 * uses as a provider id (`src/features/session/harness/selection.ts`).
 *
 * Two families, and they are NOT interchangeable:
 *   - native built-ins, addressed by their legacy composite strings
 *     (`claude-sdk`, `codex-app-server`, `cursor-sdk`) or bare id (`opencode`,
 *     `pi`) — `harnessSelectionFor` resolves them to `{kind:"native", harnessId}`;
 *   - operator ACP connections. The FIXTURE key stays `acp:<slug>` (every
 *     recorded trace, mode table and spec names them that way), but the
 *     identity the product speaks is the operator's connection id —
 *     `connectionIdFor` maps `acp:claude` to `claude-acp`, the id the mocked
 *     connections catalog advertises, the app selects, and the session config
 *     round-trips as `{id: "claude-acp", access: "connection"}`.
 *
 * `normalizeHarnessIdentity` (agent-runtime-contract's `harnesses.ts`) is the
 * server's own validator: a native id, or a connection id matching
 * `ACP_CONNECTION_ID_PATTERN` (`^[a-z][a-z0-9-]{0,63}$`). A colon-form
 * `acp:claude` is NOT a connection id the product can produce.
 */
export type Harness =
  | "opencode"
  | "acp:claude"
  | "acp:codex"
  | "acp:cursor"
  | "claude-sdk"
  | "codex-app-server"
  | "cursor-sdk"
  | "pi"

/**
 * `description` is the harness-supplied detail line every real native-SDK row
 * carries (`ClaudeDriver.fetchModels` forwards `model.description`), and the
 * picker renders it under the name. Fixtures carry it so a row's text here has
 * the same shape it has against a real harness.
 */
export type HarnessModelOption = { id: string; name: string; description?: string }

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
  // AND the workspace's control frames (`session.lifecycle`, `agent.lifecycle`,
  // `pty.*`), whose fields sit at the top level instead of under `properties`.
  | ({ type: string; properties?: Record<string, unknown> } & Record<string, unknown>)

/** A frame on `wr/events`: always written as `{ directory, payload }`. */
type MockWireEvent = MockEvent

/** A notice on `cp/events`: written flat, exactly as the control bus publishes it. */
export type MockControlPlaneNotice = ControlPlaneEvent

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

/** A `session.status` frame that actually carries a status object. */
function isStatusFrame(value: unknown): value is LiveSessionStatus {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
}

/** Read one dynamically-named field off a part without asserting its shape. */
function partField(part: MockPart, field: string): unknown {
  return Object.entries(part).find(([key]) => key === field)?.[1]
}

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
  /** What this prompt asked a busy session to do with it. */
  delivery?: "steer" | "queue"
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
   * `permission` in the WRONG shape (an object map) reads as
   * absent here instead of type-asserting its way into a passing test.
   */
  permission: { permission: string; pattern: string; action: string }[] | undefined
}

export type MockRuntimeRequests = {
  eventWebSocketConnections: number
  console: string[]
  failed: string[]
  badResponses: string[]
  /**
   * Every API request (`resourceType` fetch/xhr) that reached the end of this page's
   * route chain without any handler fulfilling it — a request that escaped the mock
   * and went to the real network.
   *
   * An escape has two failure modes and NEITHER is loud:
   *   1. SAME-ORIGIN — the VITE DEV SERVER answers the SPA's `index.html` at **HTTP
   *      200**. `badResponses` (>=400 only) never flags it, the JSON parse throws, and
   *      every caller that wraps the fetch in `.catch(() => [])` degrades to an empty
   *      result indistinguishable from a genuinely empty answer.
   *   2. CENTRAL ORIGIN (`VITE_CLAXEDO_SERVER_URL`, 127.0.0.1:3001) — nothing is
   *      listening at all, so the fetch REJECTS. Callers without a catch propagate
   *      that rejection and silently abort whatever bootstrap they were part of —
   *      strictly worse than mode 1, and harder to spot.
   *
   * FORMAT is `"<METHOD> <origin><pathname>"`. The query string is dropped so the list
   * is stable across runs (directories, session ids and cache-busters all live there);
   * the origin is kept because a request that escapes to a third party (an identity
   * provider, a CDN) is a different finding from one that escapes to the app's own
   * origin, and a pathname-only record cannot tell a filter which is which.
   *
   * Not recorded: documents, scripts, stylesheets, images and fonts — the SPA's own
   * asset graph is served by the dev server by design and is not an escape; the
   * `api()` gate (fetch/xhr only) draws that line.
   */
  unhandled: string[]
  createSessionCount: number
  /**
   * One entry per `POST /session`, in order — the validated draft-id header and body.
   * See e2e/helpers/contracts/session-create.ts.
   */
  createSessionBodies: SessionCreateRequest[]
  opencodeSessionCreateCount: number
  harnessSessionCreateCount: number
  promptCount: number
  promptBodies: PromptBody[]
  /**
   * `POST /session/:id/recovery` — one per request, counted the moment it is
   * RECEIVED (before `holdAbort`'s gate, so a held-open Stop still increments).
   */
  abortCount: number
  /** The turn each Stop named in its target, in order; `undefined` for one that named none. */
  abortedTurnIds: Array<string | undefined>
  /** `GET /session/:id/recovery` — every inspection, including the panel's. */
  recoveryInspectCount: number
  /** Each submitted request's identity, so a spec can tell a join from a retry. */
  recoveryRequests: Array<{ requestId: string; action: string; turnId?: string; attempt: number; linkedOperationId?: string }>
  /** Operation ids read back through `GET /session/:id/recovery/operations/:id`. */
  recoveryOperationReads: string[]
  /** Each turn asked for through `GET /session/:id/message?turn=&coverage=1`. */
  coverageReads: string[]
  /** Validated `POST /session/:id/permissions/:permId` decisions, in order. */
  permissionResponses: PermissionResponseValue[]
  /**
   * Every `PUT /session/:id/permission-mode`, in order.
   *
   * The point of recording these is that a picker CAN change its own label
   * without anything reaching the runtime. A spec asserts on this array, not on
   * the trigger text.
   */
  permissionModeWrites: { modeId: string }[]
  /** Validated `POST /question/:id/reply` bodies, in order. */
  questionReplies: QuestionReplyBody[]
  /** `POST /question/:id/reject` count. */
  questionRejectCount: number
  slashCount: number
  configPatchCount: number
  configPatchBodies: ConfigPatchBody[]
  /** One entry per `PATCH /session/:sessionID` (the session ROW), in order. */
  sessionUpdateBodies: SessionUpdateBody[]
  harnessOptionsCount: number
  harnessOptionsHarnesses: Harness[]
  harnessPostCount: number
  /**
   * GET probes of `/api/claxedo/agent-config/harness`, counted separately from
   * `harnessPostCount` (which counts BOTH verbs). A GET immediately after a switch POST
   * is the observable signature of `fetchHarnessStatus` running.
   */
  harnessGetCount: number
  /**
   * `POST /api/control/session-registrations/reserve` — the intent each signed
   * session create reserved before it reached a runtime, in order.
   */
  sessionReservations: SessionReservationIntent[]
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
  /** Canonical OpenCode worktree creates initiated by the new-session composer. */
  worktreeCreateBodies: Array<{ directory?: string; baseRef?: string }>
  /** Canonical cloud workspace creates initiated by the new-session composer. */
  workspaceCreateBodies: Array<{ projectId?: string; gitBranch?: string }>
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
  beforePermissionModesResponse?: () => Promise<void>
  httpImages?: Array<{ pathname: string; body: Buffer; status?: number; beforeResponse?: () => Promise<void> }>
  dir?: string
  sessionId?: string
  projectId?: string
  projectName?: string
  /** Git refs advertised to branch pickers. Defaults to main + feature/e2e. */
  branches?: string[]
  /** Structured refs distinguish a Git-resolvable ref from its cloud source branch. */
  branchChoices?: Array<{ gitRef: string; sourceBranch?: string }>
  /** Current branch returned by the runtime VCS summary. Defaults to the first advertised branch. */
  currentBranch?: string
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
   * Starts with completed history in an already-created session. Use this for
   * rail-entry/revisit scenarios: creating the session in the same renderer
   * also seeds its transient harness store, masking cold session hydration.
   */
  existingSession?: { prompt: string; reply?: string } | { messages: MockMessageRow[] }
  /** Durable host rows returned by `GET /session/:parent/subagents`. */
  subagents?: Record<string, MockRuntimeSubagentRow[]>
  /** Read-only child Sessions available to subagent open/navigation scenarios. */
  childSessions?: MockRuntimeChildSession[]
  /** Other completed root sessions available for navigation. */
  otherSessions?: Omit<MockRuntimeChildSession, "parentId">[]
  /**
   * Which session scopes `wr/events` grants. A managed-private runtime refuses
   * an unscoped reader without workspace access with 403, and refuses a
   * session the authority does not grant the same way; the client then
   * re-opens for its route's session. Absent: every scope is granted, as on
   * an owner's own runtime.
   */
  workspaceStreamAuthorize?: (scope: { sessionID?: string }) => boolean
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
  /** Message and the live-status route settle, but the `session.idle` event is never sent. */
  staleBusy?: boolean
  /** Keep the authoritative message and live status busy until the test aborts the turn. */
  holdTurn?: boolean
  /** Lifecycle events arrive separately from message snapshots, without message deltas. */
  messageRefreshOnly?: { responseDelayMs: number }
  /** Extra delay (ms) inserted before `session.idle`, after the message completes. */
  delayedIdleMs?: number
  /** Emits `session.error` (and marks the assistant message `error`) instead of completing normally. */
  errorMidTurn?: boolean | string
  /** `POST /session/:id/prompt_async` returns 500 instead of dispatching. */
  dispatchFailure?: boolean
  /** `GET /session/:id/recovery` refuses with `unavailable`, as a machine with no owner does. */
  recoveryUnavailable?: boolean
  /**
   * The cancellation reaches its deadline without the harness answering:
   * `execution: unknown`, and the turn keeps running. This is the case a client
   * must NOT read as stopped.
   */
  recoveryExecutionUnresolved?: boolean
  /** The turn ends but writing that down fails, so `persistence` never reaches `committed`. */
  recoveryStorageFailure?: boolean
  /** The operation is created and recorded, but its response never reaches the client. */
  recoveryResponseLost?: boolean
  /**
   * `POST /session/:id/recovery` records the request (see `requests.abortCount`) but
   * withholds its response until `handles.releaseAbort()` is called.
   *
   * This is what makes "status reconciles optimistically before the network
   * responds" falsifiable instead of decorative: an immediately-200 abort leaves no
   * window in which the network hasn't answered yet, so an assertion made after the
   * click proves nothing about optimism. With the response held open, the submit
   * control can only leave "stop" via the optimistic idle `createPromptAbort`
   * dispatches before it calls the abort route.
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
  /**
   * The posture this fixture's bootstrap declares in `deployment.issuesSessions`.
   *
   * Defaults to the suite's auth mode, because the two model two deployments:
   * `test-user` is a signed user, which only a session-issuing central can
   * have — the adapter's own test bypass runs inside an identity provider this
   * app starts only where the server declared one — and `local-unsigned` is a
   * visitor to a daemon that authenticates by loopback and has no accounts.
   *
   * A spec that pins one posture regardless of the mode sets it explicitly.
   */
  issuesSessions?: boolean
  /** Initial config persistence fails during `POST /session`, and later config PATCHes also return 500. */
  configPatchFailure?: boolean
  sessionArchive?: { delayMs?: number; failingSessionIds?: string[] }
  /** Stage timings, in ms, all optional — sane defaults keep specs fast. */
  timingsMs?: { busy?: number; pending?: number; delta?: number; completed?: number; idle?: number }
  /**
   * When set, additionally mounts a full cloud/relay-lane workspace-runtime session
   * (connection mint, `/workspaces/:workspaceId/...` session/prompt/message/config/
   * capabilities/provider/harness-config-options, plus the relay event stream) so an
   * oracle-verified send can be driven through the SAME shared mock used for local
   * sessions. `relayOrigin` may be the primary origin itself or a distinct fictitious
   * origin (`https://relay.<spec>.test`) — the connection mint's `relayUrl` response is
   * what the app actually follows (`createWorkspaceRelayConnection`,
   * `src/platform/runtime/agent/workspace-relay-connection.ts`, requests
   * `${relayUrl}/workspaces/:id<path>`), so either works as long as `relayOrigin` is
   * what's passed here.
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
    /** Workspace role the connection mint hands back. Defaults to "owner". */
    role?: "owner" | "admin" | "editor" | "viewer"
    /**
     * The session authority's answer to "may this reader prompt", which the
     * runtime reports with the session's capabilities. Defaults to true; a
     * `follow` grantee is the false case.
     */
    sessionPrompt?: boolean
  }
}

export type MockRuntimeHandles = {
  requests: MockRuntimeRequests
  /** Updates the server snapshot after another client's answer, without delivering a resolution to this client. */
  clearPendingQuestion: (requestID: string) => void
  /**
   * Publish one frame on the workspace runtime's `wr/events`: a session's
   * presentation event (parts, deltas, status, permission, question, todo) or
   * one of the workspace's control frames (`session.lifecycle`,
   * `agent.lifecycle`, `pty.*`). Wrapped `{ directory, payload }` on the wire,
   * as the real route writes every frame; `directory` defaults to the frame's
   * own, then to the mock workspace.
   */
  emit: (payload: MockWireEvent, directory?: string) => void
  /**
   * Publish one notice on the control plane's `cp/events` — provision steps,
   * worktree readiness, document doorbells, share grants, a workspace's
   * inventory change. Never a session's frames: those are `emit`.
   */
  emitNotice: (payload: MockControlPlaneNotice) => void
  /**
   * Feed one raw runtime frame to the mock runtime, which projects it the way
   * a real workspace runtime does — through `createClientPresentationProjection`
   * per turn — and publishes the resulting presentation frames on `wr/events`.
   * Raw runtime frames never reach the wire.
   */
  emitRuntime: (payload: RuntimeEventEnvelopeInput) => void
  /**
   * Releases a `holdAbort: true` abort response. A no-op when `holdAbort` is unset
   * (the abort answered immediately) and idempotent, so a `finally` can call it
   * unconditionally.
   */
  releaseAbort: () => void
  /**
   * States which turn this session's owner is running, for a spec that answers
   * `prompt_async` itself and so never reaches the route that would record one.
   *
   * Recovery reads the owner, not the renderer: without this the owner reports
   * no admitted turn, a Stop correctly finds nothing of the caller's to cancel,
   * and the spec measures its own fixture rather than the app.
   */
  setRunningTurn: (turnId: string | undefined) => void
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

  session: { id: string; dir: string; projectId: string; workspaceId: string }
}

// ---------------------------------------------------------------------------
// How streaming works
// ---------------------------------------------------------------------------
//
// Playwright's `route.fulfill()` cannot drip a body over time — the full response body
// must be known at the moment `fulfill()` is called. The app's stream reader
// (`src/app/integrations/claxedo-events.tsx`) reads each stream via `fetch` + a
// streaming `ReadableStream` reader and RECONNECTS on stream end with a backoff that
// resets to the floor whenever the previous connection opened successfully.
//
// So: each SSE "connection" here BLOCKS (does not call route.fulfill) until at least one
// event is pending, then fulfills with the queued batch and ends the stream — which
// causes the app to reconnect for the next batch. Staging `emit()` calls a beat apart
// (see `stage()` below) yields genuinely separate SSE deliveries without requiring a
// true persistent connection, which Playwright does not support.
//
// Each stream is an append-only EVENT LOG with monotonic sequence ids written as SSE
// `id:` lines and resumed per connection from the client's own `Last-Event-ID`,
// the way the real handlers implement resume: no loss, no duplication, no
// reordering, per reader.
//
// A reader's FIRST connection is cursor-less and is served the full log once.
// That is a deliberate divergence from the real handlers, which serve a
// cursor-less connection NOTHING from their replay ring — they resume it at
// "now" and bootstrap its cursor with an opening heartbeat frame. The mock keeps
// full-log-on-first-connect because specs emit before the app has finished
// booting and rely on catching up. `workspaceStreamCursor` models the real
// behaviour for a session-scoped stream, where a spec needs to tell a stream
// opened before a turn from one opened after it.

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

type PendingEvent = { directory: string; payload: MockWireEvent | MockControlPlaneNotice; flat?: boolean }

type LoggedEvent = { seq: number; directory: string; payload: MockWireEvent | MockControlPlaneNotice; flat?: boolean }

class EventBus {
  private log: LoggedEvent[] = []
  private seq = 0
  private waiters: Array<() => void> = []
  private subscribers = new Set<(events: LoggedEvent[]) => void>()

  private append(event: PendingEvent) {
    this.seq += 1
    const logged = { seq: this.seq, ...event }
    this.log.push(logged)
    for (const subscriber of this.subscribers) subscriber([logged])
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  emit(directory: string, payload: MockWireEvent) {
    this.append({ directory, payload })
  }

  /** Appends a frame written flat, the way `cp/events` writes every notice. */
  emitFlat(payload: MockControlPlaneNotice) {
    this.append({ directory: "", payload, flat: true })
  }

  /** The sequence a connection opening NOW resumes from: everything already logged is behind it. */
  lastId() {
    return this.seq
  }

  subscribe(cursor: number, receive: (events: LoggedEvent[]) => void) {
    receive(this.log.filter(event => event.seq > cursor))
    this.subscribers.add(receive)
    return () => { this.subscribers.delete(receive) }
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

// Two mounts of `wr/events`: the daemon's host aggregate, which names no
// workspace and carries every LOCAL runtime's frames, and a relay-backed
// workspace's own stream. Both are open at once while a cloud workspace is
// routed, so a frame carried by both would be applied twice and every
// `message.part.delta` would double the reply's text. A mount takes only the
// directories it owns, and keeps its own `EventBus` log so a `Last-Event-ID`
// cursor is only ever resumed against the log that numbered it.
class FanoutBus {
  private channels: Array<{ bus: EventBus; carries: (directory: string) => boolean }> = []

  channel(carries: (directory: string) => boolean): EventBus {
    const bus = new EventBus()
    this.channels.push({ bus, carries })
    return bus
  }

  emit(directory: string, payload: MockWireEvent) {
    for (const { bus, carries } of this.channels) if (carries(directory)) bus.emit(directory, payload)
  }

}

/** The connection's own cursor, from its SSE `Last-Event-ID` request header (Playwright lowercases header names). */
function lastEventIdOf(route: Route): number | undefined {
  const raw = route.request().headers()["last-event-id"]
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * The cursor a `/api/wr/events` connection actually resumes from.
 *
 * A `?sessionID=` request is a session-scoped stream: the reader was refused
 * at workspace level and re-opened for one session. The real handler
 * (`workspace-runtime/src/routes/events.ts`) serves such a cursor-less
 * connection NOTHING from its replay ring: it resumes at "now" and bootstraps
 * the reader's cursor with an opening heartbeat. Modelling that is what makes a
 * consumer that opens LATE genuinely miss the frames it missed, so a spec can
 * tell the difference between a stream opened before a turn and one opened
 * after it. The unscoped stream keeps the mock's full-log-on-first-connect,
 * which specs rely on to catch up while the app is still booting.
 */
function workspaceStreamCursor(route: Route, bus: EventBus) {
  const cursor = lastEventIdOf(route)
  if (cursor !== undefined) return cursor
  return new URL(route.request().url()).searchParams.has("sessionID") ? bus.lastId() : undefined
}

// Every frame carries its sequence as an SSE `id:` line so the reader builds
// the cursor it resumes with.
function sseBody(batch: LoggedEvent[], emptyFrame: () => string) {
  if (batch.length === 0) return emptyFrame()
  return batch
    .map(
      ({ seq, directory, payload, flat }) =>
        sseFrame(flat ? payload : { directory, payload }, String(seq)),
    )
    .join("")
}

// ---------------------------------------------------------------------------
// Fixtures
//
// The opencode house model's id is "big-pickle-1" — a real, versioned, servable
// model id, the shape a provisioned workspace actually serves — not the bare
// "big-pickle". Display name stays "Big Pickle" (the house brand).
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
  "acp:claude": [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6" }],
  "acp:codex": [{ id: "gpt-5.2-codex", name: "GPT-5.2 Codex" }],
  "acp:cursor": [{ id: "cursor-auto", name: "Cursor Auto" }],
  "claude-sdk": [{ id: "claude-sonnet-4-6", name: "Sonnet 4.6", description: "Sonnet 4.6 · Efficient for routine tasks" }],
  "codex-app-server": [{ id: "gpt-5.5", name: "GPT-5.5" }],
  "cursor-sdk": [{ id: "cursor-auto", name: "Cursor Auto" }],
  pi: [{ id: "openai/gpt-5.5", name: "Pi GPT-5.5" }],
}

/** The operator connection id behind an ACP fixture key (`acp:claude` -> `claude-acp`). */
export function connectionIdFor(harness: Harness): string {
  return harness.startsWith("acp:") ? `${harness.slice("acp:".length)}-acp` : harness
}

/**
 * The provider id a harness's models are catalogued under.
 *
 * The app is the producer here: `harnessModelKeyForSubmit`
 * (`src/features/session/harness/selection.ts`) stamps `providerID` with
 * `harnessSelectionId(harness)` — the native id, or the connection id for an
 * operator connection — so an ACP connection's provider id is its connection
 * id (`claude-acp`), never the fixture key.
 */
function providerIdFor(harness: Harness): string {
  const selection = harnessSelectionFor(harness)
  return selection.kind === "native" ? selection.harnessId : selection.connectionId
}

function sessionHarnessFor(harness: Harness) {
  const selection = harnessSelectionFor(harness)
  const identity = selection.kind === "native"
    ? normalizeHarnessIdentity(selection.harnessId)
    : normalizeHarnessIdentity({ id: selection.connectionId, access: "connection" })
  if (!identity) throw new Error(`Invalid mock harness identity: ${harness}`)
  return identity
}

function sameSessionHarness(current: SessionHarness, requested: SessionHarness) {
  return current.id === requested.id
    && current.access === requested.access
}

function harnessSelectionFor(harness: Harness) {
  if (harness === "claude-sdk") return { kind: "native" as const, harnessId: "claude" as const }
  if (harness === "codex-app-server") return { kind: "native" as const, harnessId: "codex" as const }
  if (harness === "cursor-sdk") return { kind: "native" as const, harnessId: "cursor" as const }
  if (harness === "pi") return { kind: "native" as const, harnessId: "pi" as const }
  if (harness === "opencode") return { kind: "native" as const, harnessId: "opencode" as const }
  return { kind: "connection" as const, connectionId: connectionIdFor(harness) }
}

function harnessFixtureFromUrl(input: string | URL, fallback: Harness): Harness {
  const url = input instanceof URL ? input : new URL(input)
  const nativeHarness = url.searchParams.get("nativeHarness")
  if (nativeHarness === "claude") return "claude-sdk"
  if (nativeHarness === "codex") return "codex-app-server"
  if (nativeHarness === "cursor") return "cursor-sdk"
  if (nativeHarness === "pi") return "pi"
  if (nativeHarness === "opencode") return "opencode"
  const connectionId = url.searchParams.get("connectionId")
  if (connectionId) {
    const fixture = (Object.keys(DEFAULT_HARNESS_MODELS) as Harness[]).find((candidate) =>
      harnessSelectionFor(candidate).kind === "connection" && connectionIdFor(candidate) === connectionId)
    if (fixture) return fixture
  }
  return fallback
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

/**
 * The `deployment` block a bootstrap body must carry.
 *
 * Every producer declares it, and the app's sign-in gate, identity provider and
 * first-project canvas read nothing else — so a fixture that omits it models a
 * server that does not exist and leaves those three surfaces resolving an error.
 *
 * The default follows the suite's auth mode, because the two model two
 * deployments: `test-user` is a signed user, which only a session-issuing
 * central can have, and `local-unsigned` is a visitor to a daemon that
 * authenticates by loopback. A fixture whose subject is a hosted control plane
 * or a signed node passes `true` regardless of the mode.
 */
export function bootstrapDeployment(issuesSessions?: boolean) {
  return { issuesSessions: issuesSessions ?? resolveE2EAuthMode() !== "local-unsigned" }
}

function api(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr"
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
}

function corsJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "Access-Control-Allow-Origin": route.request().headers().origin ?? new URL(route.request().url()).origin,
      "Vary": "Origin",
    },
    body: JSON.stringify(body),
  })
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

export async function installMockRuntime(page: Page, options: MockRuntimeOptions = {}): Promise<MockRuntimeHandles> {
  const readOnlySessions: Array<Omit<MockRuntimeChildSession, "parentId"> & { parentId?: string }> = [
    ...options.childSessions ?? [], ...options.otherSessions ?? [],
  ]
  const DIR = options.dir ?? "/tmp/e2e-mock-runtime"
  const SESSION_ID = options.sessionId ?? "ses_mock_runtime"
  const PROJECT_ID = options.projectId ?? "proj_mock_runtime"
  const LOCAL_WORKSPACE_ID = options.workspaceId ?? "ws_mock_runtime"
  const PROJECT_NAME = options.projectName ?? "mock-runtime"
  // Every control-plane workspace row belongs to a tenant; the authority's row
  // projection makes `org_id` non-optional. One mock tenant owns them all.
  const MOCK_ORG_ID = "org_mock_runtime"
  // The machine the mock control plane says serves the relay-backed rows. It is
  // never this browser, so every such row resolves to the relay wire — which is
  // what the specs model.
  const MOCK_HOST_ENROLLMENT_ID = "enr_mock_runtime_host"
  const createdLocalWorktrees: Array<{ directory: string; name: string; branch: string }> = []
  const localProjectRow = () => {
    // A created worktree is a workspace row of its own, with the id the app
    // routes it by (`/w/<workspace id>`, `workspaceRouteIdentity`): without
    // one, the first send's navigation into the new worktree's session has
    // no route to go to.
    const createdWorkspaces = Object.fromEntries(createdLocalWorktrees.map((worktree) => [`ws_local_${worktree.name}`, {
      id: `ws_local_${worktree.name}`,
      workspaceId: `ws_local_${worktree.name}`,
      project_id: PROJECT_ID,
      kind: "local" as const,
      available: true,
      directory: worktree.directory,
    }]))
    // `GET /api/claxedo/bootstrap` returns `listProjects()`, and every local
    // project produced by that store includes its root workspace in
    // `project.workspaces`. Keep the shared E2E producer faithful to that
    // contract: ClaxedoEventsProvider resolves its per-workspace event target
    // from this inventory. Omitting the root made live turns depend on the
    // compatibility subscriber's mount timing and lose events after reload.
    const configuredWorkspaces = options.workspaces ?? {}
    const configuredRoot = Object.values(configuredWorkspaces).some((workspace) => workspace.directory === DIR)
    const rootWorkspace = configuredRoot
      ? {}
      : {
          [LOCAL_WORKSPACE_ID]: {
            id: LOCAL_WORKSPACE_ID,
            workspaceId: LOCAL_WORKSPACE_ID,
            project_id: PROJECT_ID,
            kind: "local" as const,
            available: true,
            directory: DIR,
          },
        }
    const workspaces = {
      ...rootWorkspace,
      ...options.workspaces,
      ...createdWorkspaces,
    }
    return {
      id: PROJECT_ID,
      worktree: DIR,
      name: PROJECT_NAME,
      ...(createdLocalWorktrees.length > 0 ? { sandboxes: createdLocalWorktrees.map((worktree) => worktree.directory) } : {}),
      ...(Object.keys(workspaces).length > 0 ? { workspaces } : {}),
      time: { created: Date.now(), updated: Date.now() },
    }
  }
  // `let`, not `const`: a client-driven draft-harness switch (`POST
  // /api/claxedo/agent-config/harness {type}`, see `switchDraftHarness` in
  // `src/features/session/harness/harness-switcher.ts`) must be reflected in every
  // subsequent read (model/options/capabilities/status) for the rest of the test —
  // otherwise a spec that switches harness in-app instead of pre-seeding
  // `installMockRuntime({harness})` sees a stale harness forever. The hydrate GET
  // path sends no body, so this reassignment is a no-op there.
  let harness = options.harness ?? "opencode"

  let savedModel: { providerID: string; modelID: string } | null | undefined
  let savedAgent: string | null | undefined
  let savedVariant: string | null | undefined
  const harnessModels = { ...DEFAULT_HARNESS_MODELS, ...options.harnessModels }
  const advertisedBranchChoices = options.branchChoices ??
    (options.branches ?? ["main", "feature/e2e"]).map((branch) => ({ gitRef: branch, sourceBranch: branch }))
  const advertisedBranches = advertisedBranchChoices.map((choice) => choice.gitRef)
  const advertisedCurrentBranch = options.currentBranch ?? advertisedBranchChoices[0]?.sourceBranch ?? advertisedBranchChoices[0]?.gitRef
  const replyTextFn = options.replyText ?? defaultReplyText
  const timings = {
    busy: options.timingsMs?.busy ?? 20,
    pending: options.timingsMs?.pending ?? 40,
    delta: options.timingsMs?.delta ?? 40,
    completed: options.timingsMs?.completed ?? 40,
    idle: options.timingsMs?.idle ?? 30,
  }

  const requests: MockRuntimeRequests = {
    eventWebSocketConnections: 0,
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
    abortedTurnIds: [],
    recoveryInspectCount: 0,
    recoveryRequests: [],
    recoveryOperationReads: [],
    coverageReads: [],
    permissionResponses: [],
    permissionModeWrites: [],
    questionReplies: [],
    questionRejectCount: 0,
    slashCount: 0,
    configPatchCount: 0,
    configPatchBodies: [],
    sessionUpdateBodies: [],
    harnessOptionsCount: 0,
    harnessOptionsHarnesses: [],
    harnessPostCount: 0,
    harnessGetCount: 0,
    sessionReservations: [],
    cloudSessionCreateCount: 0,
    cloudSessionCreateBodies: [],
    cloudPromptCount: 0,
    cloudPromptBodies: [],
    cloudHarnessOptionsCount: 0,
    cloudHarnessOptionsHarnesses: [],
    worktreeCreateBodies: [],
    workspaceCreateBodies: [],
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

  // The two streams. `cp/events` carries the control plane's notices, flat.
  // `wr/events` carries a workspace runtime's frames, `{ directory, payload }`:
  // the daemon's host aggregate carries a frame for every runtime it serves,
  // and a relay-backed workspace's own stream carries its own and nothing else.
  const cloudDirectory = options.cloud?.workspaceId
  const controlPlaneBus = new EventBus()
  const workspaceFanout = new FanoutBus()
  const busWrEvents = workspaceFanout.channel((directory) => directory !== cloudDirectory)
  const busRelayEvents = workspaceFanout.channel((directory) => directory === cloudDirectory)
  let messages: MockMessageRow[] = []
  let lastTurn: AgentTurnOutcome | undefined
  // The user message id of the turn the mock is driving, which is what a scoped
  // Stop names and what a steered prompt joins.
  let runningTurn: string | undefined
  // CONTRACT (workspace-runtime/src/session/delivery-owner.ts): a prompt sent
  // with `delivery: "queue"` is a durable record served by `GET /session/:id/queue`,
  // not a transcript row; the owner starts it as the next turn once the session
  // is idle, and only that start commits its user message.
  type QueuedPrompt = {
    seq: number
    messageId: string
    parts: Array<{ type: string; text?: string; filename?: string }>
    queuedAt: number
    held: boolean
    turn: { userID: string; assistantID: string; text: string; agent: string; providerID: string; modelID: string; turn: number }
  }
  const queuedPrompts: QueuedPrompt[] = []
  let queuedPromptSeq = 0
  /** The owner generation every recovery target and fact in this mock is stamped with. */
  const OWNER_GENERATION = "lease_e2e"
  const recoveryOperations = new Map<string, Record<string, unknown>>()
  /** Starts committed: a session with no interrupted turn has nothing owed to the store. */
  let lastRecoveryPersistence: "committed" | "pending" | "unavailable" = "committed"
  let sessionCreated = false
  const archivedSessions = new Map<string, number>()
  let sessionDirectory = DIR
  let harnessPollCount = 0
  let harnessGetPollCount = 0
  // Pending permission/question requests — what a real engine returns from
  // GET /permission and GET /question. Specs drive these via `emit({type:
  // "permission.asked"|"question.asked", ...})` and settle them via
  // `permission.replied` / `question.replied` / `question.rejected`. Without
  // this, every session-meta hydrate (GET /permission → []) overwrites the
  // SSE-upserted dock cache and the permission/question docks never stick.
  let pendingPermissions: Array<Record<string, unknown>> = []
  let pendingQuestions: Array<Record<string, unknown>> = []
  // Same contract as permissions: GET /session/:id/todo must reflect the
  // latest `todo.updated` SSE payload, or a later todo hydrate overwrites the
  // dock with [].
  let sessionTodos: Array<Record<string, unknown>> = []

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      // `message.text()` alone is not origin-attributable, so the originating URL is
      // appended and a consumer's filter can say "from this origin" instead of
      // "anywhere". Consumers match by prefix (`startsWith("pageerror:")`) or
      // substring, so the suffix is additive.
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

  // The real runtime PERSISTS every part it streams before/at emit, so a later
  // `GET /session/:id/message` refetch always lists it. The app relies on that:
  // `reconcileStoredParts` (src/features/session/store/message-page.ts) treats
  // the REST body as CANONICAL for a settled assistant message and PRUNES any
  // stored part id the body does not list — so a mock that emits a part over
  // SSE without persisting it here makes the app delete that part (e.g. a
  // subagent task card) on the next session re-entry. Mirror the real
  // contract: fold every emitted `message.part.updated` snapshot into the
  // message row the REST route serves.
  const persistEmittedPart = (payload: MockEvent) => {
    const type = (payload as { type?: string }).type
    // Mirror message-info updates too: replay() re-OPENS a settled assistant row
    // (emits its info with `time.completed` stripped) before streaming fixture
    // parts, then re-settles it. If the REST rows keep the old SETTLED info
    // while the stream is re-opened, a refetch snapshotted mid-replay reports
    // "settled with only the original text part" — a state the real runtime can
    // never serve — and the app's canonical reconcile PRUNES every
    // already-streamed fixture part while the settled-message guard blocks
    // their re-delivery, leaving the turn permanently textless/tool-less.
    if (type === "message.updated") {
      const info = (payload as { properties?: { info?: { id?: string } } }).properties?.info
      if (!info?.id) return
      messages = messages.map((row) =>
        row.info.id === info.id ? { ...row, info: info as MockMessageInfo } : row,
      )
      return
    }
    if (type === "message.part.updated") {
      const part = (payload as { properties?: { part?: { id?: string; messageID?: string } } }).properties?.part
      if (!part?.id || !part.messageID) return
      messages = messages.map((row) =>
        row.info.id === part.messageID
          ? { ...row, parts: [...row.parts.filter((item) => item.id !== part.id), part as MockPart] }
          : row,
      )
      return
    }
    // Deltas must fold into the persisted snapshot too: `reconcileStoredParts`
    // lets the canonical REST payload win on CONTENT, so a part persisted from
    // its initial `message.part.updated` (empty/partial text) would RESET the
    // delta-accumulated text in the app on the next refetch.
    if (type === "message.part.delta") {
      const properties = (payload as {
        properties?: { messageID?: string; partID?: string; field?: string; delta?: unknown }
      }).properties
      if (!properties?.messageID || !properties.partID || typeof properties.delta !== "string") return
      // Bound to consts: narrowing of `properties.delta` does not survive into
      // the nested map callbacks below, where it would read back as `unknown`.
      const { messageID, partID } = properties
      const delta = properties.delta
      const field = properties.field ?? "text"
      messages = messages.map((row) =>
        row.info.id === messageID
          ? {
              ...row,
              parts: row.parts.map((item) => {
                if (item.id !== partID) return item
                const previous = partField(item, field)
                return { ...item, [field]: `${typeof previous === "string" ? previous : ""}${delta}` }
              }),
            }
          : row,
      )
    }
  }
  /** The directory a control frame names for itself, if any. */
  const frameDirectory = (payload: MockWireEvent) =>
    "directory" in payload && typeof payload.directory === "string" && payload.directory ? payload.directory : undefined
  const emit = (payload: MockWireEvent, directory: string = frameDirectory(payload) ?? sessionDirectory) => {
    persistEmittedPart(payload)
    const type = (payload as { type?: string }).type
    const properties = (payload as { properties?: Record<string, unknown> }).properties ?? {}
    if (type === "permission.asked") {
      const id = typeof properties.id === "string" ? properties.id : undefined
      if (id) {
        pendingPermissions = [
          ...pendingPermissions.filter((item) => item.id !== id),
          properties,
        ]
      }
    } else if (type === "permission.replied") {
      const requestID = typeof properties.requestID === "string" ? properties.requestID : undefined
      if (requestID) pendingPermissions = pendingPermissions.filter((item) => item.id !== requestID)
    } else if (type === "question.asked") {
      const id = typeof properties.id === "string" ? properties.id : undefined
      if (id) {
        pendingQuestions = [
          ...pendingQuestions.filter((item) => item.id !== id),
          properties,
        ]
      }
    } else if (type === "question.replied" || type === "question.rejected") {
      const requestID = typeof properties.requestID === "string" ? properties.requestID : undefined
      if (requestID) pendingQuestions = pendingQuestions.filter((item) => item.id !== requestID)
    } else if (type === "todo.updated") {
      const todos = properties.todos
      sessionTodos = Array.isArray(todos) ? (todos as Array<Record<string, unknown>>) : []
    } else if (type === "session.status") {
      // Keep GET /session/status in lockstep with the SSE frame (same contract as
      // driveTurn). Specs that emit busy then todo.updated otherwise lose the
      // busy bit on the next status poll, todoState returns "clear", and the
      // dock wipes itself to [].
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined
      const status: unknown = properties.status
      if (sessionID && isStatusFrame(status)) setSessionStatus(sessionID, status)
    } else if (type === "session.idle") {
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined
      if (sessionID) setSessionStatus(sessionID)
    }
    workspaceFanout.emit(directory, payload)
  }
  const emitNotice = (payload: MockControlPlaneNotice) => {
    controlPlaneBus.emitFlat(payload)
  }
  // One projection per turn, keyed the way the real runtime keys its turn
  // projector: the session and the assistant message the parts hang from.
  // `announcesAssistantMessage` because this projection is the turn's only
  // producer here; on a real host the runtime's own compat producer opens the
  // row.
  const turnProjections = new Map<string, ClientPresentationProjection>()
  const emitRuntime = (input: RuntimeEventEnvelopeInput) => {
    const envelope = runtimeEventEnvelope(input)
    for (const event of presentationEventsFromRuntimeEnvelope(envelope)) {
      workspaceFanout.emit(event.directory, event.payload)
    }
    const assistantMessageId = envelope.assistantMessageId ?? envelope.sessionId
    const key = `${envelope.sessionId}\0${assistantMessageId}`
    let projection = turnProjections.get(key)
    if (!projection) {
      projection = createClientPresentationProjection({
        sessionId: envelope.sessionId,
        directory: envelope.directory,
        assistantMessageId,
        announcesAssistantMessage: true,
      })
      turnProjections.set(key, projection)
    }
    for (const event of projection.ingest(envelope.payload)) {
      workspaceFanout.emit(event.directory, event.payload)
    }
  }

  function harnessModel() {
    return harnessModels[harness]?.[0] ?? BIG_PICKLE
  }

  function harnessConfigOptions(type: Harness, model = harnessModels[type]?.[0] ?? BIG_PICKLE): BoundHarnessConfigOption[] {
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: model.id,
        selectOptions: harnessModels[type] ?? [model],
      },
    ]
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
    // vocabulary. Omitting the active harness here starves the composer of any
    // selectable model and the submit control never leaves its disabled state.
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
      directory: sessionDirectory,
      title,
      version: "2",
      time: { created: Date.now(), updated: Date.now(), archived: archivedSessions.get(SESSION_ID) },
      summary: { additions: 0, deletions: 0, files: 0 },
      config: sessionConfig(),
      ...(lastTurn ? { lastTurn } : {}),
    }
  }

  function readOnlySessionRow(child: (typeof readOnlySessions)[number]) {
    return {
      ...sessionRow(child.title),
      lastTurn: undefined,
      id: child.id,
      slug: child.id,
      parentID: child.parentId,
      title: child.title,
      time: { created: Date.now(), updated: Date.now(), archived: archivedSessions.get(child.id) },
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

  function readOnlyMessages(child: (typeof readOnlySessions)[number]): MockMessageRow[] {
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

  if (options.existingSession && "messages" in options.existingSession) {
    messages = structuredClone(options.existingSession.messages)
    sessionCreated = true
  }
  if (options.existingSession && "prompt" in options.existingSession) {
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
  // A queued prompt has no optimistic row in the client, so its admission is
  // announced the way the runtime announces one: the user message rides the
  // stream before the turn's first status frame.
  function startQueuedTurn(record: QueuedPrompt) {
    const { turn } = record
    const userRow = userMessage({ id: turn.userID, text: turn.text, agent: turn.agent, providerID: turn.providerID, modelID: turn.modelID })
    messages = [...messages, userRow]
    emit({ type: "message.updated", properties: { sessionID: SESSION_ID, info: userRow.info } })
    runningTurn = turn.userID
    void driveTurn(turn)
  }

  function drainQueuedPrompts() {
    if (runningTurn) return
    const index = queuedPrompts.findIndex((record) => !record.held)
    if (index === -1) return
    const [record] = queuedPrompts.splice(index, 1)
    startQueuedTurn(record)
  }

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
    if (options.messageRefreshOnly) {
      emit({ type: "agent.lifecycle", tabId: SESSION_ID, sessionId: SESSION_ID, eventType: "Busy" })
    } else {
      emit({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "busy" } } })
    }

    await wait(timings.pending)
    const assistantRow = assistantMessagePending({
      id: input.assistantID,
      parentID: input.userID,
      agent: input.agent,
      providerID: input.providerID,
      modelID: input.modelID,
    })
    messages = [...messages, assistantRow]
    if (!options.messageRefreshOnly) {
      emit({ type: "message.updated", properties: { sessionID: SESSION_ID, info: assistantRow.info } })
    }

    if (options.holdTurn) return

    const fullText = replyTextFn(input.turn, input.text)
    if (options.messageRefreshOnly) {
      await wait(timings.delta + timings.completed)
      messages = messages.map((row) => row.info.id === input.assistantID
        ? { ...row, info: { ...row.info, time: { ...row.info.time, completed: Date.now() } }, parts: [textPart(SESSION_ID, input.assistantID, fullText)] }
        : row)
      runningTurn = undefined
      setSessionStatus(SESSION_ID)
      emit({ type: "agent.lifecycle", tabId: SESSION_ID, sessionId: SESSION_ID, eventType: "Idle" })
      drainQueuedPrompts()
      return
    }
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
      setSessionStatus(SESSION_ID)
      emit({ type: "session.error", properties: { sessionID: SESSION_ID } })
      return
    }

    // Stream the reply as a couple of delta chunks, then a final full-text
    // part.updated so end state is correct even if delta accumulation in the
    // client under test is not exercised by a given assertion.
    const midpoint = Math.max(1, Math.floor(fullText.length / 2))
    const chunks = [fullText.slice(0, midpoint), fullText.slice(midpoint)]
    const partID = `${input.assistantID}_text`
    // Open the part before its deltas. Consumers cannot apply a delta to an
    // unknown part, and the REST snapshot must own the same growing content.
    emit({ type: "message.part.updated", properties: { sessionID: SESSION_ID, part: textPart(SESSION_ID, input.assistantID, ""), time: Date.now() } })
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

    // Keep the live-status route authoritative even when the event stream drops the
    // terminal frame. Reconciliation must read this settled producer; it must not
    // infer or synthesize idle from the transcript.
    if (options.staleBusy) {
      setSessionStatus(SESSION_ID)
      return // idle event deliberately never sent
    }

    await wait(timings.idle + (options.delayedIdleMs ?? 0))
    runningTurn = undefined
    setSessionStatus(SESSION_ID)
    emit({ type: "session.idle", properties: { sessionID: SESSION_ID } })
    drainQueuedPrompts()
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
  /**
   * The id of the cloud lane's ONE session.
   *
   * The real route honours a caller-supplied `body.id` — it is how a signed
   * client hands the runtime the session id it already reserved with the
   * control plane (`session-core.ts`, `createSession(c, directory, title,
   * body.id)`), and `managedRegistration` REQUIRES one. So the id is the
   * client's when it names one, and this fixture's own otherwise (the harness
   * lane, `createHarnessRuntimeSessionActions.create`, sends no id). Answering
   * a different id than the one asked for would be a session the caller never
   * created, and every event this lane emits would address the wrong one.
   */
  let cloudSessionId = CLOUD_SESSION_ID
  let cloudHarness: Harness = cloud?.harness ?? "opencode"
  let cloudSavedModel: { providerID: string; modelID: string } | null | undefined
  let cloudSavedAgent: string | null | undefined
  let cloudSavedVariant: string | null | undefined
  let cloudMessages: MockMessageRow[] = []
  let cloudSessionCreated = false

  function cloudHarnessModel() {
    return harnessModels[cloudHarness]?.[0] ?? BIG_PICKLE
  }

  // A draft on a relay-backed workspace never touches the local readiness POST/polling
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


  function cloudSessionRow() {
    return {
      id: cloudSessionId,
      slug: cloudSessionId,
      projectID: CLOUD_PROJECT_ID,
      directory: CLOUD_WORKSPACE_ID,
      title: textOf(cloudMessages[0]?.parts) || "",
      version: "2",
      time: { created: Date.now(), updated: Date.now() },
      summary: { additions: 0, deletions: 0, files: 0 },
      config: cloudSessionConfig(),
    }
  }

  /** The cloud workspace's own top-level project row (self-referencing `workspaces` map)
   * so the empty-draft header's project `<Select>` can navigate local <-> cloud
   * client-side. */
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

  /**
   * The rows `GET /api/workspace?host=…` answers with — the SAME workspaces
   * the resolve/connection/checkpoint routes already model, seen from the
   * control plane's side.
   *
   * Only relay-backed workspaces exist here. A spec's `local` workspace has no
   * signed identity and is never registered with a control plane, so listing
   * one would be inventing a row the real authority cannot produce; the local
   * lane is answered by `/project` (`centralOwnsProjects`, workspace-catalog.ts)
   * and `mergeWorkspaceCatalog` folds the two sides together.
   *
   * A spec declares its workspaces in the PROJECT-INVENTORY word (`local` /
   * `cloud` / `user-hosted`), which is what `/project` answers with and what
   * the spec is written against. The control plane has no such word: it states
   * where the workspace runs, so a row carries `backing` and a placement. This
   * function is the translation, the same one the real hosted routes perform,
   * which is why a spec never spells `backing` itself.
   *
   * `org_id`/`project_id`/`display_name` are REQUIRED by the authority's row
   * projection (see ./contracts/workspace-list.ts) — the type is what says so.
   */
  function controlPlaneWorkspaceRows(): ControlPlaneWorkspaceRow[] {
    const rows: ControlPlaneWorkspaceRow[] = []
    if (cloud) {
      rows.push({
        workspace_id: CLOUD_WORKSPACE_ID,
        org_id: MOCK_ORG_ID,
        project_id: CLOUD_PROJECT_ID,
        display_name: "main",
        backing: "cloud-vm",
        placement: { directory: CLOUD_WORKSPACE_ID },
        repo_name: CLOUD_PROJECT_NAME,
        remote_directory: CLOUD_WORKSPACE_ID,
        role: "owner",
      })
    }
    for (const [directory, workspace] of Object.entries(options.workspaces ?? {})) {
      if (workspace.kind !== "cloud" && workspace.kind !== "user-hosted") continue
      const workspaceId = workspace.workspaceId ?? workspace.id ?? directory
      if (rows.some((row) => row.workspace_id === workspaceId)) continue
      rows.push({
        workspace_id: workspaceId,
        org_id: MOCK_ORG_ID,
        project_id: PROJECT_ID,
        display_name: workspace.workspace_name ?? workspaceId,
        backing: workspace.kind === "cloud" ? "cloud-vm" : "local-worktree",
        placement: {
          ...(workspace.kind === "cloud" ? {} : { host_enrollment_id: MOCK_HOST_ENROLLMENT_ID }),
          directory: workspace.directory ?? directory,
        },
        remote_directory: workspace.directory ?? directory,
        role: "owner",
        // Reachability, not authorization. Only a row the control plane places
        // on an enrolled machine carries it — the provisioner is always up, so
        // its rows state nothing here and a client that read a missing flag as
        // offline would hide every cloud workspace. `available: false` is the
        // spec's way of modelling a machine that is not serving its workspace.
        ...(workspace.kind === "user-hosted" ? { host_online: workspace.available !== false } : {}),
      })
    }
    return rows
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
        sessionID: cloudSessionId,
        role: "user",
        time: { created: Date.now() },
        agent: input.agent,
        model: { providerID: input.providerID, modelID: input.modelID },
      },
      parts: [textPart(cloudSessionId, input.id, input.text)],
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
        sessionID: cloudSessionId,
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
  // `core-cloud-provisioning.spec.ts`'s `installCloudRuntimeMock`, so specs asserting
  // on it share one vocabulary.
  async function driveCloudTurn(input: {
    userID: string
    assistantID: string
    text: string
    agent: string
    providerID: string
    modelID: string
    turn: number
  }) {
    // Every `emit()` call below passes `CLOUD_WORKSPACE_ID` explicitly as the
    // SSE envelope's `directory` — `emit()` defaults that param to the local
    // workspace's `DIR`, which is wrong here and matters: the reader addresses
    // a frame by its envelope's `directory` (`eventStreamFrameAddress`).
    await wait(timings.busy)
    emit(
      { type: "session.status", properties: { sessionID: cloudSessionId, status: { type: "busy" } } },
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
      { type: "message.updated", properties: { sessionID: cloudSessionId, info: assistantRow.info } },
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
            sessionID: cloudSessionId,
            messageID: input.assistantID,
            partID,
            field: "text",
            delta: chunk,
          },
        },
        CLOUD_WORKSPACE_ID,
      )
    }
    const finalPart = textPart(cloudSessionId, input.assistantID, accumulated)
    cloudMessages = cloudMessages.map((row) =>
      row.info.id === input.assistantID ? { ...row, parts: [finalPart] } : row,
    )
    emit(
      { type: "message.part.updated", properties: { sessionID: cloudSessionId, part: finalPart, time: Date.now() } },
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
          sessionID: cloudSessionId,
          info: cloudMessages.find((row) => row.info.id === input.assistantID)!.info,
        },
      },
      CLOUD_WORKSPACE_ID,
    )

    await wait(timings.idle)
    emit({ type: "session.idle", properties: { sessionID: cloudSessionId } }, CLOUD_WORKSPACE_ID)
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

  // The icon sprite is fetch()ed (resourceType "fetch"), so without a handler
  // it lands in `requests.unhandled` and trips the tripwire specs — but it is
  // a same-origin STATIC ASSET served by vite/preview, not an API escape.
  // Registered after the catch-all recorder (= tried before it): continue()
  // lets the web server answer while keeping the request out of the escape
  // ledger. Two spellings: the dev server serves the source path
  // (/ui/src/assets/icons/codex/sprite.svg), the prebuilt bundle a
  // fingerprinted asset (/assets/sprite-<hash>.svg).
  await page.route("**/*sprite*.svg*", (r) => r.continue())

  await page.route("**/*.png", async route => {
    const image = options.httpImages?.find(image => image.pathname === new URL(route.request().url()).pathname)
    if (!image) return route.fallback()
    await image.beforeResponse?.()
    await route.fulfill({ status: image.status ?? 200, contentType: "image/png", body: image.body })
  })

  // The only route here a spec can point at a FOREIGN origin: the posture
  // declaration is read before the first render, and a spec that moves the
  // shell's server URL off this origin still has to be answered. A fulfilled
  // cross-origin response the browser may not read is indistinguishable from an
  // unreachable server, which is a passing gate for the wrong reason.
  await page.route("**/api/claxedo/bootstrap**", (r) =>
    api(r)
      ? corsJson(r, {
          healthy: true,
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: DIR, directory: DIR, home: "/tmp" },
          // This fixture is the desktop daemon: it hosts every local runtime
          // in-process and answers the unscoped `wr/events` below, so it says
          // so. Without the declaration the app opens no workspace stream at
          // all and every spec here waits for frames that never come.
          events: { hostAggregate: true },
          // The posture the sign-in gate, the identity provider and the
          // first-project canvas all read. A fixture that declared nothing
          // would leave the gate holding, which is what a server answering no
          // declaration earns.
          deployment: bootstrapDeployment(options.issuesSessions),
          project: [localProjectRow(), ...(cloud ? [cloudProjectRow()] : [])],
          provider: providerCatalogIndex(providerResponse()),
          provider_auth: { [providerIdFor(harness)]: [{ type: "api", label: "API key" }] },
          config: { provider: { id: providerIdFor(harness), model: harnessModel().id }, agent: { id: "build" } },
        })
      : r.continue(),
  )

  // The first-party service catalog. Off loopback this REPLACES the aggregate
  // above (`bootstrapGlobal` reads it directly, src/app/boot/data/bootstrap.ts),
  // and a failure raises the "request failed" toast rather than degrading
  // quietly — so it is answered here even though every Tier M page currently
  // resolves a LOOPBACK central and therefore takes the aggregate branch. The
  // zero state is the honest one: the mock composes no service provider, which
  // is exactly when the real route answers an empty catalog.
  await contractRoute(page, "**/api/claxedo/services**", (r) => {
    if (!api(r)) return r.continue()
    if (!isServiceCatalogPath(new URL(r.request().url()).pathname)) return r.fallback()
    return json(r, serviceCatalogStateResponse())
  })

  const sseIdleTimeoutMs = 4000

  // `cp/events`. An unsigned loopback surface reads it over a WebSocket
  // (`openLocalEventWebSocket`), so the same log answers both transports.
  await page.routeWebSocket("**/api/cp/events**", socket => {
    requests.eventWebSocketConnections += 1
    const cursor = Number(new URL(socket.url()).searchParams.get("lastEventId") ?? 0)
    const unsubscribe = controlPlaneBus.subscribe(cursor, batch => {
      socket.send(sseBody(batch, () => streamHeartbeat(cursor)))
    })
    const cleanup = () => {
      unsubscribe()
      page.off("close", cleanup)
    }
    socket.onClose(cleanup)
    page.once("close", cleanup)
  })
  await contractRoute(page, "**/api/cp/events**", async (route) => {
    if (!api(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/api/cp/events") return route.fallback()
    const cursor = lastEventIdOf(route)
    const batch = await controlPlaneBus.drain(sseIdleTimeoutMs, cursor)
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sseBody(batch, () => streamHeartbeat(cursor)),
    }).catch(() => {})
  })

  /**
   * The session a `wr/events` frame belongs to, for the session-scoped arm:
   * a presentation frame names it under `properties`, a control frame at its
   * top level. Frames naming no session (`pty.*`) belong to the workspace and
   * are withheld from a session-scoped reader, as the real handler withholds
   * them.
   */
  const frameSessionId = (entry: LoggedEvent) => {
    const payload = entry.payload as Record<string, unknown>
    const properties = payload.properties as Record<string, unknown> | undefined
    const info = properties?.info as Record<string, unknown> | undefined
    const part = properties?.part as Record<string, unknown> | undefined
    for (const candidate of [properties?.sessionID, info?.id, part?.sessionID, payload.sessionId, payload.sessionID]) {
      if (typeof candidate === "string" && candidate) return candidate
    }
    return undefined
  }
  const sessionParentOf = (sessionId: string | undefined) => {
    if (!sessionId) return undefined
    return options.childSessions?.find((child) => child.id === sessionId)?.parentId
      ?? Object.entries(options.subagents ?? {}).find(([, rows]) => rows.some((row) => row.childSessionId === sessionId))?.[0]
  }
  const workspaceStreamHandler = (bus: EventBus) => async (route: Route) => {
    if (!api(route)) return route.continue()
    const url = new URL(route.request().url())
    const sessionID = url.searchParams.get("sessionID") ?? undefined
    if (options.workspaceStreamAuthorize && !options.workspaceStreamAuthorize({ sessionID })) {
      return json(route, sessionID
        ? { error: { code: "session_event_stream_denied", message: "Forbidden", cause: "session_private" } }
        : { error: { code: "workspace_event_stream_denied", message: "Forbidden", cause: "host_authority_denied" } }, 403)
    }
    const cursor = workspaceStreamCursor(route, bus)
    const batch = await bus.drain(sseIdleTimeoutMs, cursor)
    // A subagent child's frames are the parent's, the way the real handler
    // scopes them (`sessionParents`), so a session-scoped reader of the parent
    // sees its children's frames on the same stream. Unlike the real handler,
    // the session arm here is a filter over the workspace log — one numbering
    // for both arms — so a cursor carried across the narrowing is not a gap
    // on this mock; that the reader drops it is proven by its own suite
    // (`claxedo-events-cursor.vitest.tsx`), and that the real handler's
    // session ring numbers only that session's frames by
    // `routes/events.test.ts` ("a session-scoped reader's cursor…").
    const scoped = sessionID
      ? batch.filter((entry) => {
        const frameSession = frameSessionId(entry)
        return frameSession === sessionID || sessionParentOf(frameSession) === sessionID
      })
      : batch
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sseBody(scoped, () => streamHeartbeat(cursor)),
    }).catch(() => {})
  }
  // `wr/events` on the primary origin, named by no workspace: the daemon's
  // host aggregate, the only stream a loopback surface opens for its local
  // workspaces.
  await contractRoute(page, "**/api/wr/events**", workspaceStreamHandler(busWrEvents))

  // ProcessPane reconciles once when a workspace shell mounts. The shared
  // runtime has no process fixtures, so its canonical answer is an empty list;
  // specs that exercise process CRUD register a later, stateful override.
  await contractRoute(page, "**/api/wr/process**", (route) => {
    if (!api(route)) return route.continue()
    const url = new URL(route.request().url())
    if (url.pathname !== "/api/wr/process" || route.request().method() !== "GET") return route.fallback()
    return json(route, { configs: [], processes: [] })
  })

  // The rail reads the control-plane navigation projection, while transcript
  // restoration reads the workspace's session rows. Both describe the same store.
  const sessionListDefault = (route: Route) => {
    if (!api(route)) return route.continue()
    const rows = [
      ...(sessionCreated ? [sessionRow(textOf(messages[0]?.parts) || "")] : []),
      ...readOnlySessions.map(readOnlySessionRow),
    ].map(row => ({ ...row, createdAt: row.time.created, updatedAt: row.time.updated, archived: row.time.archived }))
    return json(route, sessionNavigationListResponse(route.request().url(), rows))
  }
  await contractRoute(page, "**/api/control/session-list**", sessionListDefault)
  await contractRoute(page, "**/api/claxedo/session-list**", sessionListDefault)

  // GET /api/control/sessions — the FLAT session inventory on the control plane
  // (`controlSessionListUrl`, src/platform/runtime/agent/workspace-control-routes.ts),
  // read by `fetchLocalControlSessions`
  // (src/features/session/data/sync/inventory-source.ts). Distinct route from
  // `/api/control/session-list` above, which is the rail sidebar's grouped view.
  //
  // An escape here degrades silently rather than loudly: the Vite dev server answers
  // `index.html` at **200**, so `res.ok` passes, and the caller's
  // `await res.json().catch(() => ({ sessions: [] }))` swallows the HTML parse failure
  // into an empty inventory indistinguishable from a workspace that genuinely has no
  // sessions.
  //
  // CONTRACT (claxedo-server/src/deployments/hosted-shared/hosted-core-app.ts, the
  // GET /api/control/sessions handler in mountSessionReadRoutes): `{ sessions: [...] }`. The
  // EMPTY body is not a stub here — it is the route's own answer on this exact request:
  // `fetchLocalControlSessions` sends no `workspaceId`, and the handler's first line is
  // `if (!workspaceId || !services.authority?.listSessions) return c.json({ sessions: [] })`.
  await contractRoute(page, "**/api/control/sessions**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/api/control/sessions") return r.fallback()
    return json(r, emptySessionInventoryResponse())
  })
  // GET /api/control/orgs — the signed principal's organizations. Reaching
  // Settings (or opening the rail account menu) mounts the org/team switcher,
  // which issues this read; unhandled, it escaped through the vite proxy to the
  // real, unreachable 127.0.0.1:3001. See ./contracts/org-list.ts for the real
  // handler, the bare-array shape the switcher requires, and why `[]` is the
  // route's own answer rather than a stub.
  await contractRoute(page, "**/api/control/orgs**", (r) => {
    if (!api(r)) return r.continue()
    if (!isOrgListPath(new URL(r.request().url()).pathname)) return r.fallback()
    return json(r, orgListResponse())
  })
  // The route split renamed the local spelling to `GET /api/claxedo/session`
  // (claxedo-local-server/src/session/routes/meta-routes.ts) — same contract,
  // same empty answer. The glob necessarily also matches
  // `/api/claxedo/session-list` (and any `/api/claxedo/session/...` subpath);
  // the exact-pathname check hands those back to the earlier registrations
  // (recorded in ALLOWED_SHADOWS).
  await contractRoute(page, "**/api/claxedo/session**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/api/claxedo/session") return r.fallback()
    return json(r, emptySessionInventoryResponse())
  })
  // SessionMetaRoutes reads the same session identity when a restored rail row
  // needs metadata. Its unsigned response includes the local directory.
  await contractRoute(page, "**/api/claxedo/session/*/meta", (route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() !== "GET") return route.fallback()
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "")
    const other = readOnlySessions.find(row => row.id === id)
    if (id !== SESSION_ID && !other) return json(route, { sessionID: id, tags: [], attachments: [] })
    const row = other ? readOnlySessionRow(other) : sessionRow(textOf(messages[0]?.parts) || "")
    return json(route, {
      sessionID: row.id, title: row.title, host: "workspace", workspaceID: options.workspaceId,
      projectID: PROJECT_ID, directory: row.directory, createdAt: row.time.created,
      updatedAt: row.time.updated, archived: row.time.archived, tags: [], attachments: [],
    } satisfies SessionMeta)
  })

  await page.route("**/path**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/path") return r.fallback()
    return json(r, { worktree: new URL(r.request().url()).searchParams.get("directory") ?? DIR })
  })

  await page.route("**/agent**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/agent") return r.fallback()
    return json(r, [{ id: "build", name: "build", description: "Build agent" }])
  })

  await page.route("**/api/claxedo/agent-config/providers?**", (r) => (api(r) ? json(r, providerResponse()) : r.continue()))
  await page.route("**/api/claxedo/agent-config/providers/auth?**", (r) => (api(r) ? json(r, {}) : r.continue()))



  // Bare-path glob only (no query-string wildcard): Playwright's glob-to-regex
  // anchors the pattern's end, so `**/config` alone does NOT match the app's real
  // `GET /config?directory=...` calls — those fall through unmocked to a real backend
  // that doesn't exist in this harness, producing ERR_CONNECTION_REFUSED on every
  // config-scoped fetch. Hence the explicit `?**` variant alongside it.
  const configHandler = (r: import("@playwright/test").Route) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/config") return r.fallback()
    return json(r, { provider: { id: providerIdFor(harness), model: harnessModel().id }, agent: { id: "build" } })
  }
  await page.route("**/config", configHandler)
  await page.route("**/config?**", configHandler)

  await page.route("**/project**", (r) => {
    if (!api(r)) return r.continue()
    const pathname = new URL(r.request().url()).pathname
    // GET /project/current — the engine's project row for this worktree,
    // fetched (with retries) by boot's `projectCurrentQuery`; it is the request
    // that registers the workspace in the claxedo store, so an escape here
    // means every boot burns its retry budget against a dead request.
    if (pathname === "/project/current") return json(r, localProjectRow())
    // PATCH /project/:id — project metadata writes (`client.project.update`).
    // Echo the row: the mock's project properties are fixed per install.
    if (r.request().method() === "PATCH" && pathname === `/project/${PROJECT_ID}`) {
      return json(r, localProjectRow())
    }
    if (!["/project", "/experimental/project"].includes(pathname)) return r.fallback()
    return json(r, [localProjectRow(), ...(cloud ? [cloudProjectRow()] : [])])
  })

  await page.route("**/mcp**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/mcp") return r.fallback()
    return json(r, {})
  })
  await page.route("**/vcs**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/vcs") return r.fallback()
    return json(r, {
      branch: advertisedCurrentBranch,
      default_branch: advertisedBranchChoices[0]?.sourceBranch,
    })
  })
  await page.route("**/command**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/command") return r.fallback()
    return json(r, [{ name: "build", description: "Build command" }])
  })
  await page.route("**/permission**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/permission") return r.fallback()
    return json(r, pendingPermissions)
  })
  await page.route("**/question**", (r) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname !== "/question") return r.fallback()
    return json(r, pendingQuestions)
  })

  // Permission / question MUTATION routes — the shared, contract-validated versions;
  // see e2e/helpers/contracts/session-interactions.ts. A spec that registers its own
  // route for these paths still wins (Playwright resolves last-registered-first), so a
  // spec keeping a local copy (`installDockMutationRoutes` in core-docks.spec.ts) is
  // unaffected by these.
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
     * ACP agents advertise on session/new, so a draft is answered from the
     * runtime's recorded tables (`ACP_KNOWN_MODES`) — the agents' own ids and
     * names, captured from the live binaries.
     *
     * Mirroring the real tables matters more than it looks: a spec asserting on
     * rows is asserting on THIS object, so a fixture carrying a vocabulary the
     * runtime does not produce would keep passing while the product showed
     * something else entirely.
     *
     * Each vendor's ACP list differs from its SDK list above — same product, two
     * transports, genuinely different surfaces.
     */
    "acp:claude": {
      modes: [
        { id: "auto", name: "Auto", level: "auto" },
        { id: "default", name: "Manual", level: "ask" },
        { id: "acceptEdits", name: "Accept Edits" },
        { id: "plan", name: "Plan Mode" },
        { id: "dontAsk", name: "Don't Ask" },
        { id: "bypassPermissions", name: "Bypass Permissions", level: "full" },
      ],
    },
    "acp:codex": {
      modes: [
        { id: "read-only", name: "Read-only", level: "ask" },
        { id: "agent", name: "Agent", level: "auto" },
        { id: "agent-full-access", name: "Agent (full access)", level: "full" },
      ],
    },
    "acp:cursor": {
      modes: [
        { id: "agent", name: "Agent", level: "auto" },
        { id: "plan", name: "Plan" },
        { id: "ask", name: "Ask", level: "ask" },
      ],
    },
  }
  const modeTableFor = (harness: string) => {
    if (harness === "opencode") return MODES_BY_HARNESS.opencode
    // Each ACP connection has its own table: an unknown one surfaces as a
    // missing fixture rather than borrowing another agent's modes.
    if (harness.startsWith("acp:")) {
      const table = MODES_BY_HARNESS[harness]
      if (!table) throw new Error(`mock-runtime: no permission modes recorded for ${harness}`)
      return table
    }
    return MODES_BY_HARNESS[harness.replace(/-sdk|-app-server$/, "")] ?? MODES_BY_HARNESS.opencode
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
  // Drafts name their native harness or connection in the query. Session
  // bindings are separate: changing a draft does not rewrite an existing session.
  await page.route("**/permission/modes**", async (route) => {
    if (!api(route)) return route.continue()
    await options.beforePermissionModesResponse?.()
    return json(route, modeState(harnessFixtureFromUrl(route.request().url(), harness)))
  })
  await page.route("**/session/*/permission-mode**", async (route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() === "GET") await options.beforePermissionModesResponse?.()
    if (route.request().method() === "PUT") {
      const body = JSON.parse(route.request().postData() || "{}") as { modeId?: string }
      if (body.modeId) requests.permissionModeWrites.push({ modeId: body.modeId })
    }
    // `harness`, not `options.harness` — same reason as the directory-scoped route above.
    return json(route, modeState(harness))
  })

  await contractRoute(page, "**/session/*/permissions/*", async (route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() !== "POST") return route.fallback()
    // Throws on ANY value that is not exactly "once" | "always" | "reject". That
    // strictness is the point: the server maps every unrecognised value — a typo, a
    // rename, a missing body — onto `deny` with HTTP 200 and no error, so an ALLOW
    // silently becomes a DENY (session-core.ts).
    requests.permissionResponses.push(
      parseSessionPermissionRequest(route.request().postDataJSON?.() ?? undefined, route.request().url()),
    )
    return json(route, SESSION_INTERACTION_SUCCESS.body, SESSION_INTERACTION_SUCCESS.status)
  })

  await contractRoute(page, "**/question/*/reply**", async (route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() !== "POST") return route.fallback()
    requests.questionReplies.push(
      parseQuestionReplyRequest(route.request().postDataJSON?.() ?? undefined, route.request().url()),
    )
    return json(route, SESSION_INTERACTION_SUCCESS.body, SESSION_INTERACTION_SUCCESS.status)
  })

  await contractRoute(page, "**/question/*/reject**", async (route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() !== "POST") return route.fallback()
    parseQuestionRejectRequest(route.request().postDataJSON?.() ?? undefined, route.request().url())
    requests.questionRejectCount += 1
    return json(route, SESSION_INTERACTION_SUCCESS.body, SESSION_INTERACTION_SUCCESS.status)
  })

  // The control plane's workspace list — the sidebar catalog's only source for
  // relay-backed workspaces (`workspaceCatalogQuery` asks for both hosts
  // concurrently, src/features/workspaces/data/workspace-catalog.ts). An escape here
  // reaches the central origin (127.0.0.1:3001, nothing listening) and REJECTS, which
  // the catalog's loopback branch swallows (`.catch(() => [])`) — so the rail silently
  // loses every relay-backed row.
  //
  // Registered BEFORE `/resolve`, `/drivers`, `/create`, `/:id/connection` and
  // `/:id/checkpoints` so those keep winning (Playwright resolves handlers
  // last-registered-first), and guarded on the exact BARE pathname besides, so
  // it can never shadow a sibling `/api/workspace/...` route.
  await contractRoute(page, "**/api/workspace**", (r) => {
    if (!api(r)) return r.continue()
    const url = new URL(r.request().url())
    if (!isWorkspaceListPath(url.pathname) || r.request().method() !== "GET") return r.fallback()
    return json(r, workspaceListResponse({
      host: url.searchParams.get("host"),
      workspaces: controlPlaneWorkspaceRows(),
    }))
  })

  // Echoes the REQUESTED directory back as the workspace identity, mirroring the real
  // local resolve route. Answering a fixed id instead would make the app's route bridge
  // upgrade the pane onto a different `/w/<id>` MID-FLOW, remounting the pane scope
  // (keyed on the workspace key) under the user.
  const localWorkspaceResolve = (r: Route) => {
    if (!api(r)) return r.continue()
    const directory = new URL(r.request().url()).searchParams.get("directory") ?? DIR
    return json(r, workspaceResolveResponse({
      id: options.workspaceId ?? directory,
      project_id: PROJECT_ID,
      directory,
      kind: "local",
      status: "ready",
      created_at: Date.now(),
      updated_at: Date.now(),
    }))
  }
  await contractRoute(page, "**/api/workspace/resolve**", localWorkspaceResolve)
  await contractRoute(page, "**/api/claxedo/workspace/resolve**", localWorkspaceResolve)

  // The default driver catalog is "no provider configured", the zero state of a
  // local-only machine. Specs that exercise a sandbox provider override this.
  await contractRoute(page, "**/api/workspace/drivers**", (r) =>
    api(r)
      ? json(r, unconfiguredWorkspaceDriversResponse())
      : r.continue(),
  )

  // The remote-access status Settings → Machines reads: a build with neither
  // device sign-in nor a relay configured.
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

  const runtimeDiffHandler = async (r: Route) => {
    if (!api(r)) return r.continue()
    if (new URL(r.request().url()).pathname.endsWith("/api/wr/diff/refs")) {
      return json(r, { branches: advertisedBranches, branchChoices: advertisedBranchChoices, tags: [], recent: [] })
    }
    const response = await driveEmptyRuntimeDiffRoute(r.request().url())
    return json(r, response.body, response.status)
  }
  await contractRoute(page, "**/api/wr/diff/**", runtimeDiffHandler)

  await contractRoute(page, "**/experimental/worktree**", async (r) => {
    if (!api(r)) return r.continue()
    if (r.request().method() === "GET") return json(r, [])
    if (r.request().method() !== "POST") return r.fallback()
    const url = new URL(r.request().url())
    const body = r.request().postDataJSON?.() as { baseRef?: unknown } | null
    requests.worktreeCreateBodies.push({
      directory: url.searchParams.get("directory") ?? undefined,
      ...(typeof body?.baseRef === "string" ? { baseRef: body.baseRef } : {}),
    })
    const name = `e2e-${requests.worktreeCreateBodies.length}`
    const created = {
      name,
      branch: `opencode/${name}`,
      directory: `${url.searchParams.get("directory") ?? DIR}/${name}`,
    }
    createdLocalWorktrees.push(created)
    void wait(timings.pending).then(() => emitNotice({
      type: "worktree.ready",
      directory: created.directory,
      name: created.name,
      branch: created.branch,
    }))
    return json(r, created)
  })

  // ------------------------------------------------------------------------
  // File browser / search surface on the PRIMARY origin.
  //
  // Callers wrap each request in `.catch(() => [])`, so an escape here presents as
  // "the workspace happens to be empty" rather than as a failure.
  //
  // CONTRACTS, all read from the routes the app actually talks to
  // (packages/claxedo-local-server/src/shell/file-browser.ts; workspace-runtime's
  // src/routes/file.ts is the same surface behind the relay and agrees on every shape):
  //   GET /find/file    -> string[] of workspace-RELATIVE paths (globSearch)
  //   GET /find         -> GrepMatch[] : { path:{text}, lines:{text}, line_number,
  //                        absolute_offset, submatches:[{match:{text},start,end}] }
  //   GET /file         -> { name, path, absolute, type:"file"|"directory", ignored }[]
  //   GET /file/content -> { type:"text", content } (or a base64 `binary` variant)
  //   GET /file/status  -> [] here; the fixture has no VCS state
  //   GET /file/all     -> { paths: string[] }
  //   GET /find/symbol  -> [] — the real handler is itself a stub
  // ------------------------------------------------------------------------
  const workspaceFiles = options.workspaceFiles ?? DEFAULT_WORKSPACE_FILES
  const workspaceFilePaths = workspaceFiles.map((file) => file.path)
  /** Mirrors `searchWorkspaceFiles`: fuzzy match over the indexed paths, capped. */
  const findFiles = (url: URL) => {
    const query = (url.searchParams.get("query") ?? "").trim()
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 200)
    if (!query) return workspaceFilePaths.slice(0, limit)
    return fuzzysort.go(query, workspaceFilePaths, { limit }).map((hit) => hit.target)
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
    // File routes use either the local runtime prefix or a workspace relay
    // prefix, but both consume the same directory and content fixtures.
    switch (url.pathname.replace(/^\/api\/wr(?=\/)/, "").replace(/^\/workspaces\/[^/]+/, "")) {
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
        // catch returns `{type:"text", content:""}`
        // (packages/claxedo-local-server/src/shell/file-browser.ts).
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
  // glob, so `**/find` alone never matches the app's real `GET /find?pattern=…`.
  await page.route("**/find", fileBrowserHandler)
  await page.route("**/find?**", fileBrowserHandler)
  await page.route("**/find/**", fileBrowserHandler)
  await page.route("**/file", fileBrowserHandler)
  await page.route("**/file?**", fileBrowserHandler)
  await page.route("**/file/**", fileBrowserHandler)

  await contractRoute(page, "**/api/claxedo/agent-config/harness/options**", (r) => {
    if (!api(r)) return r.continue()
    requests.harnessOptionsCount += 1
    const type = harnessFixtureFromUrl(r.request().url(), harness)
    requests.harnessOptionsHarnesses.push(type)
    const model = harnessModels[type]?.[0] ?? BIG_PICKLE
    return json(r, runtimeHarnessOptionsResponse(harnessConfigOptions(type, model)))
  })

  // The code-host catalog the first-run wizard's project form reads on a
  // server with no filesystem: this mock offers no host, so the form shows the
  // URL field alone. A spec that models a connected host registers its own
  // handler later, which Playwright consults first.
  await page.route("**/api/claxedo/integrations", (r) => {
    if (!api(r) || r.request().method() !== "GET") return r.fallback()
    return json(r, { integrations: [], connections: [] })
  })

  // Sanitized generic agent-connection discovery for the Connections screen.
  await contractRoute(page, "**/api/claxedo/agent-config/connections**", (r) => {
    if (!api(r)) return r.continue()
    const connections = (Object.keys(harnessModels) as Harness[]).flatMap((candidate) => {
      const selection = harnessSelectionFor(candidate)
      if (selection.kind !== "connection") return []
      return [{
        connectionId: selection.connectionId,
        label: selection.connectionId,
        enabled: true,
        readiness: "ready",
        capabilities: {
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
          configOptions: true,
          subagents: true,
        },
        modelSelection: { status: "optional" },
      }]
    })
    return json(r, { status: "supported", connections })
  })

  // POST /api/claxedo/usage/sync — the usage outbox beacon
  // (`installUsageOutboxWakeups`, src/features/usage/data/usage-api.ts) fires
  // once on every app boot and again on `online` events, so it reaches every
  // spec's page. CONTRACT: `syncUsageOutbox` reads back
  // `{ attempted, delivered, conflicts, pending }`; an empty outbox syncs to
  // all zeros.
  await contractRoute(page, "**/api/claxedo/usage/sync**", (r) => {
    if (!api(r)) return r.continue()
    return json(r, { attempted: 0, delivered: 0, conflicts: 0, pending: 0 })
  })

  await contractRoute(page, "**/api/claxedo/agent-config/harness**", async (r) => {
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
      // vocabulary cannot drift from the server's, and `binary`, `sessionId`,
      // `directory` and `workspaceId` are checked rather than ignored.
      const parsed = parseHarnessConfigRequest(body, r.request().url())
      const requested = parsed.selection.kind === "native"
        ? ({ claude: "claude-sdk", codex: "codex-app-server", cursor: "cursor-sdk", pi: "pi", opencode: "opencode" } as const)[parsed.selection.harnessId]
        : parsed.selection.connectionId
      if (requested in harnessModels) harness = requested as Harness
      // CONTRACT: the real switch endpoint returns `{ ok: true }` and NOTHING else
      // (agent-config-harness-routes.ts — both the per-session and the global-config
      // branch). Answering with a full harness-status payload instead would let a spec
      // watch a switch settle (including settle to ERROR) directly off the POST, via
      // `decodeHarnessState` → `applyPostedStatus` — a path production can never take.
      // Harness state settles the way it really does: through the GET below, reached
      // via `fetchHarnessStatus`.
      return json(r, HARNESS_POST_SUCCESS.body, HARNESS_POST_SUCCESS.status)
    }
    // Count GET probes so `harnessGetPollSettleAfter` can settle a slow
    // polling harness under the client's bounded re-probe loop.
    harnessGetPollCount += 1
    requests.harnessGetCount += 1
    const model = harnessModel()
    const status = harnessStatusPayload()
    const selection = harnessSelectionFor(harness)
    return json(r, { harness: selection, activeHarness: selection, model: model.id, ok: true, ...status })
  })

  await page.route("**/api/claxedo/agent-config/agents**", (r) =>
    api(r) ? json(r, [{ id: "build", name: "build", mode: "primary" }]) : r.continue(),
  )
  await page.route("**/api/claxedo/agent-config/commands**", (r) =>
    api(r) ? json(r, [{ name: "build", description: "Build command" }]) : r.continue(),
  )

  // "**" after /status is required: the app requests /session/status?directory=…, and a
  // bare "**/session/status" pattern never matches a query string — the request would
  // fall past this route entirely. That alone is not sufficient: the `**/session/*`
  // catch-all below is registered later and so out-matches this route even with the
  // wildcard — hence the explicit hand-back there.
  //
  // The body is the live map, built through `sessionStatusResponseBody` so it can only
  // ever carry the shape the real route produces — see `./contracts/session-status.ts`
  // for both server implementations. Idle is an ABSENT key on the wire, never
  // `{type:"idle"}`, so a fixed idle-VALUED map is a shape neither server path can emit.
  // Specs seed `options.sessionStatuses` and/or drive `handles.setSessionStatus` per
  // session id; sessions absent from the map read as idle everywhere, exactly as on
  // the wire.
  await contractRoute(page, "**/session/status**", (r) =>
    api(r) ? json(r, sessionStatusResponseBody(Object.fromEntries(liveSessionStatuses))) : r.continue(),
  )

  const handleSessionList = async (route: Route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() === "POST") {
      requests.createSessionCount += 1
      const url = route.request().url()
      sessionDirectory = new URL(url).searchParams.get("directory") ?? DIR
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
      const createModelId = typeof createModel?.id === "string"
        ? createModel.id
        : typeof createModel?.modelID === "string"
          ? createModel.modelID
          : undefined
      if (typeof createModel?.providerID === "string" && createModelId) {
        savedModel = { providerID: createModel.providerID, modelID: createModelId }
      }
      if (typeof body.agent === "string" || body.agent === null) savedAgent = body.agent
      if (typeof body.variant === "string" || body.variant === null) savedVariant = body.variant
      if (!("variant" in body) && typeof createModel?.variant === "string") savedVariant = createModel.variant
      const sessionHarness = harnessFixtureFromUrl(url, harness)
      if (sessionHarness !== "opencode") requests.harnessSessionCreateCount += 1
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
    const rows = [
      ...(sessionCreated ? [sessionRow(textOf(messages[0]?.parts) || "")] : []),
      ...readOnlySessions.map(readOnlySessionRow),
    ]
    const url = new URL(route.request().url())
    const includeArchived = url.searchParams.get("archived") === "true" || url.searchParams.get("archived") === "1"
    return json(route, url.pathname === "/experimental/session" && !includeArchived
      ? rows.filter(row => row.time.archived === undefined)
      : rows)
  }
  await page.route("**/session", handleSessionList)
  await page.route("**/session?**", handleSessionList)
  await page.route("**/experimental/session", handleSessionList)
  await page.route("**/experimental/session?**", handleSessionList)

  await contractRoute(page, "**/session/*/config**", async (route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() === "PATCH") {
      requests.configPatchCount += 1
      const url = route.request().url()
      // CONTRACT: validated against the real PATCH route (see
      // e2e/helpers/contracts/session-config.ts). Validating rather than recording an
      // opaque `unknown` is what catches a half-filled `model`, which `promptModel`
      // (session-config.ts) drops SILENTLY server-side and would otherwise read as a
      // successful save.
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
      // (`c.json(config)`, session-core.ts) — NOT `{ ok: true }`, whose `ok` key
      // collides with the FAILURE envelope's `ok` discriminant and would make a client
      // branching on `body.ok` look correct by accident.
      const saved = sessionConfig()
      assertSessionConfigPatchResponse(saved, url)
      return json(route, saved, SESSION_CONFIG_PATCH_SUCCESS_STATUS)
    }
    return json(route, sessionConfig())
  })

  // CONTRACT (workspace-runtime `session-core.ts` `GET /session/:id/config-options`):
  // the session's harness answers with the same options list the draft route serves.
  // Registered after `**/session/*/config**`, whose trailing `**` also matches this
  // path: Playwright tries the most recently registered route first.
  await contractRoute(page, "**/session/*/config-options**", (r) => {
    if (!api(r)) return r.continue()
    const type = harnessFixtureFromUrl(r.request().url(), harness)
    requests.harnessOptionsCount += 1
    requests.harnessOptionsHarnesses.push(type)
    const model = harnessModels[type]?.[0] ?? BIG_PICKLE
    return json(r, runtimeHarnessOptionsResponse(harnessConfigOptions(type, model)))
  })

  // CONTRACT (workspace-runtime `session-core.ts` `GET /session/:id/queue` and
  // `POST /session/:id/queue/:seq/:action`): the list is what a reader may see
  // of the owner's records; a control answers `{ ok: true }` once applied.
  await page.route("**/session/*/queue**", async (r) => {
    if (!api(r)) return r.continue()
    const url = new URL(r.request().url())
    const action = url.pathname.match(/\/queue\/(\d+)\/(cancel|steer|replace|hold|release)$/)
    if (!action) {
      return json(r, queuedPrompts.map(({ seq, parts, messageId, queuedAt, held }) => ({ seq, parts, messageId, queuedAt, held })))
    }
    const seq = Number(action[1])
    const index = queuedPrompts.findIndex((record) => record.seq === seq)
    if (index === -1) return json(r, { ok: false, status: "conflict", error: "Queued message is not available" }, 409)
    const record = queuedPrompts[index]
    switch (action[2]) {
      case "cancel":
        queuedPrompts.splice(index, 1)
        break
      case "hold":
      case "release":
        record.held = action[2] === "hold"
        break
      case "replace": {
        const body = r.request().postDataJSON() as { parts?: QueuedPrompt["parts"] }
        record.parts = body?.parts ?? []
        record.turn.text = textOf(record.parts) || record.turn.text
        record.held = false
        break
      }
      case "steer": {
        queuedPrompts.splice(index, 1)
        if (runningTurn) {
          const userRow = userMessage({ id: record.turn.userID, text: record.turn.text, agent: record.turn.agent, providerID: record.turn.providerID, modelID: record.turn.modelID })
          messages = [...messages, userRow]
          emit({ type: "message.updated", properties: { sessionID: SESSION_ID, info: userRow.info } })
        } else {
          startQueuedTurn(record)
        }
        break
      }
    }
    if (action[2] !== "steer") drainQueuedPrompts()
    return json(r, { ok: true })
  })
  await page.route("**/session/*/todo**", (r) => (api(r) ? json(r, sessionTodos) : r.continue()))

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
          configOptions: harness !== "opencode",
        })
      : r.continue(),
  )

  // `GET /session/:id/goal/state` (workspace-runtime `session-core.ts`): one
  // read composes the Goal capabilities with the goal itself, which is `null`
  // whenever the harness does not implement Goals — the shape every harness
  // this mock models answers with. Matches the local lane and the relay lane
  // (`/workspaces/:id/session/...`) alike; without it the read escaped to the
  // network and surfaced as a page error.
  await page.route("**/session/*/goal/state**", (route) => {
    if (!api(route)) return route.continue()
    if (route.request().method() !== "GET") return route.fallback()
    return json(route, { capabilities: { implemented: false, available: false, actions: [] }, goal: null })
  })

  await contractRoute(page, "**/session/*/prompt_async**", async (route) => {
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
      ...(body?.delivery ? { delivery: body.delivery } : {}),
    })

    if (body?.delivery === "queue") {
      queuedPrompts.push({
        seq: ++queuedPromptSeq,
        messageId: userID,
        parts: Array.isArray(body?.parts) ? (body.parts as QueuedPrompt["parts"]) : [{ type: "text", text }],
        queuedAt: Date.now(),
        held: false,
        turn: { userID, assistantID, text, agent, providerID, modelID, turn: requests.promptCount },
      })
      await route.fulfill({ ...sessionPromptDelivered("queue") })
      drainQueuedPrompts()
      return
    }

    const userRow = userMessage({ id: userID, text, agent, providerID, modelID })
    messages = [...messages, userRow]
    // A steered prompt joins the turn already running: the runtime commits its
    // user message and the running turn keeps going, so no turn is driven here
    // and the response carries the delivery the composer needs to read.
    if (body?.delivery === "steer" && runningTurn) {
      emit({ type: "message.updated", properties: { sessionID: SESSION_ID, info: userRow.info } })
      await route.fulfill({ ...sessionPromptDelivered("steer") })
      return
    }
    // CONTRACT: the real route returns 204 with an empty body for a prompt that
    // asked nothing about delivery, and `{ delivery }` for one that did.
    await route.fulfill(body?.delivery ? { ...sessionPromptDelivered("start") } : { ...SESSION_PROMPT_SUCCESS })

    runningTurn = userID
    // Fire-and-forget: the staged event sequence runs on its own clock, independent
    // of this route handler's lifecycle.
    void driveTurn({ userID, assistantID, text, agent, providerID, modelID, turn: requests.promptCount })
  })

  // CONTRACT (workspace-runtime/src/routes/session-core.ts): all three recovery
  // routes answer a serialized `RecoveryOutcome`, including for every refusal, so
  // a client decodes one shape rather than branching on HTTP status. Inspection
  // answers the turn identity a caller must send back unchanged.
  //
  // The facts a healthy local Stop reports are `execution: terminal`,
  // `persistence: committed`, `cleanup: unknown` — no adapter in this wave can
  // prove `verified_clear`, so the operation closes `needs_action`. A mock that
  // answered `succeeded` would hide the defect every consumer of these routes
  // was written against.
  const evidence = (value: string, source: string) => ({
    value,
    source,
    observedAt: Date.now(),
    generation: OWNER_GENERATION,
  })
  const recoveryTarget = () => runningTurn
    ? {
        scope: "turn" as const,
        workspaceId: "ws_e2e",
        sessionId: SESSION_ID,
        turnId: runningTurn,
        ownerGeneration: OWNER_GENERATION,
      }
    : undefined

  await page.route("**/session/*/recovery**", async (route) => {
    if (!api(route)) return route.continue()
    const url = new URL(route.request().url())
    const operationRead = url.pathname.match(/\/session\/[^/]+\/recovery\/operations\/([^/]+)$/)
    if (operationRead) {
      requests.recoveryOperationReads.push(operationRead[1])
      const held = recoveryOperations.get(operationRead[1])
      if (!held) {
        return json(route, {
          kind: "refused",
          refusal: { kind: "receipt_expired", message: `no operation ${operationRead[1]}`, requestId: operationRead[1] },
        })
      }
      return json(route, { kind: "operation", operation: held })
    }
    if (!url.pathname.match(/\/session\/[^/]+\/recovery$/)) return route.fallback()

    if (route.request().method() === "GET") {
      requests.recoveryInspectCount += 1
      if (options.recoveryUnavailable) {
        return json(route, {
          kind: "refused",
          refusal: { kind: "unavailable", message: "no owner on this machine can answer for this session" },
        })
      }
      const target = recoveryTarget()
      return json(route, {
        sessionId: SESSION_ID,
        ...(target ? { target } : {}),
        facts: {
          execution: evidence(runningTurn ? "running" : "terminal", "codex"),
          cleanup: evidence(runningTurn ? "owned" : "unknown", "process-owner"),
          persistence: evidence(lastRecoveryPersistence, "runtime-store"),
        },
        health: { status: "ok" as const },
        failures: [],
        operations: [...recoveryOperations.values()],
        queued: 0,
      })
    }
    if (route.request().method() !== "POST") return route.fallback()

    // Counted on RECEIPT, before the gate: a held-open Stop has still reached the
    // network, and proving exactly that is what `holdAbort` exists for.
    requests.abortCount += 1
    const body = route.request().postDataJSON?.() ?? {}
    const namedTurn = body?.target?.turnId as string | undefined
    requests.abortedTurnIds.push(namedTurn)
    requests.recoveryRequests.push({
      requestId: String(body?.requestId ?? ""),
      action: String(body?.action ?? ""),
      turnId: namedTurn,
      attempt: Number(body?.attempt ?? 0),
      linkedOperationId: body?.linkedOperationId as string | undefined,
    })
    if (abortGate) await abortGate

    const operationId = `op_${requests.abortCount}`
    const refuse = (refusal: Record<string, unknown>) => json(route, { kind: "refused", refusal })

    // A Stop naming a turn the session is no longer running is refused with the
    // turn that replaced it, the way the runtime refuses it: cancelling whatever
    // is running now would stop work nobody asked to stop.
    if (namedTurn && runningTurn && namedTurn !== runningTurn) {
      return refuse({
        kind: "generation_conflict",
        message: "that turn has already ended",
        current: recoveryTarget(),
      })
    }
    if (options.recoveryStorageFailure) {
      lastRecoveryPersistence = "unavailable"
    } else if (body?.action === "cancel_turn") {
      lastRecoveryPersistence = "committed"
    }

    if (body?.action === "cancel_turn" && !options.recoveryExecutionUnresolved) {
      if (options.messageRefreshOnly && runningTurn) {
        const assistantMessageId = assistantIdForUserMessage(runningTurn)
        const completedAt = Date.now()
        lastTurn = { status: "cancelled", completedAt, reason: "abort", assistantMessageId }
        messages = messages.map(row => row.info.id === assistantMessageId
          ? { ...row, info: { ...row.info, time: { ...row.info.time, completed: completedAt } } }
          : row)
        setSessionStatus(SESSION_ID)
        emit({ type: "agent.lifecycle", tabId: SESSION_ID, sessionId: SESSION_ID, eventType: "Idle" })
      } else {
        // A runtime that cancelled a turn and committed the interruption
        // publishes the idle itself. The client no longer writes one, so a mock
        // that stayed silent here would leave every Stop looking unanswered.
        setSessionStatus(SESSION_ID)
        emit({ type: "session.idle", properties: { sessionID: SESSION_ID } })
      }
      runningTurn = undefined
      drainQueuedPrompts()
    }

    const unresolved = options.recoveryExecutionUnresolved === true
    const operation = {
      operationId,
      requestId: String(body?.requestId ?? ""),
      target: body?.target,
      action: String(body?.action ?? "cancel_turn"),
      scopeRevision: String(body?.scopeRevision ?? OWNER_GENERATION),
      attempt: Number(body?.attempt ?? 1),
      state: "needs_action" as const,
      phase: "graceful_cancel" as const,
      phaseDeadlineAt: Date.now() + 10_000,
      facts: {
        execution: evidence(unresolved ? "unknown" : "terminal", "codex"),
        cleanup: evidence("unknown", "process-owner"),
        persistence: evidence(lastRecoveryPersistence, "runtime-store"),
      },
      ...(unresolved || options.recoveryStorageFailure
        ? {
            initiatingError: {
              code: unresolved ? "cancellation_timeout" : "persistence_unavailable",
              origin: "workspace-host",
              target: body?.target,
              stage: unresolved ? "graceful_cancel" : "reconcile",
              executionMayContinue: unresolved,
              message: unresolved
                ? "the harness did not answer the cancellation"
                : "the interrupted turn could not be written",
              at: Date.now(),
            },
          }
        : {}),
      cleanupErrors: [],
      nextActions: [{ action: "inspect" as const, scopePreviewRequired: false, reason: "cleanup is unproven" }],
      receipt: "durable" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(body?.linkedOperationId ? { linkedOperationId: body.linkedOperationId } : {}),
    }
    recoveryOperations.set(operationId, operation)
    if (options.recoveryResponseLost) return route.abort("connectionaborted")
    return json(route, { kind: "operation", operation })
  })

  await contractRoute(page, "**/session/*/command**", async (route) => {
    if (!api(route)) return route.continue()
    const url = new URL(route.request().url())
    if (!url.pathname.match(/^\/session\/[^/]+\/command$/)) return route.fallback()
    requests.slashCount += 1
    // CONTRACT: see e2e/helpers/contracts/session-command.ts. The body was never
    // inspected here, and the response was `204` with an empty body while the real
    // route returns `c.json({ ok: true })` — HTTP 200 (session-core.ts).
    parseSessionCommandRequest(route.request().postDataJSON?.() ?? undefined, route.request().url())
    return route.fulfill({ ...SESSION_COMMAND_SUCCESS })
  })

  await page.route("**/session/*/subagents**", (r) => {
    if (!api(r)) return r.continue()
    const parentSessionId = decodeURIComponent(new URL(r.request().url()).pathname.split("/").at(-2) ?? "")
    return json(r, options.subagents?.[parentSessionId] ?? [])
  })

  await page.route("**/session/*/message**", async (r) => {
    if (!api(r)) return r.continue()
    const url = new URL(r.request().url())
    const sessionId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
    const child = readOnlySessions.find((row) => row.id === sessionId)
    const snapshot = child ? readOnlyMessages(child) : messages
    if (options.messageRefreshOnly && requests.promptCount > 0 && !child) {
      await wait(options.messageRefreshOnly.responseDelayMs)
    }
    // CONTRACT (workspace-runtime/src/routes/session-core.ts): `?turn=&coverage=1`
    // is a third, exclusive read shape answering one named turn rather than a
    // page. Its envelope names the turn that was ASKED for, so a client can tell
    // an answer about its turn from an answer about the one that replaced it.
    const askedTurn = url.searchParams.get("turn")
    const coverage = url.searchParams.get("coverage")
    // The real route refuses these three rather than guessing which read was
    // meant; a mock that answered them would hide a client sending either half.
    if ((askedTurn !== null || coverage !== null) && !(askedTurn && coverage === "1")) {
      return json(r, { error: { code: "bad_request", message: "turn coverage requires turn= and coverage=1" } }, 400)
    }
    if (askedTurn && coverage === "1" && ["view", "limit", "before"].some((name) => url.searchParams.has(name))) {
      return json(r, { error: { code: "bad_request", message: "turn coverage cannot be combined with view, limit or before" } }, 400)
    }
    if (askedTurn && coverage === "1") {
      requests.coverageReads.push(askedTurn)
      const assistantMessageId = assistantIdForUserMessage(askedTurn)
      const turnRows = snapshot.filter((row) => row.info.id === askedTurn || row.info.id === assistantMessageId)
      const finished = turnRows.some((row) =>
        row.info.role === "assistant" && typeof row.info.time?.completed === "number")
      // Only a journal that records the turn ended may call the page complete,
      // and only then does it carry a terminal.
      return json(r, {
        turnId: askedTurn,
        coverage: turnRows.length === 0 ? "unavailable" : finished ? "complete" : "partial",
        ...(turnRows.length === 0 ? { reason: `no journalled turn ${askedTurn}` } : {}),
        ...(finished && lastTurn ? { terminal: lastTurn } : {}),
        committedSequence: requests.promptCount,
        messages: turnRows,
      })
    }
    return json(r, { messages: snapshot, maxEventOrdinal: 0 })
  })

  await page.route("**/session/*", async (r) => {
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
    // `routes/session-core.ts`) — so the shared `sessionRow()` fixture below is the
    // right response for both verbs; successful archive writes persist in that row.
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
      const time = body.time
      if (time && typeof time === "object" && "archived" in time && typeof time.archived === "number") {
        const id = decodeURIComponent(pathname.split("/").at(-1) ?? "")
        if (options.sessionArchive?.delayMs) await wait(options.sessionArchive.delayMs)
        if (options.sessionArchive?.failingSessionIds?.includes(id)) return json(r, { error: "archive failed" }, 500)
        archivedSessions.set(id, time.archived)
      }
    }
    const sessionId = decodeURIComponent(pathname.split("/").at(-1) ?? "")
    const child = readOnlySessions.find((row) => row.id === sessionId)
    return json(r, child ? readOnlySessionRow(child) : sessionRow(textOf(messages[0]?.parts) || ""))
  })

  // The signed control plane's session-reservation boundary. A signed client
  // reserves the session id it is about to create BEFORE it reaches the runtime
  // (`reservePrivateSession`, src/platform/runtime/private-session-reservation.ts)
  // and refuses to continue unless the receipt echoes its own immutable intent —
  // so an unmocked reservation does not degrade, it ABORTS the send: no session
  // create, no prompt, no reply. It is mounted on the PRIMARY origin for every
  // page (never relay-prefixed, and never gated on `cloud`) because it is the
  // control plane's route, taken by any relay-backed workspace whichever host
  // serves it.
  await contractRoute(page, `**${SESSION_REGISTRATION_RESERVE_PATH}`, (r) => {
    if (!api(r)) return r.continue()
    if (r.request().method() !== "POST") return r.fallback()
    const url = r.request().url()
    // CONTRACT: the same body the real route accepts, and the receipt built
    // from it — see e2e/helpers/contracts/session-registration.ts.
    const reservation = parseSessionReservationRequest(r.request().postDataJSON?.() ?? undefined, url)
    requests.sessionReservations.push(reservation)
    const result = sessionReservationResponse(reservation)
    return json(r, result, sessionReservationStatus(result))
  })

  // --------------------------------------------------------------------
  // Cloud: mount a full relay-lane workspace-runtime session (connection
  // mint + `/workspaces/:workspaceId/...` session/prompt/message/config/
  // capabilities/provider/harness-config-options + event streams).
  //
  // DUAL-ORIGIN routing — a relay-backed workspace's requests reach the
  // runtime via TWO different origins depending on which transport the
  // environment resolves, and BOTH must be intercepted identically:
  //   1. RELAY origin (`${relayUrl}/workspaces/:id<path>`,
  //      `createWorkspaceRelayConnection`,
  //      `src/platform/runtime/agent/workspace-relay-connection.ts`)
  //      — used by the post-send session controller and by any environment
  //      whose central base is NOT loopback.
  //   2. LOOPBACK local-proxy form (`${serverUrl}/workspaces/:id<path>`,
  //      `createWorkspaceRuntimeRequest`, `workspace-runtime-request.ts`)
  //      — used by the DRAFT-time harness-config transport
  //      (`workspaceHarnessTransport` picks `transport: "loopback"` whenever
  //      `centralTransportForServer(base) === "loopback"`,
  //      `harness-config-runtime.ts`, and `preferRelayOnLoopback` stays
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

    await page.route("**/api/workspace/create", (r) => {
      if (!api(r)) return r.continue()
      if (r.request().method() !== "POST") return r.fallback()
      const body = r.request().postDataJSON?.() as { projectId?: unknown; gitBranch?: unknown } | null
      requests.workspaceCreateBodies.push({
        ...(typeof body?.projectId === "string" ? { projectId: body.projectId } : {}),
        ...(typeof body?.gitBranch === "string" ? { gitBranch: body.gitBranch } : {}),
      })
      return json(r, {
        workspaceId,
        directory: workspaceId,
        projectId: CLOUD_PROJECT_ID,
        provider: "mock",
        status: "ready",
      })
    })

    // Connection mint — `GET /api/workspace/:id/connection[/refresh]` on the PRIMARY
    // origin (never relay-prefixed: the client doesn't know the relay origin until
    // this resolves). Always reports the workspace ready/minted — the 4-step
    // provisioning pipeline itself is `core-cloud-provisioning.spec.ts`'s own concern,
    // out of scope here.
    await page.route(`**/api/workspace/${workspaceId}/connection**`, (r) =>
      api(r)
        ? json(r, {
            backing: "cloud-vm",
            // A cloud sandbox's runtime delegates to the control plane's session
            // authority, so it serves SESSION-SCOPED event streams only. The
            // mint is the only place the client learns that, and the app opens
            // no workspace stream until it does — so omitting this makes the
            // whole event bus silent, exactly as it would in production.
            sessionAuthority: "managed-private",
            workspaceId,
            role: cloud.role ?? "owner",
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

    // Resolve discriminates by workspaceId/directory: a blanket catch-all here would
    // also answer the local directory's own resolve, mounted above, with cloud info,
    // breaking any spec that drives both lanes in one page.
    //
    // Both spellings, like the generic default above: `workspaceResolveUrl` requests
    // `/api/claxedo/workspace/resolve` on loopback transports (every e2e page) and
    // `/api/workspace/resolve` elsewhere. Cover only the unprefixed one and the cloud
    // workspace's resolve falls through to the local-shaped default, leaving the
    // draft submit outside the cloud lane with `cloudPromptCount` stuck at 0.
    const cloudWorkspaceResolveResponse = () => workspaceResolveResponse({
      id: workspaceId,
      project_id: CLOUD_PROJECT_ID,
      directory: workspaceId,
      remote_directory: workspaceId,
      kind: "cloud",
      driver: "daytona",
      status: "ready",
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    // The workspace-id hand-back lives INSIDE each registration (not a shared
    // helper) so the route-shadowing guard can see it verbatim.
    await contractRoute(page, `**/api/workspace/resolve**`, (r) => {
      if (!api(r)) return r.continue()
      const url = new URL(r.request().url())
      const q = url.searchParams.get("workspaceId") ?? url.searchParams.get("directory") ?? ""
      if (q !== workspaceId && !q.includes(workspaceId)) return r.fallback()
      return json(r, cloudWorkspaceResolveResponse())
    })
    await contractRoute(page, `**/api/claxedo/workspace/resolve**`, (r) => {
      if (!api(r)) return r.continue()
      const url = new URL(r.request().url())
      const q = url.searchParams.get("workspaceId") ?? url.searchParams.get("directory") ?? ""
      if (q !== workspaceId && !q.includes(workspaceId)) return r.fallback()
      return json(r, cloudWorkspaceResolveResponse())
    })

    await page.route(`${base}/vcs**`, (r) => {
      return json(r, {
        branch: advertisedCurrentBranch,
        default_branch: advertisedBranchChoices[0]?.sourceBranch,
      })
    })
    await page.route(`${base}/mcp**`, (r) => json(r, {}))
    await page.route(`${base}/agent**`, (r) =>
      json(r, [{ id: "build", name: "build", description: "Build agent", mode: "primary" }]),
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
      return json(r, pendingPermissions)
    })
    await page.route(`${base}/question**`, (r) => json(r, pendingQuestions))
    await contractRoute(page, `${base}/api/wr/health**`, (r) => json(r, readyRuntimeHealthResponse(cloudHarness)))
    // Worktree admission on the cloud draft-submit path
    // (prepareWorkspaceSessionWorktree, src/platform/runtime/cloud/workspace-runtime-store.ts):
    // submit-directory.ts POSTs /api/wr/worktrees after the draft workspace resolves
    // and ABORTS the submit without sending the prompt when the admission fails or
    // returns an invalid record — so this lane must answer with a well-formed
    // worktree (path + branch + baseCommit).
    await contractRoute(page, `${base}/api/wr/worktrees**`, (r) => {
      if (r.request().method() !== "POST") return json(r, emptyWorktreeListResponse())
      const parsed = parseWorktreeCreateBody(r.request().postDataJSON?.() ?? null)
      if (!parsed.ok) return json(r, parsed.body, parsed.status)
      return json(
        r,
        activeWorktreeResponse({
          workspaceId,
          sessionId: parsed.value.sessionId,
          path: workspaceId,
          baseCommit: parsed.value.baseCommit,
        }),
        WORKTREE_CREATE_SUCCESS_STATUS,
      )
    })
    await contractRoute(page, `${base}/api/wr/harness-config-options**`, (r) => {
      const url = new URL(r.request().url())
      const type = harnessFixtureFromUrl(url, cloudHarness)
      requests.cloudHarnessOptionsCount += 1
      requests.cloudHarnessOptionsHarnesses.push(type)
      const model = harnessModels[type]?.[0] ?? BIG_PICKLE
      return json(r, runtimeHarnessOptionsResponse(harnessConfigOptions(type, model)))
    })
    await contractRoute(page, `${base}/api/wr/diff/**`, runtimeDiffHandler)

    // `wr/events` behind the workspace's relay connection.
    await contractRoute(page, `${base}/api/wr/events**`, workspaceStreamHandler(busRelayEvents))

    // Same live-map contract as the local lane (`./contracts/session-status.ts`) and the
    // same `liveSessionStatuses` state, so `handles.setSessionStatus` drives whichever
    // lane a spec models.
    await contractRoute(page, `${base}/session/status**`, (r) =>
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
        // The app names the session's harness the way the real route reads it
        // (`?nativeHarness=<id>` or `?connectionId=<id>`), never by fixture key.
        cloudHarness = harnessFixtureFromUrl(url, cloudHarness)
        // The signed lane reserves its session id first and hands it over here;
        // the real route creates the session UNDER that id (see `cloudSessionId`).
        cloudSessionId = typeof body.id === "string" ? body.id : CLOUD_SESSION_ID
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

    await contractRoute(page, `${base}/session/*/config**`, async (route) => {
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

    // CONTRACT (workspace-runtime `session-core.ts` `GET /session/:id/config-options`):
    // the session's harness answers with the same options list the draft route serves.
    // Registered after `${base}/session/*/config**`, whose trailing `**` also matches
    // this path: Playwright tries the most recently registered route first.
    await contractRoute(page, `${base}/session/*/config-options**`, (r) => {
      if (!api(r)) return r.continue()
      const type = harnessFixtureFromUrl(r.request().url(), cloudHarness)
      requests.cloudHarnessOptionsCount += 1
      requests.cloudHarnessOptionsHarnesses.push(type)
      const model = harnessModels[type]?.[0] ?? BIG_PICKLE
      return json(r, runtimeHarnessOptionsResponse(harnessConfigOptions(type, model)))
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
        configOptions: cloudHarness !== "opencode",
        prompt: cloud.sessionPrompt ?? true,
      }),
    )
    await page.route(`${base}/session/*/todo**`, (r) => json(r, sessionTodos))
    await page.route(`${base}/session/*/message**`, (r) =>
      json(r, { messages: cloudMessages, maxEventOrdinal: 0 }),
    )
    await contractRoute(page, `${base}/session/*/prompt_async**`, async (route) => {
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
    // prefix itself. A blanket `[]` for everything under `/file` and `/find` is the
    // right shape only for `/find/file` and `/file` — `/file/content` answers
    // `{type, content}` and `/file/all` answers `{paths}`.
    await page.route(`${base}/file**`, fileBrowserHandler)
    await page.route(`${base}/find**`, fileBrowserHandler)

    // Bare (un-prefixed) relay routes, for callers that mount `cloud` without
    // exercising the full session lane above (e.g. specs asserting only on
    // `/api/wr/events` delivery to a workspace-scoped pane).
    await contractRoute(page, `${relayOrigin}/api/wr/health`, (r) => json(r, readyRuntimeHealthResponse(harness)))
    await contractRoute(page, `${relayOrigin}/api/wr/harness-config-options`, (r) => {
      const model = harnessModel()
      return json(r, runtimeHarnessOptionsResponse(harnessConfigOptions(harness, model)))
    })
    await contractRoute(page, `${relayOrigin}/api/wr/diff/**`, runtimeDiffHandler)
    await contractRoute(page, `${relayOrigin}/api/wr/events**`, workspaceStreamHandler(busRelayEvents))
  }

  return {
    requests,
    emit,
    emitNotice,
    emitRuntime,
    clearPendingQuestion: requestID => {
      pendingQuestions = pendingQuestions.filter(question => question.id !== requestID)
    },
    releaseAbort: () => releaseAbort(),
    setRunningTurn: (turnId: string | undefined) => { runningTurn = turnId },
    setSessionStatus,

    session: { id: SESSION_ID, dir: DIR, projectId: PROJECT_ID, workspaceId: LOCAL_WORKSPACE_ID },
  }
}
