import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type {
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentRuntime,
  AgentSession,
  RuntimeDirectory,
  SessionConfig,
  SessionConfigRequestUpdate,
  SessionModelGroup,
  HarnessCapabilities,
  AgentGoalMutationResult,
} from "@claxedo/agent-sdk-runtime"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import type {
  AgentHarnessAdapter,
  AgentMessagePage,
  AgentMessagePageInput,
} from "@claxedo/agent-sdk-runtime/adapters"
import { AgentMessagePageError, hasAdapterCapability } from "@claxedo/agent-sdk-runtime/adapters"
import { admitSessionInstructions } from "@claxedo/agent-sdk-runtime"
import {
  AGENT_RUNTIME_TURN_CONFLICT_CODE,
  isAgentRuntimeTurnConflictError,
} from "@claxedo/agent-sdk-runtime"
import {
  messageUpdated,
  permissionReplied,
  questionRejected,
  questionReplied,
  sessionError,
  sessionStatus,
  sessionUpdated,
  sessionDeleted,
  withDir,
  type CompatEvent,
  type CompatEnvelope,
} from "../compat-events"
import { recovering } from "@claxedo/agent-sdk-runtime/status"
import { isAgentRuntimeGoalError } from "@claxedo/agent-sdk-runtime"
import { attachSseFanout } from "@claxedo/agent-sdk-runtime/sse"
import {
  admitSessionPromptTurn,
  compatScope,
  runRuntimePromptTurn,
  runSessionPromptTurn,
  sessionPromptReply,
  sessionTurnRefusal,
  sessionTurnRefused,
  type ActiveTurnScope,
  type AdmittedSessionPromptTurn,
  type RuntimeSessionBusEvent,
  parseSessionPromptBody,
  type SessionPromptBody,
  type SessionPromptTurnResult,
  type SessionTurnRefusalCode,
} from "../session/service"
import {
  normalizeSessionConfigUpdate,
  normalizeSessionCreateConfig,
  normalizeSessionCreateBody,
  sessionCreateGroup,
} from "../session-config"
import { MAX_ACTIVE_CHILDREN_PER_PARENT, type ChildSessionHost } from "./session-children"
import {
  narrowerPermissionLevel,
  permissionCeilingAdmits,
  permissionModeLevel,
  widestPermissionModeUnder,
  type AgentPermissionMode,
  type AgentPermissionModeState,
  type AutoLevel,
} from "@claxedo/agent-sdk-runtime"
import { arr, bool, num, rec, str } from "../json-value"
import { disposeRuntimeSessionDocuments, flushRuntimeSessionDocuments } from "./document-hydration"
import {
  managedWorkspaceSessionAccessPolicy,
  sessionAccessContext,
  sessionAccessDenied,
  type SessionAccessDecision,
  type SessionAccessOperation,
  type SessionAccessPolicy,
} from "../session-access-policy"
import {
  createIdentityAwareEventSource,
  eventDeliveryPrincipal,
  sessionEventDeliveryPolicy,
} from "../event-delivery"
import {
  authorizeSessionEventScope,
  isSessionEventScopeResponse,
  scopedReplay,
  waitForSessionEventStream,
  unknownEventSessionId,
} from "./session-event-privacy"
import {
  acquireSessionTurnLease,
  type ActiveSessionTurnLease,
} from "./session-turn-lease"
import { EVENT_STREAM_HEARTBEAT_MS } from "@claxedo/agent-event-runtime"
import { SessionRollbackError } from "../session-rollback-error"
import { WorkspaceHarnessUnavailableError } from "../harness-unavailable-error"
import { asRecord } from "@claxedo/helpers/guards"

export type { RuntimeSessionBusEvent } from "../session/service"

/**
 * Extract a human-safe headline from a turn/stream failure without discarding the cause.
 * The outermost message catch and the two prompt-turn helpers previously flattened every
 * failure to the literal "Stream error", throwing away the underlying message and any
 * classification it carried. Preserve the real message so `sessionError` →
 * `firstTurnErrorData` can classify it (unmatched → "unknown") and the client's raw-detail
 * disclosure can surface it.
 */
export function streamTurnErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Stream error"
}

export type SessionLifecycleEvent = {
  type: "session.lifecycle"
  phase: "creating" | "created" | "failed"
  directory?: string
  sessionID?: string
  workspaceId?: string
  draftId?: string
  info?: unknown
  message?: string
  ts: number
}

type SessionBus = {
  publish: (event: RuntimeSessionBusEvent) => void
  subscribe: (fn: (event: unknown) => void) => () => void
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
  adapter?: AgentHarnessAdapter,
) {
  if (opts.getSession) return await opts.getSession(c, directory, sessionId) ?? undefined
  const resolvedAdapter = adapter ?? await opts.resolveAdapter(c, { sessionId, directory })
  const session = await resolvedAdapter.getSession(await requireExecutionBinding(opts, c, directory, sessionId, resolvedAdapter))
  return session ?? undefined
}

async function requireExecutionBinding(
  opts: Opts,
  c: Ctx,
  directory: RuntimeDirectory,
  sessionId: string,
  adapter: AgentHarnessAdapter,
) {
  const binding = await opts.resolveExecutionBinding?.(c, directory, sessionId, adapter)
  if (!binding) throw new HTTPException(409, { message: `Session ${sessionId} has no complete execution binding` })
  return binding
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
  const adapter = await opts.resolveAdapter(c, { sessionId: parent.id, directory })
  const state = adapter.listPermissionModes
    ? await adapter.listPermissionModes(await requireExecutionBinding(opts, c, directory, parent.id, adapter))
    : undefined
  const parentLevel = inheritedPermissionLevel(state)
  if (!parentLevel) return declared
  return declared ? narrowerPermissionLevel(parentLevel, declared) : parentLevel
}

/** Resolve the persisted ceiling and the current parent restriction for mutations. */
async function sessionPermissionCeiling(opts: Opts, c: Ctx, directory: RuntimeDirectory, session: AgentSession, adapter: AgentHarnessAdapter) {
  const config = opts.getSessionConfig
    ? await opts.getSessionConfig(c, directory, session.id, adapter)
    : await adapter.getSessionConfig(await requireExecutionBinding(opts, c, directory, session.id, adapter))
  const parent = session.parentID ? await readSession(opts, c, directory, session.parentID) : undefined
  if (session.parentID && !parent) throw new HTTPException(403, { message: "Parent session not found" })
  return effectivePermissionCeiling(opts, c, directory, parent ?? undefined, config.permissionCeiling)
}

async function rejectPermissionOverride(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string, adapter: AgentHarnessAdapter, modeId: string | undefined) {
  if (!modeId) return undefined
  const session = await readSession(opts, c, directory, sessionId, adapter)
  if (!session) return c.json(errorBody("session_not_found", "Session not found"), 404)
  const ceiling = await sessionPermissionCeiling(opts, c, directory, session, adapter)
  if (!ceiling) return undefined
  return (await permissionModeUnderCeiling(c, adapter, directory, ceiling, modeId)).refusal
}

/**
 * The mode the new session starts in. A requested mode that widens the
 * ceiling is refused; with none requested the widest mode under the ceiling is
 * chosen, so a child never inherits a harness default above its parent.
 */
async function permissionModeUnderCeiling(
  c: Ctx,
  adapter: AgentHarnessAdapter,
  directory: RuntimeDirectory,
  ceiling: AutoLevel | undefined,
  requested: string | undefined,
): Promise<{ mode?: AgentPermissionMode; refusal?: Response }> {
  if (!requested && !ceiling) return {}
  if (!adapter.listDraftPermissionModes || !adapter.setPermissionMode) {
    if (ceiling) return { refusal: c.json(errorBody("permission_ceiling_unsupported", `This harness cannot enforce the ${ceiling} permission ceiling`), 403) }
    return { refusal: c.json(errorBody("permission_mode_unsupported", "This harness cannot be told about permission modes"), 400) }
  }
  const modes = (await adapter.listDraftPermissionModes(directory)).modes
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
) {
  if (!opts.childSessions) return
  for (const child of await opts.childSessions.children(parentSessionId, directory)) {
    const childSessionId = child.childSessionId
    if (!await readSession(opts, c, directory, childSessionId)) continue
    const childAdapter = await opts.resolveAdapter(c, { sessionId: childSessionId, directory })
    const binding = await requireExecutionBinding(opts, c, directory, childSessionId, childAdapter)
    if (action === "delete") {
      await opts.beforeDeleteSession?.(c, directory, childSessionId)
      await disposeRuntimeSessionDocuments(childSessionId)
      await childAdapter.deleteSession(binding)
      await after(opts.afterDeleteSession?.(c, directory, childSessionId))
      opts.publishGlobal(withDir(compatScope(directory, childSessionId), sessionDeleted(childSessionId, directory ?? "")))
      continue
    }
    await childAdapter.abort?.(binding).catch(() => undefined)
    const body = { time: { archived: updates.archived ?? Date.now() } }
    const session = await childAdapter.updateSession(binding, body)
    if (!session) continue
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

function messagePageInput(c: Ctx): AgentMessagePageInput | undefined {
  const view = c.req.query("view")
  const limit = c.req.query("limit")
  const before = c.req.query("before")
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
 * is a literal union. Recognising the number against this list produces one
 * honestly; the call sites used to assert it.
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

function publishInteractionEvents(
  publish: (event: CompatEnvelope) => void,
  directory: RuntimeDirectory,
  sessionId: string,
  events: CompatEvent[] | undefined,
  fallback: CompatEvent,
) {
  for (const event of events?.length ? events : [fallback]) {
    publish(withDir(compatScope(directory, sessionId), event))
  }
}

type Opts = {
  resolveAdapter: (
    c: Ctx,
    input?: {
      sessionId?: string
      directory?: string
    },
  ) => Promise<AgentHarnessAdapter> | AgentHarnessAdapter
  resolveRuntime?: (
    c: Ctx,
    input?: {
      sessionId?: string
      directory?: string
    },
  ) => Promise<AgentRuntime | undefined> | AgentRuntime | undefined
  resolveExecutionBinding?: (
    c: Ctx,
    directory: RuntimeDirectory,
    sessionId: string,
    adapter: AgentHarnessAdapter,
  ) => Promise<AgentExecutionBinding | undefined> | AgentExecutionBinding | undefined
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
  createSession?: (c: Ctx, directory: RuntimeDirectory, title?: string, id?: string, create?: { parentID?: string; permissionCeiling?: SessionConfig["permissionCeiling"]; instructions?: string; group?: SessionModelGroup }) => Promise<{ id: string }>
  /** Host-owned child sessions: admission on the parent, idempotent ids, completion wakes. */
  childSessions?: ChildSessionHost
  listPermissions?: (c: Ctx, directory: RuntimeDirectory) => Promise<AgentPermission[]>
  /** Workspace inventory, unfiltered by caller-supplied session IDs; routes validate ownership. */
  listQuestions?: (c: Ctx, directory: RuntimeDirectory) => Promise<AgentQuestion[]>
  /**
   * A status payload, or a `Response` the route forwards verbatim. Awaited by
   * the route, so an async implementation is fine.
   */
  getStatus?: (c: Ctx, directory: RuntimeDirectory) => unknown
  afterListSessions?: (c: Ctx, directory: RuntimeDirectory, sessions: AgentSession[]) => Promise<void> | void
  afterCreateSession?: (c: Ctx, directory: RuntimeDirectory, session: unknown) => Promise<void> | void
  getSession?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<AgentSession | null> | AgentSession | null
  afterGetSession?: (c: Ctx, directory: RuntimeDirectory, session: unknown) => Promise<void> | void
  getSessionConfig?: (c: Ctx, directory: RuntimeDirectory, sessionId: string, adapter: AgentHarnessAdapter) => Promise<SessionConfig>
  requestedSessionHarness?: (c: Ctx) => SessionConfig["harness"] | undefined
  getTodos?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<unknown[] | undefined> | unknown[] | undefined
  updateSessionConfig?: (
    c: Ctx,
    directory: RuntimeDirectory,
    sessionId: string,
    update: SessionConfigRequestUpdate,
    adapter: AgentHarnessAdapter,
  ) => Promise<SessionConfig>
  switchSessionHarness?: (
    c: Ctx,
    directory: RuntimeDirectory,
    sessionId: string,
    update: SessionConfigRequestUpdate,
    adapter: AgentHarnessAdapter,
  ) => Promise<SessionConfig>
  getMessages?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<AgentMessage[] | undefined> | AgentMessage[] | undefined
  getMessagePage?: (
    c: Ctx,
    directory: RuntimeDirectory,
    sessionId: string,
    page: AgentMessagePageInput,
    adapter: AgentHarnessAdapter,
  ) => Promise<AgentMessagePage | undefined> | AgentMessagePage | undefined
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
  sessionBus: SessionBus
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
    adapter: AgentHarnessAdapter
    directory: RuntimeDirectory
    sessionId: string
  }) => ActiveTurnScope | undefined
  transformPromptBody?: (
    c: Ctx,
    input: { sessionId: string; directory: RuntimeDirectory; body: SessionPromptBody },
  ) => Promise<SessionPromptBody> | SessionPromptBody
}

const DRAFT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Apply an optional per-turn permission mode before a direct harness prompt. */
async function applyTurnPermissionMode(input: {
  adapter: AgentHarnessAdapter
  binding: AgentExecutionBinding
  modeId?: string
}) {
  if (!input.modeId || !input.adapter.setPermissionMode) return
  try {
    await input.adapter.setPermissionMode(input.binding, input.modeId)
  } catch {
    // A stale mode should not prevent the user's prompt from running under the
    // harness's current mode. The explicit permission-mode endpoint still
    // reports invalid mode changes synchronously.
  }
}

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

/**
 * The one JSON request-body read in these routes.
 *
 * Hono types `c.req.json()` as `any` and rejects on an absent or malformed
 * body, so every route repeated `(await c.req.json().catch(() => ({}))) as
 * Shape` — an assertion promising a shape nobody had checked. Reading it here
 * hands back an inspectable record; handlers pick fields through the
 * `json-value` narrowers, so `{"command": 42}` no longer reaches an adapter
 * that believes it holds a string.
 */
async function requestBody(c: Ctx): Promise<Record<string, unknown>> {
  const parsed: unknown = await c.req.json().catch(() => undefined)
  return rec(parsed) ?? {}
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

function errorBody(code: string, message: string) {
  return {
    error: { code, message },
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Session creation failed"
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

async function resolveGoalRuntime(
  opts: Opts,
  c: Ctx,
  sessionId: string,
  directory: RuntimeDirectory,
) {
  const runtime = await opts.resolveRuntime?.(c, { sessionId, directory })
  if (runtime) return runtime
  return noStoreJson(c, errorBody("goal_runtime_unavailable", "Goal runtime is unavailable"), 503)
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
    const sessionId = c.req.param("id")
    const guarded = await sessionOperationGuard(opts, c, sessionId, operation)
    if (guarded) return guarded
    const directory = await opts.resolveDirectory(c, { sessionId })
    const runtime = await resolveGoalRuntime(opts, c, sessionId, directory)
    if (runtime instanceof Response) return runtime
    try {
      return await invoke({ c, sessionId, directory, runtime })
    } catch (error) {
      return goalRuntimeErrorResponse(c, error)
    }
  }
}

/**
 * A runtime with no default harness, or a connection it cannot run, is a
 * configuration state and not a fault. Left to escape it became a 500, which
 * every caller reads as "the runtime broke" and the MCP tools surfaced as a
 * bare `http_500`.
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

/**
 * The turn was refused before the harness was asked to run anything, so the
 * cause is external to it and the same message id may submit again once the
 * cause is gone. `code` is what carries that; the sentence beside it cannot.
 */
function turnRefused(c: Ctx, refusal: SessionTurnRefusalCode, message: string) {
  return c.json(errorBody(refusal, message), 503)
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

function managedRegistration(opts: Opts) {
  return opts.sessionAccessPolicy?.sessionAuthority === "managed-private"
}

function managedTurnAdmission(opts: Opts) {
  return opts.sessionAccessPolicy?.sessionAuthority === "managed-private"
}

async function acquireManagedPromptLease(input: {
  opts: Opts
  c: Ctx
  sessionId: string
  turnId?: string
  onLost: () => Promise<void> | void
}): Promise<{ lease?: ActiveSessionTurnLease; rejected?: Response }> {
  if (!managedTurnAdmission(input.opts)) return {}
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

async function stopLostTurn(
  runtime: AgentRuntime | undefined,
  adapter: AgentHarnessAdapter,
  sessionId: string,
  directory: RuntimeDirectory,
  binding: () => Promise<AgentExecutionBinding>,
) {
  if (runtime) {
    await runtime.turns.abort(sessionId, directory).catch(() => undefined)
    return
  }
  await adapter.abort?.(await binding()).catch(() => undefined)
}

function lostTurnResponse(sessionId: string) {
  return Response.json(errorBody(
    "session_turn_lease_lost",
    `Session ${sessionId} turn authority was lost before completion`,
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
  adapter: AgentHarnessAdapter
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
    await input.adapter.deleteSession(await requireExecutionBinding(input.opts, input.c, input.directory, input.sessionId, input.adapter))
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
  adapter: AgentHarnessAdapter,
  directory: RuntimeDirectory,
  key: CapabilityKey,
  method: keyof AgentHarnessAdapter,
  operation: string = key,
  sessionId?: string,
) {
  const caps = await adapter.readHarnessCapabilities(directory, sessionId ? { sessionId } : undefined)
  if (!caps[key]) return unsupportedOperation(c, caps, operation, { capability: key })
  if (typeof adapter[method] === "function") return undefined
  return unsupportedOperation(c, caps, operation, {
    capability: key,
    reason: "adapter_method_unavailable",
    message: `${caps.harness} advertised ${key} but did not provide ${method}`,
  })
}

function sameSessionHarness(a: SessionConfig["harness"], b: SessionConfig["harness"]) {
  return a.id === b.id && a.access === b.access
}

function harnessSwitchUnsupported(
  c: Ctx,
  caps: HarnessCapabilities,
  current: SessionConfig["harness"],
  requested: SessionConfig["harness"],
) {
  return unsupportedOperation(c, caps, "harness_switch", {
    capability: "session_harness",
    harness: current.id,
    reason: "harness_switch_not_supported",
    message: `${current.id} sessions cannot switch to ${requested.id} through session config patch`,
  })
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
  if (!managedRegistration(opts)) return { kind: "registered" }
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

async function rollbackCreatedSession(
  opts: Opts,
  c: Ctx,
  adapter: AgentHarnessAdapter,
  directory: RuntimeDirectory,
  sessionId: string,
  cause: unknown,
) {
  try {
    await adapter.deleteSession(await requireExecutionBinding(opts, c, directory, sessionId, adapter))
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

function sessionBusEventSessionId(event: unknown): string | undefined {
  const row = rec(event)
  const properties = rec(rec(row?.payload)?.properties)
  return str(row?.sessionId)
    ?? str(row?.sessionID)
    ?? (row?.type === "process.status" ? str(row.configId) : undefined)
    ?? str(properties?.sessionID)
    ?? str(properties?.sessionId)
}

function sensitiveSessionBusEvent(event: unknown) {
  const row = asRecord(event)
  return row?.type === "agent.lifecycle" && (typeof row.prompt === "string" || typeof row.lastAssistantMessage === "string")
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
  | { rejected: Response; id?: undefined; directory?: undefined; adapter?: undefined; sessionId?: undefined }
  | { rejected?: undefined; id: string; directory: RuntimeDirectory; adapter: AgentHarnessAdapter; sessionId: string }
> {
  const id = c.req.param("id")
  const requested = c.req.query("sessionId") ?? ""
  const directory = await opts.resolveDirectory(c)
  const known = interactionSessionId(await opts.listQuestions?.(c, directory) ?? [], id)
  if (known) {
    if (requested && requested !== known) return { rejected: interactionSessionMismatch(c, "question", id) }
    const guarded = await sessionOperationGuard(opts, c, known, "question_response")
    if (guarded) return { rejected: guarded }
    const adapter = await opts.resolveAdapter(c, { sessionId: known, directory })
    const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "questions", method, "question_response", known)
    if (unsupported) return { rejected: unsupported }
    return { id, directory, adapter, sessionId: known }
  }

  // When supplied, the runtime-wide listing is authoritative across harnesses.
  // An absent request cannot be revived by selecting the default adapter.
  if (opts.listQuestions) return { rejected: interactionNotFound(c, "question", id) }

  const adapter = await opts.resolveAdapter(c, { directory })
  const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "questions", method, "question_response")
  if (unsupported) return { rejected: unsupported }
  const sessionId = interactionSessionId(await adapter.listQuestions?.(directory) ?? [], id)
  if (!sessionId) return { rejected: interactionNotFound(c, "question", id) }
  if (requested && requested !== sessionId) return { rejected: interactionSessionMismatch(c, "question", id) }
  const guarded = await sessionOperationGuard(opts, c, sessionId, "question_response")
  if (guarded) return { rejected: guarded }
  return { id, directory, adapter, sessionId }
}

export function createSessionRoutes(opts: Opts) {
  const app = new Hono()
  // This map only deduplicates prompt_async retries by message id. The
  // per-session concurrency lease is owned by AgentRuntime and is deliberately
  // separate. Production Claxedo-managed message routes resolve AgentRuntime;
  // the Session V2 wildcard proxy, hosted gateway, and vendored OpenCode
  // engine have independent admission semantics outside this lease boundary.
  // The server's checkpoint-freeze middleware runs before these routes, so a
  // 423 response may preempt lease acquisition entirely.
  const promptAdmissions = new Map<string, Set<string>>()
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
  // then surfaces on the event stream, as it did before the admission fast-path.
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
  const sessionEventSource = createIdentityAwareEventSource({
    subscribe: opts.sessionBus.subscribe,
    policy: sessionEventDeliveryPolicy(opts.sessionAccessPolicy ?? managedWorkspaceSessionAccessPolicy()),
    sessionId: sessionBusEventSessionId,
    sensitive: sensitiveSessionBusEvent,
  })
  sessionEventSource.open({ mode: "unmanaged-local", connectionId: "local-replay" })
  // Wakes left pending by a previous process are re-offered on the first
  // request, once the host has a store and adapters to deliver them with.
  app.use("*", async (_c, next) => {
    void opts.childSessions?.recover()
    await next()
  })
  app
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
      const wire = await requestBody(c)
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
        const operationId = registrationOperationId(c)
        if (managedRegistration(opts) && (!body.id || !operationId)) {
          return c.json(errorBody(
            "session_reservation_required",
            "Managed session creation requires a preassigned session id and reservation operation",
          ), 400)
        }
        const config = normalizeSessionCreateConfig(wire)
        const draftId = parseDraftId(c.req.header("x-claxedo-draft-id"))
        const workspaceId = await opts.resolveWorkspaceId?.(c, directory)
        opts.publishSessionLifecycle?.({
          type: "session.lifecycle",
          phase: "creating",
          directory,
          ...(draftId ? { draftId } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ts: Date.now(),
        })
        try {
          const adapter = await opts.resolveAdapter(c)
          const refusal = admitSessionInstructions({
            ...(opts.requestedSessionHarness?.(c) ? { harness: opts.requestedSessionHarness(c)?.id } : {}),
            channel: adapter.instructionChannel,
            instructions: body.instructions,
          })
          if (refusal) {
            return refusal.reason === "no_instruction_channel"
              ? c.json(errorBody("session_instructions_unsupported", refusal.message), 501)
              : c.json(errorBody("session_instructions_too_large", refusal.message), 400)
          }
          if (config.model && hasAdapterCapability(adapter, "runtime-config")) {
            adapter.setModel(config.model.modelID === "default" ? "" : config.model.modelID)
          }
          const existing = body.id ? await readSession(opts, c, directory, body.id, adapter) : undefined
          const requestedHarness = opts.requestedSessionHarness?.(c)
          if (existing && requestedHarness) {
            const currentConfig = opts.getSessionConfig
              ? await opts.getSessionConfig(c, directory, existing.id, adapter)
              : await adapter.getSessionConfig(await requireExecutionBinding(opts, c, directory, existing.id, adapter))
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
            ? await sessionPermissionCeiling(opts, c, directory, existing, adapter)
            : await effectivePermissionCeiling(opts, c, directory, parent, undefined)
          const ceiling = inherited && body.permissionCeiling
            ? narrowerPermissionLevel(inherited, body.permissionCeiling)
            : inherited ?? body.permissionCeiling
          const childMode = await permissionModeUnderCeiling(c, adapter, directory, ceiling, body.permissionMode)
          if (childMode.refusal) return childMode.refusal
          const createOptions = {
            ...(body.instructions ? { instructions: body.instructions } : {}),
            ...(body.group ? { group: body.group } : {}),
          }
          let session = existing ?? (opts.createSession
            ? await opts.createSession(c, directory, body.title, body.id, { ...(body.parentID ? { parentID: body.parentID } : {}), ...(ceiling ? { permissionCeiling: ceiling } : {}), ...createOptions })
            : await adapter.createSession(directory, body.title, body.id, createOptions))
          if (Object.keys(config).length > 0) {
            try {
              if (opts.updateSessionConfig) {
                await opts.updateSessionConfig(c, directory, session.id, config, adapter)
              } else {
                await adapter.updateSessionConfig(await requireExecutionBinding(opts, c, directory, session.id, adapter), config)
              }
            } catch (error) {
              await rollbackCreatedSession(opts, c, adapter, directory, session.id, error)
              throw error
            }
          }
          let subagentKey: string | undefined
          try {
            if (childMode.mode) {
              await adapter.setPermissionMode!(await requireExecutionBinding(opts, c, directory, session.id, adapter), childMode.mode.id)
            }
            if (body.parentID && children) {
              const harness = requestedHarness ?? config.harness ?? (opts.getSessionConfig
                ? (await opts.getSessionConfig(c, directory, session.id, adapter)).harness
                : (await adapter.getSessionConfig(await requireExecutionBinding(opts, c, directory, session.id, adapter))).harness)
              subagentKey = (await children.admitCreated({
                parentSessionId: body.parentID,
                childSessionId: session.id,
                directory,
                harness: harness.id,
                ...(body.role ? { role: body.role } : {}),
                ...(body.title ? { title: body.title } : {}),
              })).subagentKey
            }
          } catch (error) {
            await rollbackCreatedSession(opts, c, adapter, directory, session.id, error)
            throw error
          }
          if (body.parentID && children) {
            const persisted = await readSession(opts, c, directory, session.id, adapter)
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
            await compensateRegistration({
              opts,
              c,
              adapter,
              directory,
              sessionId: session.id,
              operationId: operationId!,
              reason: `registration_denied_${registration.response.status}`,
            })
            opts.publishSessionLifecycle?.({
              type: "session.lifecycle",
              phase: "failed",
              directory,
              ...(draftId ? { draftId } : {}),
              ...(workspaceId ? { workspaceId } : {}),
              message: "Session creator registration was denied",
              ts: Date.now(),
            })
            return registration.response
          }
          try {
            await after(opts.afterCreateSession?.(c, directory, session))
          } catch (error) {
            if (managedRegistration(opts)) {
              await compensateRegistration({
                opts,
                c,
                adapter,
                directory,
                sessionId: session.id,
                operationId: operationId!,
                reason: `post_create_projection_failed: ${errorMessage(error)}`,
              })
            } else {
              await rollbackCreatedSession(opts, c, adapter, directory, session.id, error)
            }
            throw error
          }
          if (body.parentID && children) {
            opts.publishGlobal(withDir(compatScope(directory, session.id), sessionUpdated(session)))
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
          opts.publishSessionLifecycle?.({
            type: "session.lifecycle",
            phase: "failed",
            directory,
            ...(draftId ? { draftId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            message: errorMessage(error),
            ts: Date.now(),
          })
          // A create that was REFUSED carries its own status — an unknown harness
          // is a 400, an id that belongs to another workspace is a 409. Flattening
          // those into 500 tells the caller the runtime broke when in fact the
          // runtime declined, and a 500 is the one class of failure clients retry.
          if (error instanceof HTTPException) throw error
          return c.json(errorBody("session_create_failed", errorMessage(error)), 500)
        }
      }
      return body.parentID && children
        ? children.withCreation(body.parentID, directory, create)
        : create()
    })
    // Register the harness capability routes, both global
    // (`/session/capabilities`, no :id) and per-session
    // (`/session/:id/capabilities`) routes BEFORE the parameterised
    // `/session/:id` so Hono doesn't interpret "capabilities" as a
    // session id.
    .get("/session/capabilities", async (c) => {
      try {
        const adapter = await opts.resolveAdapter(c)
        const directory = await opts.resolveDirectory(c)
        return noStoreJson(c, await adapter.readHarnessCapabilities(directory))
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
        const adapter = await opts.resolveAdapter(c, { sessionId, directory })
        return noStoreJson(c, await adapter.readHarnessCapabilities(directory, { sessionId }))
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
      const body = await requestBody(c)
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
    .get("/session/:id/config", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_config_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const config = opts.getSessionConfig
        ? await opts.getSessionConfig(c, directory, sessionId, adapter)
        : await adapter.getSessionConfig(await requireExecutionBinding(opts, c, directory, sessionId, adapter))
      return noStoreJson(c, config)
    })
    .patch("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_meta_write")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const wire = await requestBody(c)
      const title = str(wire.title)
      const archived = num(rec(wire.time)?.archived)
      const body = {
        ...(title !== undefined ? { title } : {}),
        ...(archived !== undefined ? { time: { archived } } : {}),
      }
      const session = await adapter.updateSession(await requireExecutionBinding(opts, c, directory, sessionId, adapter), body)
      if (!session) return c.json(sessionNotFound(), 404)
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
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const wire = await requestBody(c)
      if ("group" in wire) {
        return c.json(errorBody(
          "session_group_immutable",
          "A session's model group is fixed at create and cannot be changed",
        ), 409)
      }
      const body = normalizeSessionConfigUpdate(wire)
      const requestedHarness = opts.requestedSessionHarness?.(c)
      if (requestedHarness) body.harness = requestedHarness
      if (body.harness) {
        const current = opts.getSessionConfig
          ? await opts.getSessionConfig(c, directory, sessionId, adapter)
          : await adapter.getSessionConfig(await requireExecutionBinding(opts, c, directory, sessionId, adapter))
        if (!sameSessionHarness(current.harness, body.harness)) {
          if (opts.switchSessionHarness) {
            return c.json(await opts.switchSessionHarness(c, directory, sessionId, body, adapter))
          }
          return harnessSwitchUnsupported(
            c,
            await adapter.readHarnessCapabilities(directory, { sessionId }),
            current.harness,
            body.harness,
          )
        }
      }
      const config = opts.updateSessionConfig
        ? await opts.updateSessionConfig(c, directory, sessionId, body, adapter)
        : await adapter.updateSessionConfig(await requireExecutionBinding(opts, c, directory, sessionId, adapter), body)
      return c.json(config)
    })
    .delete("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "delete")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      await cascadeToChildren(opts, c, directory, sessionId, "delete")
      await opts.beforeDeleteSession?.(c, directory, sessionId)
      await disposeRuntimeSessionDocuments(sessionId)
      await adapter.deleteSession(await requireExecutionBinding(opts, c, directory, sessionId, adapter))
      await after(opts.afterDeleteSession?.(c, directory, sessionId))
      opts.publishGlobal(withDir(compatScope(directory, sessionId), sessionDeleted(sessionId, directory ?? "")))
      return c.json({ ok: true })
    })
    .post("/session/:id/message", async (c) => {
      const id = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, id, "prompt")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId: id })
      const adapter = await opts.resolveAdapter(c, { sessionId: id, directory })
      const runtime = await opts.resolveRuntime?.(c, { sessionId: id, directory })
      const access = sessionAccessContext(c)
      const parsedBody = parseSessionPromptBody(await c.req.json().catch(() => undefined))
      const body = await opts.transformPromptBody?.(c, { sessionId: id, directory, body: parsedBody }) ?? parsedBody
      const permissionRefusal = await rejectPermissionOverride(opts, c, directory, id, adapter, body.permissionMode)
      if (permissionRefusal) return permissionRefusal
      const turnAdmission = await acquireManagedPromptLease({
        opts,
        c,
        sessionId: id,
        turnId: body.messageID,
        onLost: () => stopLostTurn(runtime, adapter, id, directory, () => requireExecutionBinding(opts, c, directory, id, adapter)),
      })
      if (turnAdmission.rejected) return turnAdmission.rejected
      if (!runtime) await applyTurnPermissionMode({ adapter, binding: await requireExecutionBinding(opts, c, directory, id, adapter), modeId: body.permissionMode })
      const activeTurn = runtime && opts.createActiveTurnScope
        ? turnScope(opts.createActiveTurnScope({ c, adapter, directory, sessionId: id }), turnAdmission.lease)
        : undefined
      await opts.childSessions?.onTurnStarted(id, directory)
      try {
        const turn = await (async () => {
        try {
          return runtime
            ? await runRuntimePromptTurn({
                runtime,
                sessionId: id,
                directory,
                body,
                publishGlobal: opts.publishGlobal,
                publishStatus: (event) => opts.sessionBus.publish(event),
                activeTurn,
                ...(turnAdmission.lease ? { turnAdmission: turnAdmission.lease } : {}),
                actor: access.actor,
                author: access.author,
              })
            : await runSessionPromptTurn({
                adapter,
                binding: await requireExecutionBinding(opts, c, directory, id, adapter),
                sessionId: id,
                directory,
                body,
                publishGlobal: opts.publishGlobal,
                publishStatus: (event) => opts.sessionBus.publish(event),
                createActiveTurnScope: opts.createActiveTurnScope
                  ? ({ adapter, directory, sessionId }) => turnScope(
                      opts.createActiveTurnScope?.({ c, adapter, directory, sessionId }),
                      turnAdmission.lease,
                    )
                  : undefined,
                ...(turnAdmission.lease ? { turnAdmission: turnAdmission.lease } : {}),
              })
        } finally {
          if (!turnAdmission.lease?.lost()) await flushDocumentsAfterTurn(opts, id)
          await settleChildTurn(opts, id, directory)
        }
        })()
        if (turnAdmission.lease?.lost() || (turnAdmission.lease && !turnAdmission.lease.valid())) {
          return lostTurnResponse(id)
        }
        await after(opts.afterMessageCheckpoint?.(c, directory, id, turn.messages))
        if (turnAdmission.lease?.lost() || (turnAdmission.lease && !turnAdmission.lease.valid())) {
          return lostTurnResponse(id)
        }
        const output = sessionPromptReply(turn)
        if (output.assistantMessage) opts.publishGlobal(withDir(turn.scope, messageUpdated(output.assistantMessage)))
        return c.json(output.body)
      } catch (error) {
        if (turnAdmission.lease?.lost()) return lostTurnResponse(id)
        if (isAgentRuntimeTurnConflictError(error)) return turnAdmissionConflict(c)
        throw error
      } finally {
        await turnAdmission.lease?.release().catch(() => undefined)
      }
    })
    .get("/session/:id/message", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "message_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const snapshotRequested = c.req.query("snapshot") === "1"
      const pageInput = snapshotRequested ? undefined : messagePageInput(c)
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
        const adapter = await opts.resolveAdapter(c, { sessionId, directory })
        try {
          const page = await opts.getMessagePage?.(c, directory, sessionId, pageInput, adapter)
          if (page) return messagePageResponse(c, page)
        } catch (error) {
          throwMessagePageError(error, 500)
        }
        if (adapter.getMessagePage) {
          try {
            return messagePageResponse(c, await adapter.getMessagePage(
              await requireExecutionBinding(opts, c, directory, sessionId, adapter),
              pageInput,
            ))
          } catch (error) {
            throwMessagePageError(error, 502)
          }
        }
        throw new HTTPException(501, { message: "message paging is not supported for this session" })
      }
      const replay = await opts.getMessages?.(c, directory, sessionId)
      if (replay) {
        if (!snapshotRequested) return noStoreJson(c, replay)
        const session = await readSession(opts, c, directory, sessionId)
        if (!session) return noStoreJson(c, sessionNotFound(), 404)
        return noStoreJson(c, { messages: replay, session: normalizeSession(session, directory) })
      }
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      if (snapshotRequested) {
        const [messages, session] = await Promise.all([
          adapter.getMessages(await requireExecutionBinding(opts, c, directory, sessionId, adapter)),
          readSession(opts, c, directory, sessionId, adapter),
        ])
        if (!session) return noStoreJson(c, sessionNotFound(), 404)
        return noStoreJson(c, { messages, session: normalizeSession(session, directory) })
      }
      return noStoreJson(c, await adapter.getMessages(await requireExecutionBinding(opts, c, directory, sessionId, adapter)))
    })
    .get("/session/:id/todo", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "todo_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const replay = await opts.getTodos?.(c, directory, sessionId)
      if (replay) return noStoreJson(c, replay)
      const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "todos", "getTodos", "todos")
      if (unsupported) return unsupported
      return noStoreJson(c, await adapter.getTodos!(await requireExecutionBinding(opts, c, directory, sessionId, adapter)))
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
      const adapter = await opts.resolveAdapter(c, { directory })
      if (!adapter.listDraftPermissionModes) {
        const caps = await adapter.readHarnessCapabilities(directory)
        return noStoreJson(c, {
          modes: [],
          unsupported: `${caps.harness} has no permission modes of its own`,
          appliesFrom: "next-turn",
        })
      }
      return noStoreJson(c, await adapter.listDraftPermissionModes(directory))
    })
    .get("/session/:id/permission-mode", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "permission_mode_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      // No `unsupportedIfUnavailable` here, unlike the neighbouring routes: an
      // adapter without the method is a harness with no mode surface, and the
      // picker needs to say WHICH harness and why rather than render a generic
      // unsupported-operation error where a list belongs.
      if (!adapter.listPermissionModes) {
        const caps = await adapter.readHarnessCapabilities(directory)
        return noStoreJson(c, {
          modes: [],
          unsupported: `${caps.harness} has no permission modes of its own`,
          appliesFrom: "next-turn",
        })
      }
      return noStoreJson(c, await adapter.listPermissionModes(
        await requireExecutionBinding(opts, c, directory, sessionId, adapter),
      ))
    })
    .put("/session/:id/permission-mode", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "permission_mode_write")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      if (!adapter.setPermissionMode) {
        const caps = await adapter.readHarnessCapabilities(directory)
        return unsupportedOperation(c, caps, "set_permission_mode", {
          capability: "permissions",
          reason: "adapter_method_unavailable",
          message: `${caps.harness} cannot be told about permission modes`,
        })
      }
      const modeId = str((await requestBody(c)).modeId) ?? ""
      if (!modeId) return c.json({ error: "modeId is required" }, 400)
      const session = await readSession(opts, c, directory, sessionId, adapter)
      if (!session) return c.json(errorBody("session_not_found", "Session not found"), 404)
      const ceiling = await sessionPermissionCeiling(opts, c, directory, session, adapter)
      if (ceiling) {
        const permitted = await permissionModeUnderCeiling(c, adapter, directory, ceiling, modeId)
        if (permitted.refusal) return permitted.refusal
      }
      // The adapter's own read-back is returned verbatim. A harness that kept a
      // different mode than the one requested must reach the client as the mode
      // it kept, not as an echo of the request.
      try {
        return c.json(await adapter.setPermissionMode(
          await requireExecutionBinding(opts, c, directory, sessionId, adapter),
          modeId,
        ))
      } catch (error) {
        // A mode this harness does not offer is BAD INPUT, not a server fault.
        // Every adapter rejects an unknown id by throwing (that rejection is
        // deliberate — silently accepting one would store a mode the harness
        // will never honour), and without this the throw surfaced as a 500,
        // which reads as "the runtime broke" and sends debugging to the wrong layer.
        const message = error instanceof Error ? error.message : String(error)
        if (/does not offer|unknown permission mode/i.test(message)) {
          return c.json({ error: { code: "unknown_permission_mode", message } }, 400)
        }
        throw error
      }
    })
    .post("/session/:id/abort", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "abort")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "abort", "abort")
      if (unsupported) return unsupported
      const runtime = await opts.resolveRuntime?.(c, { sessionId, directory })
      const result = runtime
        ? await runtime.turns.abort(sessionId, directory)
        : await adapter.abort!(await requireExecutionBinding(opts, c, directory, sessionId, adapter))
      if (result.status === "recovering") {
        opts.publishGlobal(withDir(compatScope(directory, sessionId), sessionStatus(sessionId, recovering(result.message))))
      }
      return c.json(result)
    })
    .post("/session/:id/revert", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "revert")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "revert", "revert")
      if (unsupported) return unsupported
      await adapter.revert!(await requireExecutionBinding(opts, c, directory, sessionId, adapter))
      return c.json({ ok: true })
    })
    .post("/session/:id/unrevert", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "unrevert")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "unrevert", "unrevert")
      if (unsupported) return unsupported
      await adapter.unrevert!(await requireExecutionBinding(opts, c, directory, sessionId, adapter))
      return c.json({ ok: true })
    })
    .post("/session/:id/fork", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "fork")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "fork", "forkSession", "fork", sessionId)
      if (unsupported) return unsupported
      const wire = await requestBody(c)
      const body = { id: str(wire.id), messageId: str(wire.messageId) }
      const operationId = registrationOperationId(c)
      if (managedRegistration(opts) && (!body.id || !operationId)) {
        return c.json(errorBody(
          "session_reservation_required",
          "Managed session forks require a preassigned child session id and reservation operation",
        ), 400)
      }
      const child = await adapter.forkSession!(await requireExecutionBinding(opts, c, directory, sessionId, adapter), body.messageId ?? "", body.id)
      const registration = await registerCreatedSession(opts, c, child.id, operationId)
      if (registration.kind === "ambiguous") return registration.response
      if (registration.kind === "denied") {
        await compensateRegistration({
          opts,
          c,
          adapter,
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
        if (managedRegistration(opts)) {
          await compensateRegistration({
            opts,
            c,
            adapter,
            directory,
            sessionId: child.id,
            operationId: operationId!,
            reason: `post_create_projection_failed: ${errorMessage(error)}`,
          })
        } else {
          await rollbackCreatedSession(opts, c, adapter, directory, child.id, error)
        }
        throw error
      }
      return c.json(child, 201)
    })
    .post("/session/:id/command", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "command")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "commands", "executeCommand", "command")
      if (unsupported) return unsupported
      const body = await requestBody(c)
      await adapter.executeCommand!(
        await requireExecutionBinding(opts, c, directory, sessionId, adapter),
        str(body.command) ?? "",
      )
      return c.json({ ok: true })
    })
    .post("/session/:id/shell", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "shell")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "commands", "shell", "shell")
      if (unsupported) return unsupported
      const body = await requestBody(c)
      const shellModel = rec(body.model)
      const providerID = str(shellModel?.providerID)
      const modelID = str(shellModel?.modelID)
      const shellMessageID = str(body.messageID)
      await adapter.shell!(sessionId, {
        command: str(body.command) ?? "",
        agent: str(body.agent) ?? "",
        ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
        ...(shellMessageID ? { messageID: shellMessageID } : {}),
      }, directory)
      return c.json({ ok: true })
    })
    .post("/session/:id/summarize", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "summarize")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "commands", "summarize", "summarize")
      if (unsupported) return unsupported
      const body = await requestBody(c)
      const auto = bool(body.auto)
      await adapter.summarize!(sessionId, {
        providerID: str(body.providerID) ?? "",
        modelID: str(body.modelID) ?? "",
        ...(auto !== undefined ? { auto } : {}),
      }, directory)
      return c.json({ ok: true })
    })
    .post("/session/:id/prompt_async", async (c) => {
      const id = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, id, "prompt")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId: id })
      const adapter = await opts.resolveAdapter(c, { sessionId: id, directory })
      const parsedBody = parseSessionPromptBody(await c.req.json().catch(() => undefined))
      const body = await opts.transformPromptBody?.(c, { sessionId: id, directory, body: parsedBody }) ?? parsedBody
      const permissionRefusal = await rejectPermissionOverride(opts, c, directory, id, adapter, body.permissionMode)
      if (permissionRefusal) return permissionRefusal
      if (body.messageID) {
        const admitted = promptAdmissions.get(id) ?? new Set<string>()
        if (admitted.has(body.messageID)) return c.body(null, 204)
        admitted.add(body.messageID)
        promptAdmissions.set(id, admitted)
      }
      // The marker answers every later submission of this message id with 204
      // on sight, so it must not outlive a failure that happens before the
      // harness is asked to run anything: the retry that arrives once the cause
      // is gone would be answered 204 too and the turn would never run.
      let admittedForExecution = false
      try {
        if (body.messageID && c.req.header("x-claxedo-idempotency-retry") === "1") {
          const messages = await opts.getMessages?.(c, directory, id)
            ?? await adapter.getMessages(await requireExecutionBinding(opts, c, directory, id, adapter))
          const projected = messages.some((message) => asRecord(message.info)?.id === body.messageID)
          const session = projected
            ? undefined
            : await readSession(opts, c, directory, id, adapter)
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
        const runtime = await opts.resolveRuntime?.(c, { sessionId: id, directory })
        const turnAdmission = await acquireManagedPromptLease({
          opts,
          c,
          sessionId: id,
          turnId: body.messageID,
          onLost: () => stopLostTurn(runtime, adapter, id, directory, () => requireExecutionBinding(opts, c, directory, id, adapter)),
        })
        if (turnAdmission.rejected) return turnAdmission.rejected
        const access = sessionAccessContext(c)
        let settleAdmission: ((error?: unknown) => void) | undefined
        const admission = runtime
          ? new Promise<unknown>((resolve) => {
              settleAdmission = resolve
            })
          : undefined
        let runTurn: () => Promise<SessionPromptTurnResult>
        if (runtime) {
          runTurn = () => runRuntimePromptTurn({
            runtime,
            sessionId: id,
            directory,
            body,
            publishGlobal: opts.publishGlobal,
            publishStatus: (event) => opts.sessionBus.publish(event),
            createActiveTurnScope: opts.createActiveTurnScope
              ? () => turnScope(
                  opts.createActiveTurnScope?.({ c, adapter, directory, sessionId: id }),
                  turnAdmission.lease,
                )
              : undefined,
            ...(turnAdmission.lease ? { turnAdmission: turnAdmission.lease } : {}),
            streamErrorMessage: streamTurnErrorMessage,
            onAdmissionSettled: settleAdmission,
            actor: access.actor,
            author: access.author,
          })
        } else {
          const binding = await requireExecutionBinding(opts, c, directory, id, adapter)
          await applyTurnPermissionMode({ adapter, binding, modeId: body.permissionMode })
          let admitted: AdmittedSessionPromptTurn
          try {
            admitted = await admitSessionPromptTurn({ adapter, binding, sessionId: id, directory, body })
          } catch (error) {
            const refusal = sessionTurnRefusal(error)
            if (!refusal) throw error
            await turnAdmission.lease?.release().catch(() => undefined)
            return turnRefused(c, refusal, streamTurnErrorMessage(error))
          }
          runTurn = () => runSessionPromptTurn({
            adapter,
            binding: admitted.binding,
            admitted,
            sessionId: id,
            directory,
            body,
            publishGlobal: opts.publishGlobal,
            publishStatus: (event) => opts.sessionBus.publish(event),
            publishUserMessage: false,
            streamErrorMessage: streamTurnErrorMessage,
            createActiveTurnScope: opts.createActiveTurnScope
              ? ({ adapter, directory, sessionId }) => turnScope(
                  opts.createActiveTurnScope?.({ c, adapter, directory, sessionId }),
                  turnAdmission.lease,
                )
              : undefined,
            ...(turnAdmission.lease ? { turnAdmission: turnAdmission.lease } : {}),
          })
        }
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
            const refusal = sessionTurnRefusal(error)
            // Nothing executed, so the same message id must submit again.
            if (refusal) releasePromptAdmission(id, body.messageID)
            // Keep a human-safe headline but never discard the cause: route the real
            // message through sessionError (→ firstTurnErrorData), so it classifies
            // (unmatched → "unknown") and the original text reaches the raw-detail
            // disclosure instead of being flattened to the literal "Stream error".
            opts.publishGlobal(withDir(
              compatScope(directory, id),
              refusal
                ? sessionTurnRefused(refusal, streamTurnErrorMessage(error), id)
                : sessionError(streamTurnErrorMessage(error), id),
            ))
          } finally {
            const leaseLost = turnAdmission.lease?.lost() ?? false
            if (!leaseLost) {
              await flushDocumentsAfterTurn(opts, id)
              if (opts.afterMessageCheckpoint) {
                const messages = runtime
                  ? await runtime.events.list(id, directory)
                  : await adapter.getMessages(await requireExecutionBinding(opts, c, directory, id, adapter))
                await after(opts.afterMessageCheckpoint(c, directory, id, messages))
              }
            }
            await turnAdmission.lease?.release().catch(() => undefined)
            await settleChildTurn(opts, id, directory)
          }
        })()
        const admissionError = admission ? await awaitAdmissionAck(admission) : undefined
        // Admission did not settle within the bound — honor prompt_async's
        // fire-and-forget contract rather than block on a wedged turn.
        if (admissionError === ADMISSION_ACK_TIMED_OUT) return c.body(null, 204)
        if (isAgentRuntimeTurnConflictError(admissionError)) {
          releasePromptAdmission(id, body.messageID)
          return turnAdmissionConflict(c)
        }
        const admissionRefusal = sessionTurnRefusal(admissionError)
        if (admissionRefusal) {
          releasePromptAdmission(id, body.messageID)
          return turnRefused(c, admissionRefusal, streamTurnErrorMessage(admissionError))
        }
        return c.body(null, 204)
      } finally {
        if (!admittedForExecution) releasePromptAdmission(id, body.messageID)
      }
    })
    .get("/agent", async (c) => {
      const adapter = await opts.resolveAdapter(c)
      const directory = await opts.resolveDirectory(c)
      if (!adapter.listAgents) {
        const caps = await adapter.readHarnessCapabilities(directory)
        return unsupportedOperation(c, caps, "list_agents", {
          capability: "agents",
          reason: "adapter_method_unavailable",
          message: `${caps.harness} does not expose live agent options`,
        })
      }
      try {
        return c.json(await adapter.listAgents(directory))
      } catch (err) {
        if (unsupportedLiveAgentListError(err)) return c.json([])
        throw err
      }
    })
    .get("/permission", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const rows = opts.listPermissions
        ? await opts.listPermissions(c, directory)
        : await (await opts.resolveAdapter(c)).listPermissions?.(directory) ?? []
      return c.json(await filterSessionRows(opts, c, "permission_list", rows))
    })
    .get("/question", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const rows = opts.listQuestions
        ? await opts.listQuestions(c, directory)
        : await (await opts.resolveAdapter(c)).listQuestions?.(directory) ?? []
      const sessionId = c.req.query("sessionId")
      return c.json(await filterSessionRows(opts, c, "question_list", sessionId ? rows.filter((row) => row.sessionID === sessionId) : rows))
    })
    .post("/session/:sessionId/permissions/:permId", async (c) => {
      const suppliedSessionId = c.req.param("sessionId")
      const permId = c.req.param("permId")
      const directory = await opts.resolveDirectory(c, { sessionId: suppliedSessionId })
      const listedSessionId = interactionSessionId(await opts.listPermissions?.(c, directory) ?? [], permId)
      if (opts.listPermissions && !listedSessionId) return interactionNotFound(c, "permission", permId)
      if (listedSessionId && listedSessionId !== suppliedSessionId) {
        return interactionSessionMismatch(c, "permission", permId)
      }
      const adapter = await opts.resolveAdapter(c, {
        sessionId: listedSessionId || suppliedSessionId,
        directory,
      })
      const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "permissions", "respondPermission", "permission_response")
      if (unsupported) return unsupported
      const sessionId = listedSessionId
        || interactionSessionId(await adapter.listPermissions?.(directory) ?? [], permId)
      if (!sessionId) return interactionNotFound(c, "permission", permId)
      if (sessionId !== suppliedSessionId) return interactionSessionMismatch(c, "permission", permId)
      const guarded = await sessionOperationGuard(opts, c, sessionId, "permission_response")
      if (guarded) return guarded
      const r = str((await requestBody(c)).response) ?? "deny"
      const decision = r === "once" ? "allow_once" : r === "always" ? "allow_always" : "deny"
      const result = await adapter.respondPermission!(
        await requireExecutionBinding(opts, c, directory, sessionId, adapter),
        permId,
        decision,
      )
      publishInteractionEvents(
        opts.publishGlobal,
        directory,
        sessionId,
        result?.events,
        permissionReplied(sessionId, permId, r === "always" ? "always" : r === "once" ? "once" : "reject"),
      )
      return c.json({ ok: true })
    })
    .post("/question/:id/reply", async (c) => {
      const admitted = await admitQuestionOperation(opts, c, "replyQuestion")
      if (admitted.rejected) return admitted.rejected
      const { id, directory, adapter, sessionId } = admitted
      const body = rec(await c.req.json().catch(() => undefined))
      const answers = body && Object.keys(body).every((key) => key === "answers")
        ? questionAnswers(body.answers)
        : undefined
      if (!answers) return c.json({ error: "answers must be an array of string arrays" }, 400)
      const result = await adapter.replyQuestion!(
        await requireExecutionBinding(opts, c, directory, sessionId, adapter),
        id,
        answers,
      )
      publishInteractionEvents(
        opts.publishGlobal,
        directory,
        sessionId,
        result?.events,
        questionReplied(sessionId, id, answers),
      )
      return c.json({ ok: true })
    })
    .post("/question/:id/reject", async (c) => {
      const admitted = await admitQuestionOperation(opts, c, "rejectQuestion")
      if (admitted.rejected) return admitted.rejected
      const { id, directory, adapter, sessionId } = admitted
      const result = await adapter.rejectQuestion!(
        await requireExecutionBinding(opts, c, directory, sessionId, adapter),
        id,
      )
      publishInteractionEvents(
        opts.publishGlobal,
        directory,
        sessionId,
        result?.events,
        questionRejected(sessionId, id),
      )
      return c.json({ ok: true })
    })
    .get("/event", async (c) => {
      const scope = await authorizeSessionEventScope(c, opts.sessionAccessPolicy, "sessionID")
      if (isSessionEventScopeResponse(scope)) return scope
      const allows = scope.managed
        ? (event: unknown) => unknownEventSessionId(event) === scope.sessionId
        : (_event: unknown) => true
      const opened = sessionEventSource.open(eventDeliveryPrincipal(c))
      await opened.ready
      return streamSSE(c, async (stream) => {
        let cleanup: () => void = () => {}
        cleanup = attachSseFanout({
          subscribe: (listener) => opened.subscribe((event) => {
            if (allows(event)) listener(event)
          }, () => {
            cleanup()
            stream.abort()
          }),
          write: async (event, meta) => {
            return stream.writeSSE({
            ...(meta?.id ? { id: meta.id } : {}),
            data: JSON.stringify(event),
            })
          },
          heartbeat: { type: "heartbeat" },
          heartbeatMs: EVENT_STREAM_HEARTBEAT_MS,
          lastEventId: c.req.header("last-event-id"),
          replay: scope.managed ? scopedReplay(opened.replay, allows) : opened.replay,
          replayLive: false,
        })
        await waitForSessionEventStream(stream, scope, opts.sessionAccessPolicy, cleanup)
      })
    })

  if (opts.exposeCommandRoute !== false) {
    app.get("/command", async (c) => {
      const adapter = await opts.resolveAdapter(c)
      const directory = await opts.resolveDirectory(c)
      return c.json(await adapter.listCommands?.(directory) ?? [])
    })
  }

  return app
}
