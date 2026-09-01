import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type {
  AgentMessageRow,
  AgentPermissionRow,
  AgentQuestionRow,
  AgentRuntime,
  AgentSessionRow,
  RuntimeDirectory,
  SessionConfig,
  SessionConfigRequestUpdate,
  HarnessCapabilities,
} from "@claxedo/agent-sdk-runtime"
import type {
  AgentHarnessAdapter,
  AgentMessagePage,
  AgentMessagePageInput,
} from "@claxedo/agent-sdk-runtime/adapters"
import { AgentMessagePageError, hasAdapterCapability } from "@claxedo/agent-sdk-runtime/adapters"
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
  withDir,
  type CompatEvent,
  type CompatEnvelope,
} from "../compat-events"
import { recovering } from "@claxedo/agent-sdk-runtime/status"
import { attachSseFanout } from "@claxedo/agent-sdk-runtime/sse"
import {
  compatScope,
  runRuntimePromptTurn,
  runSessionPromptTurn,
  sessionPromptReply,
  type ActiveTurnScope,
  type RuntimeSessionBusEvent,
  type SessionPromptBody,
} from "../session/service"
import { normalizeSessionConfigUpdate, normalizeSessionCreateConfig } from "../session-config"
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
  messages: AgentMessageRow[]
  maxEventOrdinal?: number
  fencingToken?: number
}

type Ctx = Context

async function readSession(
  opts: Opts,
  c: Ctx,
  directory: RuntimeDirectory,
  sessionId: string,
  adapter?: AgentHarnessAdapter,
) {
  const resolvedAdapter = adapter ?? await opts.resolveAdapter(c, { sessionId, directory })
  const session = opts.getSession
    ? await opts.getSession(c, directory, sessionId, resolvedAdapter)
    : await resolvedAdapter.getSession(sessionId, directory)
  return session ?? undefined
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
  if (page.nextCursor !== undefined) {
    c.header("Access-Control-Expose-Headers", "X-Next-Cursor")
    c.header("X-Next-Cursor", page.nextCursor)
  }
  return noStoreJson(c, page.messages)
}

function throwMessagePageError(error: unknown, fallbackStatus: 500 | 502): never {
  if (!(error instanceof AgentMessagePageError)) throw error
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
    ? error.status as ContentfulStatusCode
    : fallbackStatus
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
  listSessions?: (c: Ctx, directory: RuntimeDirectory) => Promise<AgentSessionRow[]>
  listSubagents?: (c: Ctx, directory: RuntimeDirectory, parentSessionId: string) => Promise<unknown[]> | unknown[]
  createSession?: (c: Ctx, directory: RuntimeDirectory, title?: string, id?: string) => Promise<{ id: string }>
  listPermissions?: (c: Ctx, directory: RuntimeDirectory) => Promise<AgentPermissionRow[]>
  listQuestions?: (c: Ctx, directory: RuntimeDirectory) => Promise<AgentQuestionRow[]>
  getStatus?: (c: Ctx, directory: RuntimeDirectory, adapter: AgentHarnessAdapter) => Promise<unknown | Response> | unknown | Response
  afterListSessions?: (c: Ctx, directory: RuntimeDirectory, sessions: AgentSessionRow[]) => Promise<void> | void
  afterCreateSession?: (c: Ctx, directory: RuntimeDirectory, session: unknown) => Promise<void> | void
  getSession?: (c: Ctx, directory: RuntimeDirectory, sessionId: string, adapter: AgentHarnessAdapter) => Promise<AgentSessionRow | null> | AgentSessionRow | null
  afterGetSession?: (c: Ctx, directory: RuntimeDirectory, session: unknown) => Promise<void> | void
  getSessionConfig?: (c: Ctx, directory: RuntimeDirectory, sessionId: string, adapter: AgentHarnessAdapter) => Promise<SessionConfig>
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
  getMessages?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<AgentMessageRow[] | undefined> | AgentMessageRow[] | undefined
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
    session: unknown,
    updates: { title?: string; time?: { archived?: number } },
  ) => Promise<void> | void
  afterDeleteSession?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<void> | void
  afterMessageCheckpoint?: (c: Ctx, directory: RuntimeDirectory, sessionId: string, messages: AgentMessageRow[]) => Promise<void> | void
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
  sessionId: string
  directory: RuntimeDirectory
  modeId?: string
}) {
  if (!input.modeId || !input.adapter.setPermissionMode) return
  try {
    await input.adapter.setPermissionMode(input.sessionId, input.modeId, input.directory)
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

function rec(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
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

function normalizeSession(s: unknown, fallbackDirectory?: RuntimeDirectory): unknown {
  if (!s || typeof s !== "object") return s
  const r = s as Record<string, unknown>
  if (r.time) return r
  const ts = typeof r.created_at === "number" ? r.created_at : Date.now()
  const archived = typeof r.archived_at === "number" ? r.archived_at : undefined
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
    time: { created: ts, updated: ts, ...(archived !== undefined ? { archived } : {}) },
  }
}

function summarizeSession(s: unknown): unknown {
  const row = normalizeSession(s)
  if (!row || typeof row !== "object") return row
  const item = row as Record<string, unknown>
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
  const time = rec(row.time)
  const created = typeof time?.created === "number"
    ? time.created
    : typeof row.created_at === "number"
    ? row.created_at
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
        : typeof row.updated_at === "number"
        ? row.updated_at
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
}[keyof HarnessCapabilities]

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
      ...sessionAccessContext(input.c as never),
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
) {
  if (runtime) {
    await runtime.turns.abort(sessionId, directory).catch(() => undefined)
    return
  }
  await adapter.abort?.(sessionId, directory).catch(() => undefined)
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
    ...sessionAccessContext(c as never),
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
    await input.adapter.deleteSession(input.sessionId, input.directory)
    await input.opts.afterDeleteSession?.(input.c, input.directory, input.sessionId)
  } catch (error) {
    throw new AggregateError([error], "Session compensation could not delete runtime state")
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

async function unsupportedIfDisabled(
  c: Ctx,
  adapter: AgentHarnessAdapter,
  directory: RuntimeDirectory,
  key: CapabilityKey,
  operation: string = key,
  sessionId?: string,
) {
  const caps = await adapter.readHarnessCapabilities(directory, sessionId ? { sessionId } : undefined)
  if (caps[key]) return
  return unsupportedOperation(c, caps, operation, { capability: key })
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
  if (typeof adapter[method] === "function") return
  return unsupportedOperation(c, caps, operation, {
    capability: key,
    reason: "adapter_method_unavailable",
    message: `${caps.harness} advertised ${key} but did not provide ${String(method)}`,
  })
}

function sameSessionHarness(a: SessionConfig["harness"], b: SessionConfig["harness"]) {
  return a.id === b.id
    && a.access === b.access
    && (b.connection === undefined || JSON.stringify(a.connection ?? null) === JSON.stringify(b.connection))
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
    ...sessionAccessContext(c as never),
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
    await adapter.deleteSession(sessionId, directory)
    await opts.afterDeleteSession?.(c, directory, sessionId)
  } catch (cleanupError) {
    throw new AggregateError(
      [cause, cleanupError],
      "Session creation failed and runtime rollback also failed",
    )
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
    ...sessionAccessContext(c as never),
    operation,
    method: c.req.method,
    path: c.req.path,
    sessionIds: [...new Set(sessionIds.filter(Boolean))],
  }))
}

function explicitSessionId(input: unknown) {
  const row = rec(input)
  return typeof row?.sessionID === "string"
    ? row.sessionID
    : typeof row?.sessionId === "string"
      ? row.sessionId
      : ""
}

function rowSessionId(input: unknown) {
  const row = rec(input)
  return explicitSessionId(row) || (typeof row?.id === "string" ? row.id : "")
}

function interactionSessionId(rows: readonly unknown[], interactionId: string) {
  return explicitSessionId(rows.find((item) => rec(item)?.id === interactionId))
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
  if (!status || typeof status !== "object" || Array.isArray(status)) return status
  const entries = Object.entries(status as Record<string, unknown>)
  const allowed = await collectionSessionIds(opts, c, "session_status", entries.map(([sessionId]) => sessionId))
  return Object.fromEntries(entries.filter(([sessionId]) => allowed.has(sessionId)))
}

function sessionBusEventSessionId(event: unknown) {
  const row = rec(event)
  if (typeof row?.sessionId === "string") return row.sessionId
  if (typeof row?.sessionID === "string") return row.sessionID
  if (row?.type === "process.status" && typeof row.configId === "string") return row.configId
  const payload = rec(row?.payload)
  const properties = rec(payload?.properties)
  if (typeof properties?.sessionID === "string") return properties.sessionID
  if (typeof properties?.sessionId === "string") return properties.sessionId
}

function sensitiveSessionBusEvent(event: unknown) {
  const row = rec(event)
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
  // the Session V2 wildcard proxy, WorkGraph gateway, and vendored OpenCode
  // engine have independent admission semantics outside this lease boundary.
  // The server's checkpoint-freeze middleware runs before these routes, so a
  // 423 response may preempt lease acquisition entirely.
  const promptAdmissions = new Map<string, Set<string>>()
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
  app
    .get("/session", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const roots = c.req.query("roots") === "true" || c.req.query("roots") === "1"
      const sessions = opts.listSessions
        ? await opts.listSessions(c, directory)
        : await (await opts.resolveAdapter(c)).listSessions(directory)
      await after(opts.afterListSessions?.(c, directory, sessions))
      const visible = await filterSessionRows(opts, c, "session_list", sessions)
      const data = (visible as unknown[]).map((session) => normalizeSession(session, directory))
      return c.json(data)
    })
    .get("/experimental/session", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const limit = Math.min(Number(c.req.query("limit") ?? "100") || 100, 500)
      const roots = c.req.query("roots") === "true" || c.req.query("roots") === "1"
      const archived = c.req.query("archived") === "true" || c.req.query("archived") === "1"
      const sessions = opts.listSessions
        ? await opts.listSessions(c, directory)
        : await (await opts.resolveAdapter(c)).listSessions(directory)
      await after(opts.afterListSessions?.(c, directory, sessions))
      const visible = await filterSessionRows(opts, c, "session_list", sessions)
      const data = (visible as unknown[])
          .map(summarizeSession)
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .filter((item) => !roots || typeof item.parentID !== "string")
          .filter((item) => archived || typeof rec(item.time)?.archived !== "number")
          .slice(0, limit)
      return c.json(data)
    })
    .get("/session/status", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const adapter = await opts.resolveAdapter(c)
      const status = await opts.getStatus?.(c, directory, adapter)
      if (status instanceof Response) {
        if (!opts.sessionAccessPolicy) return status
        const data = await status.clone().json().catch(() => undefined)
        if (data === undefined) return status
        return c.json(
          await filterSessionStatus(opts, c, data),
          status.status as ContentfulStatusCode,
          Object.fromEntries(status.headers.entries()),
        )
      }
      return c.json(await filterSessionStatus(opts, c, status ?? {}))
    })
    .post("/session", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const body = (await c.req.json().catch(() => ({}))) as { id?: string; title?: string }
      const guarded = await sessionOperationGuard(opts, c, "", "session_create")
      if (guarded) return guarded
      const operationId = registrationOperationId(c)
      if (managedRegistration(opts) && (!body.id || !operationId)) {
        return c.json(errorBody(
          "session_reservation_required",
          "Managed session creation requires a preassigned session id and reservation operation",
        ), 400)
      }
      const config = normalizeSessionCreateConfig(body)
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
        if (config.model && hasAdapterCapability(adapter, "runtime-config")) {
          adapter.setModel(config.model.modelID === "default" ? "" : config.model.modelID)
        }
        const existing = body.id ? await readSession(opts, c, directory, body.id, adapter) : undefined
        const session = existing ?? (opts.createSession
          ? await opts.createSession(c, directory, body.title, body.id)
          : await adapter.createSession(directory, body.title, body.id))
        if (Object.keys(config).length > 0) {
          try {
            if (opts.updateSessionConfig) {
              await opts.updateSessionConfig(c, directory, session.id, config, adapter)
            } else {
              await adapter.updateSessionConfig(session.id, config, directory)
            }
          } catch (error) {
            await rollbackCreatedSession(opts, c, adapter, directory, session.id, error)
            throw error
          }
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
        return c.json(normalizeSession(session, directory), 201)
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
    })
    // Register the harness capability routes, both global
    // (`/session/capabilities`, no :id) and per-session
    // (`/session/:id/capabilities`) routes BEFORE the parameterised
    // `/session/:id` so Hono doesn't interpret "capabilities" as a
    // session id.
    .get("/session/capabilities", async (c) => {
      const adapter = await opts.resolveAdapter(c)
      const directory = await opts.resolveDirectory(c)
      const caps = await adapter.readHarnessCapabilities(directory)
      return noStoreJson(c, caps)
    })
    .get("/session/:id/capabilities", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_capabilities_read")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const caps = await adapter.readHarnessCapabilities(directory, { sessionId })
      return noStoreJson(c, caps)
    })
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
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const session = await readSession(opts, c, directory, sessionId, adapter)
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
        : await adapter.getSessionConfig(sessionId, directory)
      return noStoreJson(c, config)
    })
    .patch("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_meta_write")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const body = (await c.req.json().catch(() => ({}))) as { title?: string; time?: { archived?: number } }
      const session = await adapter.updateSession(sessionId, body, directory)
      if (!session) return c.json(sessionNotFound(), 404)
      await after(opts.afterUpdateSession?.(c, directory, session, body))
      return c.json(normalizeSession(session, directory))
    })
    .patch("/session/:id/config", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "session_config_write")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const body = normalizeSessionConfigUpdate(await c.req.json().catch(() => ({})))
      if (body.harness) {
        const current = opts.getSessionConfig
          ? await opts.getSessionConfig(c, directory, sessionId, adapter)
          : await adapter.getSessionConfig(sessionId, directory)
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
        : await adapter.updateSessionConfig(sessionId, body, directory)
      return c.json(config)
    })
    .delete("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "delete")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      await disposeRuntimeSessionDocuments(sessionId)
      await adapter.deleteSession(sessionId, directory)
      await after(opts.afterDeleteSession?.(c, directory, sessionId))
      return c.json({ ok: true })
    })
    .post("/session/:id/message", async (c) => {
      const id = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, id, "prompt")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId: id })
      const adapter = await opts.resolveAdapter(c, { sessionId: id, directory })
      const runtime = await opts.resolveRuntime?.(c, { sessionId: id, directory })
      const access = sessionAccessContext(c as never)
      const parsedBody = (await c.req.json().catch(() => ({}))) as SessionPromptBody
      const body = await opts.transformPromptBody?.(c, { sessionId: id, directory, body: parsedBody }) ?? parsedBody
      const turnAdmission = await acquireManagedPromptLease({
        opts,
        c,
        sessionId: id,
        turnId: body.messageID,
        onLost: () => stopLostTurn(runtime, adapter, id, directory),
      })
      if (turnAdmission.rejected) return turnAdmission.rejected
      if (!runtime) await applyTurnPermissionMode({ adapter, sessionId: id, directory, modeId: body.permissionMode })
      const activeTurn = runtime && opts.createActiveTurnScope
        ? turnScope(opts.createActiveTurnScope({ c, adapter, directory, sessionId: id }), turnAdmission.lease)
        : undefined
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
      if (snapshotRequested) {
        const snapshot = await opts.getMessageSnapshot?.(c, directory, sessionId)
        if (snapshot) {
          const session = await readSession(opts, c, directory, sessionId)
          if (!session) return noStoreJson(c, sessionNotFound(), 404)
          return noStoreJson(c, { ...snapshot, session: normalizeSession(session, directory) })
        }
      }
      const pageInput = snapshotRequested ? undefined : messagePageInput(c)
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
            return messagePageResponse(c, await adapter.getMessagePage(sessionId, pageInput, directory))
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
          adapter.getMessages(sessionId, directory),
          readSession(opts, c, directory, sessionId, adapter),
        ])
        if (!session) return noStoreJson(c, sessionNotFound(), 404)
        return noStoreJson(c, { messages, session: normalizeSession(session, directory) })
      }
      return noStoreJson(c, await adapter.getMessages(sessionId, directory))
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
      return noStoreJson(c, await adapter.getTodos!(sessionId, directory))
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
      if (!adapter.listPermissionModes) {
        const caps = await adapter.readHarnessCapabilities(directory)
        return noStoreJson(c, {
          modes: [],
          unsupported: `${caps.harness} has no permission modes of its own`,
          appliesFrom: "next-turn",
        })
      }
      // Empty session id: adapters treat it as "no session", which is exactly
      // what a draft is.
      return noStoreJson(c, await adapter.listPermissionModes("", directory))
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
      return noStoreJson(c, await adapter.listPermissionModes(sessionId, directory))
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
      const body = (await c.req.json().catch(() => ({}))) as { modeId?: unknown }
      const modeId = typeof body.modeId === "string" ? body.modeId : ""
      if (!modeId) return c.json({ error: "modeId is required" }, 400)
      // The adapter's own read-back is returned verbatim. A harness that kept a
      // different mode than the one requested must reach the client as the mode
      // it kept, not as an echo of the request.
      try {
        return c.json(await adapter.setPermissionMode(sessionId, modeId, directory))
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
        : await adapter.abort!(sessionId, directory)
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
      await adapter.revert!(sessionId, directory)
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
      await adapter.unrevert!(sessionId, directory)
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
      const body = (await c.req.json().catch(() => ({}))) as { id?: string; messageId?: string }
      const operationId = registrationOperationId(c)
      if (managedRegistration(opts) && (!body.id || !operationId)) {
        return c.json(errorBody(
          "session_reservation_required",
          "Managed session forks require a preassigned child session id and reservation operation",
        ), 400)
      }
      const child = await adapter.forkSession!(sessionId, body.messageId ?? "", directory, body.id)
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
      const body = (await c.req.json().catch(() => ({}))) as { command?: string }
      await adapter.executeCommand!(sessionId, body.command ?? "", directory)
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
      const body = (await c.req.json().catch(() => ({}))) as {
        command?: string
        agent?: string
        model?: { providerID: string; modelID: string }
        messageID?: string
      }
      await adapter.shell!(sessionId, {
        command: body.command ?? "",
        agent: body.agent ?? "",
        ...(body.model ? { model: body.model } : {}),
        ...(body.messageID ? { messageID: body.messageID } : {}),
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
      const body = (await c.req.json().catch(() => ({}))) as {
        providerID?: string
        modelID?: string
        auto?: boolean
      }
      await adapter.summarize!(sessionId, {
        providerID: body.providerID ?? "",
        modelID: body.modelID ?? "",
        ...(body.auto !== undefined ? { auto: body.auto } : {}),
      }, directory)
      return c.json({ ok: true })
    })
    .post("/session/:id/prompt_async", async (c) => {
      const id = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, id, "prompt")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId: id })
      const adapter = await opts.resolveAdapter(c, { sessionId: id, directory })
      const parsedBody = (await c.req.json().catch(() => ({}))) as SessionPromptBody
      const body = await opts.transformPromptBody?.(c, { sessionId: id, directory, body: parsedBody }) ?? parsedBody
      if (body.messageID) {
        const admitted = promptAdmissions.get(id) ?? new Set<string>()
        if (admitted.has(body.messageID)) return c.body(null, 204)
        admitted.add(body.messageID)
        promptAdmissions.set(id, admitted)
        try {
          if (c.req.header("x-claxedo-idempotency-retry") === "1") {
            const messages = await opts.getMessages?.(c, directory, id) ?? await adapter.getMessages(id, directory)
            const projected = messages.some((message) => rec(message.info)?.id === body.messageID)
            const session = projected
              ? undefined
              : await (opts.getSession
                  ? opts.getSession(c, directory, id, adapter)
                  : adapter.getSession(id, directory))
            if (
              projected
              || session?.status === "busy"
              || session?.status === "recovering"
              || session?.status === "retry"
            ) return c.body(null, 204)
          }
        } catch (error) {
          admitted.delete(body.messageID)
          if (admitted.size === 0) promptAdmissions.delete(id)
          throw error
        }
      }
      const runtime = await opts.resolveRuntime?.(c, { sessionId: id, directory })
      const turnAdmission = await acquireManagedPromptLease({
        opts,
        c,
        sessionId: id,
        turnId: body.messageID,
        onLost: () => stopLostTurn(runtime, adapter, id, directory),
      })
      if (turnAdmission.rejected) {
        if (body.messageID) {
          const admitted = promptAdmissions.get(id)
          admitted?.delete(body.messageID)
          if (admitted?.size === 0) promptAdmissions.delete(id)
        }
        return turnAdmission.rejected
      }
      const access = sessionAccessContext(c as never)
      if (!runtime) await applyTurnPermissionMode({ adapter, sessionId: id, directory, modeId: body.permissionMode })
      let settleAdmission: ((error?: unknown) => void) | undefined
      const admission = runtime
        ? new Promise<unknown>((resolve) => {
            settleAdmission = resolve
          })
        : undefined
      ;(async () => {
        try {
          const turn = runtime
            ? await runRuntimePromptTurn({
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
            : await runSessionPromptTurn({
                adapter,
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
          if (!turnAdmission.lease?.lost()) {
            await after(opts.afterMessageCheckpoint?.(c, directory, id, turn.messages))
          }
        } catch (error) {
          settleAdmission?.(error)
          if (isAgentRuntimeTurnConflictError(error)) return
          // Keep a human-safe headline but never discard the cause: route the real
          // message through sessionError (→ firstTurnErrorData), so it classifies
          // (unmatched → "unknown") and the original text reaches the raw-detail
          // disclosure instead of being flattened to the literal "Stream error".
          opts.publishGlobal(withDir(compatScope(directory, id), sessionError(streamTurnErrorMessage(error), id)))
        } finally {
          const leaseLost = turnAdmission.lease?.lost() ?? false
          if (!leaseLost) {
            await flushDocumentsAfterTurn(opts, id)
            await after(opts.afterMessageCheckpoint?.(c, directory, id, await adapter.getMessages(id, directory)))
          }
          await turnAdmission.lease?.release().catch(() => undefined)
        }
      })()
      const admissionError = admission ? await awaitAdmissionAck(admission) : undefined
      // Admission did not settle within the bound — honor prompt_async's
      // fire-and-forget contract rather than block on a wedged turn.
      if (admissionError === ADMISSION_ACK_TIMED_OUT) return c.body(null, 204)
      if (isAgentRuntimeTurnConflictError(admissionError)) {
        if (body.messageID) {
          const admitted = promptAdmissions.get(id)
          admitted?.delete(body.messageID)
          if (admitted?.size === 0) promptAdmissions.delete(id)
        }
        return turnAdmissionConflict(c)
      }
      return c.body(null, 204)
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
      return c.json(await filterSessionRows(opts, c, "question_list", rows))
    })
    .post("/session/:sessionId/permissions/:permId", async (c) => {
      const suppliedSessionId = c.req.param("sessionId")
      const permId = c.req.param("permId")
      const directory = await opts.resolveDirectory(c, { sessionId: suppliedSessionId })
      const listedSessionId = interactionSessionId(await opts.listPermissions?.(c, directory) ?? [], permId)
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
      const body = (await c.req.json().catch(() => ({}))) as { response?: string }
      const r = body.response ?? "deny"
      const decision = r === "once" ? "allow_once" : r === "always" ? "allow_always" : "deny"
      const result = await adapter.respondPermission!(permId, decision, directory)
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
      const body = (await c.req.json().catch(() => ({}))) as { answer?: string; answers?: string[][] }
      const result = await adapter.replyQuestion!(id, body.answer ?? "", directory)
      publishInteractionEvents(
        opts.publishGlobal,
        directory,
        sessionId,
        result?.events,
        questionReplied(sessionId, id, body.answers ?? [[body.answer ?? ""]]),
      )
      return c.json({ ok: true })
    })
    .post("/question/:id/reject", async (c) => {
      const admitted = await admitQuestionOperation(opts, c, "rejectQuestion")
      if (admitted.rejected) return admitted.rejected
      const { id, directory, adapter, sessionId } = admitted
      const result = await adapter.rejectQuestion!(id, directory)
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
          heartbeatMs: 2 * 60_000,
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
