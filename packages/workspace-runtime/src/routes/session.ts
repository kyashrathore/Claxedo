import type { SessionConfig, SessionHarness, SubagentObservation, AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import { HTTPException } from "hono/http-exception"
import { flushRuntimeSessionDocuments } from "./document-hydration"
import { acquireSessionTurnLease, type ActiveSessionTurnLease } from "./session-turn-lease"
import { createSessionRoutes } from "./session-core"
import { publishTurnFailure } from "./session-prompt-admission"
import type { SessionRouteContext } from "./session-route-options"
import type { SessionStatusSnapshot } from "./session-status-snapshot"
import { captureTurnTarget, containLostTurn } from "./session-turn-containment"
import { createChildSessionHost, type ChildOriginStore, type PendingChildWake } from "./session-children"
import { createSessionDeliveryOwner, type SessionDeliveryStore } from "../session/delivery-owner"
import type { TurnOutline } from "@claxedo/agent-runtime-contract"
import { isAgentRuntimeTurnAdmissionError, type AgentRuntime, type AgentRuntimeRecovery } from "../host/runtime"
import { runRuntimePromptTurn } from "../session/service"
import type { AgentContentPart, AgentMessage, AgentMessageAuthor, AgentSession, PromptDelivery } from "@claxedo/agent-runtime-contract"
import type { AgentMessagePage, AgentMessagePageInput, AgentTurnCoveragePage } from "@claxedo/agent-runtime-contract"
import { workspaceRuntimeBus } from "../bus"
import { errorMessage } from "@claxedo/helpers"
import { rec, str } from "../json-value"
import { createRuntimeEventHub, type RuntimeEventHub } from "../projection/runtime-event-hub"
import { assertTarget, registeredWorkspaceDirectory, workspaceId } from "../target"
import { requestedSessionHarness } from "./config"
import type { SessionPromptBody } from "../session/service"
import type { SessionAccessPolicy, SessionTurnOrigin } from "../session-access-policy"
import type { AgentSessionStarts } from "@claxedo/agent-runtime-contract"

function bridgeLifecycleEvent(event: Parameters<RuntimeEventHub["publishGlobal"]>[0]) {
  const payload = event.payload as { type?: unknown; properties?: Record<string, unknown> }
  const sessionID = str(payload.properties?.sessionID) ?? str(payload.properties?.sessionId)
  const status = rec(payload.properties?.status)
  const eventType = payload.type === "session.status" && status?.type === "busy"
    ? "Busy"
    : payload.type === "permission.asked" || payload.type === "question.asked"
    ? "UserActionRequired"
    : payload.type === "session.idle"
    ? "Idle"
    : payload.type === "session.error"
    ? "Error"
    : undefined
  if (!eventType) return
  workspaceRuntimeBus.publish({
    type: "agent.lifecycle",
    tabId: sessionID ?? event.directory,
    workspaceId: workspaceId(),
    directory: event.directory,
    ...(sessionID ? { sessionId: sessionID } : {}),
    eventType,
  })
}

function dir(c: {
  req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined }
}, input?: { sessionId?: string }): string {
  try {
    const requested = c.req.query("directory")
    if (!requested && input?.sessionId) {
      return registeredWorkspaceDirectory(input.sessionId) ?? assertTarget(undefined)
    }
    return assertTarget(requested)
  } catch (err) {
    throw new HTTPException(400, { message: errorMessage(err), cause: err })
  }
}

function requiredDirectory(directory: string | undefined): string {
  if (directory) return directory
  throw new HTTPException(400, { message: "workspace directory is required" })
}

type MessageSnapshot = {
  messages: AgentMessage[]
  maxEventOrdinal?: number
}

export type SessionRoutesOptions = {
  sessionStarts?: AgentSessionStarts
  eventHub?: RuntimeEventHub
  sessionAccessPolicy?: SessionAccessPolicy
  beforeSessionOperation?: (input: { sessionId: string; operation: string }) => Response | undefined
  /** The harness a draft read runs on: what the request named, or this host's default. */
  requestedSessionHarness: (requested: SessionHarness | undefined) => SessionHarness
  /**
   * The recovery API of the runtime that already owns this session. It is
   * separate from the runtime accessor because recovery never builds a harness
   * and never waits on a closing workspace: a host that cannot answer it
   * synchronously has no owner to answer for.
   */
  resolveRecoveryOwner?: (input: { sessionId: string }) => AgentRuntimeRecovery | undefined
  listSessions?: (c: SessionRouteContext, directory: string) => Promise<AgentSession[]>
  /** Host-owned status transport. The session-core route remains the only
   * public handler so its private-session filter cannot be shadowed. */
  getStatus?: (c: SessionRouteContext, directory: string) => SessionStatusSnapshot | Promise<SessionStatusSnapshot>
  afterCreateSession?: (input: { directory: string; session: unknown }) => Promise<void> | void
  sessionIdWorkspace?: (sessionId: string) => Promise<string | undefined> | string | undefined
  /**
   * Host-owned child sessions (`POST /session` with `parentID`). The host
   * lends its subagent admission, a secret for idempotent child ids and the
   * durable pending-wake list; the routes own the rest.
   */
  childSessions?: {
    admit: (parentSessionId: string, observation: SubagentObservation) => Promise<SubagentUpdatedEvent>
    secret: () => string
    pendingWakes: () => PendingChildWake[] | Promise<PendingChildWake[]>
    origins?: ChildOriginStore
  }
  /**
   * Host-owned durable queue for prompts admitted while a turn was running.
   * The session delivery owner executes unclaimed rows independently of
   * requests. In-flight attempts remain pending for reconciliation.
   */
  queuedPrompts?: () => SessionDeliveryStore | undefined
  listSubagents?: (input: { directory: string; parentSessionId: string }) => Promise<unknown[]> | unknown[]
  getMessages?: (input: { directory: string; sessionId: string }) => Promise<AgentMessage[] | undefined> | AgentMessage[] | undefined
  getMessagePage?: (input: { directory: string; sessionId: string; page: AgentMessagePageInput }) => Promise<AgentMessagePage | undefined> | AgentMessagePage | undefined
  getPart?: (input: { directory: string; sessionId: string; messageId: string; partId: string }) => Promise<AgentContentPart | undefined> | AgentContentPart | undefined
  turnCoverage?: (input: { directory: string; sessionId: string; turnId: string }) => Promise<AgentTurnCoveragePage | undefined> | AgentTurnCoveragePage | undefined
  getMessageSnapshot?: (input: { directory: string; sessionId: string }) => Promise<MessageSnapshot | undefined> | MessageSnapshot | undefined
  getSession?: (input: { directory: string; sessionId: string }) => Promise<AgentSession | null> | AgentSession | null
  getTodos?: (input: { directory: string; sessionId: string }) => Promise<unknown[] | undefined> | unknown[] | undefined
  getTurnOutline?: (input: { directory: string; sessionId: string }) => Promise<TurnOutline | undefined> | TurnOutline | undefined
  createActiveTurnScope?: (input: { directory: string; sessionId: string }) => { signal?: AbortSignal; dispose?: () => void } | undefined
  transformPromptBody?: (input: { sessionId: string; directory: string; body: SessionPromptBody }) => Promise<SessionPromptBody> | SessionPromptBody
  getSessionConfig?: (input: { directory: string; sessionId: string }) => Promise<SessionConfig>
  beforeDeleteSession?: (input: { directory: string; sessionId: string }) => Promise<void> | void
  afterDeleteSession?: (input: { directory: string; sessionId: string }) => Promise<void> | void
  /**
   * Observe a session update (title, archive) after the runtime applies it,
   * so a store-owned inventory does not serve stale titles or resurrect
   * archived sessions.
   */
  afterUpdateSession?: (input: { directory: string; sessionId: string; updates: { title?: string; time?: { archived?: number } } }) => Promise<void> | void
  resolveWorkspaceId?: () => string | undefined
}

export function SessionRoutes(runtimeFor: () => Promise<AgentRuntime>, options: SessionRoutesOptions) {
  const eventHub = options.eventHub ?? createRuntimeEventHub()
  const childSessions = options.childSessions && options.listSubagents && options.getSession && options.getMessages
    ? createChildSessionHost({
        admit: options.childSessions.admit,
        secret: options.childSessions.secret,
        pendingWakes: options.childSessions.pendingWakes,
        listSubagents: (parentSessionId, directory) => options.listSubagents!({ directory, parentSessionId }),
        getSession: (sessionId, directory) => options.getSession!({ directory, sessionId }),
        getMessages: (sessionId, directory) => options.getMessages!({ directory, sessionId }),
        subscribeGlobal: eventHub.subscribeGlobal,
        ...(options.childSessions.origins ? { origins: options.childSessions.origins } : {}),
        startTurn: ({ parentSessionId, ...rest }) => startHostTurn({ sessionId: parentSessionId, ...rest }),
      })
    : undefined

  const hostTurns = new Set<Promise<void>>()
  /**
   * A host turn between being asked for and being started. `hostTurns` only
   * holds turns that are already running, so without this an admission still
   * acquiring a lease or attaching a session is invisible to disposal — which
   * is exactly the window in which it would reach a workspace that has already
   * begun shutting down.
   */
  const hostAdmissions = new Set<Promise<unknown>>()
  let disposing = false
  const queuedPrompts = options.queuedPrompts
    ? createSessionDeliveryOwner({
        store: options.queuedPrompts,
        startTurn: (input) => startHostTurn(input),
        whenIdle: async (sessionId) => (await runtimeFor()).turns.whenIdle(sessionId),
        changed: (sessionId) => publishQueue(sessionId),
      })
    : undefined

  function publishQueue(sessionId: string) {
    const directory = options.queuedPrompts?.()?.sessionDirectory(sessionId)
    if (!directory || !queuedPrompts) return
    workspaceRuntimeBus.publish({ type: "session.queue", directory, sessionID: sessionId, queue: queuedPrompts.list(sessionId) })
  }

  const stopDeliveryWake = eventHub.subscribeGlobal(({ payload }) => {
    if (payload.type === "session.idle") queuedPrompts?.wake(payload.properties.sessionID)
    if (payload.type === "message.updated" && payload.properties.info.role === "user") {
      queuedPrompts?.incorporated(payload.properties.sessionID, payload.properties.info.id)
    }
  })

  type HostTurnInput = {
    sessionId: string
    directory: string
    body: SessionPromptBody
    author?: AgentMessageAuthor
    origin?: SessionTurnOrigin
    onSteeringResult?: import("../session/service").RuntimePromptTurnInput["onSteeringResult"]
    onDelivery?: (delivery: PromptDelivery) => void
    onSettled?: () => void
  }

  /**
   * A turn the runtime starts for itself — a completion wake on a parent, a
   * prompt recovered from the durable queue — driven by the same turn runner
   * the prompt routes use.
   *
   * It runs as whoever admitted it, which is what the stored origin says and
   * not what this runtime was composed as. A background turn has no request
   * left to ask, so the origin recorded at admission stands in for it, and a
   * relayed one is put back to the authority here: acquiring the lease re-asks
   * whether that actor may still drive this session, and writes the producer
   * row the durable transcript resolves the resulting user message against.
   *
   * An origin that is absent — a row admitted before any of this was
   * recorded — is refused, because nothing about it can be re-decided.
   */
  async function startHostTurn(input: HostTurnInput): Promise<"started" | "busy"> {
    const admission = admitHostTurn(input)
    hostAdmissions.add(admission)
    void admission.catch(() => {}).finally(() => hostAdmissions.delete(admission))
    return await admission
  }

  async function admitHostTurn(input: HostTurnInput): Promise<"started" | "busy"> {
    const decline = (message: string) => {
      input.onSteeringResult?.({ ok: false, status: "declined", message })
      input.onDelivery?.("queue")
      return "busy" as const
    }
    if (disposing) return decline("This runtime is shutting down and is not starting background turns")
    const managed = options.sessionAccessPolicy?.sessionAuthority === "managed-private"
    const origin = input.origin
    if (managed && !origin) return decline("Host-started input has no recorded admission provenance to re-authorize it under")
    const relayed = origin?.provenance === "relay-replayed" ? origin : undefined
    if (managed && relayed && !input.body.messageID) {
      return decline("Host-started managed input requires a stable message identity to admit a turn under")
    }
    let runtime: AgentRuntime | undefined
    let lease: ActiveSessionTurnLease | undefined
    const lostTurn = captureTurnTarget()
    const access = {
      ...(relayed ? { actor: relayed.actor, authority: relayed.authority } : {}),
      operation: "prompt" as const,
      sessionId: input.sessionId,
    }
    if (relayed) {
      if (!options.sessionAccessPolicy || !input.body.messageID) throw new Error("Managed queued input requires turn authority and a message identity")
      if (options.sessionAccessPolicy.grantTurn && !relayed.grant) {
        return decline("Host-started relayed input carries no deferred turn grant to admit a turn under")
      }
      const acquired = await acquireSessionTurnLease({
        policy: options.sessionAccessPolicy,
        access,
        turnId: input.body.messageID,
        ...(relayed.grant ? { grant: relayed.grant } : {}),
        onLost: () => containLostTurn({
          runtime: runtime?.recovery,
          sessionId: input.sessionId,
          target: lostTurn.get(),
          caller: { callerId: `actor:${relayed.actor.actorId}`, authority: "session" },
        }),
      })
      if (!acquired.acquired) return decline(acquired.decision.message)
      lease = acquired.lease
    } else if (origin && options.sessionAccessPolicy) {
      const decision = await options.sessionAccessPolicy.authorize(access)
      if (!decision.allowed) return decline(decision.message)
    }
    if (disposing) {
      await lease?.release()
      return decline("This runtime is shutting down and is not starting background turns")
    }
    try {
      runtime = await runtimeFor()
      if (input.body.delivery !== "steer") await childSessions?.onTurnStarted(input.sessionId, input.directory)
    } catch (error) {
      await lease?.release()
      throw error
    }
    const started = runtime
    const publishGlobal = (event: AgentEventEnvelope) => eventHub.publishGlobal(event)
    const scope = () => {
      const active = options.createActiveTurnScope?.({ directory: input.directory, sessionId: input.sessionId })
      if (!lease) return active
      return { signal: active?.signal ? AbortSignal.any([active.signal, lease.signal]) : lease.signal, dispose: active?.dispose }
    }
    const turnOrigin = relayed
      ? { actor: { kind: "person" as const, userId: relayed.actor.actorId }, via: "relay" as const, reissued: true }
      : { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: true }
    let actualDelivery: PromptDelivery | undefined
    return await new Promise<"started" | "busy">((resolve) => {
      const run = runRuntimePromptTurn({
        runtime: started,
        sessionId: input.sessionId,
        directory: input.directory,
        body: input.body,
        origin: turnOrigin,
        publishGlobal,
        createActiveTurnScope: scope,
        onTurnTarget: lostTurn.set,
        ...(lease ? { turnAdmission: lease } : {}),
        ...(input.author ? { author: input.author } : {}),
        ...(relayed ? { actor: relayed.actor } : {}),
        onDelivery: (delivery) => { actualDelivery = delivery; input.onDelivery?.(delivery) },
        onSteeringResult: input.onSteeringResult,
        onAdmissionSettled: (error) => {
          if (isAgentRuntimeTurnAdmissionError(error)) input.onDelivery?.("queue")
          resolve(isAgentRuntimeTurnAdmissionError(error) ? "busy" : "started")
        },
      }).catch((error: unknown) => {
        if (!isAgentRuntimeTurnAdmissionError(error)) publishTurnFailure(publishGlobal, input.directory, input.sessionId, error)
        throw error
      })
      const pendingTurn = run
        .then(async () => {
          if (actualDelivery !== "start" || lease?.lost()) return
          await flushRuntimeSessionDocuments(input.sessionId).catch((error) => console.error("queued turn document flush failed", error))
          if (!input.onSettled) await childSessions?.onTurnSettled(input.sessionId, input.directory)
        })
        .finally(() => lease?.release())
        .then(() => input.onSettled?.(), (error: unknown) => {
          if (isAgentRuntimeTurnAdmissionError(error)) {
            resolve("busy")
            return
          }
          console.error(`runtime-started turn for ${input.sessionId} failed`, error)
          resolve("started")
          input.onSettled?.()
        })
        .finally(() => hostTurns.delete(pendingTurn))
      hostTurns.add(pendingTurn)
      void pendingTurn.catch((error) => console.error("runtime turn cleanup failed", error))
    })
  }

  const routes = createSessionRoutes({
    runtime: () => runtimeFor(),
    requestedSessionHarness: (c) => requestedSessionHarness(c.req),
    defaultHarness: () => options.requestedSessionHarness(undefined),
    ...(options.resolveRecoveryOwner
      ? { resolveRecoveryOwner: (_c: SessionRouteContext, input: { sessionId: string }) => options.resolveRecoveryOwner!(input) }
      : {}),
    resolveDirectory: (c, input) => dir(c, input),
    beforeSessionOperation: (_c, input) => options.beforeSessionOperation?.(input),
    sessionAccessPolicy: options.sessionAccessPolicy,
    sessionStarts: options.sessionStarts,
    listSessions: options.listSessions ? (c, directory) => options.listSessions!(c, requiredDirectory(directory)) : undefined,
    childSessions,
    queuedPrompts,
    afterCreateSession: options.afterCreateSession
      ? (_c, directory, session) => options.afterCreateSession!({ directory: requiredDirectory(directory), session })
      : undefined,
    sessionIdWorkspace: options.sessionIdWorkspace,
    listSubagents: options.listSubagents
      ? (_c, directory, parentSessionId) => options.listSubagents!({ directory: requiredDirectory(directory), parentSessionId })
      : undefined,
    getMessages: options.getMessages
      ? (_c, directory, sessionId) => options.getMessages!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    getMessagePage: options.getMessagePage
      ? (_c, directory, sessionId, page) => options.getMessagePage!({ directory: requiredDirectory(directory), sessionId, page })
      : undefined,
    getPart: options.getPart
      ? (_c, directory, sessionId, messageId, partId) => options.getPart!({ directory: requiredDirectory(directory), sessionId, messageId, partId })
      : undefined,
    turnCoverage: options.turnCoverage
      ? (_c, directory, sessionId, turnId) => options.turnCoverage!({ directory: requiredDirectory(directory), sessionId, turnId })
      : undefined,
    getMessageSnapshot: options.getMessageSnapshot
      ? (_c, directory, sessionId) => options.getMessageSnapshot!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    getSession: options.getSession
      ? (_c, directory, sessionId) => options.getSession!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    getTurnOutline: options.getTurnOutline
      ? (_c, directory, sessionId) => options.getTurnOutline!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    getTodos: options.getTodos
      ? (_c, directory, sessionId) => options.getTodos!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    getStatus: options.getStatus ? (c, directory) => options.getStatus!(c, requiredDirectory(directory)) : undefined,
    publishGlobal: (event) => {
      eventHub.publishGlobal(event)
      bridgeLifecycleEvent(event)
    },
    publishSessionLifecycle: (event) => workspaceRuntimeBus.publish(event),
    resolveWorkspaceId: () => options.resolveWorkspaceId?.() ?? workspaceId(),
    createActiveTurnScope: options.createActiveTurnScope
      ? ({ directory, sessionId }) => options.createActiveTurnScope?.({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    transformPromptBody: options.transformPromptBody
      ? (_c, input) => options.transformPromptBody!({ ...input, directory: requiredDirectory(input.directory) })
      : undefined,
    getSessionConfig: options.getSessionConfig
      ? (_c, directory, sessionId) => options.getSessionConfig!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    afterUpdateSession: options.afterUpdateSession
      ? (_c, directory, session, updates) => options.afterUpdateSession!({ directory: requiredDirectory(directory), sessionId: session.id, updates })
      : undefined,
    beforeDeleteSession: options.beforeDeleteSession
      ? (_c, directory, sessionId) => options.beforeDeleteSession!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    afterDeleteSession: options.afterDeleteSession
      ? (_c, directory, sessionId) => options.afterDeleteSession!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
  })
  return {
    routes,
    /**
     * Re-issue the prompts this runtime's store was still holding when its
     * previous process ended. The host calls it as it boots: nothing is
     * waiting for these prompts any more, so no request will ask for them.
     */
    recoverQueuedPrompts: () => queuedPrompts?.recover() ?? Promise.resolve(),
    dispose: async () => {
      // Refuse first, then wait, and wait for the askers before the turns:
      // an offer still choosing a turn is not in `hostTurns` yet, and the
      // delivery owner's drain hands its idle wait back rather than blocking
      // on a session that will never go idle now.
      disposing = true
      stopDeliveryWake()
      await childSessions?.dispose()
      await queuedPrompts?.dispose()
      await Promise.allSettled(hostAdmissions)
      await Promise.allSettled(hostTurns)
    },
  }
}
