import { createOpencodeCompatProjection } from "@claxedo/agent-event-runtime/projections/opencode-compat"
import type { Message } from "@opencode-ai/sdk/v2"
import type {
  AgentMessageRow,
  AgentRuntime,
  AgentRuntimeStreamEvent,
  PromptInput,
  RuntimeDirectory,
  SessionConfig,
} from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import {
  buildAssistantMessage,
  messageUpdated,
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
}

export type SessionPromptTurnResult = {
  sessionId: string
  prompt: PromptInput
  scope: string
  assistantId: string
  assistantMessagePublished: boolean
  error?: string
  messages: AgentMessageRow[]
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
  streamErrorMessage?: (error: unknown) => string
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

function rec(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

export function compatScope(directory: RuntimeDirectory, sessionId: string) {
  return directory ?? sessionId
}

function prompt(body: SessionPromptBody, config?: SessionConfig): PromptInput {
  // Always assign a userMessageId so adapters publish a `message.updated`
  // event for the user prompt. Without this, reload-resume can lose user input.
  const userMessageId = body.messageID ?? mkUserMessageId()
  return {
    parts: body.parts ?? [],
    userMessageId,
    assistantMessageId: mkAssistantId(userMessageId),
    agent: body.agent ?? config?.agent ?? "build",
    model: {
      providerID: body.model?.providerID ?? config?.model?.providerID ?? "anthropic",
      modelID: body.model?.modelID ?? config?.model?.modelID ?? "claude-sonnet-4-6",
    },
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.format ? { format: body.format } : {}),
    ...(body.system ? { system: body.system } : {}),
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
  try {
    turn = await input.runtime.turns.start({
      sessionId: input.sessionId,
      parts: input.body.parts ?? [],
      ...(input.body.messageID ? { messageId: input.body.messageID } : {}),
      ...(input.body.agent ? { agent: input.body.agent } : {}),
      ...(input.body.model?.providerID && input.body.model.modelID
        ? { model: { providerID: input.body.model.providerID, modelID: input.body.model.modelID } }
        : {}),
      ...(input.body.tools ? { tools: input.body.tools } : {}),
      ...(input.body.format ? { format: input.body.format } : {}),
      ...(input.body.system ? { system: input.body.system } : {}),
      ...(input.body.variant !== undefined ? { variant: input.body.variant } : {}),
    })
    assistantId = turn.assistantMessageId
    const projection = createPromptEventProjection({
      sessionId: input.sessionId,
      directory: scope,
      prompt: turn.prompt,
    })
    while (true) {
      const result = await nextWithAbort(iterator, input.activeTurn?.signal)
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
    error = input.streamErrorMessage?.(err) ?? (err instanceof Error ? err.message : "Stream error")
    input.publishGlobal(withDir(scope, sessionError(error, input.sessionId)))
  } finally {
    input.activeTurn?.dispose?.()
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
            data: { message: input.error },
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
