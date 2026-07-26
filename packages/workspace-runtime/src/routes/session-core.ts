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
  SessionConfigUpdate,
  HarnessCapabilities,
} from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { hasAdapterCapability } from "@claxedo/agent-sdk-runtime/adapters"
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
import { attachSseFanout, createSseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import {
  compatScope,
  runRuntimePromptTurn,
  runSessionPromptTurn,
  sessionPromptReply,
  type ActiveTurnScope,
  type RuntimeSessionBusEvent,
  type SessionPromptBody,
} from "../session/service"
import { normalizeSessionConfigUpdate } from "../session-config"
import { disposeRuntimeSessionDocuments, flushRuntimeSessionDocuments } from "./document-hydration"

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
}

type Ctx = Context

function noStoreJson(c: Ctx, data: unknown, status?: ContentfulStatusCode) {
  return c.json(data, status, {
    "Cache-Control": "no-store",
  })
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
  resolveDirectory: (
    c: Ctx,
    input?: {
      sessionId?: string
    },
  ) => Promise<RuntimeDirectory> | RuntimeDirectory
  listSessions?: (c: Ctx, directory: RuntimeDirectory) => Promise<AgentSessionRow[]>
  createSession?: (c: Ctx, directory: RuntimeDirectory, title?: string) => Promise<{ id: string }>
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
    update: SessionConfigUpdate,
    adapter: AgentHarnessAdapter,
  ) => Promise<SessionConfig>
  getMessages?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<AgentMessageRow[] | undefined> | AgentMessageRow[] | undefined
  getMessageSnapshot?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<MessageSnapshot | undefined> | MessageSnapshot | undefined
  afterUpdateSession?: (c: Ctx, directory: RuntimeDirectory, session: unknown) => Promise<void> | void
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


/**
 * Apply a turn's requested permission mode before the prompt reaches the harness.
 *
 * Best-effort ON PURPOSE, and the asymmetry with the PUT route is deliberate: a
 * bad mode id there is the whole request and must fail loudly, whereas here it
 * rides along with a message the user is trying to send. Refusing the message
 * because a stale mode id no longer exists would be a worse outcome than running
 * the turn under the harness's current mode, so this logs the divergence and
 * lets the prompt through.
 *
 * Returns nothing: callers do not branch on it. The mode either landed before
 * the turn or the turn runs as the harness already stood.
 */
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
    // Swallowed by design -- see the note above.
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
    title: typeof row.title === "string" ? row.title : input.title ?? "New Session",
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

async function questionSession(adapter: AgentHarnessAdapter, qId: string, directory: RuntimeDirectory, sessionId?: string) {
  if (sessionId) return sessionId
  if (qId.includes(":")) return qId.split(":")[0] ?? ""
  const list = await adapter.listQuestions?.(directory) ?? []
  const hit = list.find((item) => {
    const row = rec(item)
    return row?.id === qId
  })
  return typeof rec(hit)?.sessionID === "string" ? String(rec(hit)?.sessionID) : ""
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

function sessionOperationGuard(
  opts: Opts,
  c: Ctx,
  sessionId: string,
  operation: string,
) {
  return opts.beforeSessionOperation?.(c, { sessionId, operation })
}

export function createSessionRoutes(opts: Opts) {
  const app = new Hono()
  const promptAdmissions = new Map<string, Set<string>>()
  const sessionBusReplay = createSseReplayBuffer<unknown>()
  opts.sessionBus.subscribe((event) => {
    sessionBusReplay.push(event)
  })
  app
    .get("/session", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const roots = c.req.query("roots") === "true" || c.req.query("roots") === "1"
      const sessions = opts.listSessions
        ? await opts.listSessions(c, directory)
        : await (await opts.resolveAdapter(c)).listSessions(directory)
      await after(opts.afterListSessions?.(c, directory, sessions))
      const data = (sessions as unknown[]).map((session) => normalizeSession(session, directory))
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
      const data = (sessions as unknown[])
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
      if (status instanceof Response) return status
      return c.json(status ?? {})
    })
    .post("/session", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const body = (await c.req.json().catch(() => ({}))) as { title?: string; model?: unknown }
      const config = normalizeSessionConfigUpdate(body)
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
        const session = opts.createSession
          ? await opts.createSession(c, directory, body.title)
          : await adapter.createSession(directory, body.title)
        await after(opts.afterCreateSession?.(c, directory, session))
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
      const guarded = await sessionOperationGuard(opts, c, sessionId, "capabilities")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const caps = await adapter.readHarnessCapabilities(directory, { sessionId })
      return noStoreJson(c, caps)
    })
    .get("/session/:id", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "get_session")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const session = opts.getSession
        ? await opts.getSession(c, directory, sessionId, adapter)
        : await adapter.getSession(sessionId, directory)
      if (!session) return noStoreJson(c, sessionNotFound(), 404)
      await after(opts.afterGetSession?.(c, directory, session))
      return noStoreJson(c, normalizeSession(session, directory))
    })
    .get("/session/:id/config", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "get_config")
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
      const guarded = await sessionOperationGuard(opts, c, sessionId, "update_session")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const body = (await c.req.json().catch(() => ({}))) as { title?: string; time?: { archived?: number } }
      const session = await adapter.updateSession(sessionId, body, directory)
      if (!session) return c.json(sessionNotFound(), 404)
      await after(opts.afterUpdateSession?.(c, directory, session))
      return c.json(normalizeSession(session, directory))
    })
    .patch("/session/:id/config", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "update_config")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const body = normalizeSessionConfigUpdate(await c.req.json().catch(() => ({})))
      if (body.harness) {
        const current = opts.getSessionConfig
          ? await opts.getSessionConfig(c, directory, sessionId, adapter)
          : await adapter.getSessionConfig(sessionId, directory)
        if (!sameSessionHarness(current.harness, body.harness)) {
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
      const guarded = await sessionOperationGuard(opts, c, sessionId, "delete_session")
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
      const guarded = await sessionOperationGuard(opts, c, id, "message")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId: id })
      const adapter = await opts.resolveAdapter(c, { sessionId: id, directory })
      const runtime = await opts.resolveRuntime?.(c, { sessionId: id, directory })
      const parsedBody = (await c.req.json().catch(() => ({}))) as SessionPromptBody
      const body = await opts.transformPromptBody?.(c, { sessionId: id, directory, body: parsedBody }) ?? parsedBody
      await applyTurnPermissionMode({ adapter, sessionId: id, directory, modeId: body.permissionMode })
      const activeTurn = runtime && opts.createActiveTurnScope
        ? opts.createActiveTurnScope({ c, adapter, directory, sessionId: id })
        : undefined
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
              })
            : await runSessionPromptTurn({
            adapter,
            sessionId: id,
            directory,
            body,
            publishGlobal: opts.publishGlobal,
            publishStatus: (event) => opts.sessionBus.publish(event),
            createActiveTurnScope: opts.createActiveTurnScope
              ? ({ adapter, directory, sessionId }) => opts.createActiveTurnScope?.({ c, adapter, directory, sessionId })
              : undefined,
              })
        } finally {
          await flushDocumentsAfterTurn(opts, id)
        }
      })()
      await after(opts.afterMessageCheckpoint?.(c, directory, id, turn.messages))
      const output = sessionPromptReply(turn)
      if (output.assistantMessage) opts.publishGlobal(withDir(turn.scope, messageUpdated(output.assistantMessage)))
      return c.json(output.body)
    })
    .get("/session/:id/message", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "messages")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId })
      if (c.req.query("snapshot") === "1") {
        const snapshot = await opts.getMessageSnapshot?.(c, directory, sessionId)
        if (snapshot) return noStoreJson(c, snapshot)
      }
      const replay = await opts.getMessages?.(c, directory, sessionId)
      if (replay) return noStoreJson(c, replay)
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const messages = await adapter.getMessages(sessionId, directory)
      return noStoreJson(c, messages)
    })
    .get("/session/:id/todo", async (c) => {
      const sessionId = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, sessionId, "todos")
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
      const guarded = await sessionOperationGuard(opts, c, sessionId, "permission_mode")
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
        // which reads as "the runtime broke" and would send someone debugging
        // the wrong layer. Verified live against claude-agent-acp.
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
      const result = await adapter.abort!(sessionId, directory)
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
      const body = (await c.req.json().catch(() => ({}))) as { messageId?: string }
      return c.json(await adapter.forkSession!(sessionId, body.messageId ?? "", directory), 201)
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
    .post("/session/:id/prompt_async", async (c) => {
      const id = c.req.param("id")
      const guarded = await sessionOperationGuard(opts, c, id, "prompt_async")
      if (guarded) return guarded
      const directory = await opts.resolveDirectory(c, { sessionId: id })
      const adapter = await opts.resolveAdapter(c, { sessionId: id, directory })
      const parsedBody = (await c.req.json().catch(() => ({}))) as SessionPromptBody
      const body = await opts.transformPromptBody?.(c, { sessionId: id, directory, body: parsedBody }) ?? parsedBody
      await applyTurnPermissionMode({ adapter, sessionId: id, directory, modeId: body.permissionMode })
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
      ;(async () => {
        try {
          const activeTurn = runtime && opts.createActiveTurnScope
            ? opts.createActiveTurnScope({ c, adapter, directory, sessionId: id })
            : undefined
          const turn = runtime
            ? await runRuntimePromptTurn({
                runtime,
                sessionId: id,
                directory,
                body,
                publishGlobal: opts.publishGlobal,
                publishStatus: (event) => opts.sessionBus.publish(event),
                activeTurn,
                streamErrorMessage: streamTurnErrorMessage,
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
                  ? ({ adapter, directory, sessionId }) => opts.createActiveTurnScope?.({ c, adapter, directory, sessionId })
                  : undefined,
              })
          await after(opts.afterMessageCheckpoint?.(c, directory, id, turn.messages))
        } catch (error) {
          // Keep a human-safe headline but never discard the cause: route the real
          // message through sessionError (→ firstTurnErrorData), so it classifies
          // (unmatched → "unknown") and the original text reaches the raw-detail
          // disclosure instead of being flattened to the literal "Stream error".
          opts.publishGlobal(withDir(compatScope(directory, id), sessionError(streamTurnErrorMessage(error), id)))
        } finally {
          await flushDocumentsAfterTurn(opts, id)
          await after(opts.afterMessageCheckpoint?.(c, directory, id, await adapter.getMessages(id, directory)))
        }
      })()
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
      return c.json(rows)
    })
    .get("/question", async (c) => {
      const directory = await opts.resolveDirectory(c)
      const rows = opts.listQuestions
        ? await opts.listQuestions(c, directory)
        : await (await opts.resolveAdapter(c)).listQuestions?.(directory) ?? []
      return c.json(rows)
    })
    .post("/session/:sessionId/permissions/:permId", async (c) => {
      const guarded = await sessionOperationGuard(opts, c, c.req.param("sessionId"), "permission_response")
      if (guarded) return guarded
      const sessionId = c.req.param("sessionId")
      const directory = await opts.resolveDirectory(c, { sessionId })
      const adapter = await opts.resolveAdapter(c, { sessionId, directory })
      const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "permissions", "respondPermission", "permission_response")
      if (unsupported) return unsupported
      const body = (await c.req.json().catch(() => ({}))) as { response?: string }
      const r = body.response ?? "deny"
      const decision = r === "once" ? "allow_once" : r === "always" ? "allow_always" : "deny"
      const permId = c.req.param("permId")
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
      const sessionId = c.req.query("sessionId") ?? ""
      if (sessionId) {
        const guarded = await sessionOperationGuard(opts, c, sessionId, "question_response")
        if (guarded) return guarded
      }
      const directory = await opts.resolveDirectory(c)
      const question = sessionId ? undefined : (await opts.listQuestions?.(c, directory))?.find((item) => item.id === c.req.param("id"))
      const adapter = await opts.resolveAdapter(c, { sessionId: sessionId || question?.sessionID, directory })
      const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "questions", "replyQuestion", "question_response")
      if (unsupported) return unsupported
      const body = (await c.req.json().catch(() => ({}))) as { answer?: string; answers?: string[][] }
      const id = c.req.param("id")
      const sid = sessionId || question?.sessionID || await questionSession(adapter, id, directory)
      const result = await adapter.replyQuestion!(id, body.answer ?? "", directory)
      publishInteractionEvents(
        opts.publishGlobal,
        directory,
        sid,
        result?.events,
        questionReplied(sid, id, body.answers ?? [[body.answer ?? ""]]),
      )
      return c.json({ ok: true })
    })
    .post("/question/:id/reject", async (c) => {
      const sessionId = c.req.query("sessionId") ?? ""
      if (sessionId) {
        const guarded = await sessionOperationGuard(opts, c, sessionId, "question_response")
        if (guarded) return guarded
      }
      const directory = await opts.resolveDirectory(c)
      const question = sessionId ? undefined : (await opts.listQuestions?.(c, directory))?.find((item) => item.id === c.req.param("id"))
      const adapter = await opts.resolveAdapter(c, { sessionId: sessionId || question?.sessionID, directory })
      const unsupported = await unsupportedIfUnavailable(c, adapter, directory, "questions", "rejectQuestion", "question_response")
      if (unsupported) return unsupported
      const id = c.req.param("id")
      const sid = sessionId || question?.sessionID || await questionSession(adapter, id, directory)
      const result = await adapter.rejectQuestion!(id, directory)
      publishInteractionEvents(
        opts.publishGlobal,
        directory,
        sid,
        result?.events,
        questionRejected(sid, id),
      )
      return c.json({ ok: true })
    })
    .get("/event", async (c) =>
      streamSSE(c, async (stream) => {
        const cleanup = attachSseFanout({
          subscribe: opts.sessionBus.subscribe,
          write: (event, meta) => stream.writeSSE({
            ...(meta?.id ? { id: meta.id } : {}),
            data: JSON.stringify(event),
          }),
          heartbeat: { type: "heartbeat" },
          heartbeatMs: 2 * 60_000,
          lastEventId: c.req.header("last-event-id"),
          replay: sessionBusReplay,
          replayLive: false,
        })
        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            cleanup()
            resolve()
          })
        })
      }),
    )

  if (opts.exposeCommandRoute !== false) {
    app.get("/command", async (c) => {
      const adapter = await opts.resolveAdapter(c)
      const directory = await opts.resolveDirectory(c)
      return c.json(await adapter.listCommands?.(directory) ?? [])
    })
  }

  return app
}
