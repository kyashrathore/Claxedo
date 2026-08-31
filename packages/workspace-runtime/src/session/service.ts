import { createOpencodeCompatProjection } from "@claxedo/agent-event-runtime/projections/opencode-compat"
import { defaultSessionModel, firstTurnErrorData, isAgentRuntimeTurnConflictError } from "@claxedo/agent-sdk-runtime"
import type { Message } from "@opencode-ai/sdk/v2"
import type {
  AgentMessage,
  AgentRuntime,
  AgentRuntimeStreamEvent,
  AgentRuntimeTurnStartInput,
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

export type RuntimeSessionBusEvent =
  | { type: "process.status"; directory: string; configId: string; status: string }

export type ActiveTurnScope = {
  signal?: AbortSignal
  dispose?: () => void
}

export type SessionPromptBody = {
  parts?: unknown[]
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

export type SessionPromptTurnInput = {
  adapter: AgentHarnessAdapter
  sessionId: string
  directory: RuntimeDirectory
  body: SessionPromptBody
  publishGlobal: (event: CompatEnvelope) => void
  publishStatus: (event: RuntimeSessionBusEvent) => void
  createActiveTurnScope?: (input: {
    adapter: AgentHarnessAdapter
    directory: RuntimeDirectory
    sessionId: string
  }) => ActiveTurnScope | undefined
  publishUserMessage?: boolean
  streamErrorMessage?: (error: unknown) => string
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
  actor?: { actorId: string; actorKind: "human" | "agent" }
  author?: {
    id: string
    name: string
    avatarUrl?: string
    kind: "human" | "agent"
  }
}

function mkAssistantId(userMessageId?: string) {
  if (userMessageId) return userMessageId + "_r"
  const ts = Date.now().toString(16)
  const rand = Math.random().toString(36).slice(2, 10)
  return `msg_${ts}${rand}`
}

function mkUserMessageId() {
  const ts = Date.now().toString(16)
  const rand = Math.random().toString(36).slice(2, 10)
  return `msg_${ts}${rand}u`
}

function replacementAbortError() {
  return new Error("Active turn aborted because the harness was replaced")
}

function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal | undefined) {
  if (!signal) return iterator.next()
  if (signal.aborted) return Promise.reject(replacementAbortError())
  let cleanup = () => {}
  const aborted = new Promise<IteratorResult<T>>((_, reject) => {
    const abort = () => reject(replacementAbortError())
    signal.addEventListener("abort", abort, { once: true })
    cleanup = () => signal.removeEventListener("abort", abort)
  })
  return Promise.race([iterator.next(), aborted]).finally(cleanup)
}

async function* sendMessageWithAbort(
  adapter: AgentHarnessAdapter,
  id: string,
  input: PromptInput,
  directory: RuntimeDirectory,
  signal: AbortSignal | undefined,
) {
  const iterator = adapter.sendMessage(id, input, directory)[Symbol.asyncIterator]()
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

function prompt(body: SessionPromptBody, config?: SessionConfig): PromptInput {
  // Always assign a userMessageId so adapters publish a `message.updated`
  // event for the user prompt. Without this, reload-resume can lose user input.
  const userMessageId = body.messageID ?? mkUserMessageId()
  // ACP owns its model default unless the user or live session config selected
  // one. Sending the native compatibility default here makes a generic ACP
  // adapter restart under an unrelated Claude model before the first prompt.
  const defaultModel = config
    ? defaultSessionModel(config.harness)
    : { providerID: "anthropic", modelID: "claude-sonnet-4-6" }
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
    ...(body.system ? { system: body.system } : {}),
    ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
    ...(body.variant !== undefined ? { variant: body.variant } : config?.variant ? { variant: config.variant } : {}),
  }
}

async function promptForSession(
  adapter: AgentHarnessAdapter,
  sessionId: string,
  directory: RuntimeDirectory,
  body: SessionPromptBody,
) {
  if (body.agent && body.model?.providerID && body.model?.modelID && body.variant !== undefined) return prompt(body)
  return prompt(body, await adapter.getSessionConfig(sessionId, directory).catch(() => undefined))
}

function isMessage(input: unknown): input is { info: { id: string; role: string }; parts: unknown[] } {
  if (!input || typeof input !== "object") return false
  const info = (input as { info?: unknown }).info
  return !!info && typeof info === "object" && typeof (info as { id?: unknown }).id === "string"
    && typeof (info as { role?: unknown }).role === "string"
}

function failure(input: unknown): string {
  if (!input || typeof input !== "object") return "session error"
  const data = (input as { data?: unknown }).data
  if (!data || typeof data !== "object") return "session error"
  return typeof (data as { message?: unknown }).message === "string"
    ? (data as { message: string }).message
    : "session error"
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
  const projection = createOpencodeCompatProjection({
    sessionId: input.sessionId,
    directory: input.directory,
    assistantMessageId: assistantId,
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
  const stream = input.runtime.events.subscribe({ sessionId: input.sessionId })
  const iterator = stream[Symbol.asyncIterator]()
  const scope = compatScope(input.directory, input.sessionId)
  let turn: Awaited<ReturnType<RuntimePromptTurnInput["runtime"]["turns"]["start"]>> | undefined
  let assistantId = ""
  let assistantMessagePublished = false
  let error: string | undefined
  let activeTurn = input.activeTurn
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
      parts: input.body.parts ?? [],
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
      ...(input.author ? { author: input.author } : {}),
    } satisfies Omit<AgentRuntimeTurnStartInput, "actorId" | "actorKind">
    turn = await (input.actor
      ? input.runtime.turns.start({
          ...turnInput,
          actorId: input.actor.actorId,
          actorKind: input.actor.actorKind,
        })
      : input.runtime.turns.start(turnInput))
    settleAdmission()
    assistantId = turn.assistantMessageId
    const projection = createPromptEventProjection({
      sessionId: input.sessionId,
      directory: scope,
      prompt: turn.prompt,
    })
    while (true) {
      const result = await nextWithAbort(iterator, activeTurn?.signal)
      if (result.done) break
      const item = result.value
      for (const event of projection.events(item.payload)) {
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
    activeTurn?.dispose?.()
    const returned = iterator.return?.()
    if (returned) await Promise.resolve(returned).catch(() => {})
  }

  if (!turn) throw new Error(error ?? "Failed to start runtime turn")

  return {
    sessionId: input.sessionId,
    prompt: turn.prompt,
    scope,
    assistantId,
    assistantMessagePublished,
    ...(error ? { error } : {}),
    messages: await input.runtime.events.list(input.sessionId, input.directory),
  }
}

export async function runSessionPromptTurn(input: SessionPromptTurnInput): Promise<SessionPromptTurnResult> {
  const promptInput = await promptForSession(input.adapter, input.sessionId, input.directory, input.body)
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
    for await (const item of sendMessageWithAbort(input.adapter, input.sessionId, promptInput, input.directory, activeTurn?.signal)) {
      for (const event of events.events(item)) {
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
    error = input.streamErrorMessage?.(err) ?? (err instanceof Error ? err.message : "Stream error")
    input.publishGlobal(withDir(scope, sessionError(error, input.sessionId)))
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
    messages: await input.adapter.getMessages(input.sessionId, input.directory),
  }
}

export function sessionPromptReply(input: SessionPromptTurnResult): {
  body: unknown
  assistantMessage?: Message
} {
  const final = reply(input.messages, input.assistantId)
  if (final) {
    return {
      body: final,
      ...(!input.assistantMessagePublished && final.info.role === "assistant"
        ? { assistantMessage: final.info as Message }
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
