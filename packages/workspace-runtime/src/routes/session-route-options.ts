import type { Context } from "hono"
import type { AgentContentPart, AgentMessage, AgentSession, AgentSessionStartBinding, AgentSessionStarts, SessionConfig, SessionHarness, AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { ConnectionSecretAuthority } from "@claxedo/agent-runtime-contract"
import type { RuntimeDirectory } from "../host/contracts"
import type { AgentMessagePage, AgentMessagePageInput, AgentTurnCoveragePage } from "@claxedo/agent-runtime-contract"
import type { TurnActor, TurnOrigin } from "@claxedo/harness/contract"
import { CredentialSelectionError } from "@claxedo/harness/registry"
import type { AgentRuntime, AgentRuntimeRecovery, HarnessTarget } from "../host/runtime"
import type { ActiveTurnScope, SessionPromptBody } from "../session/service"
import type { SessionDeliveryOwner } from "../session/delivery-owner"
import type { TurnOutline } from "@claxedo/agent-runtime-contract"
import {
  sessionAccessContext,
  sessionRequestProvenance,
  type SessionAccessContextReader,
  type SessionAccessPolicy,
  type SessionTurnOrigin,
} from "../session-access-policy"
import type { ChildSessionHost } from "./session-children"
import type { SessionStatusSnapshot } from "./session-status-snapshot"

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

export type SessionRouteOptions = {
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
  /**
   * How long POST /prompt_async waits for the turn's admission decision before
   * answering its fire-and-forget 204; 5000 ms when unset. A harness launch that
   * neither admits the turn nor throws must not hold the request open.
   */
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
  getStatus?: (c: Ctx, directory: RuntimeDirectory) => SessionStatusSnapshot | Promise<SessionStatusSnapshot>
  afterListSessions?: (c: Ctx, directory: RuntimeDirectory, sessions: AgentSession[]) => Promise<void> | void
  afterCreateSession?: (c: Ctx, directory: RuntimeDirectory, session: unknown) => Promise<void> | void
  sessionIdWorkspace?: (sessionId: string) => Promise<string | undefined> | string | undefined
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
  getPart?: (c: Ctx, directory: RuntimeDirectory, sessionId: string, messageId: string, partId: string) => Promise<AgentContentPart | undefined> | AgentContentPart | undefined
  /**
   * The turn journal this route answers coverage from. A harness is never
   * asked: only the runtime that holds the journal can establish coverage, and
   * a producer that cannot establish it must not guess.
   */
  turnCoverage?: (
    c: Ctx,
    directory: RuntimeDirectory,
    sessionId: string,
    turnId: string,
  ) => Promise<AgentTurnCoveragePage | undefined> | AgentTurnCoveragePage | undefined
  getMessageSnapshot?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<MessageSnapshot | undefined> | MessageSnapshot | undefined
  getTurnOutline?: (c: Ctx, directory: RuntimeDirectory, sessionId: string) => Promise<TurnOutline | undefined> | TurnOutline | undefined
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
  publishGlobal: (event: AgentEventEnvelope) => void
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

type Opts = SessionRouteOptions

export async function readSession(
  opts: Opts,
  c: Ctx,
  directory: RuntimeDirectory,
  sessionId: string,
) {
  if (opts.getSession) return await opts.getSession(c, directory, sessionId) ?? undefined
  return await (await opts.runtime(c)).sessions.get(sessionId, directory) ?? undefined
}

/**
 * Whose accounts a session created by this request spends: the verified
 * person, whoever relays it on their behalf, or this runtime's owner for a
 * loopback caller and for a platform service that names nobody. A human the
 * token does not name is refused.
 */
export function sessionOwner(c: SessionAccessContextReader): TurnActor {
  const actor = sessionAccessContext(c).actor
  if (!actor) return { kind: "machine-owner" }
  if (actor.userId) return { kind: "person", userId: actor.userId }
  if (actor.actorKind === "agent") return { kind: "machine-owner" }
  throw new CredentialSelectionError("account_unavailable", "Verified account owner is unavailable")
}

/** Who sent a turn, for its record only: a turn spends its session's stored owner's accounts, never the sender's. */
function turnSender(actor: { actorId: string; userId?: string } | undefined): TurnActor {
  return actor ? { kind: "person", userId: actor.userId ?? actor.actorId } : { kind: "machine-owner" }
}

export function turnOriginOf(origin: SessionTurnOrigin | undefined, c: Ctx): TurnOrigin {
  if (origin?.provenance === "relay-replayed") return { actor: turnSender(origin.actor), via: "relay", reissued: false }
  return { actor: turnSender(sessionAccessContext(c).actor), via: "loopback", reissued: false }
}

export async function sessionConfigOf(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string): Promise<SessionConfig> {
  if (opts.getSessionConfig) return await opts.getSessionConfig(c, directory, sessionId)
  return await (await opts.runtime(c)).reads.sessionConfig(sessionId, directory, requestSecretAuthority(c).secretAuthority)
}

/** A read on one session, carrying the proof its connection is attached under when this process does not hold it yet. */
export function sessionTarget(c: Ctx, sessionId: string, directory: RuntimeDirectory): HarnessTarget {
  return { sessionId, ...(directory ? { directory } : {}), ...requestSecretAuthority(c) }
}

/** The relay proof this request was admitted under, which a connection's secrets are leased with while the request runs. */
export function requestSecretAuthority(c: Ctx): { secretAuthority?: ConnectionSecretAuthority } {
  const credential = sessionAccessContext(c).credential
  return credential ? { secretAuthority: { kind: "request", credential } } : {}
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
export function managedSessionLifecycle(opts: Opts, c: Ctx) {
  return opts.sessionAccessPolicy?.sessionAuthority === "managed-private"
    && sessionRequestProvenance(c) === "relay-replayed"
}
