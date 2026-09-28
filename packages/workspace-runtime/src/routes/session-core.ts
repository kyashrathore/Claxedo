import type { AgentGoalMutationResult, AgentPermissionMode, AgentPermissionModeState, AutoLevel, SessionConfig } from "@claxedo/agent-runtime-contract"
import { randomUUID } from "node:crypto"
import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { toolImageResponse } from "./tool-image"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { AgentMessage, AgentPermission, AgentQuestion, AgentSession, RuntimeDirectory, HarnessCapabilities } from "@claxedo/agent-sdk-runtime"
import type { AgentSessionStartBinding, AgentSessionStarts, SessionHarness } from "@claxedo/agent-runtime-contract"
import {
  connectionIdForHarness,
  parseRecoveryRequest,
  RecoveryContractError,
  sameSessionHarness,
  serializeRecoveryOutcome,
  type RecoveryOutcome,
  type RecoveryRefusal,
  type RecoveryTurnTarget,
  type RecoveryRequest,
} from "@claxedo/agent-runtime-contract"
import { elicitationError } from "./elicitation-error"
import type { AgentMessageReadInput, AgentMessagePage, AgentMessagePageInput, AgentTurnCoveragePage } from "@claxedo/agent-sdk-runtime/message-page"
import { AgentMessagePageError } from "@claxedo/agent-sdk-runtime/message-page"
import { isAgentHarnessEngineError, type TurnActor, type TurnOrigin } from "@claxedo/harness/contract"
import {
  admitSessionInstructions,
  IMMUTABLE_SESSION_CONFIG_FIELDS,
  type ImmutableSessionConfigField,
} from "@claxedo/agent-sdk-runtime"
import {
  AGENT_RUNTIME_TURN_CONFLICT_CODE,
  isAgentRuntimeGoalError,
  isAgentRuntimeRequestRefusedError,
  isAgentRuntimeTurnAdmissionError as isAgentRuntimeTurnConflictError,
  type AgentRuntime,
  type AgentRuntimeRecovery,
  type HarnessTarget,
  type RecoveryCaller,
} from "../host/runtime"
import { PreviewModelInvalidError } from "../host/config-ops"
import {
  messageUpdated,
  sessionError,
  sessionUpdated,
  sessionDeleted,
  withDir,
  type CompatEnvelope,
} from "../compat-events"
import {
  compatScope,
  runRuntimePromptTurn,
  sessionPromptReply,
  type ActiveTurnScope,
  parseSessionPromptBody,
  type SessionPromptBody,
  type SessionPromptTurnResult,
} from "../session/service"
import {
  normalizeSessionConfigUpdate,
  normalizeSessionCreateConfig,
  normalizeSessionCreateBody,
  sessionCreateGroup,
} from "../session-config"
import { MAX_ACTIVE_CHILDREN_PER_PARENT, type ChildSessionHost } from "./session-children"
import type { SessionDeliveryOwner, QueuedPromptAction, QueuedPromptRequester } from "../session/delivery-owner"
import { narrowerPermissionLevel, permissionCeilingAdmits, permissionModeLevel, widestPermissionModeUnder } from "@claxedo/agent-sdk-runtime"
import { arr, num, rec, str } from "../json-value"
import { disposeRuntimeSessionDocuments, flushRuntimeSessionDocuments } from "./document-hydration"
import { errorBody } from "./error-body"
import { providerCatalogRefusal } from "./workspace-role"
import { boundedJsonBody, boundedJsonRecord, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import { routeParam } from "@claxedo/helpers/route-param"
import {
  sessionAccessContext,
  sessionAccessDenied,
  sessionRequestProvenance,
  sessionTurnOrigin,
  type SessionTurnOrigin,
  type SessionAccessDecision,
  type SessionAccessOperation,
  type SessionAccessPolicy,
  type SessionTurnGrantDecision,
} from "../session-access-policy"
import {
  acquireSessionTurnLease,
  type ActiveSessionTurnLease,
} from "./session-turn-lease"
import { SessionRollbackError } from "../session-rollback-error"
import { WorkspaceHarnessUnavailableError } from "../harness-unavailable-error"
import { asRecord } from "@claxedo/helpers/guards"
import { errorMessage as thrownMessage } from "@claxedo/helpers"


/**
 * A headline for a turn/stream failure that keeps the cause: the real message
 * is what `sessionError` → `firstTurnErrorData` classifies (unmatched →
 * "unknown") and what the client's raw-detail disclosure shows.
 */
export function streamTurnErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Stream error"
}

export type SessionLifecycleEvent = {
  type: "session.lifecycle"
  phase: "creating" | "created" | "failed"
  start?: AgentSessionStartBinding
  directory?: string
  sessionID?: string
  workspaceId?: string
  draftId?: string
  /** The creator, when the runtime knows one: a frame with no session yet is theirs alone. */
  actorId?: string
  info?: unknown
  message?: string
  ts: number
}

type MessageSnapshot = {
  messages: AgentMessage[]
  maxEventOrdinal?: number
  fencingToken?: number
}

/**
 * The request context every route hook receives. Exported so the thin
 * `SessionRoutes` wrapper declares the SAME context its own hosts are handed,
 * instead of a second `unknown` that every host then has to cast back.
 */
export type SessionRouteContext = Context

type Ctx = SessionRouteContext

async function readSession(
  opts: Opts,
  c: Ctx,
  directory: RuntimeDirectory,
  sessionId: string,
) {
  if (opts.getSession) return await opts.getSession(c, directory, sessionId) ?? undefined
  return await (await opts.runtime(c)).sessions.get(sessionId, directory) ?? undefined
}

/** Whose accounts a session created by this request spends: the verified actor, or the machine's own user. */
export function sessionOwner(c: Ctx): TurnActor {
  const actor = sessionAccessContext(c).actor
  return actor ? { kind: "person", userId: actor.actorId } : { kind: "machine-owner" }
}

function turnOriginOf(origin: SessionTurnOrigin | undefined, owner: TurnActor): TurnOrigin {
  if (origin?.provenance === "relay-replayed") return { actor: { kind: "person", userId: origin.actor.actorId }, via: "relay", reissued: false }
  return { actor: owner, via: "loopback", reissued: false }
}

async function sessionConfigOf(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string): Promise<SessionConfig> {
  if (opts.getSessionConfig) return await opts.getSessionConfig(c, directory, sessionId)
  return await (await opts.runtime(c)).reads.sessionConfig(sessionId, directory)
}

type DraftTarget = Extract<HarnessTarget, { harness: SessionHarness }>

function draftTarget(opts: Opts, c: Ctx, directory: RuntimeDirectory): DraftTarget {
  return { harness: opts.requestedSessionHarness(c) ?? opts.defaultHarness(), directory: directory ?? "", owner: sessionOwner(c) }
}

/**
 * The restriction a parent hands down: `ask` when its harness has a mode
 * surface but reports no current mode, and nothing at all when the harness has
 * no mode surface. A harness with no surface enforces no restriction on the
 * parent either, so reading it as the floor would invent a ceiling the parent
 * never ran under and refuse every child on that harness.
 */
function inheritedPermissionLevel(state: AgentPermissionModeState | undefined): AutoLevel | undefined {
  if (!state || state.unsupported) return undefined
  return permissionModeLevel(state.modes.find((mode) => mode.id === state.currentModeId))
}

/**
 * The level a new session may not exceed: the narrower of the restriction the
 * parent hands down and the ceiling the caller declared.
 */
async function effectivePermissionCeiling(
  opts: Opts,
  c: Ctx,
  directory: RuntimeDirectory,
  parent: AgentSession | undefined,
  declared: AutoLevel | undefined,
): Promise<AutoLevel | undefined> {
  if (!parent) return declared
  const state = await (await opts.runtime(c)).reads.permissionModes({ sessionId: parent.id, ...(directory ? { directory } : {}) })
  const parentLevel = inheritedPermissionLevel(state)
  if (!parentLevel) return declared
  return declared ? narrowerPermissionLevel(parentLevel, declared) : parentLevel
}

/** Resolve the persisted ceiling and the current parent restriction for mutations. */
async function sessionPermissionCeiling(opts: Opts, c: Ctx, directory: RuntimeDirectory, session: AgentSession) {
  const config = await sessionConfigOf(opts, c, directory, session.id)
  const parent = session.parentID ? await readSession(opts, c, directory, session.parentID) : undefined
  if (session.parentID && !parent) throw new HTTPException(403, { message: "Parent session not found" })
  return effectivePermissionCeiling(opts, c, directory, parent ?? undefined, config.permissionCeiling)
}

async function rejectPermissionOverride(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string, modeId: string | undefined) {
  if (!modeId) return undefined
  const session = await readSession(opts, c, directory, sessionId)
  if (!session) return c.json(errorBody("session_not_found", "Session not found"), 404)
  const ceiling = await sessionPermissionCeiling(opts, c, directory, session)
  if (!ceiling) return undefined
  return (await permissionModeUnderCeiling(c, await opts.runtime(c), { sessionId, ...(directory ? { directory } : {}) }, ceiling, modeId)).refusal
}

/**
 * The mode the new session starts in. A requested mode that widens the
 * ceiling is refused; with none requested the widest mode under the ceiling is
 * chosen, so a child never inherits a harness default above its parent.
 */
async function permissionModeUnderCeiling(
  c: Ctx,
  runtime: AgentRuntime,
  target: HarnessTarget,
  ceiling: AutoLevel | undefined,
  requested: string | undefined,
): Promise<{ mode?: AgentPermissionMode; refusal?: Response }> {
  if (!requested && !ceiling) return {}
  const state = await runtime.reads.permissionModes(target)
  if (!state || state.unsupported) {
    if (ceiling) return { refusal: c.json(errorBody("permission_ceiling_unsupported", `This harness cannot enforce the ${ceiling} permission ceiling`), 403) }
    return { refusal: c.json(errorBody("permission_mode_unsupported", "This harness cannot be told about permission modes"), 400) }
  }
  const modes = state.modes
  if (requested) {
    const mode = modes.find((candidate) => candidate.id === requested)
    if (!mode) return { refusal: c.json(errorBody("unknown_permission_mode", `Unknown permission mode "${requested}"`), 400) }
    const level = permissionModeLevel(mode)
    if (ceiling && !permissionCeilingAdmits(ceiling, level)) {
      return {
        refusal: c.json({
          error: {
            code: "permission_ceiling_exceeded",
            message: `Permission mode "${mode.id}" (${level}) widens the ${ceiling} ceiling`,
            ceiling,
            requested: { modeId: mode.id, level },
          },
        }, 403),
      }
    }
    return { mode }
  }
  const mode = widestPermissionModeUnder(modes, ceiling!)
  return mode ? { mode } : {
    refusal: c.json(errorBody("permission_ceiling_unsupported", `This harness offers no permission mode within the ${ceiling} ceiling`), 403),
  }
}

/**
 * A child session lives under its parent: archiving the parent cancels and
 * archives every host-owned child, deleting it deletes them. Children may run
 * on a different harness than the parent, so each is reached through its own
 * adapter rather than the parent's.
 */
async function cascadeToChildren(
  opts: Opts,
  c: Ctx,
  directory: RuntimeDirectory,
  parentSessionId: string,
  action: "archive" | "delete",
  updates: { archived?: number } = {},
  withSessionChange?: <T>(sessionId: string, change: () => Promise<T>) => Promise<T>,
) {
  if (!opts.childSessions) return
  for (const child of await opts.childSessions.children(parentSessionId, directory)) {
    const childSessionId = child.childSessionId
    if (action === "delete") {
      if (!withSessionChange) throw new Error("Deleting a child requires its session lifecycle claim")
      await withSessionChange(childSessionId, async () => {
        if (!await readSession(opts, c, directory, childSessionId)) return
        const start = opts.sessionStarts?.get(childSessionId)?.binding
        await opts.beforeDeleteSession?.(c, directory, childSessionId)
        await disposeRuntimeSessionDocuments(childSessionId)
        await (await opts.runtime(c)).sessions.delete(childSessionId, directory)
        await after(opts.afterDeleteSession?.(c, directory, childSessionId))
        if (start) opts.sessionStarts!.retire(start)
        opts.publishGlobal(withDir(compatScope(directory, childSessionId), sessionDeleted(childSessionId, directory ?? "", parentSessionId)))
      })
      continue
    }
    if (!await readSession(opts, c, directory, childSessionId)) continue
    // Archiving a child stops the turn it is running. The runtime keeps the
    // operation whatever it reaches, so a cancellation that does not land is
    // visible through the child's own recovery inspection rather than lost.
    const childOwner = opts.resolveRecoveryOwner?.(c, { sessionId: childSessionId })
    if (childOwner) {
      await cancelAdmittedTurn(childOwner, childSessionId, recoveryCaller(c), `archive-child:${childSessionId}:${randomUUID()}`)
    }
    const body = { time: { archived: updates.archived ?? Date.now() } }
    const session = await (await opts.runtime(c)).sessions.update(childSessionId, body, directory)
    await after(opts.afterUpdateSession?.(c, directory, session, body))
    opts.publishGlobal(withDir(compatScope(directory, childSessionId), sessionUpdated(session)))
  }
}

function createdSessionBody(session: unknown, created: Record<string, unknown>) {
  return { ...rec(session), ...created }
}

async function settleChildTurn(opts: Opts, sessionId: string, directory: RuntimeDirectory) {
  try {
    await opts.childSessions?.onTurnSettled(sessionId, directory)
  } catch (error) {
    console.error(`child session bookkeeping for ${sessionId} failed`, error)
  }
}

function noStoreJson(c: Ctx, data: unknown, status?: ContentfulStatusCode) {
  return c.json(data, status, {
    "Cache-Control": "no-store",
  })
}

const MAX_MESSAGE_PAGE_LIMIT = 500

function messageReadInput(c: Ctx): AgentMessageReadInput | undefined {
  const view = c.req.query("view")
  const limit = c.req.query("limit")
  const before = c.req.query("before")
  const turn = c.req.query("turn")
  const coverage = c.req.query("coverage")
  if (turn !== undefined || coverage !== undefined) {
    if (view !== undefined || limit !== undefined || before !== undefined) {
      throw new HTTPException(400, { message: "turn coverage cannot be combined with view, limit or before" })
    }
    if (coverage !== "1") throw new HTTPException(400, { message: "turn requires coverage=1" })
    if (turn === undefined || turn.length === 0) {
      throw new HTTPException(400, { message: "coverage=1 requires a non-empty turn" })
    }
    return { turnId: turn }
  }
  if (view === undefined && limit === undefined && before === undefined) return undefined
  if (view !== undefined) {
    if ((view !== "latest-turn" && view !== "latest-surface") || limit !== undefined || before !== undefined) {
      throw new HTTPException(400, { message: "view must be latest-turn or latest-surface and cannot be combined with limit or before" })
    }
    return { view }
  }
  if (limit === undefined || !/^[1-9]\d*$/.test(limit)) {
    throw new HTTPException(400, { message: `limit must be an integer between 1 and ${MAX_MESSAGE_PAGE_LIMIT}` })
  }
  const parsedLimit = Number(limit)
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit > MAX_MESSAGE_PAGE_LIMIT) {
    throw new HTTPException(400, { message: `limit must be an integer between 1 and ${MAX_MESSAGE_PAGE_LIMIT}` })
  }
  if (before !== undefined && before.length === 0) {
    throw new HTTPException(400, { message: "before must be a non-empty cursor" })
  }
  return {
    limit: parsedLimit,
    ...(before !== undefined ? { before } : {}),
  }
}

function messagePageResponse(c: Ctx, page: AgentMessagePage) {
  const exposed: string[] = []
  if (page.nextCursor !== undefined) {
    exposed.push("X-Next-Cursor")
    c.header("X-Next-Cursor", page.nextCursor)
  }
  if (page.maxEventOrdinal !== undefined) {
    exposed.push("X-Max-Event-Ordinal")
    c.header("X-Max-Event-Ordinal", String(page.maxEventOrdinal))
  }
  if (exposed.length) c.header("Access-Control-Expose-Headers", exposed.join(", "))
  return noStoreJson(c, page.messages)
}

/**
 * Every status Hono will accept on a body-carrying response: its `StatusCode`
 * union minus the content-less 101/204/205/304.
 *
 * A status that reaches these routes is a plain `number` — read off a delegate's
 * `Response` or off a thrown `AgentMessagePageError` — while `ContentfulStatusCode`
 * is a literal union; recognising the number against this list produces one
 * without a cast.
 */
const CONTENTFUL_STATUS_CODES: readonly ContentfulStatusCode[] = [
  100, 102, 103,
  200, 201, 202, 203, 206, 207, 208, 226,
  300, 301, 302, 303, 305, 306, 307, 308,
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415,
  416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
  500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511,
]

function contentfulStatus(status: number): ContentfulStatusCode | undefined {
  return CONTENTFUL_STATUS_CODES.find((code) => code === status)
}

function throwMessagePageError(error: unknown, fallbackStatus: 500 | 502): never {
  if (!(error instanceof AgentMessagePageError)) throw error
  const status = error.status >= 400 ? contentfulStatus(error.status) ?? fallbackStatus : fallbackStatus
  throw new HTTPException(status, { message: error.message, cause: error })
}

type Opts = {
  sessionStarts?: AgentSessionStarts
  /** The one runtime host of this workspace, built on first use. */
  runtime: (c: Ctx) => Promise<AgentRuntime>
  /** The harness a draft read runs on when the request names none. */
  defaultHarness: () => SessionHarness
  /**
   * The runtime that already owns this session, or nothing. Recovery resolves
   * no harness and awaits nothing: `runtime` builds the host when there is
   * none, which starts the very compute a caller is trying to contain, and it
   * refuses outright once the workspace is closing — which is when recovery
   * most has to answer.
   */
  resolveRecoveryOwner?: (c: Ctx, input: { sessionId: string }) => AgentRuntimeRecovery | undefined
  // Upper bound on how long POST /prompt_async waits for the turn's admission
  // decision before falling back to its fire-and-forget 204 ack. Guards against a
  // wedged turns.start (adapter spawn that never settles admission and never
  // throws) hanging the HTTP request indefinitely. Default 5000ms.
  promptAsyncAdmissionAckTimeoutMs?: number
  resolveDirectory: (
    c: Ctx,
    input?: {
      sessionId?: string
    },
  ) => Promise<RuntimeDirectory> | RuntimeDirectory
  listSessions?: (c: Ctx, directory: RuntimeDirectory) => Promise<AgentSession[]>
  listSubagents?: (c: Ctx, directory: RuntimeDirectory, parentSessionId: string) => Promise<unknown[]> | unknown[]
  /** Host-owned child sessions: admission on the parent, idempotent ids, completion wakes. */
  childSessions?: ChildSessionHost
  /** Where a prompt admitted behind a running turn is persisted while it waits. */
  queuedPrompts?: SessionDeliveryOwner
  /**
   * A status payload, or a `Response` the route forwards verbatim. Awaited by
   * the route, so an async implementation is fine.
   */
  getStatus?: (c: Ctx, directory: RuntimeDirectory) => unknown
  afterListSessions?: (c: Ctx, directory: RuntimeDirectory, sessions: AgentSession[]) => Promise<void> | void
  afterCreateSession?: (c: Ctx, directory: RuntimeDirectory, session: unknown) => Promise<void> | void
  getSession?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<AgentSession | null> | AgentSession | null
  afterGetSession?: (c: Ctx, directory: RuntimeDirectory, session: unknown) => Promise<void> | void
  getSessionConfig?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<SessionConfig>
  requestedSessionHarness: (c: Ctx) => SessionConfig["harness"] | undefined
  getTodos?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<unknown[] | undefined> | unknown[] | undefined
  getMessages?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<AgentMessage[] | undefined> | AgentMessage[] | undefined
  getMessagePage?: (
    c: Ctx,
    directory: RuntimeDirectory,
    sessionId: string,
    page: AgentMessagePageInput,
  ) => Promise<AgentMessagePage | undefined> | AgentMessagePage | undefined
  /**
   * The turn journal this route answers coverage from. No adapter is offered
   * one: an engine that does not hold the journal cannot establish coverage,
   * and a producer that cannot establish it must not be asked to guess.
   */
  turnCoverage?: (
    c: Ctx,
    directory: RuntimeDirectory,
    sessionId: string,
    turnId: string,
  ) => Promise<AgentTurnCoveragePage | undefined> | AgentTurnCoveragePage | undefined
  getMessageSnapshot?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<MessageSnapshot | undefined> | MessageSnapshot | undefined
  afterUpdateSession?: (
    c: Ctx,
    directory: RuntimeDirectory,
    session: AgentSession,
    updates: { title?: string; time?: { archived?: number } },
  ) => Promise<void> | void
  beforeDeleteSession?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<void> | void
  afterDeleteSession?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<void> | void
  afterMessageCheckpoint?: (c: Ctx, directory: RuntimeDirectory, sessionId: string, messages: AgentMessage[]) => Promise<void> | void
  flushSessionDocuments?: (sessionId: string) => Promise<void>
  exposeCommandRoute?: boolean
  publishGlobal: (event: CompatEnvelope) => void
  publishSessionLifecycle?: (event: SessionLifecycleEvent) => void
  resolveWorkspaceId?: (c: Ctx, directory: RuntimeDirectory) => Promise<string | undefined> | string | undefined
  beforeSessionOperation?: (
    c: Ctx,
    input: {
      sessionId: string
      operation: string
    },
  ) => Promise<Response | void> | Response | void
  sessionAccessPolicy?: SessionAccessPolicy
  createActiveTurnScope?: (input: {
    c: Ctx
    directory: RuntimeDirectory
    sessionId: string
  }) => ActiveTurnScope | undefined
  transformPromptBody?: (
    c: Ctx,
    input: { sessionId: string; directory: RuntimeDirectory; body: SessionPromptBody },
  ) => Promise<SessionPromptBody> | SessionPromptBody
}

const DRAFT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function parseDraftId(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw !== "string") return undefined
  if (raw.length === 0) return undefined
  if (!DRAFT_ID_PATTERN.test(raw)) {
    throw new HTTPException(400, {
      message: "x-claxedo-draft-id must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}",
    })
  }
  return raw
}

/** The `string[][]` a question reply must carry, or `undefined` when it does not. */
function questionAnswers(input: unknown): string[][] | undefined {
  const rows = arr(input)
  if (!rows) return undefined
  const answers: string[][] = []
  for (const row of rows) {
    const values = arr(row)
    if (!values?.every((value) => str(value) !== undefined)) return undefined
    answers.push(values.filter((value): value is string => str(value) !== undefined))
  }
  return answers
}

function sessionNotFound() {
  return errorBody("session_not_found", "Session not found")
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Session creation failed"
}

/**
 * Hono's default turns a thrown error into a bare "Internal Server Error",
 * which the client cannot tell from its own bug. An engine refusal is an
 * upstream failure: 502, carrying the call and the workspace the adapter
 * recorded when the engine's client gave it nothing else.
 */
function engineRefusalResponse(c: Ctx, error: unknown) {
  if (!isAgentHarnessEngineError(error)) throw error
  return c.json(errorBody(error.code, error.message), 502)
}

function goalRuntimeErrorResponse(c: Ctx, error: unknown) {
  if (!isAgentRuntimeGoalError(error)) throw error
  const status = error.code === "goal_invalid_objective"
    ? 400
    : error.code === "goal_session_not_found"
    ? 404
    : 409
  return noStoreJson(c, errorBody(error.code, error.message), status)
}

function goalMutationResponse(
  c: Ctx,
  result: AgentGoalMutationResult,
  successStatus: 200 | 201 = 200,
) {
  if (result.ok) return noStoreJson(c, result, successStatus)
  const status = result.status === "not_found"
    ? 404
    : result.status === "failed"
    ? 502
    : 409
  return noStoreJson(c, result, status)
}

async function resolveGoalRuntime(opts: Opts, c: Ctx) {
  return await opts.runtime(c)
}

/**
 * The scaffold every `/session/:id/goal*` route shares: admit the operation,
 * resolve the session's directory, resolve its Goal runtime, and translate a
 * thrown `AgentRuntimeGoalError` into its typed HTTP response.
 *
 * Each endpoint supplies only the runtime call that makes it different, so a
 * new admission or error rule lands on every Goal endpoint at once instead of
 * being copied into each handler.
 */
function goalRoute(
  opts: Opts,
  operation: SessionAccessOperation,
  invoke: (input: {
    c: Ctx
    sessionId: string
    directory: RuntimeDirectory
    runtime: AgentRuntime
  }) => Promise<Response> | Response,
) {
  return async (c: Ctx): Promise<Response> => {
    const sessionId = routeParam(c, "id")
    const guarded = await sessionOperationGuard(opts, c, sessionId, operation)
    if (guarded) return guarded
    const directory = await opts.resolveDirectory(c, { sessionId })
    const runtime = await resolveGoalRuntime(opts, c)
    try {
      return await invoke({ c, sessionId, directory, runtime })
    } catch (error) {
      return goalRuntimeErrorResponse(c, error)
    }
  }
}

/**
 * A runtime with no default harness, or a connection it cannot run, is a
 * configuration state and not a fault. Left to escape it is a 500, which
 * every caller reads as "the runtime broke" and the MCP tools show as a bare
 * `http_500`.
 */
function harnessUnavailableResponse(c: Ctx, error: unknown) {
  if (!(error instanceof WorkspaceHarnessUnavailableError)) return undefined
  return c.json(errorBody(error.code, error.message), 409)
}

const rootsOnly = (c: Ctx) => c.req.query("roots") === "true" || c.req.query("roots") === "1"

function normalizeSession(s: unknown, fallbackDirectory?: RuntimeDirectory): unknown {
  const r = rec(s)
  if (!r) return s
  if (r.time) return r
  const ts = Date.now()
  return {
    id: r.id,
    title: r.title ?? null,
    slug: r.id,
    version: "local",
    directory: r.directory ?? fallbackDirectory ?? "",
    ...(typeof r.parentID === "string" ? { parentID: r.parentID } : {}),
    ...(typeof r.rootID === "string" ? { rootID: r.rootID } : {}),
    ...(typeof r.projectID === "string" ? { projectID: r.projectID } : {}),
    ...(Array.isArray(r.tags) ? { tags: r.tags } : {}),
    ...(Array.isArray(r.attachments) ? { attachments: r.attachments } : {}),
    ...(typeof r.status === "string" || r.status === null ? { status: r.status } : {}),
    ...(r.lastTurn ? { lastTurn: r.lastTurn } : {}),
    time: { created: ts, updated: ts },
  }
}

function summarizeSession(s: unknown): unknown {
  const row = normalizeSession(s)
  const item = rec(row)
  if (!item) return row
  return {
    id: item.id,
    title: item.title ?? null,
    time: item.time ?? {
      created: Date.now(),
      updated: Date.now(),
    },
    directory: item.directory ?? "",
    ...(typeof item.parentID === "string" ? { parentID: item.parentID } : {}),
    ...(typeof item.rootID === "string" ? { rootID: item.rootID } : {}),
    ...(typeof item.projectID === "string" ? { projectID: item.projectID } : {}),
    ...(Array.isArray(item.tags) ? { tags: item.tags } : {}),
    ...(Array.isArray(item.attachments) ? { attachments: item.attachments } : {}),
    ...(typeof item.status === "string" || item.status === null ? { status: item.status } : {}),
    ...(item.lastTurn ? { lastTurn: item.lastTurn } : {}),
  }
}

function sessionLifecycleInfo(input: {
  session: { id: string }
  directory?: string
  title?: string
  workspaceId?: string
}) {
  const row = input.session as Record<string, unknown>
  const time = asRecord(row.time)
  const created = typeof time?.created === "number"
    ? time.created
    : Date.now()
  const archived = typeof time?.archived === "number" ? time.archived : undefined
  return {
    id: input.session.id,
    slug: typeof row.slug === "string" ? row.slug : input.session.id,
    projectID: typeof row.projectID === "string" ? row.projectID : input.workspaceId ?? "global",
    ...(input.workspaceId ? { workspaceID: input.workspaceId } : {}),
    ...(typeof row.directory === "string" ? { directory: row.directory } : input.directory ? { directory: input.directory } : {}),
    title: typeof row.title === "string" ? row.title : input.title ?? "",
    version: typeof row.version === "string" ? row.version : "local",
    ...(typeof row.parentID === "string" ? { parentID: row.parentID } : {}),
    time: {
      created,
      updated: typeof time?.updated === "number"
        ? time.updated
        : created,
      ...(archived !== undefined ? { archived } : {}),
    },
  }
}

async function after(input: void | Promise<void> | undefined) {
  try {
    await input
  } catch {}
}

async function flushDocumentsAfterTurn(opts: Opts, sessionId: string) {
  try {
    await (opts.flushSessionDocuments ?? flushRuntimeSessionDocuments)(sessionId)
  } catch (error) {
    console.error(`[runtime-document] end-of-turn write-back failed for ${sessionId}:`, error)
  }
}

type CapabilityKey = {
  [K in keyof HarnessCapabilities]: HarnessCapabilities[K] extends boolean ? K : never
}[keyof HarnessCapabilities] & string

function unsupportedOperation(
  c: Ctx,
  caps: HarnessCapabilities,
  operation: string,
  details?: {
    capability?: string
    harness?: string
    reason?: string
    message?: string
  },
) {
  return c.json({
    ok: false,
    error: {
      code: "unsupported_operation",
      operation,
      capability: details?.capability ?? operation,
      harness: details?.harness ?? caps.harness,
      transport: caps.harness,
      reason: details?.reason ?? "capability_disabled",
      message: details?.message ?? `${caps.harness} does not support ${operation}`,
    },
  }, 409)
}

function notImplemented(c: Ctx, operation: "revert" | "unrevert" | "shell" | "summarize" | "command") {
  return c.json({
    ok: false,
    error: {
      code: "unsupported_operation",
      operation,
      reason: "not_implemented",
      message: `${operation} is not implemented`,
    },
  }, 501)
}

/** How each fixed-at-create field answers a PATCH that names it. */
const IMMUTABLE_CONFIG_REFUSALS = {
  instructions: {
    code: "session_instructions_immutable",
    message: "A session's instructions are fixed at create and cannot be changed",
  },
  group: {
    code: "session_group_immutable",
    message: "A session's model group is fixed at create and cannot be changed",
  },
} as const satisfies Record<ImmutableSessionConfigField, { code: string; message: string }>

/** A request answer the broker refused, in the refusal's own words and status. */
function requestRefusedResponse(c: Ctx, error: unknown) {
  if (!isAgentRuntimeRequestRefusedError(error)) throw error
  const status = error.refusal === "stale" ? 404 : error.refusal === "persistence" ? 503 : 409
  return c.json(errorBody(`request_${error.refusal}`, error.message, { retryable: error.retryable }), status)
}

function turnAdmissionConflict(c: Ctx) {
  return c.json({
    ok: false,
    error: {
      code: AGENT_RUNTIME_TURN_CONFLICT_CODE,
      message: "Session is already processing a turn",
    },
  }, 409)
}

/**
 * Whether THIS request's session lifecycle is the private one: a reservation
 * before the create, a registered creator, and a durable turn lease.
 *
 * A managed-private policy is the composition's half of the answer and the
 * request's provenance is the other. One desktop daemon serves both: the
 * machine's own user reaches it loopback-direct and creates sessions with no
 * control-plane round trip, while the same runtime answers a relay-replayed
 * member only through the authority that knows who created what.
 */
function managedSessionLifecycle(opts: Opts, c: Ctx) {
  return opts.sessionAccessPolicy?.sessionAuthority === "managed-private"
    && sessionRequestProvenance(c) === "relay-replayed"
}

async function acquireManagedPromptLease(input: {
  opts: Opts
  c: Ctx
  sessionId: string
  turnId?: string
  onLost: () => Promise<RecoveryOutcome> | RecoveryOutcome
}): Promise<{ lease?: ActiveSessionTurnLease; rejected?: Response }> {
  if (!managedSessionLifecycle(input.opts, input.c)) return {}
  if (!input.turnId) {
    return {
      rejected: Response.json(errorBody(
        "session_turn_id_required",
        "Managed prompts require a stable messageID before runtime mutation",
      ), { status: 400 }),
    }
  }
  const acquired = await acquireSessionTurnLease({
    policy: input.opts.sessionAccessPolicy!,
    access: {
      ...sessionAccessContext(input.c),
      operation: "prompt",
      sessionId: input.sessionId,
      method: input.c.req.method,
      path: input.c.req.path,
    },
    turnId: input.turnId,
    onLost: input.onLost,
  })
  if (!acquired.acquired) return { rejected: sessionAccessDenied(acquired.decision) }
  return { lease: acquired.lease }
}

function turnScope(base: ActiveTurnScope | undefined, lease: ActiveSessionTurnLease | undefined): ActiveTurnScope | undefined {
  if (!lease) return base
  return {
    signal: base?.signal ? AbortSignal.any([base.signal, lease.signal]) : lease.signal,
    ...(base?.dispose ? { dispose: base.dispose } : {}),
  }
}

/**
 * The admitted turn's recovery identity, filled the moment admission returns
 * it. The lease is taken before any turn exists, so its loss callback has
 * nothing to name until this is set.
 */
export function captureTurnTarget() {
  let target: RecoveryTurnTarget | undefined
  return {
    set: (next: RecoveryTurnTarget) => { target = next },
    get: () => target,
  }
}

/**
 * Contain the turn whose durable authority was just revoked, under the exact
 * identity admission handed back. A cancellation carrying only the session
 * would reach whatever is running when it arrives, which after a replacement
 * is somebody else's turn.
 */
export async function containLostTurn(input: {
  runtime: AgentRuntimeRecovery | undefined
  sessionId: string
  target: RecoveryTurnTarget | undefined
  caller: RecoveryCaller
}): Promise<RecoveryOutcome> {
  if (!input.runtime) {
    return refusedOutcome("unavailable", `No runtime owns session ${input.sessionId} to contain its lost turn`)
  }
  const target = input.target
  if (!target) {
    return refusedOutcome("generation_conflict", `Session ${input.sessionId} lost its turn authority before a turn was admitted`)
  }
  try {
    return await submitCancelTurn(input.runtime, target, input.caller, `session-turn-lease-loss:${target.turnId}:${target.ownerGeneration}`)
  } catch (error) {
    // A containment that never became an operation has no receipt to read it
    // back by, and this lease dies with the request. The owner is the only
    // thing that outlives both, so it is told before the caller is.
    const message = thrownMessage(error)
    input.runtime.reportContainmentFailure(target, input.caller, message)
    return refusedOutcome("unavailable", `Session ${input.sessionId} could not record its lost turn's cancellation: ${message}`)
  }
}

/** Cancel whichever turn the owner reports as admitted, or nothing when none is. */
async function cancelAdmittedTurn(
  runtime: AgentRuntimeRecovery,
  sessionId: string,
  caller: RecoveryCaller,
  requestId: string,
): Promise<RecoveryOutcome | undefined> {
  const target = runtime.inspect(sessionId).target
  return target ? await submitCancelTurn(runtime, target, caller, requestId) : undefined
}

function submitCancelTurn(
  runtime: AgentRuntimeRecovery,
  target: RecoveryTurnTarget,
  caller: RecoveryCaller,
  requestId: string,
): Promise<RecoveryOutcome> {
  return runtime.submit({
    requestId,
    action: "cancel_turn",
    target,
    scopeRevision: target.ownerGeneration,
    attempt: 1,
  }, caller)
}

function refusedOutcome(kind: "unavailable" | "generation_conflict", message: string): RecoveryOutcome {
  return { kind: "refused", refusal: { kind, message } }
}

/**
 * The revoked caller's answer, carrying what containment reached for the turn
 * it lost. That result is the lease's alone until this point: the caller is
 * the one owed it, and it names an operation the runtime's own inspection
 * then reports for as long as it stays unresolved.
 */
function lostTurnResponse(sessionId: string, lease?: ActiveSessionTurnLease) {
  const loss = lease?.lossResult()
  return Response.json(errorBody(
    "session_turn_lease_lost",
    `Session ${sessionId} turn authority was lost before completion`,
    loss ? { containment: loss } : undefined,
  ), { status: 409 })
}

function registrationOperationId(c: Ctx) {
  const value = c.req.header("x-claxedo-session-registration-operation")?.trim()
  return value || undefined
}

function registrationInput(c: Ctx, sessionId: string, operationId: string, title?: string) {
  return {
    ...sessionAccessContext(c),
    operation: "session_create" as const,
    sessionId,
    registrationOperationId: operationId,
    ...(title ? { sessionTitle: title } : {}),
    method: c.req.method,
    path: c.req.path,
  }
}

async function markRegistrationAmbiguous(
  opts: Opts,
  c: Ctx,
  sessionId: string,
  operationId: string,
  reason: string,
) {
  return await opts.sessionAccessPolicy?.markRegistrationAmbiguous?.({
    ...registrationInput(c, sessionId, operationId),
    reason,
  })
}

async function compensateRegistration(input: {
  opts: Opts
  c: Ctx
  directory: RuntimeDirectory
  sessionId: string
  operationId: string
  reason: string
}) {
  const policy = input.opts.sessionAccessPolicy
  if (!policy?.beginRegistrationCompensation || !policy.completeRegistrationCompensation) {
    throw new Error("Managed session compensation authority is unavailable")
  }
  const registration = registrationInput(input.c, input.sessionId, input.operationId)
  const begun = await policy.beginRegistrationCompensation({ ...registration, reason: input.reason })
  if (!begun.allowed) throw new Error(`Session compensation was denied: ${begun.code}`)
  try {
    await (await input.opts.runtime(input.c)).sessions.delete(input.sessionId, input.directory)
    await input.opts.afterDeleteSession?.(input.c, input.directory, input.sessionId)
  } catch (error) {
    throw new Error("Session compensation could not delete runtime state", { cause: error })
  }
  const completed = await policy.completeRegistrationCompensation({ ...registration, reason: input.reason })
  if (!completed.allowed) throw new Error(`Session compensation completion was denied: ${completed.code}`)
}

function unavailableRegistration(message: string): Exclude<SessionAccessDecision, { allowed: true }> {
  return { allowed: false, status: 503, code: "session_registration_unavailable", message }
}

function unsupportedLiveAgentListError(error: unknown) {
  if (!(error instanceof Error)) return false
  return error.message.includes("does not expose live agent options")
    || error.message.includes("did not return live agent options")
}

async function unsupportedIfUnavailable(
  c: Ctx,
  runtime: AgentRuntime,
  target: HarnessTarget,
  key: CapabilityKey,
  operation: string = key,
) {
  const caps = await runtime.reads.capabilities(target)
  if (!caps[key]) return unsupportedOperation(c, caps, operation, { capability: key })
  return undefined
}

async function sessionStartGuard(opts: Opts, c: Ctx, owner: AgentSessionStartBinding, operation: SessionAccessOperation, created = false) {
  const directory = await opts.resolveDirectory(c)
  if (owner.directory !== directory) return c.json(errorBody("session_start_not_found", "Session creation not found"), 404)
  if (created) return sessionOperationGuard(opts, c, owner.sessionId, operation)
  const context = sessionAccessContext(c)
  const policy = opts.sessionAccessPolicy
  const input = { ...context, operation, sessionId: owner.sessionId, registrationOperationId: owner.operationId, method: c.req.method, path: c.req.path }
  const decision = managedSessionLifecycle(opts, c)
    ? operation === "session_meta_read"
      ? await policy!.authorizeSessionStartStatus(input)
      : await policy!.authorizeSessionStart(input)
    : await policy?.authorize({ ...context, operation: "session_create", method: c.req.method, path: c.req.path })
  if (decision && !decision.allowed) return sessionAccessDenied(decision)
}

/**
 * The reservation a create claims, answered by the authority that owns the
 * session id before this runtime reads or writes anything under it.
 *
 * Permission to create a session in a workspace is not permission to touch one
 * that already exists in it. Only the operation that reserved the id may
 * create, retry or undo it, and the authority refuses an id held by someone
 * else without naming the session behind it — so a caller who guesses another
 * person's id learns nothing and changes nothing.
 */
async function creationReservationGuard(opts: Opts, c: Ctx, sessionId: string, operationId: string) {
  if (!managedSessionLifecycle(opts, c)) return undefined
  const decision = await opts.sessionAccessPolicy!.authorizeSessionStart({
    ...sessionAccessContext(c),
    operation: "session_create",
    sessionId,
    registrationOperationId: operationId,
    method: c.req.method,
    path: c.req.path,
  })
  return decision.allowed ? undefined : sessionAccessDenied(decision)
}

const RECOVERY_REFUSAL_STATUS: Readonly<Record<RecoveryRefusal["kind"], ContentfulStatusCode>> = {
  generation_conflict: 409,
  intent_conflict: 409,
  scope_changed: 409,
  receipt_expired: 410,
  unauthorized: 403,
  unavailable: 503,
  version_update_required: 426,
}

/** Every recovery path, for a host deciding what it still serves while closing. */
export function isSessionRecoveryPath(pathname: string) {
  return /^\/session\/[^/]+\/recovery(\/operations\/[^/]+)?$/.test(pathname)
}

/**
 * Who the runtime records the operation against. It comes from the claims a
 * boundary verified, never from the body: a caller able to name itself could
 * join or read an operation another caller owns. An unnamed request still has
 * one thing established about it — how it reached this runtime — and that is
 * what it is recorded as, rather than a shared anonymous identity.
 */
function recoveryCaller(c: Ctx): RecoveryCaller {
  const { actor } = sessionAccessContext(c)
  if (actor) return { callerId: `actor:${actor.actorId}`, authority: "session" }
  return { callerId: `provenance:${sessionRequestProvenance(c)}`, authority: "session" }
}

/**
 * The bound a session route can answer for. `parseRecoveryRequest` already
 * refuses an action whose scope is not the one it names, so a harness or
 * machine target arriving here is a caller asking this session's authority to
 * retire something it does not own.
 */
function recoveryOutOfSessionScope(request: RecoveryRequest, sessionId: string): RecoveryRefusal | undefined {
  const target = request.target
  if (target.scope !== "turn" && target.scope !== "session") {
    return { kind: "unauthorized", message: `Session authority cannot ${request.action} a ${target.scope}` }
  }
  if (target.sessionId !== sessionId) {
    return { kind: "unauthorized", message: `Recovery target names session ${target.sessionId}, not ${sessionId}` }
  }
  return undefined
}

function recoveryResponse(c: Ctx, outcome: RecoveryOutcome) {
  const status = outcome.kind === "operation" ? 200 : RECOVERY_REFUSAL_STATUS[outcome.refusal.kind]
  return c.body(serializeRecoveryOutcome(outcome), status, { "content-type": "application/json" })
}

function recoveryRefused(c: Ctx, refusal: RecoveryRefusal) {
  return recoveryResponse(c, { kind: "refused", refusal })
}

/**
 * The one answer all three routes give when nothing here owns the session.
 * It is the contract's own refusal rather than an error envelope so a caller
 * decodes every non-200 the same way, and so "there is no owner on this host"
 * is not told apart from a live owner's `unavailable` by its shape.
 */
function noRecoveryOwner(sessionId: string): RecoveryRefusal {
  return { kind: "unavailable", message: `No runtime owns session ${sessionId} on this host` }
}

async function sessionOperationGuard(
  opts: Opts,
  c: Ctx,
  sessionId: string,
  operation: SessionAccessOperation,
) {
  const decision = await opts.sessionAccessPolicy?.authorize({
    ...sessionAccessContext(c),
    sessionId,
    operation,
    method: c.req.method,
    path: c.req.path,
  })
  if (decision && !decision.allowed) return sessionAccessDenied(decision)
  return opts.beforeSessionOperation?.(c, { sessionId, operation })
}

/**
 * Whether this reader may prompt the session, answered by the same policy the
 * prompt route asks and reported alongside the harness's capabilities.
 *
 * A `follow` share admits the transcript and refuses the turn, so the reader
 * reaches this route and not `POST /session/:id/message`. Without the answer
 * here the composer has only the workspace role to go on, which says nothing
 * about a session someone was shared, and the reader meets the refusal as a
 * 403 after typing.
 */
async function sessionPromptAdmitted(opts: Opts, c: Ctx, sessionId: string) {
  const decision = await opts.sessionAccessPolicy?.authorize({
    ...sessionAccessContext(c),
    sessionId,
    operation: "prompt",
  })
  return decision?.allowed !== false
}

async function registerCreatedSession(
  opts: Opts,
  c: Ctx,
  sessionId: string,
  operationId: string | undefined,
  sessionTitle?: string,
) : Promise<
  | { kind: "registered" }
  | { kind: "ambiguous"; response: Response }
  | { kind: "denied"; response: Response }
> {
  if (!managedSessionLifecycle(opts, c)) return { kind: "registered" }
  if (!operationId) {
    return {
      kind: "denied",
      response: Response.json(errorBody(
        "session_reservation_required",
        "Managed session creation requires a reservation operation",
      ), { status: 400 }),
    }
  }
  if (!opts.sessionAccessPolicy) {
    return {
      kind: "ambiguous",
      response: sessionAccessDenied(unavailableRegistration("Managed session registration policy is unavailable")),
    }
  }
  if (!opts.sessionAccessPolicy.registerSession) {
    return {
      kind: "ambiguous",
      response: sessionAccessDenied(unavailableRegistration("Managed session registration authority is unavailable")),
    }
  }
  const input = registrationInput(c, sessionId, operationId, sessionTitle)
  let decision: SessionAccessDecision
  try {
    decision = await opts.sessionAccessPolicy.registerSession(input)
  } catch (error) {
    const reason = `registration_transport_error: ${errorMessage(error)}`
    try {
      await markRegistrationAmbiguous(opts, c, sessionId, operationId, reason)
    } catch {
      // The runtime state must still be preserved: registration may have
      // committed before the transport failed, even if reconciliation storage
      // is temporarily unavailable too.
    }
    return {
      kind: "ambiguous",
      response: sessionAccessDenied(unavailableRegistration("Session creator registration outcome is ambiguous; retry the same reservation operation")),
    }
  }
  if (decision.allowed) return { kind: "registered" }
  if (decision.status === 503) {
    try {
      await markRegistrationAmbiguous(opts, c, sessionId, operationId, decision.code)
    } catch {
      // Preserve possibly registered runtime state for the exact-id retry.
    }
    return { kind: "ambiguous", response: sessionAccessDenied(decision) }
  }
  return { kind: "denied", response: sessionAccessDenied(decision) }
}

type DeferredTurnGrantRequest = { sessionId: string } & (
  | { intent: "child_completion"; subjectSessionId: string; registrationOperationId?: string }
  | { intent: "queued_prompt"; turnId: string }
)

/**
 * Mints the proof a turn the runtime later starts for itself will present:
 * a completion wake on `sessionId`, or a queued prompt on it. The plane
 * proves `agent_turn` for this request's actor now; the turn has no
 * credential of its own later, and the actor it was recorded under is a claim
 * the plane refuses as proof.
 *
 * Nothing is minted for a loopback request — the machine's own user takes no
 * lease — or on a policy that mints none, where the turn re-authorizes the
 * stored origin instead. A mint the plane refuses or that throws is one
 * outcome: this request could have proven the turn and the turn will not be
 * able to, so the caller writes nothing durable for it.
 */
async function deferredTurnGrant(opts: Opts, c: Ctx, request: DeferredTurnGrantRequest): Promise<{ grant?: string } | { refused: string }> {
  const policy = opts.sessionAccessPolicy
  if (sessionRequestProvenance(c) !== "relay-replayed" || !policy?.grantTurn) return {}
  let decision: SessionTurnGrantDecision
  try {
    decision = await policy.grantTurn({
      ...sessionAccessContext(c),
      operation: "prompt",
      ...request,
      method: c.req.method,
      path: c.req.path,
    })
  } catch (error) {
    return { refused: errorMessage(error) }
  }
  return decision.allowed ? { grant: decision.grant } : { refused: decision.message }
}

/** A refused mint answers 503 whatever the plane's own status: the create or the queue is what could not be completed. */
function deferredTurnGrantRefused(code: string, message: string) {
  return new HTTPException(503, { message, res: Response.json(errorBody(code, message), { status: 503 }) })
}

/**
 * What the durable queue records about the requester, the grant included when
 * the plane mints one for the message id the row is queued under.
 */
async function queuedPromptRequester(
  opts: Opts,
  c: Ctx,
  sessionId: string,
  messageID: string,
): Promise<QueuedPromptRequester | { refused: Response }> {
  const access = sessionAccessContext(c)
  const granted = await deferredTurnGrant(opts, c, { sessionId, intent: "queued_prompt", turnId: messageID })
  if ("refused" in granted) {
    return { refused: c.json(errorBody("queued_prompt_grant_refused", `Session ${sessionId} did not grant the queued turn ${messageID}: ${granted.refused}`), 503) }
  }
  return {
    actor: access.actor,
    author: access.author,
    authority: access.authority,
    provenance: sessionRequestProvenance(c),
    ...(granted.grant ? { grant: granted.grant } : {}),
  }
}

async function rollbackCreatedSession(
  opts: Opts,
  c: Ctx,
  directory: RuntimeDirectory,
  sessionId: string,
  cause: unknown,
) {
  try {
    await (await opts.runtime(c)).sessions.delete(sessionId, directory)
    await opts.afterDeleteSession?.(c, directory, sessionId)
  } catch (cleanupError) {
    throw new SessionRollbackError("runtime", cause, cleanupError)
  }
}

async function collectionSessionIds(
  opts: Opts,
  c: Ctx,
  operation: SessionAccessOperation,
  sessionIds: readonly string[],
) {
  if (!opts.sessionAccessPolicy) return new Set(sessionIds)
  return new Set(await opts.sessionAccessPolicy.filterSessions({
    ...sessionAccessContext(c),
    operation,
    method: c.req.method,
    path: c.req.path,
    sessionIds: [...new Set(sessionIds.filter(Boolean))],
  }))
}

function explicitSessionId(input: unknown) {
  const row = asRecord(input)
  return typeof row?.sessionID === "string"
    ? row.sessionID
    : typeof row?.sessionId === "string"
      ? row.sessionId
      : ""
}

function rowSessionId(input: unknown) {
  const row = asRecord(input)
  return explicitSessionId(row) || (typeof row?.id === "string" ? row.id : "")
}

function interactionSessionId(rows: readonly unknown[], interactionId: string) {
  return explicitSessionId(rows.find((item) => asRecord(item)?.id === interactionId))
}

function interactionNotFound(c: Ctx, kind: "permission" | "question", id: string) {
  return c.json({
    ok: false,
    error: {
      code: "interaction_not_found",
      message: `Pending ${kind} ${id} was not found`,
    },
  }, 404)
}

function interactionSessionMismatch(c: Ctx, kind: "permission" | "question", id: string) {
  return c.json({
    ok: false,
    error: {
      code: "interaction_session_mismatch",
      message: `Pending ${kind} ${id} does not belong to the supplied session`,
    },
  }, 409)
}

async function filterSessionRows<T>(opts: Opts, c: Ctx, operation: SessionAccessOperation, rows: T[]) {
  const allowed = await collectionSessionIds(opts, c, operation, rows.map(rowSessionId))
  return rows.filter((row) => allowed.has(rowSessionId(row)))
}

async function filterSessionStatus(opts: Opts, c: Ctx, status: unknown) {
  const row = rec(status)
  if (!row) return status
  const entries = Object.entries(row)
  const allowed = await collectionSessionIds(opts, c, "session_status", entries.map(([sessionId]) => sessionId))
  return Object.fromEntries(entries.filter(([sessionId]) => allowed.has(sessionId)))
}

/**
 * Resolves the session a `/question/:id` request acts on, then admits it.
 *
 * Unlike every other session operation, the question routes take their session
 * from an OPTIONAL `?sessionId=` query param — a pending question already knows
 * which session asked it. Admission still has to cover the omitted-param case:
 * gating the guard on the param let any caller skip admission entirely by
 * leaving it off, reaching `replyQuestion`/`rejectQuestion` unchecked.
 *
 * The pending-question listing is authoritative. A supplied session is only a
 * consistency assertion and never selects the authorization target.
 */
async function admitQuestionOperation(
  opts: Opts,
  c: Ctx,
  method: "replyQuestion" | "rejectQuestion",
): Promise<
  | { rejected: Response; id?: undefined; directory?: undefined; sessionId?: undefined }
  | { rejected?: undefined; id: string; directory: RuntimeDirectory; sessionId: string; start?: AgentSessionStartBinding }
> {
  const id = routeParam(c, "id")
  const requested = c.req.query("sessionId") ?? ""
  const directory = await opts.resolveDirectory(c)
  const runtime = await opts.runtime(c)
  const known = interactionSessionId(await runtime.questions.list(directory ?? ""), id)
  if (!known) return { rejected: interactionNotFound(c, "question", id) }
  if (requested && requested !== known) return { rejected: interactionSessionMismatch(c, "question", id) }
  const pending = opts.sessionStarts?.get(known)
  if (pending && pending.status !== "created") {
    const denied = await sessionStartGuard(opts, c, pending.binding, "question_response")
    if (denied) return { rejected: denied }
    if (pending.status !== "starting") return { rejected: interactionNotFound(c, "question", id) }
    return { id, directory, sessionId: known, start: pending.binding }
  }
  const guarded = await sessionOperationGuard(opts, c, known, "question_response")
  if (guarded) return { rejected: guarded }
  const unsupported = await unsupportedIfUnavailable(c, runtime, { sessionId: known, ...(directory ? { directory } : {}) }, "questions", "question_response")
  if (unsupported) return { rejected: unsupported }
  void method
  return { id, directory, sessionId: known }
}

export function createSessionRoutes(opts: Opts) {
  const app = new Hono()
  // The other routers in this package re-throw whatever is not an oversized
  // body and let the app they are mounted into answer it. This router is also
  // driven directly, where a re-throw rejects the request instead of becoming
  // a response — so the two answers every handler here already relies on,
  // `HTTPException` and a bare failure, are named rather than delegated.
  const requestErrorResponse = (err: unknown, c: Ctx): Response => {
    if (isRequestBodyTooLarge(err)) return c.json(requestBodyTooLargeBody(), 413)
    if (err instanceof HTTPException) return err.getResponse()
    return c.text("Internal Server Error", 500)
  }
  app.onError((err, c) => {
    if (!isRequestBodyTooLarge(err) && !(err instanceof HTTPException)) console.error(err)
    return requestErrorResponse(err, c)
  })
  // Creation and deletion share the identity until every provider/projection
  // effect has settled. A late deletion must never remove a recreated session.
  const activeSessionChanges = new Set<string>()
  async function withSessionChange<T>(sessionId: string, change: () => Promise<T>): Promise<T> {
    if (activeSessionChanges.has(sessionId)) throw new HTTPException(409, { message: "Session creation or deletion is still in progress" })
    activeSessionChanges.add(sessionId)
    try {
      return await change()
    } finally {
      activeSessionChanges.delete(sessionId)
    }
  }
  // Deduplicates prompt_async retries by message id and nothing more: the
  // per-session concurrency lease is AgentRuntime's. The checkpoint-freeze
  // middleware runs before these routes, so a 423 may preempt admission
  // entirely. A live entry is the owning request's pending answer: a retry
  // that finds one joins it instead of deduplicating on sight or admitting
  // the same prompt twice.
  const promptAdmissions = new Map<string, Map<string, Promise<Response>>>()
  const releasePromptAdmission = (sessionId: string, messageId: string | undefined) => {
    if (!messageId) return
    const admitted = promptAdmissions.get(sessionId)
    if (!admitted?.delete(messageId)) return
    if (admitted.size === 0) promptAdmissions.delete(sessionId)
  }
  const ADMISSION_ACK_TIMED_OUT = Symbol("prompt-async-admission-timeout")
  // Wait for the turn's admission decision, but never longer than the bound:
  // a wedged turns.start (adapter spawn that never settles admission and never
  // throws) must not hang the prompt_async response. On timeout the caller gets
  // its fire-and-forget 204 and the detached turn continues; any conflict/error
  // then surfaces on the event stream.
  const awaitAdmissionAck = async (admission: Promise<unknown>): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof ADMISSION_ACK_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(ADMISSION_ACK_TIMED_OUT), opts.promptAsyncAdmissionAckTimeoutMs ?? 5_000)
      timer.unref?.()
    })
    try {
      return await Promise.race([admission, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  /**
   * Recovery is registered ahead of every gate this router adds, so a request
   * to inspect or contain a session is not queued behind the serving path it
   * is about. The workspace host owes the same of its own closing gate.
   */
  app
    .get("/session/:id/recovery", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "recovery_inspect")
      if (guarded) return guarded
      const runtime = opts.resolveRecoveryOwner?.(c, { sessionId })
      if (!runtime) return recoveryRefused(c, noRecoveryOwner(sessionId))
      return c.json(runtime.inspect(sessionId, await opts.resolveDirectory(c, { sessionId })))
    })
    .get("/session/:id/recovery/operations/:operationId", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "recovery_inspect")
      if (guarded) return guarded
      const runtime = opts.resolveRecoveryOwner?.(c, { sessionId })
      if (!runtime) return recoveryRefused(c, noRecoveryOwner(sessionId))
      const operationId = c.req.param("operationId")
      const outcome = runtime.read(operationId, recoveryCaller(c))
      // An id this owner has never held is not an expired receipt: it names no
      // operation whose retention could have lapsed.
      if (!outcome) return c.json(errorBody("recovery_operation_unknown", `Recovery operation ${operationId} is not held by this owner`), 404)
      return recoveryResponse(c, outcome)
    })
    .post("/session/:id/recovery", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "recovery_submit")
      if (guarded) return guarded
      let request: RecoveryRequest
      try {
        request = parseRecoveryRequest(await boundedJsonBody(c))
      } catch (error) {
        if (!(error instanceof RecoveryContractError)) throw error
        return c.json(errorBody("recovery_request_invalid", error.message, { code: error.code }), 400)
      }
      const outOfScope = recoveryOutOfSessionScope(request, sessionId)
      if (outOfScope) return recoveryRefused(c, outOfScope)
      const runtime = opts.resolveRecoveryOwner?.(c, { sessionId })
      if (!runtime) return recoveryRefused(c, noRecoveryOwner(sessionId))
      return recoveryResponse(c, await runtime.submit(request, recoveryCaller(c)))
    })
  // Wakes left by a previous process are re-issued on the first request, once
  // the host has a store and adapters to deliver them with.
  app.use("*", async (_c, next) => {
    void opts.childSessions?.recover()
    await next()
  })
  app
    .get("/session-start/:id", async (c) => {
      let start = opts.sessionStarts?.get(c.req.param("id"))
      if (!start) return c.json(errorBody("session_start_not_found", "Session creation not found"), 404)
      const denied = await sessionStartGuard(opts, c, start.binding, "session_meta_read", start.status === "created")
      if (denied) return denied
      if (start.status === "starting" && !activeSessionChanges.has(start.binding.sessionId)) {
        const existing = await opts.getSession?.(c, start.binding.directory, start.binding.sessionId)
        if (existing) return c.json(errorBody("session_registration_unresolved", "The agent session exists but its creation outcome requires registration reconciliation"), 409)
        start = opts.sessionStarts!.finish(start.binding, { status: "failed", error: "Session creation was interrupted; its agent request cannot be resumed" })
      }
      return c.json(start)
    })
    .get("/session", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const roots = rootsOnly(c)
      const sessions = opts.listSessions
        ? await opts.listSessions(c, directory)
        : []
      await after(opts.afterListSessions?.(c, directory, sessions))
      const visible = await filterSessionRows(opts, c, "session_list", sessions)
      const data = (visible as unknown[])
        .map((session) => normalizeSession(session, directory))
        .filter((session) => !roots || typeof rec(session)?.parentID !== "string")
      return c.json(data)
    })
    .get("/experimental/session", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const limit = Math.min(Number(c.req.query("limit") ?? "100") || 100, 500)
      const roots = rootsOnly(c)
      const archived = c.req.query("archived") === "true" || c.req.query("archived") === "1"
      const sessions = opts.listSessions
        ? await opts.listSessions(c, directory)
        : []
      await after(opts.afterListSessions?.(c, directory, sessions))
      const visible = await filterSessionRows(opts, c, "session_list", sessions)
      const data = (visible as unknown[])
          .map(summarizeSession)
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .filter((item) => !roots || typeof item.parentID !== "string")
          .filter((item) => archived || typeof asRecord(item.time)?.archived !== "number")
          .slice(0, limit)
      return c.json(data)
    })
    .get("/session/status", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const status = await opts.getStatus?.(c, directory)
      if (status instanceof Response) {
        if (!opts.sessionAccessPolicy) return status
        const data = await status.clone().json().catch(() => undefined)
        if (data === undefined) return status
        return c.json(
          await filterSessionStatus(opts, c, data),
          contentfulStatus(status.status) ?? 200,
          Object.fromEntries(status.headers.entries()),
        )
      }
      return c.json(await filterSessionStatus(opts, c, status ?? {}))
    })
    .post("/session", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const wire = await boundedJsonRecord(c)
      const body = normalizeSessionCreateBody(wire)
      const guarded = await sessionOperationGuard(opts, c, "", "session_create")
      if (guarded) return guarded
      const group = sessionCreateGroup(wire)
      if (group && "field" in group) {
        return c.json(errorBody("session_group_invalid", `${group.field}: ${group.message}`), 400)
      }
      if (group) body.group = group.group
      const children = opts.childSessions
      if ((body.parentID || body.clientRequestId) && !children) {
        return c.json(errorBody("child_sessions_unsupported", "This runtime cannot create child sessions"), 501)
      }
      const create = async () => {
        if (body.parentID && children) {
          // A child completion can prompt this parent. Following its transcript
          // does not authorize starting that future input.
          const refused = await sessionOperationGuard(opts, c, body.parentID, "prompt")
          if (refused) return refused
        }
        const parent = body.parentID && children ? await readSession(opts, c, directory, body.parentID) : undefined
        if (body.parentID && children) {
          if (!parent) return c.json(errorBody("parent_session_not_found", `Parent session ${body.parentID} not found`), 404)
          if (parent.parentID) {
            return c.json(errorBody("subagent_recursion_denied", "A child session cannot create children of its own"), 409)
          }
          if (parent.time?.archived !== undefined) {
            return c.json(errorBody("parent_session_archived", "An archived session cannot create children"), 409)
          }
        }
        if (!body.id && body.clientRequestId && children) {
          const callerIdentity = body.parentID ?? sessionAccessContext(c).actor?.actorId
          if (!callerIdentity) {
            return c.json(errorBody("client_request_id_requires_identity", "clientRequestId needs a parent session or an authenticated caller"), 400)
          }
          body.id = children.deriveSessionId({ callerIdentity, clientRequestId: body.clientRequestId })
        }
        let operationId = registrationOperationId(c)
        const managed = managedSessionLifecycle(opts, c)
        // A child the workspace's own runtime creates in process has no caller
        // that reserved first, so it reserves itself as the verified actor —
        // the owner grant's identity — and the control plane decides. A root
        // create keeps needing the caller's own reservation.
        const selfReservation = managed && !operationId && body.parentID && children
          ? opts.sessionAccessPolicy?.reserveSession?.bind(opts.sessionAccessPolicy)
          : undefined
        if (selfReservation && !body.id) body.id = `ses_${randomUUID()}`
        if (managed && (!body.id || (!operationId && !selfReservation))) {
          return c.json(errorBody(
            "session_reservation_required",
            "Managed session creation requires a preassigned session id and reservation operation",
          ), 400)
        }
        const config = normalizeSessionCreateConfig(wire)
        const draftId = parseDraftId(c.req.header("x-claxedo-draft-id"))
        const workspaceId = await opts.resolveWorkspaceId?.(c, directory)
        const creator = sessionAccessContext(c).actor?.actorId
        let start: AgentSessionStartBinding | undefined
        let claimed: string | undefined
        try {
          // Checking the id and claiming it in two steps lets two creates for
          // one id both pass and both drive the harness. The pair is one
          // synchronous step, so the loser is refused before it touches
          // anything and the winner holds the id until this request settles.
          if (body.id) {
            if (activeSessionChanges.has(body.id)) return c.json(errorBody("session_creation_in_progress", "Session creation or deletion is still in progress"), 409)
            activeSessionChanges.add(body.id)
            claimed = body.id
          }
          let reserved = false
          if (body.id && operationId) {
            const refused = await creationReservationGuard(opts, c, body.id, operationId)
            if (refused) return refused
            reserved = managed
          }
          const runtime = await opts.runtime(c)
          const requestedHarness = opts.requestedSessionHarness(c)
          const owner = sessionOwner(c)
          const draft = { harness: requestedHarness ?? opts.defaultHarness(), directory: directory ?? "", owner } satisfies HarnessTarget
          const draftCapabilities = await runtime.reads.capabilities(draft)
          const refusal = admitSessionInstructions({
            ...(requestedHarness ? { harness: requestedHarness.id } : {}),
            channel: draftCapabilities.instructionChannel,
            instructions: body.instructions,
          })
          if (refusal) {
            return refusal.reason === "no_instruction_channel"
              ? c.json(errorBody("session_instructions_unsupported", refusal.message), 501)
              : c.json(errorBody("session_instructions_too_large", refusal.message), 400)
          }
          const existing = body.id ? await readSession(opts, c, directory, body.id) : undefined
          // An id this request holds a live reservation for is its own creation
          // resumed, and the plane has no stored session to ask about until it
          // registers. Any other id that already exists is somebody's session:
          // the session itself, not the workspace the request named, says
          // whether this caller may read its harness, its parent and its
          // ceiling, configure it, or have it rolled back.
          if (existing && !reserved) {
            const denied = await sessionOperationGuard(opts, c, existing.id, "session_create")
            if (denied) return denied
          }
          if (existing && requestedHarness) {
            const currentConfig = await sessionConfigOf(opts, c, directory, existing.id)
            if (!sameSessionHarness(currentConfig.harness, requestedHarness)) {
              throw new HTTPException(409, { message: "Session already belongs to another harness" })
            }
          }
          if (existing && body.parentID && children) {
            if (existing.parentID !== body.parentID) {
              return c.json(errorBody("session_parent_mismatch", `Session ${existing.id} does not belong to ${body.parentID}`), 409)
            }
            const row = await children.childOf(existing.id, directory)
            if (!row) return c.json(errorBody("subagent_row_missing", `Session ${existing.id} has no subagent row`), 409)
            return c.json(createdSessionBody(normalizeSession(existing, directory), { parentID: body.parentID, subagentKey: row.subagentKey }), 200)
          }
          if (body.parentID && children) {
            const active = await children.activeChildren(body.parentID, directory)
            if (active.length >= MAX_ACTIVE_CHILDREN_PER_PARENT) {
              return c.json(errorBody(
                "subagent_child_cap_reached",
                `Session ${body.parentID} already has ${active.length} active children (limit ${MAX_ACTIVE_CHILDREN_PER_PARENT})`,
              ), 409)
            }
          }
          const inherited = existing
            ? await sessionPermissionCeiling(opts, c, directory, existing)
            : await effectivePermissionCeiling(opts, c, directory, parent, undefined)
          const ceiling = inherited && body.permissionCeiling
            ? narrowerPermissionLevel(inherited, body.permissionCeiling)
            : inherited ?? body.permissionCeiling
          const childMode = await permissionModeUnderCeiling(c, runtime,
            existing ? { sessionId: existing.id, ...(directory ? { directory } : {}) } : draft, ceiling, body.permissionMode)
          if (childMode.refusal) return childMode.refusal
          if (selfReservation && !existing) {
            const reservation = await selfReservation({
              ...sessionAccessContext(c),
              operation: "session_create",
              sessionId: body.id!,
              parentSessionId: body.parentID!,
              ...(body.title ? { sessionTitle: body.title } : {}),
              method: c.req.method,
              path: c.req.path,
            })
            if (!reservation.allowed) return sessionAccessDenied(reservation)
            operationId = reservation.operationId
          }
          if (!existing && opts.sessionStarts) {
            if (!body.id) {
              body.id = `ses_${randomUUID()}`
              activeSessionChanges.add(body.id)
              claimed = body.id
            }
            const owner: AgentSessionStartBinding = {
              sessionId: body.id, directory: directory ?? "", workspaceId: workspaceId ?? "",
              operationId: operationId ?? randomUUID(),
              connectionId: connectionIdForHarness(draft.harness),
            }
            if (opts.sessionStarts.get(body.id)) throw new HTTPException(409, { message: "Session creation already has an owner; inspect its status before retrying" })
            opts.sessionStarts.begin(owner)
            start = owner
          }
          opts.publishSessionLifecycle?.({
            type: "session.lifecycle", phase: "creating", directory,
            ...(start ? { start } : {}),
            ...(draftId ? { draftId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(creator ? { actorId: creator } : {}), ts: Date.now(),
          })
          if (existing && opts.sessionStarts) {
            const prior = opts.sessionStarts.get(existing.id)
            if (prior?.status === "starting" && prior.binding.operationId === operationId) start = prior.binding
          }
          const createOptions = {
            ...(start ? { start } : {}),
            ...(body.instructions ? { instructions: body.instructions } : {}),
            ...(body.group ? { group: body.group } : {}),
          }
          const { model: createModel, variant: createVariant, agent: createAgent, ...laterConfig } = config
          let session: AgentSession | { id: string } = existing ?? await runtime.sessions.create({
            ...(body.id ? { id: body.id } : {}),
            workspaceId: workspaceId ?? "",
            directory,
            harness: draft.harness,
            owner,
            origin: turnOriginOf(sessionTurnOrigin(c), owner),
            ...(start ? { start } : {}),
            ...(body.parentID ? { parentID: body.parentID } : {}),
            ...(createModel ? { model: createModel } : {}),
            ...(createVariant !== undefined ? { variant: createVariant } : {}),
            ...(createAgent !== undefined ? { agent: createAgent } : {}),
            ...(ceiling ? { permissionCeiling: ceiling } : {}),
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...createOptions,
          })
          const pendingConfig = existing ? config : laterConfig
          if (Object.keys(pendingConfig).length > 0) {
            try {
              await runtime.sessions.updateConfig(session.id, pendingConfig, directory)
            } catch (error) {
              // Undo only what this request made. A session that was already
              // there belongs to the attempt that created it, and deleting it
              // to tidy up a failed configuration destroys that work.
              if (!existing) await rollbackCreatedSession(opts, c, directory, session.id, error)
              throw error
            }
          }
          let subagentKey: string | undefined
          try {
            if (childMode.mode) {
              await runtime.reads.setPermissionMode(session.id, childMode.mode.id, directory)
            }
            if (body.parentID && children) {
              const harness = requestedHarness ?? config.harness ?? (await sessionConfigOf(opts, c, directory, session.id)).harness
              // Minted before the subagent row exists: the origin is written
              // once, and a wake with no grant on a plane that mints them is
              // never admitted, so a refused mint must fail the create.
              const granted = await deferredTurnGrant(opts, c, {
                sessionId: body.parentID,
                intent: "child_completion",
                subjectSessionId: session.id,
                ...(operationId ? { registrationOperationId: operationId } : {}),
              })
              if ("refused" in granted) {
                throw deferredTurnGrantRefused(
                  "child_wake_grant_refused",
                  `Session ${body.parentID} did not grant a completion wake for ${session.id}: ${granted.refused}`,
                )
              }
              const origin = sessionTurnOrigin(c)
              const wakeOrigin = origin?.provenance === "relay-replayed" && granted.grant ? { ...origin, grant: granted.grant } : origin
              subagentKey = (await children.admitCreated({
                parentSessionId: body.parentID,
                childSessionId: session.id,
                directory,
                harness: harness.id,
                ...(body.role ? { role: body.role } : {}),
                ...(body.title ? { title: body.title } : {}),
                ...(wakeOrigin ? { origin: wakeOrigin } : {}),
              })).subagentKey
            }
          } catch (error) {
            if (!existing) await rollbackCreatedSession(opts, c, directory, session.id, error)
            throw error
          }
          if (body.parentID && children) {
            const persisted = await readSession(opts, c, directory, session.id)
            if (!persisted) throw new Error(`Created child ${session.id} has no persisted session row`)
            session = persisted
          }
          const created = {
            ...(body.parentID ? { parentID: body.parentID } : {}),
            ...(subagentKey ? { subagentKey } : {}),
            ...(childMode.mode ? { permissionMode: childMode.mode.id } : {}),
          }
          const registration = await registerCreatedSession(opts, c, session.id, operationId, body.title)
          if (registration.kind === "ambiguous") {
            return registration.response
          }
          if (registration.kind === "denied") {
            if (start) opts.sessionStarts!.finish(start, { status: "failed", error: "Session creator registration was denied" })
            await compensateRegistration({
              opts,
              c,
              directory,
              sessionId: session.id,
              operationId: operationId!,
              reason: `registration_denied_${registration.response.status}`,
            })
            opts.publishSessionLifecycle?.({
              type: "session.lifecycle",
              phase: "failed",
              ...(start ? { start } : {}),
              directory,
              ...(draftId ? { draftId } : {}),
              ...(workspaceId ? { workspaceId } : {}),
              ...(creator ? { actorId: creator } : {}),
              message: "Session creator registration was denied",
              ts: Date.now(),
            })
            return registration.response
          }
          try {
            await after(opts.afterCreateSession?.(c, directory, session))
          } catch (error) {
            if (managed) {
              await compensateRegistration({
                opts,
                c,
                directory,
                sessionId: session.id,
                operationId: operationId!,
                reason: `post_create_projection_failed: ${errorMessage(error)}`,
              })
            } else if (!existing) {
              await rollbackCreatedSession(opts, c, directory, session.id, error)
            }
            throw error
          }
          if (body.parentID && children) {
            opts.publishGlobal(withDir(compatScope(directory, session.id), sessionUpdated(session as AgentSession)))
          }
          if (start) {
            if (session.id !== start.sessionId) throw new Error("Agent returned a different local session identity")
            const binding = runtime.attachments.binding(session.id)
            opts.sessionStarts!.finish(start, { status: "created", upstreamSessionId: binding.upstreamSessionId })
          }
          opts.publishSessionLifecycle?.({
            type: "session.lifecycle",
            phase: "created",
            directory,
            sessionID: session.id,
            ...(draftId ? { draftId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            info: sessionLifecycleInfo({ session, directory, title: body.title, workspaceId }),
            ts: Date.now(),
          })
          return c.json(createdSessionBody(normalizeSession(session, directory), created), 201)
        } catch (error) {
          if (start && opts.sessionStarts?.get(start.sessionId)?.status === "starting") {
            opts.sessionStarts.finish(start, { status: "failed", error: errorMessage(error) })
          }
          opts.publishSessionLifecycle?.({
            type: "session.lifecycle",
            phase: "failed",
            ...(start ? { start } : {}),
            directory,
            ...(draftId ? { draftId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(creator ? { actorId: creator } : {}),
            message: errorMessage(error),
            ts: Date.now(),
          })
          // A create that was REFUSED carries its own status — an unknown harness
          // is a 400, an id that belongs to another workspace is a 409. Flattening
          // those into 500 tells the caller the runtime broke when in fact the
          // runtime declined, and a 500 is the one class of failure clients retry.
          if (error instanceof HTTPException) throw error
          return harnessUnavailableResponse(c, error) ?? c.json(errorBody("session_create_failed", errorMessage(error)), 500)
        } finally {
          if (claimed) activeSessionChanges.delete(claimed)
        }
      }
      return body.parentID && children
        ? children.withCreation(body.parentID, directory, () => withSessionChange(body.parentID!, create))
        : create()
    })
    // Register the harness capability routes, both global
    // (`/session/capabilities`, no :id) and per-session
    // (`/session/:id/capabilities`) routes BEFORE the parameterised
    // `/session/:id` so Hono doesn't interpret "capabilities" as a
    // session id.
    .get("/session/capabilities", async (c) => {
      try {
        const directory = await opts.resolveDirectory(c)
        const runtime = await opts.runtime(c)
        const target = draftTarget(opts, c, directory)
        if (await runtime.reads.servesProviderCatalog(target)) {
          const refused = providerCatalogRefusal(c)
          if (refused) return refused
        }
        return noStoreJson(c, await runtime.reads.capabilities(target))
      } catch (error) {
        const refusal = harnessUnavailableResponse(c, error)
        if (refusal) return refusal
        throw error
      }
    })
    .get("/session/:id/capabilities", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_capabilities_read")
      if (guarded) return guarded
      try {
        const directory = await opts.resolveDirectory(c, { sessionId })
        return noStoreJson(c, {
          ...await (await opts.runtime(c)).reads.capabilities({ sessionId, ...(directory ? { directory } : {}) }),
          prompt: await sessionPromptAdmitted(opts, c, sessionId),
        })
      } catch (error) {
        const refusal = harnessUnavailableResponse(c, error)
        if (refusal) return refusal
        throw error
      }
    })
    // The combined Goal read. Session activation needs BOTH the adapter's Goal
    // capabilities and the session's current Goal; asking for them separately
    // costs two sequential round-trips and makes the runtime derive
    // capabilities twice. This composes the same two resource calls server-side
    // and skips the Goal read entirely when the harness has no Goal support.
    .get("/session/:id/goal/state", goalRoute(opts, "goal_state", async ({ c, sessionId, directory, runtime }) => {
      const capabilities = await runtime.goals.capabilities(sessionId, directory)
      return noStoreJson(c, {
        capabilities,
        goal: capabilities.implemented ? await runtime.goals.read(sessionId, directory) : null,
      })
    }))
    .get("/session/:id/goal/capabilities", goalRoute(opts, "goal_capabilities", async ({ c, sessionId, directory, runtime }) =>
      noStoreJson(c, await runtime.goals.capabilities(sessionId, directory))))
    .get("/session/:id/goal", goalRoute(opts, "goal_read", async ({ c, sessionId, directory, runtime }) =>
      noStoreJson(c, await runtime.goals.read(sessionId, directory))))
    .post("/session/:id/goal", goalRoute(opts, "goal_start", async ({ c, sessionId, directory, runtime }) => {
      const body = await boundedJsonRecord(c)
      return goalMutationResponse(
        c,
        await runtime.goals.start({ sessionId, objective: str(body.objective) ?? "" }, directory),
        201,
      )
    }))
    .post("/session/:id/goal/pause", goalRoute(opts, "goal_pause", async ({ c, sessionId, directory, runtime }) =>
      goalMutationResponse(c, await runtime.goals.pause(sessionId, directory))))
    .post("/session/:id/goal/resume", goalRoute(opts, "goal_resume", async ({ c, sessionId, directory, runtime }) =>
      goalMutationResponse(c, await runtime.goals.resume(sessionId, directory))))
    .post("/session/:id/goal/stop", goalRoute(opts, "goal_stop", async ({ c, sessionId, directory, runtime }) =>
      goalMutationResponse(c, await runtime.goals.stop(sessionId, directory))))
    .delete("/session/:id/goal", goalRoute(opts, "goal_delete", async ({ c, sessionId, directory, runtime }) =>
      goalMutationResponse(c, await runtime.goals.delete(sessionId, directory))))
    .get("/session/:id/subagents", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "list_subagents")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      return noStoreJson(c, await opts.listSubagents?.(c, directory, sessionId) ?? [])
    })
    .get("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_meta_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const session = await readSession(opts, c, directory, sessionId)
      if (!session) return noStoreJson(c, sessionNotFound(), 404)
      await after(opts.afterGetSession?.(c, directory, session))
      return noStoreJson(c, normalizeSession(session, directory))
    })
    .get("/session/:id/config-options", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_config_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const runtime = await opts.runtime(c)
      let preview: Awaited<ReturnType<typeof runtime.reads.configOptions>>
      try {
        preview = await runtime.reads.configOptions({ sessionId, ...(directory ? { directory } : {}) }, c.req.query("model") || undefined)
      } catch (cause) {
        if (cause instanceof PreviewModelInvalidError) return noStoreJson(c, errorBody("preview_model_invalid", cause.message), 400)
        throw cause
      }
      if (!preview) return noStoreJson(c, { error: "Session harness does not expose config options" }, 404)
      return noStoreJson(c, preview)
    })
    .get("/session/:id/config", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_config_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      return noStoreJson(c, await sessionConfigOf(opts, c, directory, sessionId))
    })
    .patch("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_meta_write")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const wire = await boundedJsonRecord(c)
      const title = str(wire.title)
      const archived = num(rec(wire.time)?.archived)
      const body = {
        ...(title !== undefined ? { title } : {}),
        ...(archived !== undefined ? { time: { archived } } : {}),
      }
      if (!await readSession(opts, c, directory, sessionId)) return c.json(sessionNotFound(), 404)
      const session = await (await opts.runtime(c)).sessions.update(sessionId, body, directory)
      await after(opts.afterUpdateSession?.(c, directory, session, body))
      opts.publishGlobal(withDir(compatScope(directory, sessionId), sessionUpdated(session)))
      if (archived !== undefined) await cascadeToChildren(opts, c, directory, sessionId, "archive", { archived })
      return c.json(normalizeSession(session, directory))
    })
    .patch("/session/:id/config", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_config_write")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const wire = await boundedJsonRecord(c)
      const immutable = IMMUTABLE_SESSION_CONFIG_FIELDS.find((field) => field in wire)
      if (immutable) {
        const refusal = IMMUTABLE_CONFIG_REFUSALS[immutable]
        return c.json(errorBody(refusal.code, refusal.message), 409)
      }
      const body = normalizeSessionConfigUpdate(wire)
      const requestedHarness = opts.requestedSessionHarness(c)
      if (requestedHarness) body.harness = requestedHarness
      try {
        return c.json(await (await opts.runtime(c)).sessions.updateConfig(sessionId, body, directory))
      } catch (error) {
        const refusal = harnessUnavailableResponse(c, error)
        if (refusal) return refusal
        throw error
      }
    })
    .delete("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "delete")
      if (guarded) return guarded
      return withSessionChange(sessionId, async () => {
        const directory = await opts.resolveDirectory(c, { sessionId })
        // Read before deleting: once the row is gone nothing can say whether it
        // was a subsession, and the rail's visible count depends on that.
        const parentID = (await readSession(opts, c, directory, sessionId).catch(() => undefined) as { parentID?: string } | undefined)?.parentID
        const start = opts.sessionStarts?.get(sessionId)?.binding
        await cascadeToChildren(opts, c, directory, sessionId, "delete", {}, withSessionChange)
        await opts.beforeDeleteSession?.(c, directory, sessionId)
        await disposeRuntimeSessionDocuments(sessionId)
        await (await opts.runtime(c)).sessions.delete(sessionId, directory)
        await after(opts.afterDeleteSession?.(c, directory, sessionId))
        // A deletion that got this far removed the session the creation owns, so
        // the id goes back. Anything that throws above keeps the owner, which is
        // what lets a caller distinguish a freed id from a half-deleted one.
        if (start) opts.sessionStarts!.retire(start)
        opts.publishGlobal(withDir(compatScope(directory, sessionId), sessionDeleted(sessionId, directory ?? "", parentID)))
        return c.json({ ok: true })
      })
    })
    .post("/session/:id/message", async (c) => {
      const id = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, id, "prompt")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId: id })
      if (!await readSession(opts, c, directory, id)) return c.json(sessionNotFound(), 404)
      const runtime = await opts.runtime(c)
      const access = sessionAccessContext(c)
      const parsedBody = parseSessionPromptBody(await boundedJsonBody(c))
      const body = await opts.transformPromptBody?.(c, { sessionId: id, directory, body: parsedBody }) ?? parsedBody
      const permissionRefusal = await rejectPermissionOverride(opts, c, directory, id, body.permissionMode)
      if (permissionRefusal) return permissionRefusal
      if (body.delivery) {
        if (!opts.queuedPrompts) return c.json({ error: "Queued delivery requires a durable runtime owner" }, 409)
        body.messageID ??= `msg_${randomUUID()}`
        const requester = await queuedPromptRequester(opts, c, id, body.messageID)
        if ("refused" in requester) return requester.refused
        const submission = { sessionId: id, body, ...requester }
        if (body.delivery === "queue") {
          opts.queuedPrompts.queue(submission)
          return c.json({ delivery: "queue", messageID: body.messageID }, 202)
        }
        const result = await opts.queuedPrompts.steer(submission)
        if (result.ok) return c.json({ delivery: "steer", messageID: body.messageID })
        return c.json({ ...result, error: result.message }, result.status === "pending" || result.status === "unknown" ? 202 : 409)
      }
      const lostTurn = captureTurnTarget()
      const turnAdmission = await acquireManagedPromptLease({
        opts,
        c,
        sessionId: id,
        turnId: body.messageID,
        onLost: () => containLostTurn({ runtime: runtime.recovery, sessionId: id, target: lostTurn.get(), caller: recoveryCaller(c) }),
      })
      if (turnAdmission.rejected) return turnAdmission.rejected
      const activeTurn = opts.createActiveTurnScope
        ? turnScope(opts.createActiveTurnScope({ c, directory, sessionId: id }), turnAdmission.lease)
        : undefined
      await opts.childSessions?.onTurnStarted(id, directory)
      try {
        const turn = await (async () => {
        try {
          return await runRuntimePromptTurn({
                runtime,
                sessionId: id,
                directory,
                body,
                origin: turnOriginOf(sessionTurnOrigin(c), sessionOwner(c)),
                publishGlobal: opts.publishGlobal,
                activeTurn,
                onTurnTarget: lostTurn.set,
                ...(turnAdmission.lease ? { turnAdmission: turnAdmission.lease } : {}),
                actor: access.actor,
                author: access.author,
              })
        } finally {
          if (!turnAdmission.lease?.lost()) await flushDocumentsAfterTurn(opts, id)
          await settleChildTurn(opts, id, directory)
        }
        })()
        if (turnAdmission.lease?.lost() || (turnAdmission.lease && !turnAdmission.lease.valid())) {
          return lostTurnResponse(id, turnAdmission.lease)
        }
        await after(opts.afterMessageCheckpoint?.(c, directory, id, turn.messages))
        if (turnAdmission.lease?.lost() || (turnAdmission.lease && !turnAdmission.lease.valid())) {
          return lostTurnResponse(id, turnAdmission.lease)
        }
        const output = sessionPromptReply(turn)
        if (output.assistantMessage) opts.publishGlobal(withDir(turn.scope, messageUpdated(output.assistantMessage)))
        return c.json(output.body)
      } catch (error) {
        if (turnAdmission.lease?.lost()) return lostTurnResponse(id, turnAdmission.lease)
        if (isAgentRuntimeTurnConflictError(error)) return turnAdmissionConflict(c)
        throw error
      } finally {
        await turnAdmission.lease?.release().catch(() => undefined)
      }
    })
    .get("/session/:id/message/:messageId/attachment/:attachmentId", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "message_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const messages = await opts.getMessages?.(c, directory, sessionId)
      if (!messages) return noStoreJson(c, sessionNotFound(), 404)
      return toolImageResponse({ messages, sessionId, messageId: c.req.param("messageId"), attachmentId: c.req.param("attachmentId") })
    })
    .get("/session/:id/message", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "message_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const snapshotRequested = c.req.query("snapshot") === "1"
      const pageInput = snapshotRequested ? undefined : messageReadInput(c)
      if (pageInput && "turnId" in pageInput) {
        const { turnId } = pageInput
        try {
          const coverage = await opts.turnCoverage?.(c, directory, sessionId, turnId)
          if (coverage) return noStoreJson(c, coverage)
        } catch (error) {
          throwMessagePageError(error, 500)
        }
        return noStoreJson(c, {
          turnId,
          coverage: "unavailable",
          reason: "No turn journal in this runtime owns this session",
          committedSequence: 0,
          messages: [],
        } satisfies AgentTurnCoveragePage)
      }
      if (!pageInput) {
        const snapshot = await opts.getMessageSnapshot?.(c, directory, sessionId)
        if (snapshot) {
          if (!snapshotRequested) return messagePageResponse(c, snapshot)
          const session = await readSession(opts, c, directory, sessionId)
          if (!session) return noStoreJson(c, sessionNotFound(), 404)
          return noStoreJson(c, { ...snapshot, session: normalizeSession(session, directory) })
        }
      }
      if (pageInput) {
        try {
          const page = await opts.getMessagePage?.(c, directory, sessionId, pageInput)
          if (page) return messagePageResponse(c, page)
        } catch (error) {
          throwMessagePageError(error, 500)
        }
        throw new HTTPException(501, { message: "message paging is not supported for this session" })
      }
      const replay = await opts.getMessages?.(c, directory, sessionId) ?? await (await opts.runtime(c)).events.list(sessionId, directory)
      if (!snapshotRequested) return noStoreJson(c, replay)
      const session = await readSession(opts, c, directory, sessionId)
      if (!session) return noStoreJson(c, sessionNotFound(), 404)
      return noStoreJson(c, { messages: replay, session: normalizeSession(session, directory) })
    })
    .get("/session/:id/todo", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "todo_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const runtime = await opts.runtime(c)
      const target = { sessionId, ...(directory ? { directory } : {}) } satisfies HarnessTarget
      const unsupported = await unsupportedIfUnavailable(c, runtime, target, "todos", "todos")
      if (unsupported) return unsupported
      const replay = await opts.getTodos?.(c, directory, sessionId)
      if (replay) return noStoreJson(c, replay)
      return noStoreJson(c, await runtime.reads.todos(sessionId, directory) ?? [])
    })
    .get("/permission/modes", async (c) => {
      // DIRECTORY-scoped, for a draft that has no session yet.
      //
      // Under `/permission/` deliberately. claxedo-server gates every path
      // through an explicit ownership registry (route-ownership.ts), so a new
      // top-level path 404s before reaching this router no matter what is
      // registered here. `/permission` is already a declared prefix owned by the
      // session runtime, so nesting under it needs no registry change — and the
      // session-scoped sibling below works for the same reason via `/session`.
      //
      // Without this the composer could not show a harness's modes until after
      // the first message, so the opening turn — the one moment a user most
      // wants to say "ask me about everything" — ran under a default nobody
      // chose. Claude, Codex and Cursor need no session for this at all: their
      // mode lists are static. ACP genuinely does, because the agent advertises
      // its modes on `session/new`, and it reports empty here rather than
      // inventing a list.
      const directory = await opts.resolveDirectory(c)
      const runtime = await opts.runtime(c)
      const target = draftTarget(opts, c, directory)
      const state = await runtime.reads.permissionModes(target)
      if (!state) {
        return noStoreJson(c, {
          modes: [],
          unsupported: `${target.harness.id} has no permission modes of its own`,
          appliesFrom: "next-turn",
        })
      }
      return noStoreJson(c, state)
    })
    .get("/session/:id/permission-mode", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "permission_mode_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const runtime = await opts.runtime(c)
      // No `unsupportedIfUnavailable` here, unlike the neighbouring routes: a
      // transport without the group is a harness with no mode surface, and the
      // picker needs to say WHICH harness and why rather than render a generic
      // unsupported-operation error where a list belongs.
      const state = await runtime.reads.permissionModes({ sessionId, ...(directory ? { directory } : {}) })
      if (!state) {
        const caps = await runtime.reads.capabilities({ sessionId, ...(directory ? { directory } : {}) })
        return noStoreJson(c, {
          modes: [],
          unsupported: `${caps.harness} has no permission modes of its own`,
          appliesFrom: "next-turn",
        })
      }
      return noStoreJson(c, state)
    })
    .put("/session/:id/permission-mode", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "permission_mode_write")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const runtime = await opts.runtime(c)
      const target = { sessionId, ...(directory ? { directory } : {}) } satisfies HarnessTarget
      const caps = await runtime.reads.capabilities(target)
      if (!caps.configOptions) {
        return unsupportedOperation(c, caps, "set_permission_mode", {
          capability: "permissions",
          reason: "adapter_method_unavailable",
          message: `${caps.harness} cannot be told about permission modes`,
        })
      }
      const modeId = str((await boundedJsonRecord(c)).modeId) ?? ""
      if (!modeId) return c.json({ error: "modeId is required" }, 400)
      const session = await readSession(opts, c, directory, sessionId)
      if (!session) return c.json(errorBody("session_not_found", "Session not found"), 404)
      const ceiling = await sessionPermissionCeiling(opts, c, directory, session)
      if (ceiling) {
        const permitted = await permissionModeUnderCeiling(c, runtime, target, ceiling, modeId)
        if (permitted.refusal) return permitted.refusal
      }
      // The transport's own read-back is returned verbatim. A harness that kept
      // a different mode than the one requested must reach the client as the
      // mode it kept, not as an echo of the request.
      try {
        const state = await runtime.reads.setPermissionMode(sessionId, modeId, directory)
        if (!state) {
          return unsupportedOperation(c, caps, "set_permission_mode", {
            capability: "permissions",
            reason: "adapter_method_unavailable",
            message: `${caps.harness} cannot be told about permission modes`,
          })
        }
        return c.json(state)
      } catch (error) {
        // A mode this harness does not offer is BAD INPUT, not a server fault.
        // Every transport rejects an unknown id by throwing — silently accepting
        // one would store a mode the harness will never honour — and left to
        // escape that throw is a 500, which reads as "the runtime broke" and
        // sends debugging to the wrong layer.
        const message = error instanceof Error ? error.message : String(error)
        if (/does not offer|unknown permission mode/i.test(message)) {
          return c.json({ error: { code: "unknown_permission_mode", message } }, 400)
        }
        throw error
      }
    })
    .post("/session/:id/revert", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "revert")
      if (guarded) return guarded
      return notImplemented(c, "revert")
    })
    .post("/session/:id/unrevert", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "unrevert")
      if (guarded) return guarded
      return notImplemented(c, "unrevert")
    })
    .post("/session/:id/fork", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "fork")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const runtime = await opts.runtime(c)
      const unsupported = await unsupportedIfUnavailable(c, runtime, { sessionId, ...(directory ? { directory } : {}) }, "fork", "fork")
      if (unsupported) return unsupported
      const wire = await boundedJsonRecord(c)
      const body = { id: str(wire.id), messageId: str(wire.messageId) }
      const operationId = registrationOperationId(c)
      if (managedSessionLifecycle(opts, c) && (!body.id || !operationId)) {
        return c.json(errorBody(
          "session_reservation_required",
          "Managed session forks require a preassigned child session id and reservation operation",
        ), 400)
      }
      if (body.id && operationId) {
        const refused = await creationReservationGuard(opts, c, body.id, operationId)
        if (refused) return refused
      }
      const child = await runtime.sessions.fork(sessionId, body.messageId ?? "", body.id, directory)
      const registration = await registerCreatedSession(opts, c, child.id, operationId)
      if (registration.kind === "ambiguous") return registration.response
      if (registration.kind === "denied") {
        await compensateRegistration({
          opts,
          c,
          directory,
          sessionId: child.id,
          operationId: operationId!,
          reason: `registration_denied_${registration.response.status}`,
        })
        return registration.response
      }
      try {
        await after(opts.afterCreateSession?.(c, directory, child))
      } catch (error) {
        if (managedSessionLifecycle(opts, c)) {
          await compensateRegistration({
            opts,
            c,
            directory,
            sessionId: child.id,
            operationId: operationId!,
            reason: `post_create_projection_failed: ${errorMessage(error)}`,
          })
        } else {
          await rollbackCreatedSession(opts, c, directory, child.id, error)
        }
        throw error
      }
      return c.json(child, 201)
    })
    .post("/session/:id/command", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "command")
      if (guarded) return guarded
      return notImplemented(c, "command")
    })
    .post("/session/:id/shell", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "shell")
      if (guarded) return guarded
      return notImplemented(c, "shell")
    })
    .post("/session/:id/summarize", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "summarize")
      if (guarded) return guarded
      return notImplemented(c, "summarize")
    })
    .get("/session/:id/queue", async (c) => {
      const id = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, id, "queue_read")
      if (guarded) return guarded
      return c.json((opts.queuedPrompts?.list(id) ?? []).map(({ seq, parts, messageId, queuedAt, held, steering }) => ({ seq, parts, messageId, queuedAt, held, steering })))
    })
    .post("/session/:id/queue/:seq/:action", async (c) => {
      const id = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, id, "prompt")
      if (guarded) return guarded
      const action = queuedPromptAction(c.req.param("action"), await boundedJsonBody(c))
      if (!action) return c.json(errorBody("queue_action_unknown", "Unknown queue action"), 400)
      const result = await opts.queuedPrompts?.control(id, Number(c.req.param("seq")), action)
      if (!result) return c.json(errorBody("queue_unavailable", "Queue is unavailable"), 409)
      if (result.ok) return c.json(result)
      return c.json({ ...result, ...errorBody(`queue_${result.status}`, result.message) }, result.status === "pending" || result.status === "unknown" ? 202 : result.status === "provider_owned" ? 423 : 409)
    })
    .post("/session/:id/prompt_async", async (c) => {
      const id = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, id, "prompt")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId: id })
      if (!await readSession(opts, c, directory, id)) return c.json(sessionNotFound(), 404)
      const parsedBody = parseSessionPromptBody(await boundedJsonBody(c))
      const body = await opts.transformPromptBody?.(c, { sessionId: id, directory, body: parsedBody }) ?? parsedBody
      const permissionRefusal = await rejectPermissionOverride(opts, c, directory, id, body.permissionMode)
      if (permissionRefusal) return permissionRefusal
      let settleAdmissionAnswer: ((response: Response) => void) | undefined
      if (body.messageID) {
        const pending = promptAdmissions.get(id)?.get(body.messageID)
        if (pending) return (await pending).clone()
        const admissions = promptAdmissions.get(id) ?? new Map<string, Promise<Response>>()
        admissions.set(body.messageID, new Promise<Response>((resolve) => {
          settleAdmissionAnswer = resolve
        }))
        promptAdmissions.set(id, admissions)
      }
      // A stored answer outlives its request, so it must not survive a
      // failure that happens before the harness is asked to run anything:
      // the retry that arrives once the cause is gone would join the stale
      // failure and the turn would never run.
      let admittedForExecution = false
      const admit = async (): Promise<Response> => {
        const runtime = await opts.runtime(c)
        if (body.messageID && c.req.header("x-claxedo-idempotency-retry") === "1") {
          const messages = await opts.getMessages?.(c, directory, id) ?? await runtime.events.list(id, directory)
          const projected = messages.some((message) => asRecord(message.info)?.id === body.messageID)
          const session = projected
            ? undefined
            : await readSession(opts, c, directory, id)
          if (
            projected
            || session?.status === "busy"
            || session?.status === "recovering"
            || session?.status === "retry"
          ) {
            admittedForExecution = true
            return c.body(null, 204)
          }
        }
        body.messageID ??= `msg_${randomUUID()}`
        if (body.delivery && !opts.queuedPrompts) {
          return c.json({ error: "Queued delivery requires a durable runtime owner" }, 409)
        }
        const access = sessionAccessContext(c)
        if (body.delivery) {
          if (!opts.queuedPrompts) return c.json({ error: "Queued delivery requires a durable runtime owner" }, 409)
          const requester = await queuedPromptRequester(opts, c, id, body.messageID)
          if ("refused" in requester) return requester.refused
          const submission = { sessionId: id, body, ...requester }
          if (body.delivery === "queue") {
            try { opts.queuedPrompts.queue(submission) }
            catch (error) { return c.json({ error: streamTurnErrorMessage(error) }, 503) }
            admittedForExecution = true
            return c.json({ delivery: "queue" })
          }
          const result = await opts.queuedPrompts.steer(submission)
          admittedForExecution = true
          if (result.ok) return c.json({ delivery: "steer" })
          return c.json({ ...result, error: result.message }, result.status === "pending" || result.status === "unknown" ? 202 : 409)
        }
        const lostTurn = captureTurnTarget()
        const turnAdmission = await acquireManagedPromptLease({
          opts,
          c,
          sessionId: id,
          turnId: body.messageID,
          onLost: () => containLostTurn({ runtime: runtime.recovery, sessionId: id, target: lostTurn.get(), caller: recoveryCaller(c) }),
        })
        if (turnAdmission.rejected) return turnAdmission.rejected
        let settleAdmission: ((error?: unknown) => void) | undefined
        const admission = new Promise<unknown>((resolve) => {
          settleAdmission = resolve
        })
        const runTurn: () => Promise<SessionPromptTurnResult> = () => runRuntimePromptTurn({
          runtime,
          sessionId: id,
          directory,
          body,
          origin: turnOriginOf(sessionTurnOrigin(c), sessionOwner(c)),
          publishGlobal: opts.publishGlobal,
          createActiveTurnScope: opts.createActiveTurnScope
            ? () => turnScope(opts.createActiveTurnScope?.({ c, directory, sessionId: id }), turnAdmission.lease)
            : undefined,
          ...(turnAdmission.lease ? { turnAdmission: turnAdmission.lease } : {}),
          streamErrorMessage: streamTurnErrorMessage,
          onTurnTarget: lostTurn.set,
          onAdmissionSettled: settleAdmission,
          actor: access.actor,
          author: access.author,
        })
        await opts.childSessions?.onTurnStarted(id, directory)
        // The turn runs detached: the response must not wait for the model. The
        // IIFE has its own catch/finally, so nothing here can reject unobserved.
        admittedForExecution = true
        void (async () => {
          try {
            const turn = await runTurn()
            if (!turnAdmission.lease?.lost()) {
              await after(opts.afterMessageCheckpoint?.(c, directory, id, turn.messages))
            }
          } catch (error) {
            settleAdmission?.(error)
            if (isAgentRuntimeTurnConflictError(error)) return
            // The real message goes through sessionError (→ firstTurnErrorData)
            // so it classifies (unmatched → "unknown") and the original text
            // reaches the raw-detail disclosure.
            opts.publishGlobal(withDir(compatScope(directory, id), sessionError(streamTurnErrorMessage(error), id)))
          } finally {
            const leaseLost = turnAdmission.lease?.lost() ?? false
            if (!leaseLost) {
              await flushDocumentsAfterTurn(opts, id)
              if (opts.afterMessageCheckpoint) {
                await after(opts.afterMessageCheckpoint(c, directory, id, await runtime.events.list(id, directory)))
              }
            }
            await turnAdmission.lease?.release().catch(() => undefined)
            await settleChildTurn(opts, id, directory)
          }
        })()
        const admissionError = await awaitAdmissionAck(admission)
        // Admission did not settle within the bound — honor prompt_async's
        // fire-and-forget contract rather than block on a wedged turn.
        if (admissionError === ADMISSION_ACK_TIMED_OUT) return c.body(null, 204)
        if (isAgentRuntimeTurnConflictError(admissionError)) {
          releasePromptAdmission(id, body.messageID)
          return turnAdmissionConflict(c)
        }
        return c.body(null, 204)
      }
      try {
        const answer = await admit()
        settleAdmissionAnswer?.(answer.clone())
        return answer
      } catch (error) {
        settleAdmissionAnswer?.(requestErrorResponse(error, c))
        throw error
      } finally {
        if (!admittedForExecution) releasePromptAdmission(id, body.messageID)
      }
    })
    .get("/agent", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const runtime = await opts.runtime(c)
      const target = draftTarget(opts, c, directory)
      try {
        const agents = await runtime.reads.agents(target)
        if (!agents) {
          const caps = await runtime.reads.capabilities(target)
          return unsupportedOperation(c, caps, "list_agents", {
            capability: "agents",
            reason: "adapter_method_unavailable",
            message: `${caps.harness} does not expose live agent options`,
          })
        }
        return c.json(agents)
      } catch (err) {
        if (unsupportedLiveAgentListError(err)) return c.json([])
        return engineRefusalResponse(c, err)
      }
    })
    .get("/permission", async (c) => {
      const directory = await opts.resolveDirectory(c)
      let rows: AgentPermission[]
      try {
        rows = await (await opts.runtime(c)).permissions.list(directory ?? "")
      } catch (error) {
        return engineRefusalResponse(c, error)
      }
      return c.json(await filterSessionRows(opts, c, "permission_list", rows))
    })
    .get("/question", async (c) => {
      const directory = await opts.resolveDirectory(c)
      let rows: AgentQuestion[]
      try {
        rows = await (await opts.runtime(c)).questions.list(directory ?? "")
      } catch (error) {
        return engineRefusalResponse(c, error)
      }
      const sessionId = c.req.query("sessionId")
      const selected = sessionId ? rows.filter((row) => row.sessionID === sessionId) : rows
      const normal: AgentQuestion[] = []
      const pending: AgentQuestion[] = []
      for (const row of selected) {
        const start = opts.sessionStarts?.get(row.sessionID)
        if (!start || start.status === "created") normal.push(row)
        else if (start.status === "starting" && !await sessionStartGuard(opts, c, start.binding, "question_list")) pending.push(row)
      }
      return c.json([...await filterSessionRows(opts, c, "question_list", normal), ...pending])
    })
    .post("/session/:sessionId/permissions/:permId", async (c) => {
      const suppliedSessionId = c.req.param("sessionId")
      const permId = c.req.param("permId")
      const directory = await opts.resolveDirectory(c, { sessionId: suppliedSessionId })
      const runtime = await opts.runtime(c)
      const permission = (await runtime.permissions.list(directory ?? "")).find((item) => item.id === permId)
      const sessionId = permission?.sessionID
      if (!sessionId) return interactionNotFound(c, "permission", permId)
      if (sessionId !== suppliedSessionId) return interactionSessionMismatch(c, "permission", permId)
      const unsupported = await unsupportedIfUnavailable(c, runtime, { sessionId, ...(directory ? { directory } : {}) }, "permissions", "permission_response")
      if (unsupported) return unsupported
      const guarded = await sessionOperationGuard(opts, c, sessionId, "permission_response")
      if (guarded) return guarded
      const body = await boundedJsonRecord(c)
      if (body.optionId !== undefined && (typeof body.optionId !== "string" || body.response !== undefined)) {
        return c.json({ error: "Provide an optionId or a response, not both" }, 400)
      }
      const optionId = typeof body.optionId === "string" ? body.optionId : undefined
      if (permission?.options !== undefined) {
        if (optionId === undefined || !permission.options.some((option) => option.id === optionId)) {
          return c.json({ error: "Choose one of the permission request's offered options" }, 400)
        }
      } else if (optionId !== undefined) {
        return c.json({ error: "This permission request does not offer provider options" }, 400)
      }
      const r = optionId !== undefined ? "once" : str(body.response) ?? "deny"
      const decision = r === "once" ? "allow_once" : r === "always" ? "allow_always" : "deny"
      try {
        const result = await runtime.permissions.respond(permId, decision, directory ?? "", optionId)
        return c.json({ ok: true, events: result.events })
      } catch (error) {
        return requestRefusedResponse(c, error)
      }
    })
    .post("/question/:id/reply", async (c) => {
      const admitted = await admitQuestionOperation(opts, c, "replyQuestion")
      if (admitted.rejected) return admitted.rejected
      const { id, sessionId } = admitted
      const body = rec(await boundedJsonBody(c))
      const answers = body && Object.keys(body).every((key) => key === "answers")
        ? questionAnswers(body.answers)
        : undefined
      if (!answers) return c.json({ error: "answers must be an array of string arrays" }, 400)
      try {
        await (await opts.runtime(c)).questions.answer(id, answers, sessionId, admitted.start)
      } catch (error) {
        const failure = elicitationError(error)
        if (failure) return c.json(failure.body, failure.status)
        return requestRefusedResponse(c, error)
      }
      return c.json({ ok: true })
    })
    .post("/question/:id/reject", async (c) => {
      const admitted = await admitQuestionOperation(opts, c, "rejectQuestion")
      if (admitted.rejected) return admitted.rejected
      const { id, sessionId } = admitted
      try {
        await (await opts.runtime(c)).questions.reject(id, sessionId, admitted.start)
      } catch (error) {
        return requestRefusedResponse(c, error)
      }
      return c.json({ ok: true })
    })

  if (opts.exposeCommandRoute !== false) {
    app.get("/command", async (c) => {
      const directory = await opts.resolveDirectory(c)
      try {
        return c.json(await (await opts.runtime(c)).reads.commands(draftTarget(opts, c, directory)) ?? [])
      } catch (error) {
        return engineRefusalResponse(c, error)
      }
    })
  }

  return app
}

function queuedPromptAction(action: string, body: unknown): QueuedPromptAction | undefined {
  if (action === "cancel" || action === "steer" || action === "hold" || action === "release") return action
  if (action !== "replace") return undefined
  const parts = parseSessionPromptBody(body).parts
  return parts?.length ? { replace: parts } : undefined
}
