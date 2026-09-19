import { HTTPException } from "hono/http-exception"
import { createSessionRoutes, type SessionRouteContext } from "./session-core"
import { createChildSessionHost, type PendingChildWake } from "./session-children"
import { createQueuedPromptHost, type QueuedPromptStore } from "./session-queued-prompts"
import { isAgentRuntimeTurnConflictError, type SubagentAdmissionStore } from "@claxedo/agent-sdk-runtime"
import { admitSessionPromptTurn, runRuntimePromptTurn, runSessionPromptTurn } from "../session/service"
import {
  type AgentRuntime,
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
import { workspaceRuntimeBus } from "../bus"
import { errorMessage } from "../error-message"
import { rec, str } from "../json-value"
import { createRuntimeEventHub, type RuntimeEventHub } from "../runtime-event-hub"
import { assertTarget, registeredWorkspaceDirectory, workspaceId } from "../target"
import { requestedSessionHarness } from "./config"
import type { QueuedPromptAction, SessionPromptBody } from "../session/service"
import type { CompatEnvelope } from "../compat-events"
import type { SessionAccessPolicy } from "../session-access-policy"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"

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
    eventHub?: RuntimeEventHub
    sessionAccessPolicy?: SessionAccessPolicy
    beforeSessionOperation?: (input: { sessionId: string; operation: string }) => Response | undefined
    resolveRuntime?: (input?: { sessionId?: string; directory?: string; harness?: SessionHarness }) => AgentRuntime | Promise<AgentRuntime | undefined> | undefined
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
    createSession?: (c: SessionRouteContext, directory: string, title?: string, id?: string, create?: { parentID?: string; permissionCeiling?: SessionConfig["permissionCeiling"]; instructions?: string; group?: SessionModelGroup }) => Promise<{ id: string }>
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
    }
    /**
     * Host-owned durable queue for prompts admitted while a turn was running.
     * The rows outlive the request that is holding one, so a restart re-issues
     * it instead of dropping it.
     */
    queuedPrompts?: () => QueuedPromptStore | undefined
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
        startTurn: ({ parentSessionId, ...rest }) => startHostTurn({ sessionId: parentSessionId, ...rest }),
      })
    : undefined

  const queuedPrompts = options?.queuedPrompts
    ? createQueuedPromptHost({ store: options.queuedPrompts, startTurn: (input) => startHostTurn(input) })
    : undefined

  /**
   * A turn the runtime starts for itself — a completion wake on a parent, a
   * prompt recovered from the durable queue — driven by the same turn runners
   * the prompt routes use. It carries no control-plane turn lease: the runtime
   * that owns the session is the one starting the turn.
   *
   * `runSessionPromptTurn` has no queue: an adapter-only host starts the turn
   * it is handed, so that branch reports `start` itself.
   */
  async function startHostTurn(input: {
    sessionId: string
    directory: string
    body: SessionPromptBody
    author?: AgentMessageAuthor
    actor?: { actorId: string; actorKind: "human" | "agent" }
    queuedAction?: () => Promise<QueuedPromptAction>
    onQueuedWaitEnd?: () => void
    onDelivery?: (delivery: PromptDelivery) => void
    onSettled?: () => void
  }): Promise<"started" | "busy"> {
    const adapter = await getAdapter({ sessionId: input.sessionId, directory: input.directory })
    const runtime = await options?.resolveRuntime?.({ sessionId: input.sessionId, directory: input.directory })
    const publishGlobal = (event: CompatEnvelope) => eventHub.publishGlobal(event)
    const scope = () => options?.createActiveTurnScope?.({ adapter, directory: input.directory, sessionId: input.sessionId })
    return await new Promise<"started" | "busy">((resolve) => {
      const run = runtime
        ? runRuntimePromptTurn({
            runtime,
            sessionId: input.sessionId,
            directory: input.directory,
            body: input.body,
            publishGlobal,
            createActiveTurnScope: scope,
            ...(input.author ? { author: input.author } : {}),
            ...(input.actor ? { actor: input.actor } : {}),
            ...(input.onDelivery ? { onDelivery: input.onDelivery } : {}),
            queuedAction: input.queuedAction,
            onQueuedWaitEnd: input.onQueuedWaitEnd,
            onAdmissionSettled: (error) => resolve(isAgentRuntimeTurnConflictError(error) ? "busy" : "started"),
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
      run
        .then(() => input.onSettled?.(), (error: unknown) => {
          if (isAgentRuntimeTurnConflictError(error)) {
            resolve("busy")
            return
          }
          console.error(`runtime-started turn for ${input.sessionId} failed`, error)
          resolve("started")
          input.onSettled?.()
        })
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
  }
}
