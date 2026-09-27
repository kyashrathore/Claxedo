import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import type {
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentRuntime,
  AgentRuntimeRecovery,
  AgentSession,
  RuntimeDirectory,
  SessionConfig,
  SessionConfigRequestUpdate,
  SessionModelGroup,
} from "@claxedo/agent-sdk-runtime"
import type { AgentExecutionBinding, AgentSessionStartBinding, AgentSessionStarts } from "@claxedo/agent-runtime-contract"
import type { AgentHarnessAdapter, AgentMessagePage, AgentMessagePageInput } from "@claxedo/agent-sdk-runtime/adapters"
import type { AgentTurnCoveragePage } from "@claxedo/agent-sdk-runtime/message-page"
import type { CompatEnvelope } from "../compat-events"
import type { ActiveTurnScope, SessionPromptBody } from "../session/service"
import type { SessionDeliveryOwner } from "../session/delivery-owner"
import { sessionRequestProvenance, type SessionAccessPolicy } from "../session-access-policy"
import type { ChildSessionHost } from "./session-children"

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

export async function readRuntimeSession(
  opts: SessionRouteOptions,
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

export async function requireExecutionBinding(
  opts: SessionRouteOptions,
  c: Ctx,
  directory: RuntimeDirectory,
  sessionId: string,
  adapter: AgentHarnessAdapter,
) {
  const binding = await opts.resolveExecutionBinding?.(c, directory, sessionId, adapter)
  if (!binding) throw new HTTPException(409, { message: `Session ${sessionId} has no complete execution binding` })
  return binding
}

export type SessionRouteOptions = {
  sessionStarts?: AgentSessionStarts
  resolveSessionStartBinding?: (c: Ctx, directory: RuntimeDirectory, sessionId: string, operationId: string) => AgentSessionStartBinding
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
  /**
   * The runtime that already owns this session, or nothing. Recovery resolves
   * no harness and awaits nothing: `resolveRuntime` builds an adapter when the
   * session has none, which starts the very compute a caller is trying to
   * contain, and it refuses outright once the workspace is closing — which is
   * when recovery most has to answer.
   */
  resolveRecoveryOwner?: (c: Ctx, input: { sessionId: string }) => AgentRuntimeRecovery | undefined
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
  createSession?: (c: Ctx, directory: RuntimeDirectory, title?: string, id?: string, create?: { start?: AgentSessionStartBinding; parentID?: string; permissionCeiling?: SessionConfig["permissionCeiling"]; instructions?: string; group?: SessionModelGroup }) => Promise<{ id: string }>
  /** Host-owned child sessions: admission on the parent, idempotent ids, completion wakes. */
  childSessions?: ChildSessionHost
  /** Where a prompt admitted behind a running turn is persisted while it waits. */
  queuedPrompts?: SessionDeliveryOwner
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
    adapter: AgentHarnessAdapter
    directory: RuntimeDirectory
    sessionId: string
  }) => ActiveTurnScope | undefined
  transformPromptBody?: (
    c: Ctx,
    input: { sessionId: string; directory: RuntimeDirectory; body: SessionPromptBody },
  ) => Promise<SessionPromptBody> | SessionPromptBody
}

export async function after(input: void | Promise<void> | undefined) {
  try {
    await input
  } catch {}
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
export function managedSessionLifecycle(opts: SessionRouteOptions, c: Ctx) {
  return opts.sessionAccessPolicy?.sessionAuthority === "managed-private"
    && sessionRequestProvenance(c) === "relay-replayed"
}
