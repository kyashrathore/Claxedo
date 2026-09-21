import type {
  AgentSessionStart,
  AgentMessage,
  AgentPermission,
  AgentPresentationEvent,
  AgentPresentationSession,
  AgentPromptResponse,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentRuntimeStatus,
  AgentTodo,
  RecoveryOutcome,
  RecoveryRequest,
} from "@claxedo/agent-runtime-contract"
import { parseRecoveryOutcome } from "@claxedo/agent-runtime-contract"
import type {
  AgentConfigOptions,
  AgentGoalMutationResult,
  AgentRuntimeRecoveryInspection,
  AgentPermissionModeState,
  GoalCapabilities,
  HarnessCapabilities,
  RuntimeGoalSnapshot,
  SessionConfig,
  SessionConfigUpdate,
} from "@claxedo/agent-sdk-runtime"
import { namedMembers, without, type WorkspaceRuntimeCaller, type WorkspaceRuntimeRequestOptions, type WorkspaceRuntimeResponse, type WorkspaceScope } from "./request"

type Options = WorkspaceRuntimeRequestOptions
type Reply<T> = Promise<WorkspaceRuntimeResponse<T>>

/** What the routes that only acknowledge a mutation answer with. */
type Ok = { ok: true }

export type SessionInput = WorkspaceScope & { sessionID: string }
export type SessionCreateInput = WorkspaceScope & {
  parentID?: string
  title?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  metadata?: Record<string, unknown>
  permission?: unknown
  workspaceID?: string
}
export type SessionUpdateInput = SessionInput & {
  title?: string
  time?: { archived?: number }
  [key: string]: unknown
}
export type SessionMessageInput = SessionInput & Record<string, unknown>
export type SessionDeliveryAcknowledgement =
  | { delivery: "queue" | "steer"; messageID?: string }
  | { ok: false; status: "pending" | "unknown"; operationId?: string; message: string }
export type SessionListInput = WorkspaceScope & {
  scope?: "project"
  path?: string
  roots?: boolean | "true" | "false"
  start?: number
  search?: string
  limit?: number
}
export type SessionSummaryListInput = WorkspaceScope & { roots?: boolean; archived?: boolean; limit?: number }
export type SessionMessagePageInput = SessionInput & (
  | { snapshot: "1" }
  | { view?: "latest-turn" | "latest-surface"; limit?: number; before?: string }
)
export type SessionGoalStartInput = SessionInput & { objective: string }

/** A prompt the runtime holds behind a running turn, as the queue route reports it. */
export type QueuedSessionPrompt = {
  steering?: { mode: "start" | "steer"; operationId: string; state: "dispatching" | "accepted" | "unknown" | "rejected"; message?: string }
  seq: number
  messageId?: string
  queuedAt: number
  parts: Array<Record<string, unknown>>
  /** Kept back from the next idle while a client edits it. */
  held: boolean
}

export type SessionQueueControlInput = SessionInput & { seq: number } & (
  | { action: "cancel" | "steer" | "hold" | "release" }
  | { action: "replace"; parts: Array<Record<string, unknown>> }
)

export type WorkspaceSessionClient = {
  list(input?: SessionListInput, options?: Options): Reply<AgentPresentationSession[]>
  summaries(input?: SessionSummaryListInput, options?: Options): Reply<Record<string, unknown>[]>
  create(input?: SessionCreateInput, options?: Options): Reply<AgentPresentationSession>
  get(input: SessionInput, options?: Options): Reply<AgentPresentationSession>
  start(input: SessionInput, options?: Options): Reply<AgentSessionStart>
  configOptions(input: SessionInput, options?: Options): Reply<AgentConfigOptions>
  attachment(input: SessionInput & { messageID: string; attachmentID: string }, options?: Options): Promise<Response>
  delete(input: SessionInput, options?: Options): Reply<Ok>
  update(input: SessionUpdateInput, options?: Options): Reply<AgentPresentationSession>
  status(input?: WorkspaceScope, options?: Options): Reply<Record<string, AgentRuntimeStatus>>
  harnessCapabilities(input?: WorkspaceScope, options?: Options): Reply<HarnessCapabilities>
  capabilities(input: SessionInput, options?: Options): Reply<HarnessCapabilities>
  subagents(input: SessionInput, options?: Options): Reply<unknown[]>
  /** The page's messages alone; its cursor rides the `X-Next-Cursor` response header. */
  messages(input: SessionMessagePageInput, options?: Options): Reply<AgentMessage[]>
  todo(input: SessionInput, options?: Options): Reply<AgentTodo[]>
  fork(input: SessionInput & { messageID?: string }, options?: Options): Reply<AgentPresentationSession>
  /**
   * What the runtime owner knows about this session, and the operations a
   * caller submits against it. `submit` and `read` answer a `RecoveryOutcome`
   * for every status the contract defines, including its refusals, so only a
   * body that is not one at all is thrown.
   */
  recovery: {
    inspect(input: SessionInput, options?: Options): Reply<AgentRuntimeRecoveryInspection>
    submit(input: SessionInput & { request: RecoveryRequest }, options?: Options): Reply<RecoveryOutcome>
    read(input: SessionInput & { operationId: string }, options?: Options): Reply<RecoveryOutcome>
  }
  summarize(input: SessionInput & { providerID: string; modelID: string; auto?: boolean }, options?: Options): Reply<Ok>
  prompt(input: SessionMessageInput, options?: Options): Reply<AgentPromptResponse | SessionDeliveryAcknowledgement>
  /** Immediate admission has no body; explicit delivery requests return their durable admission state. */
  promptAsync(input: SessionMessageInput, options?: Options): Reply<void | SessionDeliveryAcknowledgement>
  command(input: SessionMessageInput, options?: Options): Reply<AgentPromptResponse>
  shell(input: SessionMessageInput, options?: Options): Reply<AgentPromptResponse>
  revert(input: SessionInput & { messageID: string; partID?: string }, options?: Options): Reply<AgentPresentationSession>
  unrevert(input: SessionInput, options?: Options): Reply<AgentPresentationSession>
  config: {
    get(input: SessionInput, options?: Options): Reply<SessionConfig>
    update(input: SessionInput & SessionConfigUpdate, options?: Options): Reply<SessionConfig>
  }
  permissionMode: {
    get(input: SessionInput, options?: Options): Reply<AgentPermissionModeState>
    set(input: SessionInput & { modeId: string }, options?: Options): Reply<AgentPermissionModeState>
  }
  queue: {
    list(input: SessionInput, options?: Options): Reply<QueuedSessionPrompt[]>
    control(input: SessionQueueControlInput, options?: Options): Reply<Ok | { ok: false; status: "pending" | "unknown"; operationId: string; message: string }>
  }
  goal: {
    state(input: SessionInput, options?: Options): Reply<{ capabilities: GoalCapabilities; goal: RuntimeGoalSnapshot | null }>
    capabilities(input: SessionInput, options?: Options): Reply<GoalCapabilities>
    get(input: SessionInput, options?: Options): Reply<RuntimeGoalSnapshot | null>
    start(input: SessionGoalStartInput, options?: Options): Reply<AgentGoalMutationResult>
    pause(input: SessionInput, options?: Options): Reply<AgentGoalMutationResult>
    resume(input: SessionInput, options?: Options): Reply<AgentGoalMutationResult>
    stop(input: SessionInput, options?: Options): Reply<AgentGoalMutationResult>
    delete(input: SessionInput, options?: Options): Reply<AgentGoalMutationResult>
  }
}

export type WorkspacePermissionClient = {
  list(input?: WorkspaceScope, options?: Options): Reply<AgentPermission[]>
  modes(input?: WorkspaceScope, options?: Options): Reply<AgentPermissionModeState>
  respond(input: WorkspaceScope & { sessionID: string; permissionID: string; response?: "once" | "always" | "reject"; optionId?: string }, options?: Options): Reply<Ok & { events: AgentPresentationEvent[] }>
}

export type WorkspaceQuestionClient = {
  list(input?: WorkspaceScope, options?: Options): Reply<AgentQuestion[]>
  reply(input: WorkspaceScope & { requestID: string; answers?: AgentQuestionAnswer[] }, options?: Options): Reply<Ok>
  reject(input: WorkspaceScope & { requestID: string }, options?: Options): Reply<Ok>
}

const SESSION_LIST_QUERY = ["scope", "path", "roots", "start", "search", "limit"] as const
const SESSION_SUMMARY_QUERY = ["roots", "archived", "limit"] as const

const sessionPath = (input: SessionInput, suffix = "") => `/session/${encodeURIComponent(input.sessionID)}${suffix}`

export function sessionClient(caller: WorkspaceRuntimeCaller): WorkspaceSessionClient {
  const read = <T>(operation: string, input: SessionInput, suffix: string, options?: Options, query?: Record<string, unknown>) =>
    caller.call<T>({ operation, path: sessionPath(input, suffix), scope: input, query, options })
  const write = <T>(operation: string, method: string, input: SessionInput, suffix: string, options?: Options, body?: unknown) =>
    caller.call<T>({ operation, method, path: sessionPath(input, suffix), scope: input, body, options })
  const goalRead = <T>(operation: string, suffix: string) => (input: SessionInput, options?: Options) =>
    read<T>(operation, input, suffix, options)
  const goalWrite = (operation: string, method: string, suffix: string) => (input: SessionInput, options?: Options) =>
    write<AgentGoalMutationResult>(operation, method, input, suffix, options)

  return {
    list: (input = {}, options) => caller.call({ operation: "session.list", path: "/session", scope: input, query: namedMembers(input, SESSION_LIST_QUERY), options }),
    summaries: (input = {}, options) => caller.call({ operation: "session.summaries", path: "/experimental/session", scope: input, query: namedMembers(input, SESSION_SUMMARY_QUERY), options }),
    create: (input = {}, options) => caller.call({ operation: "session.create", method: "POST", path: "/session", scope: input, body: without(input), options }),
    get: (input, options) => read("session.get", input, "", options),
    start: (input, options) => caller.call({ operation: "session.start", path: `/session-start/${encodeURIComponent(input.sessionID)}`, scope: input, options }),
    configOptions: (input, options) => read("session.configOptions", input, "/config-options", options),
    attachment: async (input, options) => (await caller.send({ operation: "session.attachment", path: sessionPath(input, `/message/${encodeURIComponent(input.messageID)}/attachment/${encodeURIComponent(input.attachmentID)}`), scope: input, options })).response,
    delete: (input, options) => write("session.delete", "DELETE", input, "", options),
    update: (input, options) => write("session.update", "PATCH", input, "", options, without(input, ["sessionID"])),
    status: (input = {}, options) => caller.call({ operation: "session.status", path: "/session/status", scope: input, options }),
    harnessCapabilities: (input = {}, options) => caller.call({ operation: "session.harnessCapabilities", path: "/session/capabilities", scope: input, options }),
    capabilities: (input, options) => read("session.capabilities", input, "/capabilities", options),
    subagents: (input, options) => read("session.subagents", input, "/subagents", options),
    messages: (input, options) => read("session.messages", input, "/message", options, without(input, ["sessionID"])),
    todo: (input, options) => read("session.todo", input, "/todo", options),
    fork: (input, options) => write("session.fork", "POST", input, "/fork", options, without(input, ["sessionID"])),
    recovery: {
      inspect: (input, options) => read<AgentRuntimeRecoveryInspection>("session.recovery.inspect", input, "/recovery", options),
      submit: (input, options) => caller.decoded({
        operation: "session.recovery.submit",
        method: "POST",
        path: sessionPath(input, "/recovery"),
        scope: input,
        body: input.request,
        options,
        decode: parseRecoveryOutcome,
      }),
      read: (input, options) => caller.decoded({
        operation: "session.recovery.read",
        path: sessionPath(input, `/recovery/operations/${encodeURIComponent(input.operationId)}`),
        scope: input,
        options,
        decode: parseRecoveryOutcome,
      }),
    },
    summarize: (input, options) => write("session.summarize", "POST", input, "/summarize", options, without(input, ["sessionID"])),
    prompt: (input, options) => write("session.prompt", "POST", input, "/message", options, without(input, ["sessionID"])),
    promptAsync: (input, options) => {
      const request = {
        operation: "session.promptAsync", method: "POST", path: sessionPath(input, "/prompt_async"),
        scope: input, body: without(input, ["sessionID"]), options,
      }
      return input.delivery === "queue" || input.delivery === "steer"
        ? caller.call<SessionDeliveryAcknowledgement>(request)
        : caller.callNoContent(request)
    },
    command: (input, options) => write("session.command", "POST", input, "/command", options, without(input, ["sessionID"])),
    shell: (input, options) => write("session.shell", "POST", input, "/shell", options, without(input, ["sessionID"])),
    revert: (input, options) => write("session.revert", "POST", input, "/revert", options, without(input, ["sessionID"])),
    unrevert: (input, options) => write("session.unrevert", "POST", input, "/unrevert", options),
    config: {
      get: (input, options) => read("session.config.get", input, "/config", options),
      update: (input, options) => write("session.config.update", "PATCH", input, "/config", options, without(input, ["sessionID"])),
    },
    permissionMode: {
      get: (input, options) => read("session.permissionMode.get", input, "/permission-mode", options),
      set: (input, options) => write("session.permissionMode.set", "PUT", input, "/permission-mode", options, { modeId: input.modeId }),
    },
    queue: {
      list: (input, options) => read<QueuedSessionPrompt[]>("session.queue.list", input, "/queue", options),
      control: (input, options) => write<Ok | { ok: false; status: "pending" | "unknown"; operationId: string; message: string }>(
        "session.queue.control",
        "POST",
        input,
        `/queue/${encodeURIComponent(String(input.seq))}/${encodeURIComponent(input.action)}`,
        options,
        "parts" in input ? { parts: input.parts } : undefined,
      ),
    },
    goal: {
      state: goalRead("session.goal.state", "/goal/state"),
      capabilities: goalRead("session.goal.capabilities", "/goal/capabilities"),
      get: goalRead("session.goal.get", "/goal"),
      start: (input, options) => write("session.goal.start", "POST", input, "/goal", options, { objective: input.objective }),
      pause: goalWrite("session.goal.pause", "POST", "/goal/pause"),
      resume: goalWrite("session.goal.resume", "POST", "/goal/resume"),
      stop: goalWrite("session.goal.stop", "POST", "/goal/stop"),
      delete: goalWrite("session.goal.delete", "DELETE", "/goal"),
    },
  }
}

export function permissionClient(caller: WorkspaceRuntimeCaller): WorkspacePermissionClient {
  return {
    list: (input = {}, options) => caller.call({ operation: "permission.list", path: "/permission", scope: input, options }),
    modes: (input = {}, options) => caller.call({ operation: "permission.modes", path: "/permission/modes", scope: input, options }),
    respond: (input, options) => caller.call({
      operation: "permission.respond",
      method: "POST",
      path: `/session/${encodeURIComponent(input.sessionID)}/permissions/${encodeURIComponent(input.permissionID)}`,
      scope: input,
      body: { ...(input.response !== undefined ? { response: input.response } : {}), ...(input.optionId !== undefined ? { optionId: input.optionId } : {}) },
      options,
    }),
  }
}

export function questionClient(caller: WorkspaceRuntimeCaller): WorkspaceQuestionClient {
  return {
    list: (input = {}, options) => caller.call({ operation: "question.list", path: "/question", scope: input, options }),
    reply: (input, options) => caller.call({
      operation: "question.reply",
      method: "POST",
      path: `/question/${encodeURIComponent(input.requestID)}/reply`,
      scope: input,
      body: { answers: input.answers },
      options,
    }),
    reject: (input, options) => caller.call({
      operation: "question.reject",
      method: "POST",
      path: `/question/${encodeURIComponent(input.requestID)}/reject`,
      scope: input,
      options,
    }),
  }
}
