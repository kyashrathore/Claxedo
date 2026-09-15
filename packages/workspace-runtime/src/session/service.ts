import { assistantMessageIdForTurn } from "@claxedo/agent-event-runtime/contracts"
import { createClientPresentationProjection } from "@claxedo/agent-event-runtime/projections/client-presentation"
import { defaultSessionModel, firstTurnErrorData, isAgentRuntimeTurnConflictError, resolveTurnSystem } from "@claxedo/agent-sdk-runtime"
import {
  AgentRuntimeContractError,
  assertAgentExecutionBinding,
  type AgentExecutionBinding,
  type AgentRuntimeError,
} from "@claxedo/agent-runtime-contract"
import type {
  AgentMessage,
  AgentRuntime,
  AgentRuntimeStreamEvent,
  AgentRuntimeTurnStartInput,
  PromptDelivery,
  PromptDeliveryRequest,
  PromptInput,
  RuntimeDirectory,
  SessionConfig,
} from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import {
  buildAssistantMessage,
  sessionError,
  withDir,
  type CompatEnvelope,
  type CompatEvent,
} from "../compat-events"
import { arr, bool, rec, str } from "../json-value"

export type RuntimeSessionBusEvent =
  | { type: "process.status"; directory: string; configId: string; status: string }

export type ActiveTurnScope = {
  signal?: AbortSignal
  dispose?: () => void
}

export type SessionPromptBody = {
  parts?: PromptInput["parts"]
  messageID?: string
  agent?: string
  model?: { providerID?: string; modelID?: string }
  tools?: Record<string, boolean>
  format?: PromptInput["format"]
  system?: string
  variant?: string
  /**
   * The permission mode this turn should run under, applied BEFORE the prompt
   * reaches the harness.
   *
   * Carried on the prompt rather than requiring a prior `PUT
   * /session/:id/permission-mode` because of the first turn. That route can only
   * run once a session exists, but a session is created BY the first message —
   * so a mode chosen in the composer before sending had no way to reach the
   * harness in time, and the opening turn always ran under whichever default the
   * runtime picked. That is exactly backwards: before the agent has touched
   * anything is when someone most wants to say "ask me about everything".
   *
   * Every harness accepts a mode at turn start, which is why this works
   * uniformly: `permissionMode` is a `query()` option on Claude and `query()`
   * runs per turn; Codex already carries the policy on `turn/start`; ACP takes
   * `set_mode` between `session/new` and the prompt.
   *
   * The PUT route remains, for changing the mode MID-conversation.
   */
  permissionMode?: string
  /**
   * What to do when the session is already running a turn: `steer` hands this
   * prompt to that turn, `queue` holds it until the turn ends. Absent means the
   * caller wants a turn of its own and takes the admission conflict.
   */
  delivery?: PromptDeliveryRequest
}

/**
 * Recognise one prompt part on the wire.
 *
 * A predicate rather than an assertion: the caller keeps the client's own
 * object — extra fields a harness understands still travel — while the part
 * type and the fields the turn machinery dereferences are actually checked.
 */
function isPromptPart(input: unknown): input is PromptInput["parts"][number] {
  const part = rec(input)
  if (!part) return false
  if (part.type === "text") return str(part.text) !== undefined
  if (part.type === "file") return str(part.mime) !== undefined && str(part.url) !== undefined
  if (part.type === "agent") return str(part.name) !== undefined
  return false
}

/** The `Record<string, boolean>` subset of a wire `tools` map. */
function promptTools(input: unknown): SessionPromptBody["tools"] {
  const source = rec(input)
  if (!source) return undefined
  const tools: Record<string, boolean> = {}
  for (const [name, value] of Object.entries(source)) {
    const enabled = bool(value)
    if (enabled !== undefined) tools[name] = enabled
  }
  return tools
}

/**
 * The one place a request payload becomes a `SessionPromptBody`.
 *
 * Every prompt route used to assert the shape of `c.req.json()` — an `any` the
 * routes then handed to the harness unexamined, so a `text` part carrying a
 * number reached the adapter believing it held a string. This narrows each
 * field instead: what does not match the contract is dropped here, at the
 * boundary, rather than several layers deeper.
 */
export function parseSessionPromptBody(input: unknown): SessionPromptBody {
  const body = rec(input)
  if (!body) return {}
  const parts = arr(body.parts)?.filter(isPromptPart)
  const model = rec(body.model)
  const format = rec(body.format)
  const formatType = str(format?.type)
  return {
    parts,
    messageID: str(body.messageID),
    agent: str(body.agent),
    model: model && { providerID: str(model.providerID), modelID: str(model.modelID) },
    tools: promptTools(body.tools),
    format: format && formatType !== undefined ? { ...format, type: formatType } : undefined,
    system: str(body.system),
    variant: str(body.variant),
    permissionMode: str(body.permissionMode),
    delivery: promptDelivery(body.delivery),
  }
}

function promptDelivery(input: unknown): PromptDeliveryRequest | undefined {
  return input === "steer" || input === "queue" ? input : undefined
}

/**
 * What a client may do to a prompt still waiting: drop it, hand it to the
 * running turn, keep it back from the next idle while it is being edited
 * (`hold` / `release`), or swap its parts — which also releases it.
 */
export type QueuedPromptAction = "cancel" | "steer" | "hold" | "release" | { replace: NonNullable<PromptInput["parts"]> }

type QueuedIdleHandoff = Awaited<ReturnType<AgentRuntime["turns"]["whenIdle"]>>
type QueuedWaitDecision =
  | { kind: "start"; handoff: QueuedIdleHandoff }
  | { kind: "cancel" | "steer" | "hold" | "release" }
  | { kind: "replace"; parts: NonNullable<PromptInput["parts"]> }

export type SessionPromptTurnResult = {
  sessionId: string
  prompt: PromptInput
  scope: string
  assistantId: string
  assistantMessagePublished: boolean
  error?: string
  messages: AgentMessage[]
}

/**
 * How the runtime admitted the prompt, reported as soon as it decides and
 * before the turn runs, because that is what the response has to carry.
 */
export type PromptDeliveryObserver = (delivery: PromptDelivery) => void

export type SessionPromptTurnInput = {
  adapter: AgentHarnessAdapter
  sessionId: string
  directory: RuntimeDirectory
  body: SessionPromptBody
  /** Decided by the caller, so a refusal is the answer its client is waiting on. */
  admitted: AdmittedSessionPromptTurn
  publishGlobal: (event: CompatEnvelope) => void
  publishStatus: (event: RuntimeSessionBusEvent) => void
  createActiveTurnScope?: (input: {
    adapter: AgentHarnessAdapter
    directory: RuntimeDirectory
    sessionId: string
  }) => ActiveTurnScope | undefined
  publishUserMessage?: boolean
  streamErrorMessage?: (error: unknown) => string
  /** Current durable lease generation, checked before every producer publish. */
  turnAdmission?: { valid(): boolean; fencingToken(): number }
}

export type RuntimePromptTurnInput = {
  runtime: AgentRuntime
  sessionId: string
  directory: RuntimeDirectory
  body: SessionPromptBody
  publishGlobal: (event: CompatEnvelope) => void
  publishStatus: (event: RuntimeSessionBusEvent) => void
  activeTurn?: ActiveTurnScope
  createActiveTurnScope?: () => ActiveTurnScope | undefined
  streamErrorMessage?: (error: unknown) => string
  onAdmissionSettled?: (error?: unknown) => void
  queuedAction?: () => Promise<QueuedPromptAction>
  onQueuedWaitEnd?: () => void
  onDelivery?: PromptDeliveryObserver
  /** Current durable lease generation, checked before every producer publish. */
  turnAdmission?: { valid(): boolean; fencingToken(): number }
  actor?: { actorId: string; actorKind: "human" | "agent" }
  author?: {
    id: string
    name: string
    avatarUrl?: string
    kind: "human" | "agent"
  }
}

function mkAssistantId(userMessageId?: string) {
  if (userMessageId) return assistantMessageIdForTurn(userMessageId)
  const ts = Date.now().toString(16)
  const rand = Math.random().toString(36).slice(2, 10)
  return `msg_${ts}${rand}`
}

function mkUserMessageId() {
  const ts = Date.now().toString(16)
  const rand = Math.random().toString(36).slice(2, 10)
  return `msg_${ts}${rand}u`
}

function activeTurnAbortError() {
  return new Error("Active turn aborted")
}

function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal | undefined) {
  if (!signal) return iterator.next()
  if (signal.aborted) return Promise.reject(activeTurnAbortError())
  let cleanup = () => {}
  const aborted = new Promise<IteratorResult<T>>((_, reject) => {
    const abort = () => reject(activeTurnAbortError())
    signal.addEventListener("abort", abort, { once: true })
    cleanup = () => signal.removeEventListener("abort", abort)
  })
  return Promise.race([iterator.next(), aborted]).finally(cleanup)
}

async function* sendMessageWithAbort(
  adapter: AgentHarnessAdapter,
  binding: AgentExecutionBinding,
  input: PromptInput,
  signal: AbortSignal | undefined,
) {
  if (!adapter.executeTurn) {
    throw new AgentRuntimeContractError({
      code: "unsupported_operation",
      operation: "executeTurn",
      message: `Harness ${binding.connectionId} does not support bound execution`,
    })
  }
  const iterator = adapter.executeTurn(binding, input)[Symbol.asyncIterator]()
  try {
    while (true) {
      const result = await nextWithAbort(iterator, signal)
      if (result.done) return
      yield result.value
    }
  } finally {
    const returned = iterator.return?.()
    if (returned) await Promise.resolve(returned).catch(() => {})
  }
}

export function compatScope(directory: RuntimeDirectory, sessionId: string) {
  return directory ?? sessionId
}

function prompt(adapter: AgentHarnessAdapter, body: SessionPromptBody, config?: SessionConfig): PromptInput {
  // Always assign a userMessageId so adapters publish a `message.updated`
  // event for the user prompt. Without this, reload-resume can lose user input.
  const userMessageId = body.messageID ?? mkUserMessageId()
  // ACP owns its model default unless the user or live session config selected
  // one. Sending the native compatibility default here makes a generic ACP
  // adapter restart under an unrelated Claude model before the first prompt.
  const defaultModel = config
    ? defaultSessionModel(config.harness)
    : { providerID: "anthropic", modelID: "claude-sonnet-4-6" }
  const system = resolveTurnSystem(config, adapter.instructionChannel, body.system)
  return {
    parts: body.parts ?? [],
    userMessageId,
    assistantMessageId: mkAssistantId(userMessageId),
    agent: body.agent ?? config?.agent ?? "build",
    model: {
      providerID: body.model?.providerID ?? config?.model?.providerID ?? defaultModel.providerID,
      modelID: body.model?.modelID ?? config?.model?.modelID ?? defaultModel.modelID,
    },
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.format ? { format: body.format } : {}),
    ...(system ? { system } : {}),
    ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
    ...(body.variant !== undefined ? { variant: body.variant } : config?.variant ? { variant: config.variant } : {}),
  }
}

export type SessionTurnRefusalCode = "session_configuration_unavailable"

/**
 * Raised only while nothing has been asked to execute, which is what lets a
 * caller resubmit the same message id: the cause is external to the turn and
 * may be gone by the retry. Any refusal added here must keep that guarantee —
 * an error thrown once the harness is running is an ordinary turn failure and
 * must not become a `SessionTurnRefusedError`.
 */
export class SessionTurnRefusedError extends AgentRuntimeContractError {
  constructor(readonly refusal: SessionTurnRefusalCode, detail: AgentRuntimeError) {
    super(detail)
    this.name = "SessionTurnRefusedError"
  }
}

export function sessionTurnRefusal(error: unknown): SessionTurnRefusalCode | undefined {
  return error instanceof SessionTurnRefusedError ? error.refusal : undefined
}

/**
 * The config read is unconditional, and a failure refuses the turn: a session's
 * retained instructions live only there, so skipping the read whenever the
 * caller happened to name agent, model and variant — or treating a failed read
 * as "no config" — would run the turn under none of the instructions the
 * session was created with. A session that retained nothing reads back a config
 * without an instruction block, which is a successful read.
 */
async function promptForSession(
  adapter: AgentHarnessAdapter,
  binding: AgentExecutionBinding,
  body: SessionPromptBody,
) {
  let config: SessionConfig | undefined
  try {
    config = (await adapter.getSessionConfig(binding)) ?? undefined
  } catch (cause) {
    throw new SessionTurnRefusedError("session_configuration_unavailable", {
      code: "upstream_error",
      connectionId: binding.connectionId,
      message: `Session ${binding.sessionId} configuration is unavailable, so its instructions cannot be applied: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    })
  }
  return prompt(adapter, body, config)
}

export type AdmittedSessionPromptTurn = {
  binding: AgentExecutionBinding
  prompt: PromptInput
}

/**
 * Everything an adapter turn can be refused on before the harness is asked to
 * run anything: a complete execution binding and the session's configuration. A
 * caller that answers its client before the turn finishes decides admission
 * here first, so a refusal is that answer rather than an event the client is
 * not waiting for.
 */
export async function admitSessionPromptTurn(input: {
  adapter: AgentHarnessAdapter
  binding: AgentExecutionBinding | undefined
  sessionId: string
  directory: RuntimeDirectory
  body: SessionPromptBody
}): Promise<AdmittedSessionPromptTurn> {
  if (!input.binding) {
    throw new AgentRuntimeContractError({
      code: "invalid_execution_binding",
      field: "upstreamSessionId",
      message: `Session ${input.sessionId} has no complete execution binding`,
    })
  }
  const binding = assertAgentExecutionBinding(input.binding, {
    ...input.binding,
    sessionId: input.sessionId,
    directory: input.directory ?? "",
  })
  return { binding, prompt: await promptForSession(input.adapter, binding, input.body) }
}

function isMessage(input: unknown): input is AgentMessage {
  const info = rec(rec(input)?.info)
  return !!info
    && str(info.id) !== undefined
    && str(info.role) !== undefined
    && str(info.sessionID) !== undefined
    && arr(rec(input)?.parts) !== undefined
}

function failure(input: unknown): string {
  return str(rec(rec(input)?.data)?.message) ?? "session error"
}

function isCompatEvent(event: AgentRuntimeStreamEvent): event is CompatEvent {
  return "properties" in event
}

function createPromptEventProjection(input: {
  sessionId: string
  directory: string
  prompt: PromptInput
}) {
  let assistantId = input.prompt.assistantMessageId ?? mkAssistantId(input.prompt.userMessageId)
  const projection = createClientPresentationProjection({
    sessionId: input.sessionId,
    directory: input.directory,
    assistantMessageId: assistantId,
    // Consumers file parts against an existing reply row, so it must be named
    // on the event lane before the first part arrives. `turn.start`'s store
    // upsert only reaches subscribers when that store emits it, and adapter
    // lanes that yield stream events never emit the row themselves.
    announcesAssistantMessage: true,
    announceAssistantIdentity: {
      agent: input.prompt.agent,
      model: input.prompt.model,
      variant: input.prompt.variant,
    },
  })
  return {
    assistantId() {
      return assistantId
    },
    events(event: AgentRuntimeStreamEvent): CompatEvent[] {
      if (isCompatEvent(event)) return [event]
      if (event.type === "step-start") assistantId = event.newMessageId
      return projection.ingest(event).map((item) => item.payload)
    },
  }
}

function isTerminalEvent(event: AgentRuntimeStreamEvent) {
  if (isCompatEvent(event)) return event.type === "session.idle" || event.type === "session.error"
  return event.type === "finish" || event.type === "error" || event.type === "session-status" && event.status === "error"
}

function reply(messages: unknown[], assistantId: string) {
  const rows = messages.filter(isMessage)
  const exact = rows.find((row) => row.info.id === assistantId)
  if (exact) return exact
  return [...rows].reverse().find((row) => row.info.role === "assistant") ?? null
}

export async function runRuntimePromptTurn(input: RuntimePromptTurnInput): Promise<SessionPromptTurnResult> {
  // The host's own turn driver: it reads the session's events to project and
  // publish them, so it is exempt from the eventDelivery identity requirement
  // (see AgentRuntimeSubscribeInput.hostInternal). An identityless subscribe
  // here against a policy-composed runtime throws before `turn.start`, and
  // the failure surfaces only as a transient bus `session.error` — every
  // local prompt dies with "Subscription identity is required".
  const subscribe = () => input.runtime.events.subscribe({ sessionId: input.sessionId, hostInternal: true })[Symbol.asyncIterator]()
  let iterator = subscribe()
  const scope = compatScope(input.directory, input.sessionId)
  let turn: Awaited<ReturnType<RuntimePromptTurnInput["runtime"]["turns"]["start"]>> | undefined
  let assistantId = ""
  let assistantMessagePublished = false
  let error: string | undefined
  let activeTurn = input.activeTurn
  let messages!: AgentMessage[]
  let admissionSettled = false
  const settleAdmission = (admissionError?: unknown) => {
    if (admissionSettled) return
    admissionSettled = true
    input.onAdmissionSettled?.(admissionError)
  }
  try {
    const turnInput = {
      sessionId: input.sessionId,
      // The runtime invokes this only after winning its per-session admission
      // lease and before it enters the harness. That keeps rejected concurrent
      // turns out of the host activity count without leaving a window where a
      // real turn is running but runner replacement cannot see it.
      onAdmitted: () => {
        activeTurn ??= input.createActiveTurnScope?.()
      },
      ...(input.body.messageID ? { messageId: input.body.messageID } : {}),
      ...(input.body.agent ? { agent: input.body.agent } : {}),
      ...(input.body.model?.providerID && input.body.model.modelID
        ? { model: { providerID: input.body.model.providerID, modelID: input.body.model.modelID } }
        : {}),
      ...(input.body.tools ? { tools: input.body.tools } : {}),
      ...(input.body.format ? { format: input.body.format } : {}),
      ...(input.body.system ? { system: input.body.system } : {}),
      ...(input.body.permissionMode ? { permissionMode: input.body.permissionMode } : {}),
      ...(input.body.variant !== undefined ? { variant: input.body.variant } : {}),
      ...(input.body.delivery ? { delivery: input.body.delivery } : {}),
      ...(input.author ? { author: input.author } : {}),
      ...(input.turnAdmission ? { admission: input.turnAdmission } : {}),
    } satisfies Omit<AgentRuntimeTurnStartInput, "actorId" | "actorKind">
    // Read at every start, not captured in turnInput: a replace action while
    // the prompt waits swaps the parts the eventual turn is started with.
    let parts = input.body.parts ?? []
    const start = (delivery = input.body.delivery) => input.actor
      ? input.runtime.turns.start({
          ...turnInput,
          parts,
          delivery,
          actorId: input.actor.actorId,
          actorKind: input.actor.actorKind,
        })
      : input.runtime.turns.start({ ...turnInput, parts, delivery })
    turn = await start()
    // A queued prompt waits here, in the host request that holds it, because
    // the turn it becomes needs this loop to reach the event bus: the runtime
    // publishes to subscribers, and this subscription is the only one bridging
    // them to the client.
    // A held prompt is being edited: it waits for its next action alone and
    // lets the session go idle past it, so the text the user is still typing
    // over cannot start a turn.
    let held = false
    while (turn.delivery === "queue") {
      input.onDelivery?.("queue")
      settleAdmission()
      const idle: Promise<QueuedIdleHandoff> | undefined = held ? undefined : input.runtime.turns.whenIdle(input.sessionId)
      const decision: QueuedWaitDecision = await Promise.race([
        idle?.then((handoff) => ({ kind: "start" as const, handoff })) ?? new Promise<never>(() => {}),
        input.queuedAction?.().then((action) => typeof action === "object"
          ? { kind: "replace" as const, parts: action.replace }
          : { kind: action }) ?? new Promise<never>(() => {}),
      ])
      input.onQueuedWaitEnd?.()
      if (decision.kind !== "start") void idle?.then((handoff) => handoff.abandon())
      if (decision.kind === "hold" || decision.kind === "release") {
        held = decision.kind === "hold"
        continue
      }
      if (decision.kind === "replace") {
        parts = decision.parts
        held = false
        continue
      }
      if (decision.kind === "cancel") {
        return { sessionId: input.sessionId, prompt: turn.prompt, scope, assistantId: turn.assistantMessageId,
          assistantMessagePublished: false, messages: await input.runtime.events.list(input.sessionId, input.directory) }
      }
      try {
        // The first subscription may contain the previous turn's buffered
        // terminal event. The next turn must bridge only its own events, and
        // must subscribe before start() can publish its first message.
        await iterator.return?.()
        iterator = subscribe()
        turn = await start(decision.kind === "steer" ? "steer" : input.body.delivery)
      } catch (error) {
        if (decision.kind === "start") decision.handoff.abandon()
        throw error
      }
    }
    input.onDelivery?.(turn.delivery)
    settleAdmission()
    assistantId = turn.assistantMessageId
    // A steered prompt joined the running turn, and that turn's own driver is
    // already publishing its events through a subscription of its own.
    if (turn.delivery === "steer") {
      return {
        sessionId: input.sessionId,
        prompt: turn.prompt,
        scope,
        assistantId,
        assistantMessagePublished: false,
        messages: await input.runtime.events.list(input.sessionId, input.directory),
      }
    }
    const projection = createPromptEventProjection({
      sessionId: input.sessionId,
      directory: scope,
      prompt: turn.prompt,
    })
    while (true) {
      const result = await nextWithAbort(iterator, activeTurn?.signal)
      if (result.done) break
      const item = result.value
      if (input.turnAdmission && !input.turnAdmission.valid()) break
      for (const event of projection.events(item.payload)) {
        if (input.turnAdmission && !input.turnAdmission.valid()) break
        input.publishStatus({ type: "process.status", directory: scope, configId: input.sessionId, status: "streaming" })
        input.publishGlobal(withDir(scope, event))
        if (event.type === "message.updated" && event.properties.info.role === "assistant") {
          assistantId = event.properties.info.id
          assistantMessagePublished = true
        }
        if (event.type === "session.error") error = failure(event.properties.error)
      }
      assistantId = projection.assistantId()
      if (isTerminalEvent(item.payload)) break
    }
  } catch (err) {
    settleAdmission(err)
    if (isAgentRuntimeTurnConflictError(err)) throw err
    error = input.streamErrorMessage?.(err) ?? (err instanceof Error ? err.message : "Stream error")
    input.publishGlobal(withDir(scope, sessionError(error, input.sessionId)))
  } finally {
    try {
      const returned = iterator.return?.()
      if (returned) await Promise.resolve(returned).catch(() => {})
      if (turn) messages = await input.runtime.events.list(input.sessionId, input.directory)
    } finally {
      activeTurn?.dispose?.()
    }
  }

  if (!turn) throw new Error(error ?? "Failed to start runtime turn")

  return {
    sessionId: input.sessionId,
    prompt: turn.prompt,
    scope,
    assistantId,
    assistantMessagePublished,
    ...(error ? { error } : {}),
    messages,
  }
}

export async function runSessionPromptTurn(input: SessionPromptTurnInput): Promise<SessionPromptTurnResult> {
  const { binding, prompt: promptInput } = input.admitted
  const scope = compatScope(input.directory, input.sessionId)

  let assistantId = promptInput.assistantMessageId ?? mkAssistantId(promptInput.userMessageId)
  let error: string | undefined
  const events = createPromptEventProjection({
    sessionId: input.sessionId,
    directory: scope,
    prompt: promptInput,
  })
  const activeTurn = input.createActiveTurnScope?.({
    adapter: input.adapter,
    directory: input.directory,
    sessionId: input.sessionId,
  })
  let assistantMessagePublished = false
  try {
    for await (const item of sendMessageWithAbort(input.adapter, binding, promptInput, activeTurn?.signal)) {
      if (input.turnAdmission && !input.turnAdmission.valid()) break
      for (const event of events.events(item)) {
        if (input.turnAdmission && !input.turnAdmission.valid()) break
        input.publishStatus({ type: "process.status", directory: scope, configId: input.sessionId, status: "streaming" })
        input.publishGlobal(withDir(scope, event))
        if (event.type === "message.updated" && event.properties.info.role === "assistant") {
          assistantId = event.properties.info.id
          assistantMessagePublished = true
        }
        if (event.type === "session.error") error = failure(event.properties.error)
      }
      assistantId = events.assistantId()
    }
  } catch (err) {
    if (!input.turnAdmission || input.turnAdmission.valid()) {
      error = input.streamErrorMessage?.(err) ?? (err instanceof Error ? err.message : "Stream error")
      input.publishGlobal(withDir(scope, sessionError(error, input.sessionId)))
    }
  } finally {
    activeTurn?.dispose?.()
  }

  return {
    sessionId: input.sessionId,
    prompt: promptInput,
    scope,
    assistantId,
    assistantMessagePublished,
    ...(error ? { error } : {}),
    messages: await input.adapter.getMessages(binding),
  }
}

export function sessionPromptReply(input: SessionPromptTurnResult): {
  body: unknown
  assistantMessage?: AgentMessage["info"]
} {
  const final = reply(input.messages, input.assistantId)
  if (final) {
    return {
      body: final,
      ...(!input.assistantMessagePublished && final.info.role === "assistant"
        ? { assistantMessage: final.info }
        : {}),
    }
  }
  const info = buildAssistantMessage({
    id: input.assistantId,
    sessionID: input.sessionId,
    parentID: input.prompt.userMessageId ?? input.assistantId,
    agent: input.prompt.agent,
    model: input.prompt.model,
    directory: input.scope,
    completed: Date.now(),
    ...(input.error
      ? {
          error: {
            name: "UnknownError" as const,
            data: firstTurnErrorData(input.error),
          },
        }
      : {}),
    ...(input.prompt.variant ? { variant: input.prompt.variant } : {}),
  })
  return {
    body: {
      info,
      parts: [],
    },
    ...(!input.assistantMessagePublished ? { assistantMessage: info } : {}),
  }
}
