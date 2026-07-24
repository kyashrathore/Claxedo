import { HTTPException } from "hono/http-exception"
import { createSessionRoutes } from "./session-core"
import {
  normalizeHarnessIdentity,
  type AgentRuntime,
  type AgentMessageRow,
  type AgentPermissionRow,
  type AgentQuestionRow,
  type SessionHarness,
  type AgentSessionRow,
  type PromptInput,
  type SessionConfig,
  type SessionConfigUpdate,
} from "@claxedo/agent-sdk-runtime"
import {
  hasAdapterCapability,
  type AgentHarnessAdapter,
  type HttpProxyAdapter,
} from "@claxedo/agent-sdk-runtime/adapters"
import { workspaceRuntimeBus } from "../bus"
import { withDir } from "../compat-events"
import { createRuntimeEventHub, type RuntimeEventHub } from "../runtime-event-hub"
import { assertTarget, registeredWorkspaceDirectory, workspaceId } from "../target"
import { sessionStatusSnapshot } from "./session-status-snapshot"
import type { SessionPromptBody } from "../session/service"

function bridgeLifecycleEvent(event: Parameters<RuntimeEventHub["publishGlobal"]>[0]) {
  const payload = event.payload as { type?: unknown; properties?: Record<string, unknown> }
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
  messages: AgentMessageRow[]
  maxEventOrdinal?: number
}

export function SessionRoutes(
  getAdapter: (input?: { sessionId?: string; directory?: string; harness?: SessionHarness }) => AgentHarnessAdapter | Promise<AgentHarnessAdapter>,
  options?: {
    eventHub?: RuntimeEventHub
    beforeSessionOperation?: (input: { sessionId: string; operation: string }) => Response | undefined
    resolveRuntime?: (input?: { sessionId?: string; directory?: string; harness?: SessionHarness }) => AgentRuntime | Promise<AgentRuntime | undefined> | undefined
    listPermissions?: (c: unknown, directory: string) => Promise<AgentPermissionRow[]>
    listQuestions?: (c: unknown, directory: string) => Promise<AgentQuestionRow[]>
    listSessions?: (c: unknown, directory: string) => Promise<AgentSessionRow[]>
    getMessages?: (input: {
      directory: string
      sessionId: string
    }) => Promise<AgentMessageRow[] | undefined> | AgentMessageRow[] | undefined
    getMessageSnapshot?: (input: {
      directory: string
      sessionId: string
    }) => Promise<MessageSnapshot | undefined> | MessageSnapshot | undefined
    getSession?: (input: {
      adapter: AgentHarnessAdapter
      directory: string
      sessionId: string
    }) => Promise<AgentSessionRow | null> | AgentSessionRow | null
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
      update: SessionConfigUpdate
    }) => Promise<SessionConfig>
    opencodeHeaders?: HeadersInit
  },
) {
  const eventHub = options?.eventHub ?? createRuntimeEventHub()
  function requestedHarness(c: {
    req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined }
  }) {
    return normalizeHarnessIdentity(c.req.query("harness") ?? c.req.query("runner") ?? undefined)
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
    listPermissions: options?.listPermissions
      ? (c, directory) => options.listPermissions!(c, requiredDirectory(directory))
      : undefined,
    listQuestions: options?.listQuestions
      ? (c, directory) => options.listQuestions!(c, requiredDirectory(directory))
      : undefined,
    listSessions: options?.listSessions
      ? (c, directory) => options.listSessions!(c, requiredDirectory(directory))
      : undefined,
    getMessages: options?.getMessages
      ? (_c, directory, sessionId) => options.getMessages!({ directory: requiredDirectory(directory), sessionId })
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
    getStatus: async (_c, directory, adapter) => {
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
  })
}
