import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { toolImageResponse } from "./tool-image"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type {
  AgentPermission,
  AgentQuestion,
  AgentRuntime,
  RuntimeDirectory,
  SessionConfig,
  HarnessCapabilities,
  AgentGoalMutationResult,
} from "@claxedo/agent-sdk-runtime"
import type { AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import { cancelledAssistantMessageId } from "@claxedo/agent-runtime-contract/turn-fold"
import {
  parseRecoveryRequest,
  RecoveryContractError,
  sameSessionHarness,
  serializeRecoveryOutcome,
  type RecoveryOutcome,
  type RecoveryRefusal,
  type RecoveryRequest,
} from "@claxedo/agent-runtime-contract"
import { elicitationError } from "./elicitation-error"
import type {
  AgentHarnessAdapter,
  AgentInteractionResult,
  AgentMessagePage,
} from "@claxedo/agent-sdk-runtime/adapters"
import { AGENT_MESSAGE_PAGE_LIMIT, type AgentMessagePageInput, type AgentMessageReadInput, type AgentTurnCoveragePage } from "@claxedo/agent-sdk-runtime/message-page"
import { FirstPageQueryError, parseFirstPageQuery, readFirstRead, type FirstPageQuery } from "@claxedo/agent-sdk-runtime/first-page"
import { AgentMessagePageError, hasAdapterCapability, isAgentHarnessEngineError } from "@claxedo/agent-sdk-runtime/adapters"
import {
  admitSessionInstructions,
  IMMUTABLE_SESSION_CONFIG_FIELDS,
  type ImmutableSessionConfigField,
} from "@claxedo/agent-sdk-runtime"
import { isAgentRuntimeMessageIdConflictError, isAgentRuntimeTurnConflictError } from "@claxedo/agent-sdk-runtime"
import {
  messageUpdated,
  permissionReplied,
  questionRejected,
  questionReplied,
  sessionUpdated,
  sessionDeleted,
  withDir,
  type CompatEvent,
  type CompatEnvelope,
} from "../compat-events"
import { isAgentRuntimeGoalError } from "@claxedo/agent-sdk-runtime"
import {
  admitSessionPromptTurn,
  compatScope,
  runRuntimePromptTurn,
  runSessionPromptTurn,
  sessionPromptReply,
  sessionTurnRefusal,
  parseSessionPromptBody,
  type SessionPromptBody,
} from "../session/service"
import {
  normalizeSessionConfigUpdate,
  normalizeSessionCreateConfig,
  normalizeSessionCreateBody,
  sessionCreateGroup,
} from "../session-config"
import { MAX_ACTIVE_CHILDREN_PER_PARENT } from "./session-children"
import type { QueuedPromptAction } from "../session/delivery-owner"
import { narrowerPermissionLevel, PermissionModeRefusedError } from "@claxedo/agent-sdk-runtime"
import { arr, bool, num, rec, str } from "../json-value"
import { disposeRuntimeSessionDocuments } from "./document-hydration"
import { errorBody } from "./error-body"
import { boundedJsonBody, boundedJsonRecord, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import { routeParam } from "@claxedo/helpers/route-param"
import {
  sessionAccessContext,
  sessionAccessDenied,
  sessionTurnOrigin,
  type SessionAccessDecision,
  type SessionAccessOperation,
} from "../session-access-policy"
import type { ActiveSessionTurnLease } from "./session-turn-lease"
import { SessionRollbackError } from "../session-rollback-error"
import { WorkspaceHarnessUnavailableError } from "../harness-unavailable-error"
import { asRecord } from "@claxedo/helpers/guards"
import {
  acquireManagedPromptLease,
  applyTurnPermissionMode,
  createPromptAdmission,
  deferredTurnGrant,
  deferredTurnGrantRefused,
  flushDocumentsAfterTurn,
  messageIdConflict,
  publishTurnFailure,
  queuedPromptRequester,
  settleChildTurn,
  streamTurnErrorMessage,
  turnAdmissionConflict,
  turnRefused,
  turnScope,
} from "./session-prompt-admission"
import { effectivePermissionCeiling, permissionModeUnderCeiling, rejectPermissionOverride, sessionPermissionCeiling } from "./session-permission-ceiling"
import {
  after,
  managedSessionLifecycle,
  readRuntimeSession,
  requireExecutionBinding,
  type SessionRouteContext as Ctx,
  type SessionRouteOptions as Opts,
} from "./session-route-options"
import type { SessionStatusSnapshot } from "./session-status-snapshot"
import { cancelAdmittedTurn, captureTurnTarget, containLostTurn, recoveryCaller } from "./session-turn-containment"

/** Publish a session's row after a config write, so every client's copy of the row moves with it. */
async function publishSessionRow(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string, adapter: AgentHarnessAdapter) {
  const session = await readRuntimeSession(opts, c, directory, sessionId, adapter)
  if (session) opts.publishGlobal(withDir(compatScope(directory, sessionId), sessionUpdated(session)))
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
        if (!await readRuntimeSession(opts, c, directory, childSessionId)) return
        const childAdapter = await opts.resolveAdapter(c, { sessionId: childSessionId, directory })
        const binding = await requireExecutionBinding(opts, c, directory, childSessionId, childAdapter)
        const start = opts.sessionStarts?.get(childSessionId)?.binding
        await opts.beforeDeleteSession?.(c, directory, childSessionId)
        await disposeRuntimeSessionDocuments(childSessionId)
        await childAdapter.deleteSession(binding)
        await after(opts.afterDeleteSession?.(c, directory, childSessionId))
        if (start) opts.sessionStarts!.retire(start)
        opts.publishGlobal(withDir(compatScope(directory, childSessionId), sessionDeleted(childSessionId, directory ?? "", parentSessionId)))
      })
      continue
    }
    if (!await readRuntimeSession(opts, c, directory, childSessionId)) continue
    const childAdapter = await opts.resolveAdapter(c, { sessionId: childSessionId, directory })
    const binding = await requireExecutionBinding(opts, c, directory, childSessionId, childAdapter)
    // Archiving a child stops the turn it is running. The runtime keeps the
    // operation whatever it reaches, so a cancellation that does not land is
    // visible through the child's own recovery inspection rather than lost.
    const childOwner = opts.resolveRecoveryOwner?.(c, { sessionId: childSessionId })
    if (childOwner) {
      await cancelAdmittedTurn(childOwner, childSessionId, recoveryCaller(c), `archive-child:${childSessionId}:${randomUUID()}`)
    }
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

type SessionFirstInput = { prompt: SessionPromptBody } | { goal: string }

/**
 * A create's first prompt or goal. `delivery` is refused: a session that does
 * not exist yet has no running turn to queue behind or steer.
 */
function sessionFirstInput(wire: Record<string, unknown>): SessionFirstInput | { invalid: string } | undefined {
  if (wire.prompt === undefined && wire.goal === undefined) return undefined
  if (wire.prompt !== undefined && wire.goal !== undefined) return { invalid: "A session starts with a prompt or a goal, not both" }
  if (wire.goal !== undefined) {
    const objective = str(rec(wire.goal)?.objective)
    return objective === undefined ? { invalid: "goal.objective must be a string" } : { goal: objective }
  }
  const prompt = rec(wire.prompt)
  if (!prompt) return { invalid: "prompt must be an object" }
  if (prompt.delivery !== undefined) return { invalid: "A new session has no running turn to queue behind or steer" }
  return { prompt: parseSessionPromptBody(prompt) }
}

function noStoreJson(c: Ctx, data: unknown, status?: ContentfulStatusCode) {
  return c.json(data, status, {
    "Cache-Control": "no-store",
  })
}

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
  if (view === "latest-turn" && limit === undefined) {
    if (before === undefined) return { view }
    if (before.length === 0) throw new HTTPException(400, { message: "before must be a non-empty cursor" })
    return { view, before }
  }
  if (view !== undefined) {
    if (view !== "latest-surface" || limit !== undefined || before !== undefined) {
      throw new HTTPException(400, { message: "view must be latest-turn or latest-surface, cannot be combined with limit, and only latest-turn takes before" })
    }
    return { view }
  }
  if (limit === undefined || !/^[1-9]\d*$/.test(limit)) {
    throw new HTTPException(400, { message: `limit must be an integer between 1 and ${AGENT_MESSAGE_PAGE_LIMIT}` })
  }
  const parsedLimit = Number(limit)
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit > AGENT_MESSAGE_PAGE_LIMIT) {
    throw new HTTPException(400, { message: `limit must be an integer between 1 and ${AGENT_MESSAGE_PAGE_LIMIT}` })
  }
  if (before !== undefined && before.length === 0) {
    throw new HTTPException(400, { message: "before must be a non-empty cursor" })
  }
  return {
    limit: parsedLimit,
    ...(before !== undefined ? { before } : {}),
  }
}

function firstPageQuery(c: Ctx): FirstPageQuery | undefined {
  try {
    return parseFirstPageQuery((name) => c.req.query(name))
  } catch (error) {
    if (error instanceof FirstPageQueryError) throw new HTTPException(400, { message: error.message })
    throw error
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

function publishInteractionEvents(
  publish: (event: CompatEnvelope) => void,
  directory: RuntimeDirectory,
  sessionId: string,
  events: CompatEvent[] | undefined,
  fallback: CompatEvent,
) {
  const published = events?.length ? events : [fallback]
  for (const event of published) {
    publish(withDir(compatScope(directory, sessionId), event))
  }
  return published
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

type GoalInvocation = (input: {
  c: Ctx
  sessionId: string
  directory: RuntimeDirectory
  runtime: AgentRuntime
}) => Promise<Response> | Response

/**
 * The scaffold every Goal start or control shares, `/session/:id/goal*` and a
 * create that carries its first goal alike: admit the operation, resolve the
 * Goal runtime, and translate a thrown `AgentRuntimeGoalError` into its typed
 * HTTP response. Each caller supplies only the runtime call that makes it
 * different, so a new admission or error rule lands on every Goal endpoint at
 * once instead of being copied into each handler.
 */
function goalRoute(opts: Opts, operation: SessionAccessOperation, invoke: GoalInvocation) {
  return async (c: Ctx): Promise<Response> => {
    const sessionId = routeParam(c, "id")
    const guarded = await sessionOperationGuard(opts, c, sessionId, operation)
    if (guarded) return guarded
    return invokeGoalRuntime(opts, c, sessionId, await opts.resolveDirectory(c, { sessionId }), invoke)
  }
}

async function invokeGoalRuntime(opts: Opts, c: Ctx, sessionId: string, directory: RuntimeDirectory, invoke: GoalInvocation) {
  const runtime = await resolveGoalRuntime(opts, c, sessionId, directory)
  if (runtime instanceof Response) return runtime
  try {
    return await invoke({ c, sessionId, directory, runtime })
  } catch (error) {
    return goalRuntimeErrorResponse(c, error)
  }
}

function goalStartInvocation(objective: string): GoalInvocation {
  return async ({ c, sessionId, directory, runtime }) =>
    goalMutationResponse(c, await runtime.goals.start({ sessionId, objective }, directory), 201)
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

async function filterSessionStatus(opts: Opts, c: Ctx, status: SessionStatusSnapshot) {
  const entries = Object.entries(status)
  const allowed = await collectionSessionIds(opts, c, "session_status", entries.map(([sessionId]) => sessionId))
  return Object.fromEntries(entries.filter(([sessionId]) => allowed.has(sessionId)))
}

async function listPermissionRows(opts: Opts, c: Ctx, directory: RuntimeDirectory): Promise<AgentPermission[] | Response> {
  try {
    return opts.listPermissions
      ? await opts.listPermissions(c, directory)
      : await (await opts.resolveAdapter(c)).listPermissions?.(directory) ?? []
  } catch (error) {
    return engineRefusalResponse(c, error)
  }
}

async function listQuestionRows(opts: Opts, c: Ctx, directory: RuntimeDirectory): Promise<AgentQuestion[] | Response> {
  try {
    return opts.listQuestions
      ? await opts.listQuestions(c, directory)
      : await (await opts.resolveAdapter(c)).listQuestions?.(directory) ?? []
  } catch (error) {
    return engineRefusalResponse(c, error)
  }
}

function sessionStartSettled(opts: Opts, sessionId: string) {
  const start = opts.sessionStarts?.get(sessionId)
  return !start || start.status === "created"
}

async function sessionOwnStatus(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string): Promise<unknown> {
  return (await opts.getStatus?.(c, directory))?.[sessionId] ?? null
}

async function readSessionTodos(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string): Promise<unknown[] | Response> {
  const replay = await opts.getTodos?.(c, directory, sessionId)
  if (replay) return replay
  const adapter = await opts.resolveAdapter(c, { sessionId, directory })
  const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "todos", "getTodos", "todos")
  if (unsupported) return unsupported
  return adapter.getTodos!(await requireExecutionBinding(opts, c, directory, sessionId, adapter))
}

async function listSessionSubagents(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string) {
  return await opts.listSubagents?.(c, directory, sessionId) ?? []
}

async function readSessionGoal(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string) {
  const runtime = await resolveGoalRuntime(opts, c, sessionId, directory)
  if (runtime instanceof Response) return runtime
  try {
    const capabilities = await runtime.goals.capabilities(sessionId, directory)
    return { capabilities, goal: capabilities.implemented ? await runtime.goals.read(sessionId, directory) : null }
  } catch (error) {
    return goalRuntimeErrorResponse(c, error)
  }
}

type SessionFactRefusal = { status: number; code?: string; message: string }
type SessionFact<T> = { value: T } | { error: SessionFactRefusal }

/**
 * One fact of the open view. A fact that cannot be read is reported in its
 * own field, so a failed side read never costs the reader the session row,
 * the same isolation the separate reads it replaces had.
 */
async function sessionFact<T>(read: () => Promise<T | Response>): Promise<SessionFact<T>> {
  try {
    const result = await read()
    if (!(result instanceof Response)) return { value: result }
    const refusal = rec(rec(await result.json().catch(() => undefined))?.error)
    const code = str(refusal?.code)
    return { error: { status: result.status, ...(code ? { code } : {}), message: str(refusal?.message) ?? `Refused with status ${result.status}` } }
  } catch (error) {
    if (error instanceof HTTPException) return { error: { status: error.status, message: error.message } }
    console.error(error)
    return { error: { status: 500, message: "Internal Server Error" } }
  }
}

async function readMessagePage(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string, pageInput: AgentMessagePageInput): Promise<AgentMessagePage> {
  const adapter = await opts.resolveAdapter(c, { sessionId, directory })
  try {
    const page = await opts.getMessagePage?.(c, directory, sessionId, pageInput, adapter)
    if (page) return page
  } catch (error) {
    return throwMessagePageError(error, 500)
  }
  if (!adapter.getMessagePage) throw new HTTPException(501, { message: "message paging is not supported for this session" })
  try {
    return await adapter.getMessagePage(await requireExecutionBinding(opts, c, directory, sessionId, adapter), pageInput)
  } catch (error) {
    return throwMessagePageError(error, 502)
  }
}

async function readPresentedSession(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string) {
  const session = await readRuntimeSession(opts, c, directory, sessionId)
  if (session) await after(opts.afterGetSession?.(c, directory, session))
  return session
}

/**
 * `GET /session/:id?view=open`: every fact a reader needs beside the row to
 * open the session, read by the producers the per-fact routes use. The session
 * read's own guard admits them all: no session access policy tells one read
 * operation from another, because each classifies an operation only by its
 * `sessionAccessWriteClass`, and a read has none. The rows are narrowed to
 * this session here rather than filtered through the policy.
 */
async function sessionOpenView(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string) {
  const own = <T extends { sessionID: string }>(rows: T[] | Response) =>
    rows instanceof Response ? rows : rows.filter((row) => row.sessionID === sessionId)
  const [status, permissions, questions, todos, goal, subagents] = await Promise.all([
    sessionFact(() => sessionOwnStatus(opts, c, directory, sessionId)),
    sessionFact(async () => own(await listPermissionRows(opts, c, directory))),
    sessionFact(async () => sessionStartSettled(opts, sessionId) ? own(await listQuestionRows(opts, c, directory)) : []),
    sessionFact(() => readSessionTodos(opts, c, directory, sessionId)),
    sessionFact(() => readSessionGoal(opts, c, directory, sessionId)),
    sessionFact(() => listSessionSubagents(opts, c, directory, sessionId)),
  ])
  return { status, permissions, questions, todos, goal, subagents }
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
  | { rejected?: undefined; id: string; directory: RuntimeDirectory; adapter: AgentHarnessAdapter; sessionId: string; start?: AgentSessionStartBinding }
> {
  const id = routeParam(c, "id")
  const requested = c.req.query("sessionId") ?? ""
  const directory = await opts.resolveDirectory(c)
  const known = interactionSessionId(await opts.listQuestions?.(c, directory) ?? [], id)
  if (known) {
    if (requested && requested !== known) return { rejected: interactionSessionMismatch(c, "question", id) }
    const pending = opts.sessionStarts?.get(known)
    if (pending && pending.status !== "created") {
      const denied = await sessionStartGuard(opts, c, pending.binding, "question_response")
      if (denied) return { rejected: denied }
      if (pending.status !== "starting") return { rejected: interactionNotFound(c, "question", id) }
      const adapter = await opts.resolveAdapter(c, { sessionId: known, directory })
      if (method === "replyQuestion" ? !adapter.replySessionStartQuestion : !adapter.rejectSessionStartQuestion) {
        return { rejected: c.json(errorBody("session_start_questions_unsupported", "This agent cannot answer startup questions"), 501) }
      }
      return { id, directory, adapter, sessionId: known, start: pending.binding }
    }
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
  const admitPrompt = createPromptAdmission(opts, requestErrorResponse)
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
  const admitFirstInput = async (
    c: Ctx,
    input: { sessionId: string; directory: RuntimeDirectory; adapter: AgentHarnessAdapter; first: SessionFirstInput },
  ): Promise<{ created: Record<string, unknown> } | { refused: Response } | { failed: unknown }> => {
    const { sessionId, directory } = input
    if ("goal" in input.first) {
      const guarded = await sessionOperationGuard(opts, c, sessionId, "goal_start")
      if (guarded) return { refused: guarded }
      const answer = await invokeGoalRuntime(opts, c, sessionId, directory, goalStartInvocation(input.first.goal))
      return answer.status === 201 ? { created: { goal: await answer.json() } } : { refused: answer }
    }
    const guarded = await sessionOperationGuard(opts, c, sessionId, "prompt")
    if (guarded) return { refused: guarded }
    const admission = await admitPrompt(c, { sessionId, directory, adapter: input.adapter, body: input.first.prompt })
    if (admission.answer.status === 204 && !admission.failed) return { created: { prompt: { delivery: "start" } } }
    await Promise.allSettled([admission.turn])
    return admission.failed ? { failed: admission.failed.error } : { refused: admission.answer }
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
      return c.json(await filterSessionStatus(opts, c, await opts.getStatus?.(c, directory) ?? {}))
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
      const first = sessionFirstInput(wire)
      if (first && "invalid" in first) return c.json(errorBody("session_first_input_invalid", first.invalid), 400)
      if (first && body.parentID) {
        return c.json(errorBody("session_first_input_invalid", "A child session is started by its parent, not by its create"), 400)
      }
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
        const parent = body.parentID && children ? await readRuntimeSession(opts, c, directory, body.parentID) : undefined
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
        const publishFailed = (message: string) => opts.publishSessionLifecycle?.({
          type: "session.lifecycle",
          phase: "failed",
          ...(start ? { start } : {}),
          directory,
          ...(draftId ? { draftId } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(creator ? { actorId: creator } : {}),
          message,
          ts: Date.now(),
        })
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
          const existing = body.id ? await readRuntimeSession(opts, c, directory, body.id, adapter) : undefined
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
          if (!existing && opts.sessionStarts && opts.resolveSessionStartBinding) {
            if (!body.id) {
              body.id = `ses_${randomUUID()}`
              activeSessionChanges.add(body.id)
              claimed = body.id
            }
            const owner = opts.resolveSessionStartBinding(c, directory, body.id, operationId ?? randomUUID())
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
          // Set on every create, "" when it names no model: the adapter keeps
          // one model for the sessions it creates, and a create that skipped
          // this would inherit the previous session's.
          if (hasAdapterCapability(adapter, "runtime-config")) {
            adapter.setModel(!config.model || config.model.modelID === "default" ? "" : config.model.modelID)
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
              // Undo only what this request made. A session that was already
              // there belongs to the attempt that created it, and deleting it
              // to tidy up a failed configuration destroys that work.
              if (!existing) await rollbackCreatedSession(opts, c, adapter, directory, session.id, error)
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
            if (!existing) await rollbackCreatedSession(opts, c, adapter, directory, session.id, error)
            throw error
          }
          if (body.parentID && children) {
            const persisted = await readRuntimeSession(opts, c, directory, session.id, adapter)
            if (!persisted) throw new Error(`Created child ${session.id} has no persisted session row`)
            session = persisted
          }
          const created = {
            ...(body.parentID ? { parentID: body.parentID } : {}),
            ...(subagentKey ? { subagentKey } : {}),
            ...(childMode.mode ? { permissionMode: childMode.mode.id } : {}),
          }
          const createdId = session.id
          const undoCreated = async (reason: string, cause: unknown) => {
            if (managed) {
              await compensateRegistration({ opts, c, adapter, directory, sessionId: createdId, operationId: operationId!, reason })
            } else if (!existing) {
              await rollbackCreatedSession(opts, c, adapter, directory, createdId, cause)
            }
          }
          const refuseCreated = async (response: Response, message: string, reason: string) => {
            if (start) opts.sessionStarts!.finish(start, { status: "failed", error: message })
            await undoCreated(reason, new Error(message))
            publishFailed(message)
            return response
          }
          const registration = await registerCreatedSession(opts, c, session.id, operationId, body.title)
          if (registration.kind === "ambiguous") {
            return registration.response
          }
          if (registration.kind === "denied") {
            return await refuseCreated(
              registration.response,
              "Session creator registration was denied",
              `registration_denied_${registration.response.status}`,
            )
          }
          try {
            await after(opts.afterCreateSession?.(c, directory, session))
          } catch (error) {
            await undoCreated(`post_create_projection_failed: ${errorMessage(error)}`, error)
            throw error
          }
          const firstAdmission = first
            ? await admitFirstInput(c, { sessionId: session.id, directory, adapter, first })
            : { created: {} }
          if ("failed" in firstAdmission) {
            await undoCreated(`first_input_failed: ${errorMessage(firstAdmission.failed)}`, firstAdmission.failed)
            throw firstAdmission.failed
          }
          if ("refused" in firstAdmission) {
            return await refuseCreated(
              firstAdmission.refused,
              "The session's first input was refused",
              `first_input_refused_${firstAdmission.refused.status}`,
            )
          }
          if (first) {
            // Admission can already have retitled the session from its first
            // prompt; the answer is what the create's projection records.
            const admitted = await readRuntimeSession(opts, c, directory, session.id, adapter)
            if (!admitted) throw new Error(`Created session ${session.id} has no persisted session row`)
            session = admitted
          }
          if (body.parentID && children) {
            opts.publishGlobal(withDir(compatScope(directory, session.id), sessionUpdated(session)))
          }
          if (start) {
            if (session.id !== start.sessionId) throw new Error("Agent returned a different local session identity")
            const binding = await requireExecutionBinding(opts, c, directory, session.id, adapter)
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
          return c.json(createdSessionBody(normalizeSession(session, directory), { ...created, ...firstAdmission.created }), 201)
        } catch (error) {
          if (start && opts.sessionStarts?.get(start.sessionId)?.status === "starting") {
            opts.sessionStarts.finish(start, { status: "failed", error: errorMessage(error) })
          }
          publishFailed(errorMessage(error))
          // A create that was REFUSED carries its own status — an unknown harness
          // is a 400, an id that belongs to another workspace is a 409. Flattening
          // those into 500 tells the caller the runtime broke when in fact the
          // runtime declined, and a 500 is the one class of failure clients retry.
          if (error instanceof HTTPException) throw error
          return c.json(errorBody("session_create_failed", errorMessage(error)), 500)
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
        return noStoreJson(c, {
          ...await adapter.readHarnessCapabilities(directory, { sessionId }),
          prompt: await sessionPromptAdmitted(opts, c, sessionId),
        })
      } catch (error) {
        const refusal = harnessUnavailableResponse(c, error)
        if (refusal) return refusal
        throw error
      }
    })
    .get("/session/:id/goal/capabilities", goalRoute(opts, "goal_capabilities", async ({ c, sessionId, directory, runtime }) =>
      noStoreJson(c, await runtime.goals.capabilities(sessionId, directory))))
    .get("/session/:id/goal", goalRoute(opts, "goal_read", async ({ c, sessionId, directory, runtime }) =>
      noStoreJson(c, await runtime.goals.read(sessionId, directory))))
    .post("/session/:id/goal", goalRoute(opts, "goal_start", async (input) =>
      goalStartInvocation(str((await boundedJsonRecord(input.c)).objective) ?? "")(input)))
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
      return noStoreJson(c, await listSessionSubagents(opts, c, directory, sessionId))
    })
    .get("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_meta_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const view = c.req.query("view")
      if (view !== undefined && view !== "open") return noStoreJson(c, errorBody("session_view_unknown", `Unknown session view ${view}`), 400)
      const session = await readPresentedSession(opts, c, directory, sessionId)
      if (!session) return noStoreJson(c, sessionNotFound(), 404)
      if (view === "open") return noStoreJson(c, await sessionOpenView(opts, c, directory, sessionId))
      return noStoreJson(c, normalizeSession(session, directory))
    })
    .get("/session/:id/config-options", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_config_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const binding = await requireExecutionBinding(opts, c, directory, sessionId, adapter)
      if (!adapter.probeConfigOptions) return noStoreJson(c, { error: "Session harness does not expose config options" }, 404)
      return noStoreJson(c, await adapter.probeConfigOptions(directory, binding, c.req.query("model") || undefined))
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
      const wire = await boundedJsonRecord(c)
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
      const wire = await boundedJsonRecord(c)
      const immutable = IMMUTABLE_SESSION_CONFIG_FIELDS.find((field) => field in wire)
      if (immutable) {
        const refusal = IMMUTABLE_CONFIG_REFUSALS[immutable]
        return c.json(errorBody(refusal.code, refusal.message), 409)
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
            const switched = await opts.switchSessionHarness(c, directory, sessionId, body, adapter)
            await publishSessionRow(opts, c, directory, sessionId, adapter)
            return c.json(switched)
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
      await publishSessionRow(opts, c, directory, sessionId, adapter)
      return c.json(config)
    })
    .delete("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "delete")
      if (guarded) return guarded
      return withSessionChange(sessionId, async () => {
        const directory = await opts.resolveDirectory(c, { sessionId })
        const adapter = await opts.resolveAdapter(c, { sessionId, directory })
        // Read before deleting: once the row is gone nothing can say whether it
        // was a subsession, and the rail's visible count depends on that.
        const parentID = (await readRuntimeSession(opts, c, directory, sessionId, adapter).catch(() => undefined) as { parentID?: string } | undefined)?.parentID
        const start = opts.sessionStarts?.get(sessionId)?.binding
        await cascadeToChildren(opts, c, directory, sessionId, "delete", {}, withSessionChange)
        await opts.beforeDeleteSession?.(c, directory, sessionId)
        await disposeRuntimeSessionDocuments(sessionId)
        await adapter.deleteSession(await requireExecutionBinding(opts, c, directory, sessionId, adapter))
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
      const adapter = await opts.resolveAdapter(c, { sessionId: id, directory })
      const runtime = await opts.resolveRuntime?.(c, { sessionId: id, directory })
      const access = sessionAccessContext(c)
      const parsedBody = parseSessionPromptBody(await boundedJsonBody(c))
      const body = await opts.transformPromptBody?.(c, { sessionId: id, directory, body: parsedBody }) ?? parsedBody
      const permissionRefusal = await rejectPermissionOverride(opts, c, directory, id, adapter, body.permissionMode)
      if (permissionRefusal) return permissionRefusal
      if (body.delivery) {
        if (!runtime || !opts.queuedPrompts) return c.json({ error: "Queued delivery requires a durable runtime owner" }, 409)
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
        onLost: () => containLostTurn({ runtime: runtime?.recovery, sessionId: id, target: lostTurn.get(), caller: recoveryCaller(c) }),
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
                activeTurn,
                onTurnTarget: lostTurn.set,
                ...(turnAdmission.lease ? { turnAdmission: turnAdmission.lease } : {}),
                actor: access.actor,
                author: access.author,
              })
            : await runSessionPromptTurn({
                adapter,
                admitted: await admitSessionPromptTurn({
                  adapter,
                  binding: await requireExecutionBinding(opts, c, directory, id, adapter),
                  sessionId: id,
                  directory,
                  body,
                }),
                sessionId: id,
                directory,
                body,
                publishGlobal: opts.publishGlobal,
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
        if (isAgentRuntimeMessageIdConflictError(error)) return messageIdConflict(c)
        const refusal = sessionTurnRefusal(error)
        if (refusal) return turnRefused(c, refusal, streamTurnErrorMessage(error))
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
          const session = await readRuntimeSession(opts, c, directory, sessionId)
          if (!session) return noStoreJson(c, sessionNotFound(), 404)
          return noStoreJson(c, { ...snapshot, session: normalizeSession(session, directory) })
        }
      }
      if (pageInput) return messagePageResponse(c, await readMessagePage(opts, c, directory, sessionId, pageInput))
      const replay = await opts.getMessages?.(c, directory, sessionId)
      if (replay) {
        if (!snapshotRequested) return noStoreJson(c, replay)
        const session = await readRuntimeSession(opts, c, directory, sessionId)
        if (!session) return noStoreJson(c, sessionNotFound(), 404)
        return noStoreJson(c, { messages: replay, session: normalizeSession(session, directory) })
      }
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      if (snapshotRequested) {
        const [messages, session] = await Promise.all([
          adapter.getMessages(await requireExecutionBinding(opts, c, directory, sessionId, adapter)),
          readRuntimeSession(opts, c, directory, sessionId, adapter),
        ])
        if (!session) return noStoreJson(c, sessionNotFound(), 404)
        return noStoreJson(c, { messages, session: normalizeSession(session, directory) })
      }
      return noStoreJson(c, await adapter.getMessages(await requireExecutionBinding(opts, c, directory, sessionId, adapter)))
    })
    .get("/session/:id/outline", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "message_read")
      if (guarded) return guarded
      if (!opts.getTurnOutline) throw new HTTPException(501, { message: "turn outlines are not supported for this session" })
      const query = firstPageQuery(c)
      const directory = await opts.resolveDirectory(c, { sessionId })
      const session = await readPresentedSession(opts, c, directory, sessionId)
      const outline = session ? await opts.getTurnOutline(c, directory, sessionId) : undefined
      if (!session || !outline) return noStoreJson(c, sessionNotFound(), 404)
      return noStoreJson(c, await readFirstRead(
        normalizeSession(session, directory),
        outline,
        (before) => readMessagePage(opts, c, directory, sessionId, before === undefined ? { view: "latest-turn" } : { view: "latest-turn", before }),
        query && { ...query, cancelledAssistantMessageId: cancelledAssistantMessageId(session.lastTurn) },
      ))
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
      const modeId = str((await boundedJsonRecord(c)).modeId) ?? ""
      if (!modeId) return c.json({ error: "modeId is required" }, 400)
      const session = await readRuntimeSession(opts, c, directory, sessionId, adapter)
      if (!session) return c.json(errorBody("session_not_found", "Session not found"), 404)
      const ceiling = await sessionPermissionCeiling(opts, c, directory, session, adapter)
      if (ceiling) {
        const permitted = await permissionModeUnderCeiling(c, adapter, directory, ceiling, modeId)
        if (permitted.refusal) return permitted.refusal
      }
      try {
        await adapter.setPermissionMode(await requireExecutionBinding(opts, c, directory, sessionId, adapter), modeId)
      } catch (error) {
        if (error instanceof PermissionModeRefusedError) return c.json(errorBody(error.code, error.message), 400)
        throw error
      }
      // The adapter stored and published the mode it kept, which for an ACP
      // agent is the one the agent reported rather than an echo of the request.
      const updated = await readRuntimeSession(opts, c, directory, sessionId, adapter)
      if (!updated) return c.json(errorBody("session_not_found", "Session not found"), 404)
      return c.json(normalizeSession(updated, directory))
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
        if (managedSessionLifecycle(opts, c)) {
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
      const body = await boundedJsonRecord(c)
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
      const body = await boundedJsonRecord(c)
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
      const body = await boundedJsonRecord(c)
      const auto = bool(body.auto)
      await adapter.summarize!(sessionId, {
        providerID: str(body.providerID) ?? "",
        modelID: str(body.modelID) ?? "",
        ...(auto !== undefined ? { auto } : {}),
      }, directory)
      return c.json({ ok: true })
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
      const adapter = await opts.resolveAdapter(c, { sessionId: id, directory })
      const body = parseSessionPromptBody(await boundedJsonBody(c))
      const admission = await admitPrompt(c, { sessionId: id, directory, adapter, body })
      if (admission.failed) publishTurnFailure(opts.publishGlobal, directory, id, admission.failed.error)
      return admission.answer
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
        return engineRefusalResponse(c, err)
      }
    })
    .get("/permission", async (c) => {
      const rows = await listPermissionRows(opts, c, await opts.resolveDirectory(c))
      if (rows instanceof Response) return rows
      return c.json(await filterSessionRows(opts, c, "permission_list", rows))
    })
    .get("/question", async (c) => {
      const rows = await listQuestionRows(opts, c, await opts.resolveDirectory(c))
      if (rows instanceof Response) return rows
      const sessionId = c.req.query("sessionId")
      const selected = sessionId ? rows.filter((row) => row.sessionID === sessionId) : rows
      const normal: AgentQuestion[] = []
      const pending: AgentQuestion[] = []
      for (const row of selected) {
        const start = opts.sessionStarts?.get(row.sessionID)
        if (sessionStartSettled(opts, row.sessionID)) normal.push(row)
        else if (start?.status === "starting" && !await sessionStartGuard(opts, c, start.binding, "question_list")) pending.push(row)
      }
      return c.json([...await filterSessionRows(opts, c, "question_list", normal), ...pending])
    })
    .post("/session/:sessionId/permissions/:permId", async (c) => {
      const suppliedSessionId = c.req.param("sessionId")
      const permId = c.req.param("permId")
      const directory = await opts.resolveDirectory(c, { sessionId: suppliedSessionId })
      const listed = (await opts.listPermissions?.(c, directory) ?? []).find((item) => item.id === permId)
      const listedSessionId = listed?.sessionID
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
      const permission = listed ?? (await adapter.listPermissions?.(directory) ?? []).find((item) => item.id === permId)
      const sessionId = permission?.sessionID
      if (!sessionId) return interactionNotFound(c, "permission", permId)
      if (sessionId !== suppliedSessionId) return interactionSessionMismatch(c, "permission", permId)
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
      const result = await adapter.respondPermission!(
        await requireExecutionBinding(opts, c, directory, sessionId, adapter),
        permId,
        decision,
        optionId,
      )
      const events = publishInteractionEvents(
        opts.publishGlobal,
        directory,
        sessionId,
        result?.events,
        permissionReplied(sessionId, permId, optionId !== undefined ? { optionId } : r === "always" ? "always" : r === "once" ? "once" : "reject"),
      )
      return c.json({ ok: true, events })
    })
    .post("/question/:id/reply", async (c) => {
      const admitted = await admitQuestionOperation(opts, c, "replyQuestion")
      if (admitted.rejected) return admitted.rejected
      const { id, directory, adapter, sessionId } = admitted
      const body = rec(await boundedJsonBody(c))
      const answers = body && Object.keys(body).every((key) => key === "answers")
        ? questionAnswers(body.answers)
        : undefined
      if (!answers) return c.json({ error: "answers must be an array of string arrays" }, 400)
      let result: AgentInteractionResult | void
      try {
        result = admitted.start
          ? await adapter.replySessionStartQuestion!(admitted.start, id, answers)
          : await adapter.replyQuestion!(await requireExecutionBinding(opts, c, directory, sessionId, adapter), id, answers)
      } catch (error) {
        const failure = elicitationError(error)
        if (!failure) throw error
        return c.json(failure.body, failure.status)
      }
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
      const result = admitted.start
        ? await adapter.rejectSessionStartQuestion!(admitted.start, id)
        : await adapter.rejectQuestion!(await requireExecutionBinding(opts, c, directory, sessionId, adapter), id)
      publishInteractionEvents(
        opts.publishGlobal,
        directory,
        sessionId,
        result?.events,
        questionRejected(sessionId, id),
      )
      return c.json({ ok: true })
    })

  if (opts.exposeCommandRoute !== false) {
    app.get("/command", async (c) => {
      const adapter = await opts.resolveAdapter(c)
      const directory = await opts.resolveDirectory(c)
      try {
        return c.json(await adapter.listCommands?.(directory) ?? [])
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
