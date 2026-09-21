import { HTTPException } from "hono/http-exception"
import { flushRuntimeSessionDocuments } from "./document-hydration"
import { acquireSessionTurnLease, type ActiveSessionTurnLease } from "./session-turn-lease"
import { captureTurnTarget, containLostTurn, createSessionRoutes, type SessionRouteContext } from "./session-core"
import { createChildSessionHost, type ChildOriginStore, type PendingChildWake } from "./session-children"
import { createSessionDeliveryOwner, type SessionDeliveryStore } from "../session/delivery-owner"
import { isAgentRuntimeTurnConflictError, type SubagentAdmissionStore } from "@claxedo/agent-sdk-runtime"
import { admitSessionPromptTurn, runRuntimePromptTurn, runSessionPromptTurn } from "../session/service"
import {
  type AgentRuntime,
  type AgentRuntimeRecovery,
  type AgentMessage,
  type AgentMessageAuthor,
  type AgentPermission,
  type AgentQuestion,
  type SessionHarness,
  type AgentSession,
  type PromptDelivery,
  type SessionConfig,
  type SessionConfigRequestUpdate,
  type SessionModelGroup,
} from "@claxedo/agent-sdk-runtime"
import {
  type AgentMessagePage,
  type AgentMessagePageInput,
  type AgentHarnessAdapter,
} from "@claxedo/agent-sdk-runtime/adapters"
import type { AgentTurnCoveragePage } from "@claxedo/agent-sdk-runtime/message-page"
import { workspaceRuntimeBus } from "../bus"
import { errorMessage } from "../error-message"
import { rec, str } from "../json-value"
import { createRuntimeEventHub, type RuntimeEventHub } from "../runtime-event-hub"
import { assertTarget, registeredWorkspaceDirectory, workspaceId } from "../target"
import { requestedSessionHarness } from "./config"
import type { SessionPromptBody } from "../session/service"
import type { CompatEnvelope } from "../compat-events"
import type { SessionAccessPolicy, SessionTurnOrigin } from "../session-access-policy"
import type { AgentExecutionBinding, AgentSessionStartBinding, AgentSessionStarts } from "@claxedo/agent-runtime-contract"

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

export function SessionRoutes(
  getAdapter: (input?: { sessionId?: string; directory?: string; harness?: SessionHarness }) => AgentHarnessAdapter | Promise<AgentHarnessAdapter>,
  options?: {
    sessionStarts?: AgentSessionStarts
    resolveSessionStartBinding?: (c: SessionRouteContext, directory: string, sessionId: string, operationId: string) => AgentSessionStartBinding
    eventHub?: RuntimeEventHub
    sessionAccessPolicy?: SessionAccessPolicy
    beforeSessionOperation?: (input: { sessionId: string; operation: string }) => Response | undefined
    resolveRuntime?: (input?: { sessionId?: string; directory?: string; harness?: SessionHarness }) => AgentRuntime | Promise<AgentRuntime | undefined> | undefined
    /**
     * The recovery API of the runtime that already owns this session. It is
     * separate from `resolveRuntime` because recovery never builds a harness
     * and never waits on a closing workspace: a host that cannot answer it
     * synchronously has no owner to answer for.
     */
    resolveRecoveryOwner?: (input: { sessionId: string }) => AgentRuntimeRecovery | undefined
    resolveExecutionBinding?: (input: {
      adapter: AgentHarnessAdapter
      directory: string
      sessionId: string
    }) => AgentExecutionBinding | Promise<AgentExecutionBinding>
    listPermissions?: (c: SessionRouteContext, directory: string) => Promise<AgentPermission[]>
    listQuestions?: (c: SessionRouteContext, directory: string) => Promise<AgentQuestion[]>
    listSessions?: (c: SessionRouteContext, directory: string) => Promise<AgentSession[]>
    /** Host-owned status transport. The session-core route remains the only
     * public handler so its private-session filter cannot be shadowed. */
    getStatus?: (c: SessionRouteContext, directory: string) => unknown
    /**
     * Own session creation instead of delegating straight to the adapter, so
     * the host's session store learns about a create directly rather than from
     * the list-time adapter fan-out.
     */
    createSession?: (c: SessionRouteContext, directory: string, title?: string, id?: string, create?: { start?: AgentSessionStartBinding; parentID?: string; permissionCeiling?: SessionConfig["permissionCeiling"]; instructions?: string; group?: SessionModelGroup }) => Promise<{ id: string }>
    afterCreateSession?: (input: { directory: string; session: unknown }) => Promise<void> | void
    /**
     * Host-owned child sessions (`POST /session` with `parentID`). The host
     * lends its subagent admission, a secret for idempotent child ids and the
     * durable pending-wake list; the routes own the rest.
     */
    childSessions?: {
      admission: SubagentAdmissionStore
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
    listSubagents?: (input: {
      directory: string
      parentSessionId: string
    }) => Promise<unknown[]> | unknown[]
    getMessages?: (input: {
      directory: string
      sessionId: string
    }) => Promise<AgentMessage[] | undefined> | AgentMessage[] | undefined
    getMessagePage?: (input: {
      adapter: AgentHarnessAdapter
      directory: string
      sessionId: string
      page: AgentMessagePageInput
    }) => Promise<AgentMessagePage | undefined> | AgentMessagePage | undefined
    turnCoverage?: (input: {
      directory: string
      sessionId: string
      turnId: string
    }) => Promise<AgentTurnCoveragePage | undefined> | AgentTurnCoveragePage | undefined
    getMessageSnapshot?: (input: {
      directory: string
      sessionId: string
    }) => Promise<MessageSnapshot | undefined> | MessageSnapshot | undefined
    getSession?: (input: {
      directory: string
      sessionId: string
    }) => Promise<AgentSession | null> | AgentSession | null
    getTodos?: (input: {
      directory: string
      sessionId: string
    }) => Promise<unknown[] | undefined> | unknown[] | undefined
    createActiveTurnScope?: (input: {
      adapter: AgentHarnessAdapter
      directory: string
      sessionId: string
    }) => { signal?: AbortSignal; dispose?: () => void } | undefined
    transformPromptBody?: (input: {
      sessionId: string
      directory: string
      body: SessionPromptBody
    }) => Promise<SessionPromptBody> | SessionPromptBody
    getSessionConfig?: (input: {
      adapter: AgentHarnessAdapter
      directory: string
      sessionId: string
    }) => Promise<SessionConfig>
    updateSessionConfig?: (input: {
      adapter: AgentHarnessAdapter
      directory: string
      sessionId: string
      update: SessionConfigRequestUpdate
    }) => Promise<SessionConfig>
    switchSessionHarness?: (input: {
      adapter: AgentHarnessAdapter
      directory: string
      sessionId: string
      update: SessionConfigRequestUpdate
    }) => Promise<SessionConfig>
    beforeDeleteSession?: (input: { directory: string; sessionId: string }) => Promise<void> | void
    afterDeleteSession?: (input: { directory: string; sessionId: string }) => Promise<void> | void
    /**
     * Observe a session update (title, archive) after the adapter applies it,
     * so a store-owned inventory does not serve stale titles or resurrect
     * archived sessions.
     */
    afterUpdateSession?: (input: {
      directory: string
      sessionId: string
      updates: { title?: string; time?: { archived?: number } }
    }) => Promise<void> | void
  },
) {
  const eventHub = options?.eventHub ?? createRuntimeEventHub()
  /**
   * The harness a request names, or undefined when it names none.
   *
   * A string that does NOT resolve is a 400 rather than undefined, and that
   * distinction is the whole point. Falling through to undefined makes the
   * caller's adapter resolve from the DIRECTORY instead — the last harness
   * selected there — so a request naming an unrecognised harness was answered
   * with a different harness's data and no indication of the substitution.
   * `/permission/modes` made that visible: asking for one harness returned
   * another's permission modes, which the picker then displayed under the name
   * that had been asked for. Showing one harness's policy under another's label
   * is exactly the confusion this whole surface exists to prevent, so an
   * unrecognised name fails instead of being quietly reinterpreted.
   */
  function requestedHarness(c: {
    req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined }
  }) {
    return requestedSessionHarness(c.req)
  }
  const childSessions = options?.childSessions && options.listSubagents && options.getSession && options.getMessages
    ? createChildSessionHost({
        admission: options.childSessions.admission,
        secret: options.childSessions.secret,
        pendingWakes: options.childSessions.pendingWakes,
        listSubagents: (parentSessionId, directory) => options.listSubagents!({ directory, parentSessionId }),
        getSession: (sessionId, directory) => options.getSession!({ directory, sessionId }),
        getMessages: (sessionId, directory) => options.getMessages!({ directory, sessionId }),
        publishRuntime: eventHub.publishRuntime,
        subscribeGlobal: eventHub.subscribeGlobal,
        ...(options.childSessions.origins ? { origins: options.childSessions.origins } : {}),
        startTurn: ({ parentSessionId, ...rest }) => startHostTurn({ sessionId: parentSessionId, ...rest }),
      })
    : undefined

  const hostTurns = new Set<Promise<void>>()
  /**
   * A host turn between being asked for and being started. `hostTurns` only
   * holds turns that are already running, so without this an admission still
   * acquiring a lease or resolving an adapter is invisible to disposal — which
   * is exactly the window in which it would reach a workspace that has already
   * begun shutting down.
   */
  const hostAdmissions = new Set<Promise<unknown>>()
  let disposing = false
  const queuedPrompts = options?.queuedPrompts
    ? createSessionDeliveryOwner({
        store: options.queuedPrompts,
        startTurn: (input) => startHostTurn(input),
        whenIdle: async (sessionId, directory) => {
          const runtime = await options.resolveRuntime?.({ sessionId, directory })
          if (!runtime) throw new Error("Queued delivery requires an agent runtime")
          return runtime.turns.whenIdle(sessionId)
        },
      })
    : undefined

  const stopDeliveryWake = eventHub.subscribeGlobal(({ payload }) => {
    if (payload.type === "session.idle") queuedPrompts?.wake(payload.properties.sessionID)
  })

  /**
   * A turn the runtime starts for itself — a completion wake on a parent, a
   * prompt recovered from the durable queue — driven by the same turn runners
   * the prompt routes use.
   *
   * It runs as whoever admitted it, which is what the stored origin says and
   * not what this runtime was composed as. `managedSessionLifecycle` asks a
   * live request the same two questions — is the composition managed, and did
   * this reach us through the relay — and one desktop daemon answers them
   * differently per request: the machine's own user drives a session over
   * loopback with no actor and no lease, while a relayed member drives it only
   * through the authority. A background turn has no request left to ask, so the
   * origin recorded at admission stands in for it, and a relayed one is put
   * back to the authority here: acquiring the lease re-asks whether that actor
   * may still drive this session, and writes the producer row the durable
   * transcript resolves the resulting user message against.
   *
   * An origin that is absent — a row admitted before any of this was
   * recorded — is refused, because nothing about it can be re-decided.
   *
   * Nothing is resolved before that identity is checked: resolving an adapter
   * or a runtime starts a harness and writes config for the session, and a
   * refused turn must leave no trace of having been attempted.
   *
   * `runSessionPromptTurn` has no queue: an adapter-only host starts the turn
   * it is handed, so that branch reports `start` itself. It runs unfenced — it
   * has no runtime to abort and no admission to hand the turn — so a lease can
   * never reach it: a leased turn without a runtime is refused instead.
   */
  async function startHostTurn(input: {
    sessionId: string
    directory: string
    body: SessionPromptBody
    author?: AgentMessageAuthor
    origin?: SessionTurnOrigin
    onSteeringResult?: import("../session/service").RuntimePromptTurnInput["onSteeringResult"]
    onDelivery?: (delivery: PromptDelivery) => void
    onSettled?: () => void
  }): Promise<"started" | "busy"> {
    const admission = admitHostTurn(input)
    hostAdmissions.add(admission)
    void admission.catch(() => {}).finally(() => hostAdmissions.delete(admission))
    return await admission
  }

  async function admitHostTurn(input: {
    sessionId: string
    directory: string
    body: SessionPromptBody
    author?: AgentMessageAuthor
    origin?: SessionTurnOrigin
    onSteeringResult?: import("../session/service").RuntimePromptTurnInput["onSteeringResult"]
    onDelivery?: (delivery: PromptDelivery) => void
    onSettled?: () => void
  }): Promise<"started" | "busy"> {
    const decline = (message: string) => {
      input.onSteeringResult?.({ ok: false, status: "declined", message })
      input.onDelivery?.("queue")
      return "busy" as const
    }
    if (disposing) return decline("This runtime is shutting down and is not starting background turns")
    const managed = options?.sessionAccessPolicy?.sessionAuthority === "managed-private"
    const origin = input.origin
    if (managed && !origin) {
      return decline("Host-started input has no recorded admission provenance to re-authorize it under")
    }
    const relayed = origin?.provenance === "relay-replayed" ? origin : undefined
    if (managed && relayed && !input.body.messageID) {
      return decline("Host-started managed input requires a stable message identity to admit a turn under")
    }
    // Assigned below, read by `onLost` only once the lease is live and the
    // turn is running: the lease is taken before a harness exists, so a
    // revoked actor costs the session no process and no config write.
    let runtime: AgentRuntime | undefined
    let lease: ActiveSessionTurnLease | undefined
    const lostTurn = captureTurnTarget()
    const access = {
      ...(relayed ? { actor: relayed.actor, authority: relayed.authority } : {}),
      operation: "prompt" as const,
      sessionId: input.sessionId,
    }
    if (relayed) {
      if (!options?.sessionAccessPolicy || !input.body.messageID) throw new Error("Managed queued input requires turn authority and a message identity")
      const acquired = await acquireSessionTurnLease({
        policy: options.sessionAccessPolicy,
        access,
        turnId: input.body.messageID,
        onLost: () => containLostTurn({
          runtime: runtime?.recovery,
          sessionId: input.sessionId,
          target: lostTurn.get(),
          caller: { callerId: `actor:${relayed.actor.actorId}`, authority: "session" },
        }),
      })
      if (!acquired.acquired) return decline(acquired.decision.message)
      lease = acquired.lease
    } else if (origin && options?.sessionAccessPolicy) {
      // A local origin takes no lease, exactly as the machine user's own
      // prompts do not. It is still put to the policy now rather than trusted
      // because it was true once: a composition that requires verified actors
      // refuses it here instead of running a turn nobody can be asked about.
      const decision = await options.sessionAccessPolicy.authorize(access)
      if (!decision.allowed) return decline(decision.message)
    }
    // Authority replies can arrive after shutdown started. The admission is
    // still ours to release; no provider has taken responsibility for it yet.
    if (disposing) {
      await lease?.release()
      return decline("This runtime is shutting down and is not starting background turns")
    }
    let adapter: Awaited<ReturnType<typeof getAdapter>>
    try {
      adapter = await getAdapter({ sessionId: input.sessionId, directory: input.directory })
      runtime = await options?.resolveRuntime?.({ sessionId: input.sessionId, directory: input.directory })
      if (lease && !runtime) {
        await lease.release()
        return decline("Durable turn admission requires an agent runtime to fence")
      }
      if (input.body.delivery !== "steer") await childSessions?.onTurnStarted(input.sessionId, input.directory)
    } catch (error) {
      // No running turn owns cleanup until provider setup and bookkeeping
      // finish. Otherwise a failed setup keeps renewing the session's lease.
      await lease?.release()
      throw error
    }
    const publishGlobal = (event: CompatEnvelope) => eventHub.publishGlobal(event)
    const scope = () => {
      const active = options?.createActiveTurnScope?.({ adapter, directory: input.directory, sessionId: input.sessionId })
      if (!lease) return active
      return { signal: active?.signal ? AbortSignal.any([active.signal, lease.signal]) : lease.signal, dispose: active?.dispose }
    }
    let actualDelivery: PromptDelivery | undefined
    return await new Promise<"started" | "busy">((resolve) => {
      const run = runtime
        ? runRuntimePromptTurn({
            runtime,
            sessionId: input.sessionId,
            directory: input.directory,
            body: input.body,
            publishGlobal,
            createActiveTurnScope: scope,
            onTurnTarget: lostTurn.set,
            ...(lease ? { turnAdmission: lease } : {}),
            ...(input.author ? { author: input.author } : {}),
            ...(relayed ? { actor: relayed.actor } : {}),
            onDelivery: (delivery) => { actualDelivery = delivery; input.onDelivery?.(delivery) },
            onSteeringResult: input.onSteeringResult,
            onAdmissionSettled: (error) => {
              if (isAgentRuntimeTurnConflictError(error)) input.onDelivery?.("queue")
              resolve(isAgentRuntimeTurnConflictError(error) ? "busy" : "started")
            },
          })
        : (async () => {
            const binding = await options?.resolveExecutionBinding?.({ adapter, directory: input.directory, sessionId: input.sessionId })
            if (!binding) throw new Error(`Session ${input.sessionId} has no complete execution binding`)
            const admitted = await admitSessionPromptTurn({
              adapter,
              binding,
              sessionId: input.sessionId,
              directory: input.directory,
              body: input.body,
            })
            resolve("started")
            input.onDelivery?.("start")
            return runSessionPromptTurn({
              adapter,
              admitted,
              sessionId: input.sessionId,
              directory: input.directory,
              body: input.body,
              publishGlobal,
              createActiveTurnScope: ({ adapter, directory, sessionId }) =>
                options?.createActiveTurnScope?.({ adapter, directory: requiredDirectory(directory), sessionId }),
            })
          })()
      const pendingTurn = run
        .then(async () => {
          if (actualDelivery !== "start" || lease?.lost()) return
          await flushRuntimeSessionDocuments(input.sessionId).catch((error) => console.error("queued turn document flush failed", error))
          if (!input.onSettled) await childSessions?.onTurnSettled(input.sessionId, input.directory)
        })
        .finally(() => lease?.release())
        .then(() => input.onSettled?.(), (error: unknown) => {
          if (isAgentRuntimeTurnConflictError(error)) {
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
    requestedSessionHarness: (c) => requestedHarness(c),
    resolveAdapter: async (c, input) => {
      const harness = requestedHarness(c)
      return await getAdapter({
        ...input,
        ...(harness ? { harness } : {}),
      })
    },
    ...(options?.resolveRecoveryOwner
      ? { resolveRecoveryOwner: (_c: SessionRouteContext, input: { sessionId: string }) => options.resolveRecoveryOwner!(input) }
      : {}),
    resolveRuntime: options?.resolveRuntime
      ? async (c, input) => {
          const harness = requestedHarness(c)
          return await options.resolveRuntime?.({
            ...input,
            ...(harness ? { harness } : {}),
          })
        }
      : undefined,
    resolveExecutionBinding: options?.resolveExecutionBinding
      ? (_c, directory, sessionId, adapter) => options.resolveExecutionBinding!({
          adapter,
          directory: requiredDirectory(directory),
          sessionId,
        })
      : undefined,
    resolveDirectory: (c, input) => dir(c, input),
    beforeSessionOperation: (_c, input) => options?.beforeSessionOperation?.(input),
    sessionAccessPolicy: options?.sessionAccessPolicy,
    sessionStarts: options?.sessionStarts,
    resolveSessionStartBinding: options?.resolveSessionStartBinding
      ? (c, directory, sessionId, operationId) => options.resolveSessionStartBinding!(c, requiredDirectory(directory), sessionId, operationId)
      : undefined,
    listPermissions: options?.listPermissions
      ? (c, directory) => options.listPermissions!(c, requiredDirectory(directory))
      : undefined,
    listQuestions: options?.listQuestions
      ? (c, directory) => options.listQuestions!(c, requiredDirectory(directory))
      : undefined,
    listSessions: options?.listSessions
      ? (c, directory) => options.listSessions!(c, requiredDirectory(directory))
      : undefined,
    createSession: options?.createSession
      ? (c, directory, title, id, create) => options.createSession!(c, requiredDirectory(directory), title, id, create)
      : undefined,
    childSessions,
    queuedPrompts,
    afterCreateSession: options?.afterCreateSession
      ? (_c, directory, session) => options.afterCreateSession!({
          directory: requiredDirectory(directory),
          session,
        })
      : undefined,
    listSubagents: options?.listSubagents
      ? (_c, directory, parentSessionId) => options.listSubagents!({
          directory: requiredDirectory(directory),
          parentSessionId,
        })
      : undefined,
    getMessages: options?.getMessages
      ? (_c, directory, sessionId) => options.getMessages!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    getMessagePage: options?.getMessagePage
      ? (_c, directory, sessionId, page, adapter) => options.getMessagePage!({
          adapter,
          directory: requiredDirectory(directory),
          sessionId,
          page,
        })
      : undefined,
    turnCoverage: options?.turnCoverage
      ? (_c, directory, sessionId, turnId) => options.turnCoverage!({
          directory: requiredDirectory(directory),
          sessionId,
          turnId,
        })
      : undefined,
    getMessageSnapshot: options?.getMessageSnapshot
      ? (_c, directory, sessionId) => options.getMessageSnapshot!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    getSession: options?.getSession
      ? (_c, directory, sessionId) => options.getSession!({
          directory: requiredDirectory(directory),
          sessionId,
        })
      : undefined,
    getTodos: options?.getTodos
      ? (_c, directory, sessionId) => options.getTodos!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    getStatus: options?.getStatus
      ? (c, directory) => options.getStatus!(c, requiredDirectory(directory))
      : undefined,
    publishGlobal: (event) => {
      eventHub.publishGlobal(event)
      bridgeLifecycleEvent(event)
    },
    publishSessionLifecycle: (event) => workspaceRuntimeBus.publish(event),
    resolveWorkspaceId: () => workspaceId(),
    createActiveTurnScope: options?.createActiveTurnScope
      ? ({ adapter, directory, sessionId }) => options.createActiveTurnScope?.({ adapter, directory: requiredDirectory(directory), sessionId })
      : undefined,
    transformPromptBody: options?.transformPromptBody
      ? (_c, input) => options.transformPromptBody!({ ...input, directory: requiredDirectory(input.directory) })
      : undefined,
    getSessionConfig: options?.getSessionConfig
      ? (_c, directory, sessionId, adapter) => options.getSessionConfig!({
          adapter,
          directory: requiredDirectory(directory),
          sessionId,
        })
      : undefined,
    updateSessionConfig: options?.updateSessionConfig
      ? (_c, directory, sessionId, update, adapter) => options.updateSessionConfig!({
          adapter,
          directory: requiredDirectory(directory),
          sessionId,
          update,
        })
      : undefined,
    switchSessionHarness: options?.switchSessionHarness
      ? (_c, directory, sessionId, update, adapter) => options.switchSessionHarness!({
          adapter,
          directory: requiredDirectory(directory),
          sessionId,
          update,
        })
      : undefined,
    afterUpdateSession: options?.afterUpdateSession
      ? (_c, directory, session, updates) => options.afterUpdateSession!({
          directory: requiredDirectory(directory),
          sessionId: session.id,
          updates,
        })
      : undefined,
    beforeDeleteSession: options?.beforeDeleteSession
      ? (_c, directory, sessionId) => options.beforeDeleteSession!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    afterDeleteSession: options?.afterDeleteSession
      ? (_c, directory, sessionId) => options.afterDeleteSession!({
          directory: requiredDirectory(directory),
          sessionId,
        })
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
