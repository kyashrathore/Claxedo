import { decodeApiError } from "@claxedo/helpers/api-error"
import type { AgentGoalMutationResult, AgentPermissionModeState, GoalCapabilities, SessionConfig, SessionConfigUpdate } from "@claxedo/agent-runtime-contract"
import type {
  AgentContentPart,
  AgentSessionStart,
  AgentMessage,
  AgentPermission,
  AgentPresentationEvent,
  AgentPresentationSession,
  AgentPromptResponse,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentRuntimeStatus,
  RecoveryOutcome,
  RecoveryRequest,
} from "@claxedo/agent-runtime-contract"
import { isRecoveryOutcome, parseRecoveryOutcome } from "@claxedo/agent-runtime-contract"
import type { HarnessCapabilities } from "@claxedo/session-core"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import type { ConfigOptionsPreview } from "@claxedo/harness/contract"
import type { AgentRuntimeRecoveryInspection } from "@claxedo/session-core"
import type { AgentTurnCoveragePage } from "@claxedo/agent-runtime-contract"
import type { FirstRead, TurnPage } from "@claxedo/agent-runtime-contract"
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
export type SessionMessagePageInput = SessionInput & { turn?: never; coverage?: never } & (
  | { snapshot: "1" }
  | { view?: "latest-turn" | "latest-surface"; limit?: number; before?: string }
)
export type SessionTurnCoverageInput = SessionInput & { turn: string; coverage: "1" }
/** The reader's viewport and settings, which choose how many turns a page carries and which tool rows ride whole. */
export type SessionViewport = { rows: number; cols: number; reasoning: "0" | "1"; shell: "0" | "1"; edit: "0" | "1" }
/** An outline read; with the reader's viewport it also asks for the first page its transcript draws. */
export type SessionOutlineInput = SessionInput & ({ [K in keyof SessionViewport]?: never } | SessionViewport)
/** The page of turns before `before`, projected as the first page is. */
export type SessionTurnPageInput = SessionInput & SessionViewport & { before: string }
export type SessionPartInput = SessionInput & { messageID: string; partID: string }
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
  configOptions(input: SessionInput, options?: Options): Reply<ConfigOptionsPreview>
  attachment(input: SessionInput & { messageID: string; attachmentID: string }, options?: Options): Promise<Response>
  delete(input: SessionInput, options?: Options): Reply<Ok>
  update(input: SessionUpdateInput, options?: Options): Reply<AgentPresentationSession>
  status(input?: WorkspaceScope, options?: Options): Reply<Record<string, AgentRuntimeStatus>>
  harnessCapabilities(input?: WorkspaceScope, options?: Options): Reply<HarnessCapabilities>
  capabilities(input: SessionInput, options?: Options): Reply<HarnessCapabilities>
  subagents(input: SessionInput, options?: Options): Reply<unknown[]>
  /** One turn's coverage envelope, answered against `input.turn` and no other turn. */
  messages(input: SessionTurnCoverageInput, options?: Options): Reply<AgentTurnCoveragePage>
  /** The page's messages alone; its cursor rides the `X-Next-Cursor` response header. */
  messages(input: SessionMessagePageInput, options?: Options): Reply<AgentMessage[]>
  /** The session's row and its turns as the nav rail lists them, never their content; with a viewport, also the first page. */
  outline(input: SessionOutlineInput, options?: Options): Reply<FirstRead<AgentPresentationSession>>
  turnPage(input: SessionTurnPageInput, options?: Options): Reply<TurnPage>
  /** One part whole, as a row that a page sent as its header reads it when it opens. */
  part(input: SessionPartInput, options?: Options): Reply<AgentContentPart>
  fork(input: SessionInput & { messageID?: string }, options?: Options): Reply<AgentPresentationSession>
  /**
   * What the runtime owner knows about this session, and the operations a
   * caller submits against it. All three answer a `RecoveryOutcome` for every
   * status the contract defines, refusals included, so only a body that is not
   * one at all is thrown. An inspection the owner could answer is the
   * inspection itself, which carries no `kind` — `isRecoveryOutcome` is the
   * discriminant.
   */
  recovery: {
    inspect(input: SessionInput, options?: Options): Reply<AgentRuntimeRecoveryInspection | RecoveryOutcome>
    submit(input: SessionInput & { request: RecoveryRequest }, options?: Options): Reply<RecoveryOutcome>
    read(input: SessionInput & { operationId: string }, options?: Options): Reply<RecoveryOutcome>
  }
  prompt(input: SessionMessageInput, options?: Options): Reply<AgentPromptResponse | SessionDeliveryAcknowledgement>
  /** Immediate admission has no body; explicit delivery requests return their durable admission state. */
  promptAsync(input: SessionMessageInput, options?: Options): Reply<void | SessionDeliveryAcknowledgement>
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

/**
 * The two statuses the recovery routes answer their own error envelope with:
 * a request that failed to parse, and an operation id this owner never held.
 * Both are answers about the request itself, so they stay exceptions — a
 * caller must not read "your request was malformed" as a turn it may retry.
 */
const RECOVERY_ROUTE_ERROR_STATUSES = new Set([400, 404])

/**
 * A recovery answer, from whatever answered. The owner's own body is an
 * outcome; a hop in front of it that gave up — a relay timeout, an
 * unreachable upstream, a body nothing would forward — answers the runtime's
 * error envelope under some other status, and that is `unavailable`: nothing
 * reached the owner, so it made no decision about the turn. Reading it as an
 * operation would invent one the owner never opened, and throwing it away
 * would lose the only thing the caller was told.
 */
function decodeRecoveryOutcome(body: unknown, status: number): RecoveryOutcome {
  if (isRecoveryOutcome(body)) return parseRecoveryOutcome(body)
  const envelope = decodeApiError(status, body)
  if (!envelope || RECOVERY_ROUTE_ERROR_STATUSES.has(status)) {
    throw new Error("recovery answer is neither an outcome nor a forwarding failure")
  }
  return { kind: "refused", refusal: { kind: "unavailable", message: `${envelope.code}: ${envelope.message}` } }
}

/**
 * The one body that is neither an outcome nor an error envelope. Checked before
 * it is handed on: a caller that reads `facts` or `operations` off a malformed
 * answer reports "no operations" for a session the owner never described, and
 * the request that asked for it is gone by then.
 */
function recoveryInspection(body: unknown): AgentRuntimeRecoveryInspection {
  if (!isRecoveryInspection(body)) {
    throw new Error("recovery answer is neither an outcome nor a session inspection")
  }
  return body
}

function isRecoveryInspection(body: unknown): body is AgentRuntimeRecoveryInspection {
  if (typeof body !== "object" || body === null) return false
  const fields = body as Partial<Record<keyof AgentRuntimeRecoveryInspection, unknown>>
  return typeof fields.sessionId === "string"
    && typeof fields.queued === "number"
    && typeof fields.facts === "object" && fields.facts !== null
    && typeof fields.health === "object" && fields.health !== null
    && Array.isArray(fields.failures)
    && Array.isArray(fields.operations)
}

const sessionApiPath = (input: SessionInput, suffix = "") => `/session/${encodeURIComponent(input.sessionID)}${suffix}`

export function sessionClient(caller: WorkspaceRuntimeCaller): WorkspaceSessionClient {
  const read = <T>(operation: string, input: SessionInput, suffix: string, options?: Options, query?: Record<string, unknown>) =>
    caller.call<T>({ operation, path: sessionApiPath(input, suffix), scope: input, query, options })
  const write = <T>(operation: string, method: string, input: SessionInput, suffix: string, options?: Options, body?: unknown) =>
    caller.call<T>({ operation, method, path: sessionApiPath(input, suffix), scope: input, body, options })
  function messages(input: SessionTurnCoverageInput, options?: Options): Reply<AgentTurnCoveragePage>
  function messages(input: SessionMessagePageInput, options?: Options): Reply<AgentMessage[]>
  function messages(input: SessionInput & Record<string, unknown>, options?: Options) {
    return read<AgentTurnCoveragePage | AgentMessage[]>("session.messages", input, "/message", options, without(input, ["sessionID"]))
  }
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
    attachment: async (input, options) => (await caller.send({ operation: "session.attachment", path: sessionApiPath(input, `/message/${encodeURIComponent(input.messageID)}/attachment/${encodeURIComponent(input.attachmentID)}`), scope: input, options })).response,
    delete: (input, options) => write("session.delete", "DELETE", input, "", options),
    update: (input, options) => write("session.update", "PATCH", input, "", options, without(input, ["sessionID"])),
    status: (input = {}, options) => caller.call({ operation: "session.status", path: "/session/status", scope: input, options }),
    harnessCapabilities: (input = {}, options) => caller.call({ operation: "session.harnessCapabilities", path: "/session/capabilities", scope: input, options }),
    capabilities: (input, options) => read("session.capabilities", input, "/capabilities", options),
    subagents: (input, options) => read("session.subagents", input, "/subagents", options),
    messages,
    outline: (input, options) => read("session.outline", input, "/outline", options, without(input, ["sessionID"])),
    turnPage: (input, options) => read("session.turnPage", input, "/page", options, without(input, ["sessionID"])),
    part: (input, options) => read("session.part", input, `/message/${encodeURIComponent(input.messageID)}/part/${encodeURIComponent(input.partID)}`, options),
    fork: (input, options) => write("session.fork", "POST", input, "/fork", options, without(input, ["sessionID"])),
    recovery: {
      inspect: (input, options) => caller.decoded({
        operation: "session.recovery.inspect",
        path: sessionApiPath(input, "/recovery"),
        scope: input,
        options,
        // An inspection the owner answered carries no `kind` and is not an
        // error envelope, so it is the only body that is not an outcome.
        decode: (body, status) => isRecoveryOutcome(body) || decodeApiError(status, body)
          ? decodeRecoveryOutcome(body, status)
          : recoveryInspection(body),
      }),
      submit: (input, options) => caller.decoded({
        operation: "session.recovery.submit",
        method: "POST",
        path: sessionApiPath(input, "/recovery"),
        scope: input,
        body: input.request,
        options,
        decode: decodeRecoveryOutcome,
      }),
      read: (input, options) => caller.decoded({
        operation: "session.recovery.read",
        path: sessionApiPath(input, `/recovery/operations/${encodeURIComponent(input.operationId)}`),
        scope: input,
        options,
        decode: decodeRecoveryOutcome,
      }),
    },
    prompt: (input, options) => write("session.prompt", "POST", input, "/message", options, without(input, ["sessionID"])),
    promptAsync: (input, options) => {
      const request = {
        operation: "session.promptAsync", method: "POST", path: sessionApiPath(input, "/prompt_async"),
        scope: input, body: without(input, ["sessionID"]), options,
      }
      return input.delivery === "queue" || input.delivery === "steer"
        ? caller.call<SessionDeliveryAcknowledgement>(request)
        : caller.callNoContent(request)
    },
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
