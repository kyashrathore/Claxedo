import { HTTPException } from "hono/http-exception"
import { createSessionRoutes } from "./session-core"
import {
  normalizeHarnessIdentity,
  type AgentRuntime,
  type AgentMessage,
  type AgentPermission,
  type AgentQuestion,
  type SessionHarness,
  type AgentSession,
  type PromptInput,
  type SessionConfig,
  type SessionConfigRequestUpdate,
} from "@claxedo/agent-sdk-runtime"
import {
  type AgentMessagePage,
  type AgentMessagePageInput,
  hasAdapterCapability,
  type AgentHarnessAdapter,
  type HttpProxyAdapter,
} from "@claxedo/agent-sdk-runtime/adapters"
import { workspaceRuntimeBus } from "../bus"
import { withDir } from "../compat-events"
import { createRuntimeEventHub, type RuntimeEventHub } from "../runtime-event-hub"
import { assertTarget, registeredWorkspaceDirectory, workspaceId } from "../target"
import { harnessQueryParam } from "./http"
import { sessionStatusSnapshot } from "./session-status-snapshot"
import type { SessionPromptBody } from "../session/service"
import type { SessionAccessPolicy } from "../session-access-policy"

function bridgeLifecycleEvent(event: Parameters<RuntimeEventHub["publishGlobal"]>[0]) {
  const payload = event.payload as { type?: unknown; properties?: Record<string, unknown> }

  // `session.updated` is forwarded verbatim rather than translated into an
  // `agent.lifecycle` frame: it is not a lifecycle transition, it is a row
  // change (title, `time.updated`, archived-at) the rail must reconcile.
  //
  // This hop is the whole reason a `claude` native-SDK session sat in the
  // sidebar as "New Session" until an unrelated refetch happened to land. The
  // auto-title publishes `session.updated` through `publishGlobal`, this
  // function saw a type it had no `eventType` mapping for, and fell through to
  // the `if (!eventType) return` below — so the frame never reached the
  // workspace stream at all. Both other ends were already correct: the app
  // subscribes to `session.updated` (`claxedoDirectoryEventTypes`) and
  // reconciles it into the paginated session-list
  // (`directory-event-projector` -> `reconcileUpdatedSessionListQueryData`).
  //
  // Kept ahead of the `eventType` mapping so a future compat type that is BOTH
  // a row change and a lifecycle transition cannot be silently swallowed by
  // whichever branch happens to be written first.
  if (payload.type === "session.updated") {
    workspaceRuntimeBus.publish({
      type: "session.updated",
      ...(event.directory ? { directory: event.directory } : {}),
      workspaceId: workspaceId(),
      properties: payload.properties,
    })
    return
  }

  const sessionID = (payload.properties?.sessionID ?? payload.properties?.sessionId) as string | undefined
  const status = payload.properties?.status as { type?: unknown } | undefined
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
    ...(sessionID ? { sessionId: sessionID } : {}),
    eventType,
  })
}

function dir(c: {
  req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined }
}, input?: { sessionId?: string }): string {
  try {
    const requested = c.req.query("directory") || c.req.header("x-opencode-directory")
    if (!requested && input?.sessionId) {
      return registeredWorkspaceDirectory(input.sessionId) ?? assertTarget(undefined)
    }
    return assertTarget(requested)
  } catch (err) {
    throw new HTTPException(400, { message: (err as Error).message })
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
    listPermissions?: (c: unknown, directory: string) => Promise<AgentPermission[]>
    listQuestions?: (c: unknown, directory: string) => Promise<AgentQuestion[]>
    listSessions?: (c: unknown, directory: string) => Promise<AgentSession[]>
    /** Host-owned status transport. The session-core route remains the only
     * public handler so its private-session filter cannot be shadowed. */
    getStatus?: (
      c: unknown,
      directory: string,
      adapter: AgentHarnessAdapter,
    ) => Promise<Response | unknown> | Response | unknown
    /**
     * Own session creation instead of delegating straight to the adapter.
     *
     * `createSessionRoutes` already supports this; it was simply not exposed
     * here, so a host had no way to observe a create. Workspace Runtime needs
     * it to become the OWNER of local session inventory (U8-F7): without a
     * create hook the store only ever learns about a session from the
     * list-time adapter fan-out, which makes the store a cache the fan-out
     * happens to fill rather than the authority.
     */
    createSession?: (c: unknown, directory: string, title?: string, id?: string) => Promise<{ id: string }>
    afterCreateSession?: (input: { directory: string; session: unknown }) => Promise<void> | void
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
      adapter: AgentHarnessAdapter
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
    afterDeleteSession?: (input: { directory: string; sessionId: string }) => Promise<void> | void
    /**
     * Observe a session update (title, archive) after the adapter applies it.
     *
     * Exposed for the same reason as `createSession`: without it the durable
     * store never sees a rename or an archive, so a store-owned inventory would
     * serve stale titles and resurrect archived sessions (U8-F7).
     */
    afterUpdateSession?: (input: {
      directory: string
      sessionId: string
      updates: { title?: string; time?: { archived?: number } }
    }) => Promise<void> | void
    opencodeHeaders?: HeadersInit
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
    const raw = harnessQueryParam(c.req)
    if (raw === undefined) return undefined
    const identity = normalizeHarnessIdentity(raw)
    if (!identity) throw new HTTPException(400, { message: `Unknown harness "${raw}"` })
    return identity
  }
  return createSessionRoutes({
    resolveAdapter: async (c, input) => {
      const harness = requestedHarness(c as never)
      return await getAdapter({
        ...input,
        ...(harness ? { harness } : {}),
      })
    },
    resolveRuntime: options?.resolveRuntime
      ? async (c, input) => {
          const harness = requestedHarness(c as never)
          return await options.resolveRuntime?.({
            ...input,
            ...(harness ? { harness } : {}),
          })
        }
      : undefined,
    resolveDirectory: (c, input) => dir(c as never, input),
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
      ? (c, directory, title, id) => options.createSession!(c, requiredDirectory(directory), title, id)
      : undefined,
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
      ? (_c, directory, sessionId, adapter) => options.getSession!({
          adapter,
          directory: requiredDirectory(directory),
          sessionId,
        })
      : undefined,
    getTodos: options?.getTodos
      ? (_c, directory, sessionId) => options.getTodos!({ directory: requiredDirectory(directory), sessionId })
      : undefined,
    getStatus: options?.getStatus
      ? (c, directory, adapter) => options.getStatus!(c, requiredDirectory(directory), adapter)
      : async (_c, directory, adapter) => {
          const target = requiredDirectory(directory)
          if (!hasAdapterCapability(adapter, "http-proxy")) return sessionStatusSnapshot(await adapter.listSessions(target))
          const url = await (adapter as AgentHarnessAdapter & HttpProxyAdapter).getServerUrl()
          const headers = new Headers(options?.opencodeHeaders)
          headers.set("x-opencode-directory", target)
          const res = await fetch(`${url}/session/status`, {
            headers,
          })
          return new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          })
        },
    sessionBus: workspaceRuntimeBus,
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
          sessionId: String((session as { id?: unknown }).id ?? ""),
          updates,
        })
      : undefined,
    afterDeleteSession: options?.afterDeleteSession
      ? (_c, directory, sessionId) => options.afterDeleteSession!({
          directory: requiredDirectory(directory),
          sessionId,
        })
      : undefined,
  })
}
