import { randomUUID } from "crypto"
import type {
  AgentEventRuntime,
  RawHarnessEvent,
  SubagentUpdatedEvent,
} from "@claxedo/agent-event-runtime"
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
  AgentPermissionModeState,
} from "../../adapter-contract"
import { harnessCapabilities, type HarnessCapabilities } from "../../capabilities"
import { createTurnEventProjector, type RuntimeAppendSource } from "../shared/turn-projection"
import {
  createChildEventRouter,
  type ChildProjectionTarget,
  type RuntimeEventRoute,
} from "../shared/child-event-routing"
import {
  createSessionTurnLifecycle,
  EXPLICIT_TURN_ABORT_REASON,
  type SessionTurnLifecycle,
} from "../shared/turn-lifecycle"
import type { AgentRuntimeStore } from "../shared/runtime-store"
import { hasConcreteSessionTitle } from "../../session-title"
import { requireWorkspaceDirectory } from "../../target"
import { firstTurnErrorData } from "../../first-turn-error"
import type { AgentProcessObserver } from "../../process-observer"
import {
  createMemorySubagentAdmissionStore,
  createSubagentAdmissionBoundary,
  type SubagentObservation,
} from "../../subagent-admission"

export type SdkRuntimeRunnerType = NativeSdkHarnessId
export type SdkRuntimeStore = AgentRuntimeStore
export type SdkRuntimeTranscriptRegistrar = {
  register(input: {
    parentSessionId: string
    providerKind: string
    filePath: string
  }): Promise<
    | { state: "ready"; handle: string }
    | { state: "unavailable"; reason: string }
  >
  open?(input: {
    parentSessionId: string
    handle: string
  }): Promise<
    | { state: "ready"; messages: unknown[] }
    | { state: "empty"; messages: [] }
    | { state: "unavailable"; reason: string }
  >
}

export type SdkRuntimeAdapterOptions = AgentHarnessAdapterProcessOptions & {
  driver: SdkRuntimeDriverFactory
  binary?: string
  storeRoot?: string
  store?: SdkRuntimeStore
  createStore?: (storeRoot?: string) => SdkRuntimeStore
  eventHub?: RuntimeEventHub
  transcriptRegistrar?: SdkRuntimeTranscriptRegistrar
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
  transcriptRegistrar?: SdkRuntimeTranscriptRegistrar
  bindSession(input: { sessionId: string; directory: string; title?: string; agentSessionId: string }): void
}
export type SdkRuntimeTurnInput = {
  sessionId: string
  getAgentSessionId: () => string
  input: PromptInput
  directory: string
  abort: AbortController
  ingest: (raw: RawHarnessEvent, source: RuntimeAppendSource, route?: RuntimeEventRoute) => void
  associateChild: (correlationKey: string, target: ChildProjectionTarget) => void
  observeSubagent: (input: {
    observation: SubagentObservation
    correlationKeys?: string[]
    source?: RuntimeAppendSource
  }) => Promise<{
    event: SubagentUpdatedEvent
    childSessionId?: string
  }>
  rebindAgentSession: (agentSessionId: string) => void
  model: string
}
export type SdkRuntimeDriver = {
  readonly type: SdkRuntimeRunnerType
  setAuth(keys: SdkRuntimeAuth): void
  applyConfig(config: Record<string, unknown>): void | Promise<void>
  createAgentSession(input: { directory: string; title?: string; model: string; system?: string }): Promise<string>
  createRuntime(threadId: string): AgentEventRuntime
  runTurn(input: SdkRuntimeTurnInput): Promise<void>
  deleteAgentSession(sessionId: string, agentSessionId: string, directory: string): void | Promise<void>
  dispose?(): void
  readRuntimeHealth(directory: string): AgentHarnessAdapterHealth
  configOptions(currentModel: string, directory?: string): Promise<AgentConfigOptionRow[]>
  peekConfigOptions(currentModel: string): AgentConfigOptionRow[]
  /**
   * Optional because a driver without them is a driver whose harness has no
   * permission surface — the adapter then omits the methods entirely, so the
   * route answers "unsupported" instead of an empty list that reads like the
   * harness merely had nothing to say.
   */
  permissionModes?(sessionId: string, directory: string): AgentPermissionModeState
  setPermissionMode?(sessionId: string, modeId: string, directory: string): Promise<AgentPermissionModeState>
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

/**
 * Does this event mean the turn is over?
 *
 * Deliberately the same rule `runtime.ts`'s drain loop uses to decide a turn
 * reached a terminal state — compat events settle on `session.idle` /
 * `session.error`, native runtime events on `finish` / `error` / a
 * `session-status` of `error`. Duplicated rather than shared because the two
 * live on opposite sides of the adapter boundary and importing across it to
 * save four lines would be a worse trade than the drift risk; if a third caller
 * appears, promote it.
 */
function isTurnTerminalEvent(event: AgentRuntimeStreamEvent) {
  if ("properties" in event) return event.type === "session.idle" || event.type === "session.error"
  return event.type === "finish" || event.type === "error" || (event.type === "session-status" && event.status === "error")
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
  private subagentAdmissionStore = createMemorySubagentAdmissionStore()
  private subagentChildren = new Map<string, {
    sessionId: string
    agentSessionId: string
    target: ChildProjectionTarget
  }>()
  private hydratedFileTranscripts = new Set<string>()
  private subagentChildByCorrelation = new Map<string, string>()

  constructor(private readonly options: SdkRuntimeAdapterOptions) {
    this.store = options.store ?? options.createStore?.(options.storeRoot) ?? missingStore()
    this.ownsStore = !options.store
    this.driver = options.driver({
      lifecycle: () => this.lifecycle(),
      pendingPermissions: this.pendingPermissions,
      pendingQuestions: this.pendingQuestions,
      processObserver: options.processObserver,
      transcriptRegistrar: options.transcriptRegistrar,
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
      subagents: true,
    })
  }

  async listSessions(directory: string): Promise<AgentSessionRow[]> {
    directory = requireWorkspaceDirectory(directory)
    return this.store.listSessions(directory) as AgentSessionRow[]
  }

  async getSession(id: string, _directory: string): Promise<AgentSessionRow | null> {
    return this.store.getSession(id) as AgentSessionRow | null
  }

  async createSession(directory: string, title?: string, sessionId: string = randomUUID()): Promise<{ id: string }> {
    directory = requireWorkspaceDirectory(directory)
    if (this.store.getSession(sessionId)) return { id: sessionId }
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

  async createHandoffSession(directory: string, title: string | undefined, sessionId: string, options: { system: string }) {
    directory = requireWorkspaceDirectory(directory)
    const agentSessionId = await this.driver.createAgentSession({ directory, title, model: this.currentModel, system: options.system })
    this.store.bindSession({ sessionId, directory, title, agentSessionId })
    let rolledBack = false
    return {
      id: sessionId,
      agentSessionId,
      ownerKey: null,
      rollback: async () => {
        if (rolledBack) return
        await this.driver.deleteAgentSession(sessionId, agentSessionId, directory)
        rolledBack = true
      },
    }
  }

  async releaseHandoffSource(sessionId: string, agentSessionId: string, _ownerKey: string | null, directory: string) {
    this.lifecycle().abort(sessionId)
    await this.driver.deleteAgentSession(sessionId, agentSessionId, directory)
  }

  async updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, _directory: string): Promise<AgentSessionRow | null> {
    if (updates.time?.archived !== undefined) this.lifecycle().abort(id)
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
    this.lifecycle().abort(id)
    for (const child of this.store.listSubagents?.(id) ?? []) {
      const childSessionId = (child as { childSessionId?: string }).childSessionId
      if (!childSessionId) continue
      const agentSessionId = this.store.getAgentSessionId(childSessionId)
      if (agentSessionId) await this.driver.deleteAgentSession(childSessionId, agentSessionId, _directory)
    }
    const agentSessionId = this.store.getAgentSessionId(id)
    if (agentSessionId) await this.driver.deleteAgentSession(id, agentSessionId, _directory)
    this.store.deleteSession(id)
  }

  /**
   * Runs one turn, holding the session's busy lock for the turn's LIFETIME —
   * which ends when the turn settles, not when this generator finishes.
   *
   * The lock exists to answer "is a turn in flight on this session"; a second
   * prompt arriving while one is has nowhere to go, so it is refused. But the
   * generator does more than the turn: after the terminal event the consumer
   * (`runtime.ts`'s drain loop) still commits events, fans out to subscribers,
   * and awaits an auto-title round-trip before this `finally` runs. Measured on
   * a failing Tier R run, that tail is ~515ms:
   *
   *   747ms  T1 terminal (session.idle)      2168ms  T2 terminal
   *  1261ms  T1 lock released (+514ms)       2683ms  T3 REFUSED
   *                                          2684ms  T2 lock released (+516ms)
   *
   * T3 missed the release by ONE millisecond and was told "Session is already
   * processing a message" — for a turn that had been over for half a second.
   * That is the bug: a user who sends a second message promptly after a reply
   * lands gets it silently swallowed, with the composer showing ready
   * throughout. It reproduced on every Tier R claude-sdk run and vanished if
   * the next send was delayed ~2.5s, which is what made it look like five
   * different bugs across the layers it was chased through.
   *
   * So the lock is released at TERMINAL EMISSION, the moment the turn is
   * semantically over. The `finally` still releases — `enter`'s closure deletes
   * from a Set, so a second call is a no-op — because a turn that throws or is
   * abandoned before emitting a terminal event must not strand the session.
   */
  async *sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<AgentRuntimeStreamEvent> {
    directory = requireWorkspaceDirectory(directory)
    const leaveBusy = this.lifecycle().enter(id)
    if (!leaveBusy) {
      yield sessionError("Session is already processing a message", id)
      return
    }
    try {
      for await (const event of this._sendMessage(id, input, directory)) {
        // Release BEFORE yielding: the consumer may take arbitrarily long to
        // process this event (the auto-title round-trip is downstream of it),
        // and every millisecond of that is a window a next prompt can lose in.
        if (isTurnTerminalEvent(event)) leaveBusy()
        yield event
      }
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
    if (input.permissionMode) {
      if (!this.driver.setPermissionMode) throw new Error(`${this.driver.type} does not support permission modes`)
      await this.driver.setPermissionMode(id, input.permissionMode, directory)
    }
    const start = [
      sessionStatus(id, { type: "busy" }),
      ...(input.userMessageId
        ? [messageUpdated(buildUserMessage({
            id: input.userMessageId,
            sessionID: id,
            agent: input.agent,
            model: input.model,
            ...(input.author ? { author: input.author } : {}),
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
    const parentProjector = createTurnEventProjector({
      store: this.store,
      owner: {
        sessionId: id,
        getAgentSessionId: () => agentSessionId,
      },
      directory,
      input,
      assistantMessageId: input.assistantMessageId,
      created,
      onEvent: push,
      onRuntimeEvent: this.options.eventHub?.publishRuntime,
    })
    const router = createChildEventRouter({
      parent: parentProjector,
      createChildProjector: (target) => createTurnEventProjector({
        store: this.store,
        owner: {
          sessionId: target.sessionId,
          getAgentSessionId: target.getAgentSessionId,
        },
        directory,
        input: target.input,
        assistantMessageId: target.assistantMessageId,
        created: target.created,
        onEvent: () => {},
        onRuntimeEvent: this.options.eventHub?.publishRuntime,
      }),
      onDiagnostic: (payload) => this.options.eventHub?.publishRuntime({
        directory,
        sessionId: id,
        agentSessionId,
        assistantMessageId: input.assistantMessageId,
        payload,
      }),
    })
    const ingest = (raw: RawHarnessEvent, source: RuntimeAppendSource, route?: RuntimeEventRoute) => {
      const result = runtime.ingest(raw)
      for (const runtimeEvent of result.events) router.project(runtimeEvent, source, route)
    }
    const observeSubagent: SdkRuntimeTurnInput["observeSubagent"] = async (observed) => {
      const fileTranscript = observed.observation.transcript?.kind === "file" && observed.observation.transcript.ref
        ? await this.options.transcriptRegistrar?.open?.({
            parentSessionId: id,
            handle: observed.observation.transcript.ref,
          })
        : undefined
      const admittedObservation = observed.observation.transcript?.kind === "file" &&
          (!fileTranscript || fileTranscript.state === "unavailable")
        ? { ...observed.observation, transcript: { kind: "none" as const } }
        : observed.observation
      const correlationKeys = [...new Set([
        ...(observed.correlationKeys ?? []),
        admittedObservation.stableCorrelationId,
        admittedObservation.providerId,
      ].filter((key): key is string => !!key))]
      const existingChildKey = correlationKeys
        .map((key) => this.subagentChildByCorrelation.get(scopedSubagentKey(id, key)))
        .find((key): key is string => !!key)
      const existingChild = existingChildKey ? this.subagentChildren.get(existingChildKey) : undefined
      const openable = admittedObservation.childSessionId !== undefined ||
        admittedObservation.transcript?.kind === "live" ||
        admittedObservation.transcript?.kind === "messages" ||
        admittedObservation.transcript?.kind === "file" && fileTranscript !== undefined && fileTranscript.state !== "unavailable"
      const childSessionId = admittedObservation.childSessionId ?? existingChild?.sessionId ?? (openable ? randomUUID() : undefined)
      const observation = {
        ...admittedObservation,
        ...(childSessionId ? { childSessionId } : {}),
      }
      const source = observed.source ?? { dir: "in" as const, method: "subagent/updated" }
      const admissionStore = this.store.admit && this.store.markPublished
        ? {
            admit: (input: Parameters<NonNullable<SdkRuntimeStore["admit"]>>[0]) => this.store.admit!(input),
            markPublished: (parentSessionId: string, observationId: string) => this.store.markPublished!(parentSessionId, observationId),
          }
        : this.subagentAdmissionStore
      const event = await createSubagentAdmissionBoundary({
        store: admissionStore,
        publish: (_parentSessionId, payload) => router.project(payload, source),
      }).admit(id, observation)

      if (!childSessionId) return { event }
      const childKey = scopedSubagentKey(id, event.subagentKey)
      const child = this.subagentChildren.get(childKey) ?? existingChild ?? (() => {
        const agentSessionId = observation.providerId ?? `unbound:${childSessionId}`
        const created = Date.now()
        const target = {
          sessionId: childSessionId,
          getAgentSessionId: () => this.subagentChildren.get(childKey)?.agentSessionId ?? agentSessionId,
          assistantMessageId: randomUUID(),
          created,
          input: {
            userMessageId: randomUUID(),
            agent: input.agent,
            model: input.model,
            ...(input.variant ? { variant: input.variant } : {}),
          },
        } satisfies ChildProjectionTarget
        this.store.bindSession({
          sessionId: childSessionId,
          parentSessionId: id,
          directory,
          title: observation.description ?? observation.label ?? "Subagent",
          agentSessionId,
        })
        const parentConfig = this.store.getSessionConfig(id)
        if (parentConfig) this.store.updateSessionConfig(childSessionId, parentConfig)
        this.store.startTurn({
          sessionId: childSessionId,
          agentSessionId,
          userMessageId: target.input.userMessageId,
          assistantMessageId: target.assistantMessageId,
          agent: target.input.agent,
          model: target.input.model,
          parts: observation.description ? [{ type: "text", text: observation.description }] : [],
          ...(target.input.variant ? { variant: target.input.variant } : {}),
        })
        return { sessionId: childSessionId, agentSessionId, target }
      })()
      if (observation.providerId && child.agentSessionId.startsWith("unbound:")) {
        child.agentSessionId = observation.providerId
        this.store.bindSession({
          sessionId: child.sessionId,
          parentSessionId: id,
          directory,
          title: observation.description ?? observation.label ?? "Subagent",
          agentSessionId: child.agentSessionId,
        })
      }
      this.subagentChildren.set(childKey, child)
      for (const correlationKey of correlationKeys) {
        this.subagentChildByCorrelation.set(scopedSubagentKey(id, correlationKey), childKey)
        router.associate(correlationKey, child.target)
      }
      const fileCorrelation = correlationKeys[0] ?? event.subagentKey
      if (fileTranscript && fileTranscript.state !== "unavailable" && !this.hydratedFileTranscripts.has(childKey)) {
        this.hydratedFileTranscripts.add(childKey)
        router.associate(fileCorrelation, child.target)
        const text = transcriptText(fileTranscript.messages)
        if (text) router.project({ type: "text-delta", delta: text }, source, { kind: "child", correlationKey: fileCorrelation })
      }
      if (observation.status === "completed" || observation.status === "failed" || observation.status === "killed" || observation.status === "interrupted") {
        this.store.finishTurn?.({
          sessionId: child.sessionId,
          assistantMessageId: child.target.assistantMessageId,
          outcome: observation.status === "failed"
            ? { status: "failed", completedAt: Date.now(), error: observation.label ?? "Subagent failed" }
            : observation.status === "completed"
              ? { status: "completed", completedAt: Date.now() }
              : { status: "cancelled", completedAt: Date.now(), reason: observation.status },
        })
      }
      return { event, childSessionId: child.sessionId }
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
      associateChild: router.associate,
      observeSubagent,
      rebindAgentSession,
      model: this.currentModel,
    })
      .catch((err: unknown) => {
        if (abort.signal.reason === EXPLICIT_TURN_ABORT_REASON) return
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
          if (isTerminalCompatEvent(event)) promptDone = true
        }
        if (promptDone) break
      }
    } finally {
      await run
      router.dispose()
    }

    if (abort.signal.reason === EXPLICIT_TURN_ABORT_REASON) {
      const updated = messageUpdated(buildAssistantMessage({
        id: router.assistantMessageId(),
        sessionID: id,
        parentID: input.userMessageId ?? id,
        agent: input.agent,
        model: input.model,
        directory,
        created: router.created(),
        completed: Date.now(),
        error: { name: "MessageAbortedError", data: { message: "Aborted by user" } },
        variant: input.variant,
      }))
      this.store.appendEvent({
        sessionId: id,
        agentSessionId,
        payload: updated,
        source: { dir: "in", method: "prompt.aborted" },
      })
      yield updated
      return
    }
    if (!promptError) return
    for (const event of router.terminalizeParent(promptError, { dir: "in", method: "prompt.error.open-tools", frame: { message: promptError } })) yield event
    const updated = messageUpdated(buildAssistantMessage({
      id: router.assistantMessageId(),
      sessionID: id,
      parentID: input.userMessageId ?? id,
      agent: input.agent,
      model: input.model,
      directory,
      created: router.created(),
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
    const lifecycle = this.lifecycle()
    if (!lifecycle.abort(id)) return { ok: true, status: "already_idle" }
    this.resolvePendingPermissions(id, "deny")
    // `cancelled` is an admission acknowledgement: callers may start the next
    // turn as soon as it resolves. Wait until this adapter's own generation has
    // left its busy section so the replacement cannot be rejected by a stale
    // second lock and persisted as a failed assistant turn.
    await lifecycle.whenIdle(id)
    return { ok: true, status: "cancelled" }
  }

  async listCommands(_directory: string): Promise<AgentCommandRow[]> {
    return listCommands()
  }

  async getTodos(sessionId: string, _directory: string): Promise<Array<{ content: string; status: string; priority: string }>> {
    return this.store.getTodos(sessionId)
  }

  async listPermissionModes(sessionId: string, directory: string): Promise<AgentPermissionModeState> {
    return this.driver.permissionModes?.(sessionId, directory) ?? { modes: [], appliesFrom: "next-turn" }
  }

  async setPermissionMode(sessionId: string, modeId: string, directory: string): Promise<AgentPermissionModeState> {
    if (!this.driver.setPermissionMode) {
      throw new Error(`${this.driver.type} does not support permission modes`)
    }
    return this.driver.setPermissionMode(sessionId, modeId, directory)
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
    await this.driver.applyConfig(config)
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

function transcriptText(messages: unknown[]) {
  return messages.flatMap((message) => readableTranscriptText(message)).filter(Boolean).join("\n\n")
}

function readableTranscriptText(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : []
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Array.isArray(value) ? value.flatMap(readableTranscriptText) : []
  }
  const record = value as Record<string, unknown>
  if (typeof record.text === "string") return readableTranscriptText(record.text)
  if (typeof record.content === "string" || Array.isArray(record.content)) return readableTranscriptText(record.content)
  if (record.message) return readableTranscriptText(record.message)
  return []
}

function scopedSubagentKey(parentSessionId: string, key: string) {
  return `${parentSessionId}\0${key}`
}
