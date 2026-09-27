import type { AgentMessage, PromptDelivery, PromptDeliveryRequest, PromptInput, RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"
import { assistantMessageIdForTurn } from "@claxedo/agent-runtime-contract"
import { createClientPresentationProjection } from "@claxedo/agent-event-runtime/projections/client-presentation"
import { firstTurnErrorData, type AgentRuntimeStreamEvent, type RuntimeDirectory } from "@claxedo/agent-sdk-runtime"
import type { TurnOrigin } from "@claxedo/harness/contract"
import { isAgentRuntimeTurnAdmissionError, type AgentRuntime, type AgentRuntimeTurnStartInput } from "../host/runtime"
import {
  buildAssistantMessage,
  sessionError,
  withDir,
  type CompatEnvelope,
  type CompatEvent,
} from "../compat-events"
import { arr, bool, rec, str } from "../json-value"

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
  /** `null` asks for the harness's default effort, overriding a level the session saved. */
  variant?: string | null
  serviceTier?: string
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
 * number reached the harness believing it held a string. This narrows each
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
    variant: body.variant === null ? null : str(body.variant),
    serviceTier: str(body.serviceTier),
    permissionMode: str(body.permissionMode),
    delivery: promptDelivery(body.delivery),
  }
}

function promptDelivery(input: unknown): PromptDeliveryRequest | undefined {
  return input === "steer" || input === "queue" ? input : undefined
}

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

export type RuntimePromptTurnInput = {
  runtime: AgentRuntime
  sessionId: string
  directory: RuntimeDirectory
  body: SessionPromptBody
  origin: TurnOrigin
  publishGlobal: (event: CompatEnvelope) => void
  activeTurn?: ActiveTurnScope
  createActiveTurnScope?: () => ActiveTurnScope | undefined
  streamErrorMessage?: (error: unknown) => string
  onAdmissionSettled?: (error?: unknown) => void
  onSteeringResult?: (result: NonNullable<Awaited<ReturnType<AgentRuntime["turns"]["start"]>>["steering"]>) => void
  onDelivery?: PromptDeliveryObserver
  /**
   * The admitted turn's recovery identity, the moment admission returns it.
   * The lease owner needs it before it can contain a turn whose authority was
   * revoked, and it is the only place this host learns it.
   */
  onTurnTarget?: (target: RecoveryTurnTarget) => void
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

export function compatScope(directory: RuntimeDirectory, sessionId: string) {
  return directory ?? sessionId
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
    // upsert only reaches subscribers when that store emits it.
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
  const subscribe = () => input.runtime.events.subscribe({ sessionId: input.sessionId })[Symbol.asyncIterator]()
  const iterator = subscribe()
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
      origin: input.origin,
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
      ...(input.body.serviceTier ? { serviceTier: input.body.serviceTier } : {}),
      ...(input.body.delivery ? { delivery: input.body.delivery } : {}),
      ...(input.author ? { author: input.author } : {}),
      ...(input.turnAdmission ? { admission: input.turnAdmission } : {}),
    } satisfies Omit<AgentRuntimeTurnStartInput, "actorId" | "actorKind">
    const parts = input.body.parts ?? []
    const start = (delivery = input.body.delivery) => input.actor
      ? input.runtime.turns.start({ ...turnInput, parts, delivery, actorId: input.actor.actorId, actorKind: input.actor.actorKind })
      : input.runtime.turns.start({ ...turnInput, parts, delivery })
    turn = await start()
    if (turn.target) input.onTurnTarget?.(turn.target)
    if (turn.steering) input.onSteeringResult?.(turn.steering)
    input.onDelivery?.(turn.delivery)
    settleAdmission()
    assistantId = turn.assistantMessageId
    // Acceptance transfers input to the provider. Its transcript evidence is
    // published independently through the runtime hub.
    if (turn.delivery === "steer" || turn.delivery === "queue") {
      return {
        sessionId: input.sessionId,
        prompt: turn.prompt,
        scope,
        assistantId,
        assistantMessagePublished: false,
        messages: await input.runtime.events.list(input.sessionId, input.directory),
      }
    }
    const projection = createPromptEventProjection({ sessionId: input.sessionId, directory: scope, prompt: turn.prompt })
    while (true) {
      const result = await nextWithAbort(iterator, activeTurn?.signal)
      if (result.done) break
      const item = result.value
      if (input.turnAdmission && !input.turnAdmission.valid()) break
      for (const event of projection.events(item.payload)) {
        if (input.turnAdmission && !input.turnAdmission.valid()) break
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
    if (isAgentRuntimeTurnAdmissionError(err)) throw err
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
    body: { info, parts: [] },
    ...(!input.assistantMessagePublished ? { assistantMessage: info } : {}),
  }
}
