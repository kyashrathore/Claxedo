import { randomUUID } from "crypto"
import type { AgentEventRuntime, RawHarnessEvent } from "@claxedo/agent-event-runtime"
import {
  buildAssistantMessage,
  buildUserMessage,
  isTerminalCompatEvent,
  messageUpdated,
  permissionReplied,
  questionRejected,
  questionReplied,
  sessionError,
  sessionStatus,
  sessionUpdated,
  type CompatEvent,
} from "../../compat-events"
import { listCommands } from "../../command-discovery"
import { Log } from "../../log"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import type { NativeSdkHarnessId } from "../../sdk-model-catalog"
import type {
  AgentCommandRow,
  AgentConfigOptionRow,
  AgentMessageRow,
  AgentPermissionRow,
  AgentQuestionRow,
  AgentRuntimeStreamEvent,
  AgentSessionRow,
  PromptInput,
  SessionConfig,
  SessionConfigUpdate,
} from "../../index"
import type {
  AbortResult,
  AgentHarnessAdapter,
  AgentHarnessAdapterHealth,
  AgentInteractionResult,
  AgentHarnessAdapterProcessOptions,
} from "../../adapter-contract"
import { harnessCapabilities, type HarnessCapabilities } from "../../capabilities"
import { createTurnEventProjector, type RuntimeAppendSource } from "../shared/turn-projection"
import { createSessionTurnLifecycle, type SessionTurnLifecycle } from "../shared/turn-lifecycle"
import type { AgentRuntimeStore } from "../shared/runtime-store"
import { hasConcreteSessionTitle } from "../../session-title"
import { requireWorkspaceDirectory } from "../../target"
import { firstTurnErrorData } from "../../first-turn-error"
import type { AgentProcessObserver } from "../../process-observer"

export type SdkRuntimeRunnerType = NativeSdkHarnessId
export type SdkRuntimeStore = AgentRuntimeStore

export type SdkRuntimeAdapterOptions = AgentHarnessAdapterProcessOptions & {
  driver: SdkRuntimeDriverFactory
  binary?: string
  storeRoot?: string
  store?: SdkRuntimeStore
  createStore?: (storeRoot?: string) => SdkRuntimeStore
  eventHub?: RuntimeEventHub
}

export type JsonRecord = Record<string, unknown>
export type PendingPermission = {
  sessionId: string
  agentSessionId: string
  method: string
  params: JsonRecord
  resolve: (decision: "allow_once" | "allow_always" | "deny" | "reject_always") => void
}
export type PendingQuestion = {
  sessionId: string
  agentSessionId: string
  questions: unknown[]
  resolve: (answer: string) => void
  reject: () => void
}
export type ActiveTurn = {
  abort: AbortController
  close?: () => void
  turnId?: string
}

export type SdkRuntimeAuth = { anthropic?: string; openai?: string; cursor?: string }
export type SdkRuntimeDriverHost = {
  lifecycle: () => SessionTurnLifecycle<ActiveTurn>
  pendingPermissions: Map<string, PendingPermission>
  pendingQuestions: Map<string, PendingQuestion>
  processObserver?: AgentProcessObserver
  bindSession(input: { sessionId: string; directory: string; title?: string; agentSessionId: string }): void
}
export type SdkRuntimeTurnInput = {
  sessionId: string
  getAgentSessionId: () => string
  input: PromptInput
  directory: string
  abort: AbortController
  ingest: (raw: RawHarnessEvent, source: RuntimeAppendSource) => void
  rebindAgentSession: (agentSessionId: string) => void
  model: string
}
export type SdkRuntimeDriver = {
  readonly type: SdkRuntimeRunnerType
  setAuth(keys: SdkRuntimeAuth): void
  applyConfig(config: Record<string, unknown>): void
  createAgentSession(input: { directory: string; title?: string; model: string }): Promise<string>
  createRuntime(threadId: string): AgentEventRuntime
  runTurn(input: SdkRuntimeTurnInput): Promise<void>
  deleteAgentSession?(sessionId: string, agentSessionId: string): void
  dispose?(): void
  readRuntimeHealth(directory: string): AgentHarnessAdapterHealth
  configOptions(currentModel: string, directory?: string): Promise<AgentConfigOptionRow[]>
  peekConfigOptions(currentModel: string): AgentConfigOptionRow[]
}
export type SdkRuntimeDriverFactory = (host: SdkRuntimeDriverHost) => SdkRuntimeDriver

const log = Log.create({ service: "sdk-runtime-adapter" })

function missingStore(): SdkRuntimeStore {
  throw new Error("SdkRuntimeAdapter requires a runtime store from the host")
}

export function record(input: unknown): JsonRecord | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as JsonRecord
}

export function text(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  const row = record(err)
  const data = record(row?.data)
  return text(data?.message) ?? text(row?.message) ?? String(err)
}

export function extractTextFromParts(parts: unknown[]) {
  return parts.flatMap((part) => {
    if (typeof part === "string") return [part]
    const row = record(part)
    if (!row) return []
    return text(row.text) ?? text(row.content) ?? []
  }).join("\n").trim()
}

function fallbackSessionTitle(input: string) {
  const cleaned = input.replace(/\s+/g, " ").trim()
  if (/^(hi|hello|hey|yo|greetings)[!. ]*$/i.test(cleaned)) return "Greeting"
  const source = cleaned.replace(/^(please|can you|could you|would you)\s+/i, "").trim() || cleaned
  return source.length > 72 ? source.slice(0, 72).trimEnd() + "..." : source
}

export class SdkRuntimeAdapter implements AgentHarnessAdapter {
  readonly adapterCapabilities = ["runtime-config"] as const
  readonly commitsStreamEvents = true
  private store: SdkRuntimeStore
  private ownsStore = false
  private storeClosed = false
  private currentModel = ""
  private driver: SdkRuntimeDriver
  private turnLifecycle = createSessionTurnLifecycle<ActiveTurn>()
  private pendingPermissions = new Map<string, PendingPermission>()
  private pendingQuestions = new Map<string, PendingQuestion>()

  constructor(private readonly options: SdkRuntimeAdapterOptions) {
    this.store = options.store ?? options.createStore?.(options.storeRoot) ?? missingStore()
    this.ownsStore = !options.store
    this.driver = options.driver({
      lifecycle: () => this.lifecycle(),
      pendingPermissions: this.pendingPermissions,
      pendingQuestions: this.pendingQuestions,
      processObserver: options.processObserver,
      bindSession: (input) => this.store.bindSession(input),
    })
  }

  private lifecycle(): SessionTurnLifecycle<ActiveTurn> {
    this.turnLifecycle ??= createSessionTurnLifecycle<ActiveTurn>()
    return this.turnLifecycle
  }

  setModel(model: string) {
    this.currentModel = model
  }

  setAuth(keys: { anthropic?: string; openai?: string; cursor?: string }) {
    this.driver.setAuth(keys)
  }

  readHarnessCapabilities(): HarnessCapabilities {
    return harnessCapabilities({
      harness: this.driver.type,
      abort: true,
      reconnect: false,
      replay: true,
      permissions: true,
      questions: true,
      todos: true,
      commands: false,
      fork: false,
      revert: false,
      unrevert: false,
      configOptions: true,
    })
  }

  async listSessions(directory: string): Promise<AgentSessionRow[]> {
    directory = requireWorkspaceDirectory(directory)
    return this.store.listSessions(directory) as AgentSessionRow[]
  }

  async getSession(id: string, _directory: string): Promise<AgentSessionRow | null> {
    return this.store.getSession(id) as AgentSessionRow | null
  }

  async createSession(directory: string, title?: string): Promise<{ id: string }> {
    directory = requireWorkspaceDirectory(directory)
    const sessionId = randomUUID()
    const agentSessionId = await this.driver.createAgentSession({
      directory,
      title,
      model: this.currentModel,
    })
    this.store.bindSession({
      sessionId,
      directory,
      title,
      agentSessionId,
    })
    this.store.updateSessionConfig(sessionId, {
      harness: {
        id: this.driver.type,
        access: "native",
        ...(this.options.binary ? { connection: { kind: "process" as const, binary: this.options.binary } } : {}),
      },
      ...(this.currentModel ? { model: { providerID: this.driver.type, modelID: this.currentModel } } : {}),
      variant: null,
      agent: null,
    })
    return { id: sessionId }
  }

  async updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, _directory: string): Promise<AgentSessionRow | null> {
    return this.store.updateSession(id, updates) as AgentSessionRow | null
  }

  async getSessionConfig(id: string, _directory: string): Promise<SessionConfig> {
    return this.store.getSessionConfig(id) ?? {
      harness: {
        id: this.driver.type,
        access: "native",
        ...(this.options.binary ? { connection: { kind: "process" as const, binary: this.options.binary } } : {}),
      },
      ...(this.currentModel ? { model: { providerID: this.driver.type, modelID: this.currentModel } } : {}),
      variant: null,
      agent: null,
    }
  }

  async updateSessionConfig(id: string, update: SessionConfigUpdate, directory: string): Promise<SessionConfig> {
    directory = requireWorkspaceDirectory(directory)
    return this.store.updateSessionConfig(id, update) ?? await this.getSessionConfig(id, directory)
  }

  async deleteSession(id: string, _directory: string): Promise<void> {
    const agentSessionId = this.store.getAgentSessionId(id)
    if (agentSessionId) this.driver.deleteAgentSession?.(id, agentSessionId)
    this.store.deleteSession(id)
  }

  async *sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<AgentRuntimeStreamEvent> {
    directory = requireWorkspaceDirectory(directory)
    const leaveBusy = this.lifecycle().enter(id)
    if (!leaveBusy) {
      yield sessionError("Session is already processing a message", id)
      return
    }
    try {
      yield* this._sendMessage(id, input, directory)
    } finally {
      leaveBusy()
    }
  }

  private async *_sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<AgentRuntimeStreamEvent> {
    const current = this.store.getAgentSessionId(id)
    if (!current) {
      yield sessionError(`Session ${id} not found`, id)
      return
    }
    let agentSessionId = current
    const created = Date.now()
    const start = [
      sessionStatus(id, { type: "busy" }),
      ...(input.userMessageId
        ? [messageUpdated(buildUserMessage({
            id: input.userMessageId,
            sessionID: id,
            agent: input.agent,
            model: input.model,
            ...(input.tools ? { tools: input.tools } : {}),
            ...(input.format ? { format: input.format } : {}),
            ...(input.system ? { system: input.system } : {}),
            ...(input.variant ? { variant: input.variant } : {}),
          }))]
        : []),
      messageUpdated(buildAssistantMessage({
        id: input.assistantMessageId,
        sessionID: id,
        parentID: input.userMessageId ?? id,
        agent: input.agent,
        model: input.model,
        directory,
        created,
      })),
    ]
    const committedStart = this.store.startTurn({
      sessionId: id,
      agentSessionId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      agent: input.agent,
      model: input.model,
      parts: input.parts,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.format ? { format: input.format } : {}),
      ...(input.system ? { system: input.system } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
    })

    const runtime = this.driver.createRuntime(agentSessionId)
    const queue: CompatEvent[] = [...(committedStart?.events ?? start)]
    const resolvers: Array<() => void> = []
    let promptDone = false
    let promptError: string | null = null
    const abort = new AbortController()

    const push = (event: CompatEvent) => {
      queue.push(event)
      for (const resolve of resolvers.splice(0)) resolve()
    }
    const wait = () => new Promise<void>((resolve) => {
      if (queue.length > 0 || promptDone) resolve()
      else resolvers.push(resolve)
    })
    const projector = createTurnEventProjector({
      store: this.store,
      sessionId: id,
      getAgentSessionId: () => agentSessionId,
      directory,
      input,
      assistantMessageId: input.assistantMessageId,
      created,
      onEvent: push,
      onRuntimeEvent: this.options.eventHub?.publishRuntime,
    })
    const ingest = (raw: RawHarnessEvent, source: RuntimeAppendSource) => {
      const result = runtime.ingest(raw)
      for (const runtimeEvent of result.events) projector.project(runtimeEvent, source)
    }
    const rebindAgentSession = (sdkSessionId: string) => {
      if (!sdkSessionId || sdkSessionId === agentSessionId) return
      agentSessionId = sdkSessionId
      this.store.bindSession({
        sessionId: id,
        directory,
        agentSessionId,
      })
    }

    this.lifecycle().set(id, { abort })
    const run = this.driver.runTurn({
      sessionId: id,
      getAgentSessionId: () => agentSessionId,
      input,
      directory,
      abort,
      ingest,
      rebindAgentSession,
      model: this.currentModel,
    })
      .catch((err: unknown) => {
        promptError = errorMessage(err)
      })
      .finally(() => {
        promptDone = true
        this.lifecycle().delete(id)
        for (const resolve of resolvers.splice(0)) resolve()
      })

    let titleEmitted = false
    try {
      while (true) {
        await wait()
        let event: CompatEvent | undefined
        while ((event = queue.shift())) {
          if (event.type === "session.idle" && !titleEmitted) {
            titleEmitted = true
            const titleEvent = this.maybeAutoTitle(id, agentSessionId, directory, input.parts)
            if (titleEvent) yield titleEvent
          }
          yield event
          if (isTerminalCompatEvent(event)) {
            promptDone = true
            break
          }
        }
        if (promptDone) break
      }
    } finally {
      await run
    }

    if (!promptError) return
    for (const event of projector.terminalizeOpenTools(promptError, { dir: "in", method: "prompt.error.open-tools", frame: { message: promptError } })) yield event
    const updated = messageUpdated(buildAssistantMessage({
      id: projector.assistantMessageId(),
      sessionID: id,
      parentID: input.userMessageId ?? id,
      agent: input.agent,
      model: input.model,
      directory,
      created: projector.created(),
      completed: Date.now(),
      error: { name: "UnknownError", data: firstTurnErrorData(promptError) },
      variant: input.variant,
    }))
    this.store.appendEvent({
      sessionId: id,
      agentSessionId,
      payload: updated,
      source: { dir: "in", method: "prompt.error", frame: { message: promptError } },
    })
    yield updated
    const error = sessionError(promptError, id)
    this.store.appendEvent({
      sessionId: id,
      agentSessionId,
      payload: error,
      source: { dir: "in", method: "prompt.error", frame: { message: promptError } },
    })
    yield error
  }

  async getMessages(id: string, _directory: string): Promise<AgentMessageRow[]> {
    return this.store.getMessages(id) as AgentMessageRow[]
  }

  async abort(id: string, _directory: string): Promise<AbortResult> {
    if (!this.lifecycle().abort(id)) return { ok: true, status: "already_idle" }
    this.resolvePendingPermissions(id, "deny")
    return { ok: true, status: "cancelled" }
  }

  async listCommands(_directory: string): Promise<AgentCommandRow[]> {
    return listCommands()
  }

  async getTodos(sessionId: string, _directory: string): Promise<Array<{ content: string; status: string; priority: string }>> {
    return this.store.getTodos(sessionId)
  }

  async listPermissions(directory: string): Promise<AgentPermissionRow[]> {
    directory = requireWorkspaceDirectory(directory)
    const live = new Set(this.pendingPermissions.keys())
    return this.store.listPermissions(directory).filter((row) => {
      if (live.has(row.id)) return true
      return false
    }) as AgentPermissionRow[]
  }

  async respondPermission(
    permId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
    directory: string,
  ): Promise<AgentInteractionResult | void> {
    directory = requireWorkspaceDirectory(directory)
    const row = (this.store.listPermissions(directory) as Array<{ id: string; sessionID: string }>).find((item) => item.id === permId)
    const pending = this.pendingPermissions.get(permId)
    const events: CompatEvent[] = []
    if (row) {
      const committed = this.store.appendEvent({
        sessionId: row.sessionID,
        agentSessionId: pending?.agentSessionId,
        payload: permissionReplied(
          row.sessionID,
          permId,
          decision === "allow_always" ? "always" : decision === "allow_once" ? "once" : "reject",
        ),
        source: { dir: "out", method: "permission.reply", frame: { decision } },
      })
      if (committed?.payload) events.push(committed.payload)
    }
    if (!pending) return
    this.pendingPermissions.delete(permId)
    pending.resolve(decision)
    return events.length > 0 ? { events } : undefined
  }

  async listQuestions(directory: string): Promise<AgentQuestionRow[]> {
    directory = requireWorkspaceDirectory(directory)
    const live = new Set(this.pendingQuestions.keys())
    return this.store.listQuestions(directory).filter((row) => live.has(row.id)) as AgentQuestionRow[]
  }

  async replyQuestion(qId: string, answer: string, _directory: string): Promise<AgentInteractionResult | void> {
    const pending = this.pendingQuestions.get(qId)
    if (!pending) return
    this.pendingQuestions.delete(qId)
    const committed = this.store.appendEvent({
      sessionId: pending.sessionId,
      agentSessionId: pending.agentSessionId,
      payload: questionReplied(pending.sessionId, qId, [[answer]]),
      source: { dir: "out", method: "question.reply", frame: { answer } },
    })
    pending.resolve(answer)
    return committed?.payload ? { events: [committed.payload] } : undefined
  }

  async rejectQuestion(qId: string, _directory: string): Promise<AgentInteractionResult | void> {
    const pending = this.pendingQuestions.get(qId)
    if (!pending) return
    this.pendingQuestions.delete(qId)
    const committed = this.store.appendEvent({
      sessionId: pending.sessionId,
      agentSessionId: pending.agentSessionId,
      payload: questionRejected(pending.sessionId, qId),
      source: { dir: "out", method: "question.reject", frame: {} },
    })
    pending.reject()
    return committed?.payload ? { events: [committed.payload] } : undefined
  }

  async applyConfig(config: Record<string, unknown>): Promise<void> {
    this.driver.applyConfig(config)
  }

  async probeConfigOptions(directory: string): Promise<AgentConfigOptionRow[]> {
    return this.driver.configOptions(this.currentModel, directory)
  }

  peekConfigOptions(_directory: string): AgentConfigOptionRow[] {
    return this.driver.peekConfigOptions(this.currentModel)
  }

  readRuntimeHealth(_directory: string): AgentHarnessAdapterHealth {
    return this.driver.readRuntimeHealth(_directory)
  }

  private closeStore() {
    if (!this.ownsStore || this.storeClosed) return
    this.storeClosed = true
    this.store.close?.()
  }

  dispose(): void {
    this.lifecycle().abortAll()
    this.resolvePendingPermissions()
    for (const item of this.pendingQuestions.values()) item.reject()
    this.pendingQuestions.clear()
    this.driver?.dispose?.()
    this.closeStore()
  }

  private resolvePendingPermissions(sessionId?: string, decision: "deny" | "reject_always" = "deny") {
    for (const [id, item] of [...this.pendingPermissions.entries()]) {
      if (sessionId && item.sessionId !== sessionId) continue
      this.pendingPermissions.delete(id)
      if (item.sessionId && this.store?.appendEvent) {
        this.store.appendEvent({
          sessionId: item.sessionId,
          agentSessionId: item.agentSessionId,
          payload: permissionReplied(item.sessionId, id, "reject"),
          source: { dir: "out", method: "permission.abort", frame: { decision } },
        })
      }
      item.resolve?.(decision)
    }
  }

  private maybeAutoTitle(id: string, agentSessionId: string, directory: string, parts: unknown[]) {
    const session = this.store.getSession(id) as { title?: string | null } | null
    if (hasConcreteSessionTitle(session?.title)) return null
    const text = extractTextFromParts(parts)
    if (!text) return null
    const now = Date.now()
    const event = sessionUpdated({
      id,
      slug: id,
      projectID: "",
      directory,
      title: fallbackSessionTitle(text),
      version: "local",
      time: { created: now, updated: now },
    })
    this.store.appendEvent({
      sessionId: id,
      agentSessionId,
      payload: event,
      source: { dir: "in", method: "auto-title", frame: {} },
    })
    return event
  }

}
