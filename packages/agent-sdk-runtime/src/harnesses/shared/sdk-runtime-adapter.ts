import { randomUUID } from "crypto"
import {
  assertAgentExecutionBinding,
  type AgentExecutionBinding,
} from "@claxedo/agent-runtime-contract"
import { type RawHarnessEvent, type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { createAgentSessionIndex } from "./agent-session-index"
import { createGoalPublisher, type GoalPublisher } from "./goal-publisher"
import { createNativeGoalResource } from "./native-goal-resource"
import {
  buildAssistantMessage,
  buildUserMessage,
  isTerminalCompatEvent,
  messageUpdated,
  sessionError,
  sessionStatus,
  type CompatEvent,
} from "../../compat-events"
import { listCommands } from "../../command-discovery"
import type {
  AgentCommand,
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentRuntimeStreamEvent,
  AgentSession,
  PromptInput,
  SessionConfig,
  SessionConfigUpdate,
} from "../../index"
import type {
  AbortResult,
  AgentConfigOptions,
  AgentGoalResource,
  AgentGoalMutationResult,
  AgentHarnessAdapter,
  AgentHarnessAdapterHealth,
  AgentHarnessAdapterHealthContext,
  AgentPermissionModeState,
  AgentSessionCreateOptions,
  AgentTurnWriteContext,
} from "../../adapter-contract"
import { turnWriteFence } from "../../adapter-contract"
import type { HarnessCapabilities } from "../../capabilities"
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
import { commitSdkAutomaticTitle } from "./sdk-runtime-title"
import { createSdkRuntimeProducers } from "./sdk-runtime-producers"
import { requireWorkspaceDirectory } from "../../target"
import { firstTurnErrorData } from "../../first-turn-error"
import {
  createMemorySubagentAdmissionStore,
  createSubagentAdmissionBoundary,
} from "../../subagent-admission"
import type { AgentRuntimeSessionBinding } from "./runtime-store"
import type {
  ActiveTurn,
  JsonRecord,
  PendingPermission,
  PendingQuestion,
  SdkRuntimeAdapterOptions,
  SdkRuntimeAuth,
  SdkRuntimeDriver,
  SdkRuntimeDriverFactory,
  SdkRuntimeDriverHost,
  SdkRuntimeRunnerType,
  SdkRuntimeStore,
  SdkRuntimeTranscriptRegistrar,
  SdkRuntimeTurnInput,
} from "./sdk-runtime-driver"
import { errorMessage, extractTextFromParts, record, text } from "./sdk-runtime-values"
import { isTerminalRuntimePayload } from "../../runtime/turn-outcome"
import { createSubagentChildren } from "./subagent-lifecycle"
import {
  admissibleSubagentObservation,
  openSubagentTranscript,
  subagentCorrelationKeys,
  transcriptText,
} from "./subagent-transcript"
import { acceptedSessionConfig, acceptedSessionUpdate } from "./accepted-session-mutation"
import { SdkRuntimeInteractions } from "./sdk-runtime-interactions"
import { sdkConfigOptions, sdkHarnessCapabilities } from "./sdk-runtime-capabilities"

export type {
  ActiveTurn,
  JsonRecord,
  PendingPermission,
  PendingQuestion,
  SdkRuntimeAdapterOptions,
  SdkRuntimeAuth,
  SdkRuntimeDriver,
  SdkRuntimeDriverFactory,
  SdkRuntimeDriverHost,
  SdkRuntimeRunnerType,
  SdkRuntimeStore,
  SdkRuntimeTranscriptRegistrar,
  SdkRuntimeTurnInput,
} from "./sdk-runtime-driver"
export { errorMessage, extractTextFromParts, record, stringRecord, text } from "./sdk-runtime-values"

function missingStore(): SdkRuntimeStore {
  throw new Error("SdkRuntimeAdapter requires a runtime store from the host")
}

export class SdkRuntimeAdapter implements AgentHarnessAdapter {
  readonly adapterCapabilities = ["runtime-config", "session-instructions"] as const
  readonly commitsStreamEvents = true
  private store: SdkRuntimeStore
  private ownsStore = false
  private storeClosed = false
  private producers = createSdkRuntimeProducers()
  private currentModel = ""
  private driver: SdkRuntimeDriver
  private turnLifecycle = createSessionTurnLifecycle<ActiveTurn>()
  private interactions: SdkRuntimeInteractions
  private subagentAdmissionStore = createMemorySubagentAdmissionStore()
  private subagentChildren = new Map<string, {
    sessionId: string
    agentSessionId: string
    target: ChildProjectionTarget
  }>()
  private hydratedFileTranscripts = new Set<string>()
  private goalPublisher?: GoalPublisher

  /**
   * Lazy so instances built without the constructor (Object.create in tests)
   * still publish and forget safely — same pattern as the ACP adapter.
   */
  private publisher(): GoalPublisher {
    return (this.goalPublisher ??= createGoalPublisher(this.options.eventHub))
  }
  private agentSessionIndex = createAgentSessionIndex()
  readonly goals: AgentGoalResource | undefined

  constructor(private readonly options: SdkRuntimeAdapterOptions) {
    this.store = options.store ?? options.createStore?.(options.storeRoot) ?? missingStore()
    this.ownsStore = !options.store
    this.interactions = new SdkRuntimeInteractions(this.store)
    this.driver = options.driver({
      lifecycle: () => this.lifecycle(),
      pendingPermissions: this.interactions.permissions,
      pendingQuestions: this.interactions.questions,
      processObserver: options.processObserver,
      transcriptRegistrar: options.transcriptRegistrar,
      bindSession: (input) => this.bindStoreSession(input),
      getAgentSessionId: (sessionId) => this.store.getAgentSessionId(sessionId),
      getSessionForAgentSession: (agentSessionId) => this.agentSessionIndex.get(agentSessionId),
      getGoal: (sessionId) => this.store.getGoal?.(sessionId) ?? null,
      getSessionConfig: (sessionId) => this.store.getSessionConfig(sessionId),
      updatePermissionState: (sessionId, state, modeId) => {
        if (!this.store.updateSessionConfig(sessionId, {
          permissionState: state,
          ...(modeId ? { permissionMode: modeId } : {}),
        })) throw new Error(`Cannot persist permissions for missing session ${sessionId}`)
      },
      publishGoal: (input) => this.publishGoal(input.sessionId, input.directory, input.goal),
      runProviderTurn: (input, execute) => this.runProviderTurn(input.sessionId, input.directory, execute, input.userMessage),
    })
    this.goals = this.createGoalResource()
  }

  /** Every session binding also feeds the provider-id reverse index. */
  private bindStoreSession(input: AgentRuntimeSessionBinding) {
    this.store.bindSession(input)
    this.agentSessionIndex.remember(input)
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
    return sdkHarnessCapabilities(this.driver)
  }

  /** One resource per adapter: the driver it wraps never changes. */
  private createGoalResource(): AgentGoalResource | undefined {
    const goals = this.driver.goals
    if (!goals) return this.nativeGoalResource()
    const publish = async <T extends RuntimeGoalSnapshot | null>(
      sessionId: string,
      directory: string,
      operation: () => Promise<AgentGoalMutationResult<T>>,
    ) => {
      const result = await operation()
      if (result.ok) this.publishGoal(sessionId, directory, result.goal)
      return result
    }
    return {
      readCapabilities: (sessionId, directory) => goals.readCapabilities(sessionId, directory),
      read: (sessionId, directory) => goals.read(sessionId, directory),
      start: (sessionId, input, directory) => {
        const required = requireWorkspaceDirectory(directory)
        return publish(sessionId, required, () => goals.start(sessionId, input, required))
      },
      pause: (sessionId, directory) => {
        const required = requireWorkspaceDirectory(directory)
        return publish(sessionId, required, () => goals.pause(sessionId, required))
      },
      resume: (sessionId, directory) => {
        const required = requireWorkspaceDirectory(directory)
        return publish(sessionId, required, () => goals.resume(sessionId, required))
      },
      stop: (sessionId, directory) => {
        const required = requireWorkspaceDirectory(directory)
        return publish(sessionId, required, () => goals.stop(sessionId, required))
      },
      delete: (sessionId, directory) => {
        const required = requireWorkspaceDirectory(directory)
        return publish(sessionId, required, () => goals.delete(sessionId, required))
      },
    }
  }

  private nativeGoalResource(): AgentGoalResource | undefined {
    const native = this.driver.nativeGoal
    if (!native) return undefined
    return createNativeGoalResource({
      native,
      driverType: this.driver.type,
      lifecycle: () => this.lifecycle(),
      projectedGoal: (sessionId) => this.store.getGoal?.(sessionId),
      publishGoal: (sessionId, directory, goal) => this.publishGoal(sessionId, directory, goal),
      sessionConfig: async (sessionId) => this.store.getSessionConfig(sessionId) ?? {
        harness: { id: this.driver.type, access: "native" },
        variant: null,
        agent: null,
      },
      defaultModelId: () => this.currentModel,
      streamTurn: (sessionId, input, directory, execute) => this.streamMessage(sessionId, input, directory, execute),
    })
  }

  private publishGoal(sessionId: string, directory: string, goal: RuntimeGoalSnapshot | null) {
    this.publisher().publish({
      sessionId,
      directory,
      agentSessionId: this.store.getAgentSessionId(sessionId) ?? undefined,
      goal,
      applyState: (next) => this.store.setGoal?.(sessionId, next),
    })
  }

  private runProviderTurn(
    sessionId: string,
    directory: string,
    execute: (turn: SdkRuntimeTurnInput) => Promise<void>,
    userMessage?: { id: string; text: string },
  ): Promise<boolean> {
    return (async () => {
      const config = this.store.getSessionConfig(sessionId)
      const parent = userMessage ? undefined : this.store.getLatestUserMessageId(sessionId)
      if (!userMessage && !parent) throw new Error(`Provider turn has no user intent for session ${sessionId}`)
      const input: PromptInput = {
        parts: userMessage ? [{ type: "text", text: userMessage.text }] : [],
        ...(userMessage ? { userMessageId: userMessage.id } : { parentMessageId: parent! }),
        assistantMessageId: randomUUID(),
        agent: config?.agent ?? "build",
        model: config?.model ?? { providerID: this.driver.type, modelID: this.currentModel || "default" },
        ...(config?.variant ? { variant: config.variant } : {}),
      }
      let admitted = false
      for await (const _event of this.streamMessage(sessionId, input, directory, async (turn) => {
        admitted = true
        await execute(turn)
      })) {}
      return admitted
    })().catch((error) => {
      console.error(`${this.driver.type} provider Goal turn projection failed`, error)
      return false
    })
  }

  async getSession(binding: AgentExecutionBinding): Promise<AgentSession | null> {
    const { sessionId } = assertAgentExecutionBinding(binding)
    return this.store.getSession(sessionId) ?? null
  }

  async createSession(directory: string, title?: string, sessionId: string = randomUUID(), options: AgentSessionCreateOptions = {}): Promise<{ id: string }> {
    const complete = this.producers.begin()
    try {
      directory = requireWorkspaceDirectory(directory)
      if (this.store.getSession(sessionId)) return { id: sessionId }
      const { id: agentSessionId, model: nativeModel } = await this.driver.createAgentSession({
        directory,
        title,
        model: this.currentModel,
        ...(options.instructions ? { system: options.instructions } : {}),
        sessionId,
      })
      this.bindStoreSession({
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
        ...(nativeModel ? { model: nativeModel } : this.currentModel ? { model: { providerID: this.driver.type, modelID: this.currentModel } } : {}),
        variant: null,
        agent: null,
        ...(options.instructions ? { instructions: options.instructions } : {}),
      })
      return { id: sessionId }
    } finally { complete() }
  }

  async createHandoffSession(directory: string, title: string | undefined, sessionId: string, options: { system: string }) {
    const complete = this.producers.begin()
    try {
      directory = requireWorkspaceDirectory(directory)
      const { id: agentSessionId } = await this.driver.createAgentSession({ directory, title, model: this.currentModel, system: options.system, sessionId })
      this.bindStoreSession({ sessionId, directory, title, agentSessionId })
      let rolledBack = false
      return {
        id: sessionId,
        agentSessionId,
        ownerKey: null,
        rollback: async () => {
          if (rolledBack) return
          await this.driver.deleteAgentSession?.(sessionId, agentSessionId, directory)
          rolledBack = true
        },
      }
    } finally { complete() }
  }

  async releaseHandoffSource(sessionId: string, agentSessionId: string, _ownerKey: string | null, directory: string) {
    this.lifecycle().abort(sessionId)
    await this.driver.deleteAgentSession?.(sessionId, agentSessionId, directory)
  }

  async updateSession(binding: AgentExecutionBinding, updates: { title?: string; time?: { archived?: number } }): Promise<AgentSession | null> {
    assertAgentExecutionBinding(binding)
    const id = binding.sessionId
    if (updates.time?.archived !== undefined) this.lifecycle().abort(id)
    return acceptedSessionUpdate(this.store, id, updates)
  }

  async getSessionConfig(binding: AgentExecutionBinding): Promise<SessionConfig> {
    assertAgentExecutionBinding(binding)
    return this.store.getSessionConfig(binding.sessionId) ?? {
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

  async updateSessionConfig(binding: AgentExecutionBinding, update: SessionConfigUpdate): Promise<SessionConfig> {
    assertAgentExecutionBinding(binding)
    requireWorkspaceDirectory(binding.directory)
    const current = this.store.getSessionConfig(binding.sessionId)
    if (!current) throw new Error(`Session ${binding.sessionId} has no runtime config`)
    return acceptedSessionConfig(current, update)
  }

  async deleteSession(binding: AgentExecutionBinding): Promise<void> {
    assertAgentExecutionBinding(binding)
    const id = binding.sessionId
    const directory = requireWorkspaceDirectory(binding.directory)
    this.lifecycle().abort(id)
    for (const child of this.store.listSubagents?.(id) ?? []) {
      const childSessionId = text(record(child)?.childSessionId)
      if (!childSessionId) continue
      const agentSessionId = this.store.getAgentSessionId(childSessionId)
      if (agentSessionId) await this.driver.deleteAgentSession?.(childSessionId, agentSessionId, directory)
      this.agentSessionIndex.forget(childSessionId)
    }
    const agentSessionId = this.store.getAgentSessionId(id)
    if (agentSessionId) await this.driver.deleteAgentSession?.(id, agentSessionId, directory)
    this.store.deleteSession(id)
    this.agentSessionIndex.forget(id)
    this.publisher().forget(id)
  }

  /**
   * Runs one turn, holding the session's busy lock until TERMINAL EMISSION —
   * the moment the turn is semantically over, not the moment this generator
   * finishes. The lock answers "is a turn in flight on this session", and a
   * second prompt arriving while one is has nowhere to go, so it is refused.
   * The generator outlives the turn by hundreds of milliseconds: after the
   * terminal event the consumer (`runtime.ts`'s drain loop) still commits
   * events, fans out to subscribers, and awaits an auto-title round-trip, and
   * a prompt landing in that tail would be refused for a turn already over.
   * The `finally` releases too — `enter`'s closure deletes from a Set, so a
   * second call is a no-op — so a turn that throws or is abandoned before any
   * terminal event cannot strand the session.
   */
  async *executeTurn(
    binding: AgentExecutionBinding,
    input: PromptInput,
    writeContext?: AgentTurnWriteContext,
  ): AsyncIterable<AgentRuntimeStreamEvent> {
    assertAgentExecutionBinding(binding)
    const id = binding.sessionId
    const directory = requireWorkspaceDirectory(binding.directory)
    yield* this.streamMessage(id, input, directory, (turn) => this.driver.runTurn(turn), writeContext)
  }

  private async *streamMessage(
    id: string,
    input: PromptInput,
    directory: string,
    execute: (turn: SdkRuntimeTurnInput) => Promise<void>,
    writeContext?: AgentTurnWriteContext,
  ): AsyncIterable<AgentRuntimeStreamEvent> {
    const complete = this.producers.begin()
    const leaveBusy = this.lifecycle().enter(id)
    if (!leaveBusy) {
      complete()
      yield sessionError("Session is already processing a message", id)
      return
    }
    try {
      for await (const event of this._sendMessage(id, input, directory, execute, writeContext)) {
        // Release BEFORE yielding: the consumer may take arbitrarily long to
        // process this event (the auto-title round-trip is downstream of it),
        // and every millisecond of that is a window a next prompt can lose in.
        if (isTerminalRuntimePayload(event)) leaveBusy()
        yield event
      }
    } finally {
      leaveBusy()
      complete()
    }
  }

  private async *_sendMessage(
    id: string,
    input: PromptInput,
    directory: string,
    execute: (turn: SdkRuntimeTurnInput) => Promise<void>,
    writeContext?: AgentTurnWriteContext,
  ): AsyncIterable<AgentRuntimeStreamEvent> {
    const fenced = turnWriteFence(writeContext)
    const current = this.store.getAgentSessionId(id)
    if (!current) {
      yield sessionError(`Session ${id} not found`, id)
      return
    }
    // A session hydrated from a durable store was never bound in this process;
    // prompting it is where the reverse index learns its provider id.
    this.agentSessionIndex.remember({ sessionId: id, directory, agentSessionId: current })
    let agentSessionId = current
    const created = Date.now()
    const permissionMode = input.permissionMode ?? this.store.getSessionConfig(id)?.permissionMode
    if (permissionMode) await this.applyPermissionMode(id, directory, permissionMode)
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
        parentID: input.userMessageId ?? input.parentMessageId ?? id,
        agent: input.agent,
        model: input.model,
        directory,
        created,
      })),
    ]
    const committedStart = this.store.startTurn({
      ...fenced,
      sessionId: id,
      agentSessionId,
      userMessageId: input.userMessageId,
      parentMessageId: input.parentMessageId,
      assistantMessageId: input.assistantMessageId,
      agent: input.agent,
      model: input.model,
      parts: input.parts,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.format ? { format: input.format } : {}),
      ...(input.system ? { system: input.system } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
    })

    const runtime = this.driver.createRuntime(agentSessionId, this.store.getTodos(id))
    const queue: CompatEvent[] = [...(committedStart?.events ?? start)]
    const resolvers: Array<() => void> = []
    let promptDone = false
    let promptError: string | null = null
    const abort = new AbortController()
    // Every cancellation path (including native Goal Stop) owns the same
    // pending interactions; cleanup must not depend on the HTTP abort entry.
    const cancelInteractions = () => {
      this.interactions.resolvePermissions(id, "deny")
      this.interactions.rejectQuestions(id)
    }
    abort.signal.addEventListener("abort", cancelInteractions, { once: true })

    const push = (event: CompatEvent) => {
      queue.push(event)
      for (const resolve of resolvers.splice(0)) resolve()
    }
    const wait = () => new Promise<void>((resolve) => {
      if (queue.length > 0 || promptDone) resolve()
      else resolvers.push(resolve)
    })
    const parentProjector = createTurnEventProjector({
      ...fenced,
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
        ...fenced,
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
    const subagentChildren = createSubagentChildren({
      parentSessionId: id,
      directory,
      input,
      fenced,
      store: this.store,
      children: this.subagentChildren,
      bindSession: (binding) => this.bindStoreSession(binding),
      projectChild: router.projectChild,
    })
    const observeSubagent: SdkRuntimeTurnInput["observeSubagent"] = async (observed) => {
      const fileTranscript = await openSubagentTranscript(this.options.transcriptRegistrar, id, observed.observation)
      const observation = admissibleSubagentObservation(observed.observation, fileTranscript)
      const correlationKeys = subagentCorrelationKeys(observed.correlationKeys, observation)
      const source = observed.source ?? { dir: "in" as const, method: "subagent/updated" }
      const admissionStore = this.store.admit && this.store.markPublished
        ? {
            admit: (input: Parameters<NonNullable<SdkRuntimeStore["admit"]>>[0]) => this.store.admit!(input),
            markPublished: (parentSessionId: string, observationId: string) => this.store.markPublished!(parentSessionId, observationId),
          }
        : this.subagentAdmissionStore
      // Admission owns child-session identity: it reuses the resolved row's
      // bound child, honors a harness-named child, or allocates one when the
      // transcript is openable. The adapter must NOT pick a child from its
      // own in-memory maps before admitting — a second resolver can disagree
      // with admission's row resolution (claude's dual-channel Task
      // observations; adapter memory empty after a process restart), and one
      // row's child stamped toward another crashes the unique child index.
      const transcriptKind = observation.transcript?.kind
      const openable = transcriptKind === "live" || transcriptKind === "messages" || transcriptKind === "file"
      const event = await createSubagentAdmissionBoundary({
        store: admissionStore,
        publish: (_parentSessionId, payload) => router.project(payload, source),
      }).admit(id, observation, openable ? { allocateChildSessionId: () => randomUUID() } : undefined)
      subagentChildren.track(observation, event)

      const childSessionId = event.childSessionId
      if (!childSessionId) return { event }
      // The host already owns this child's execution binding, configuration
      // and transcript on its chosen harness. The parent only adds a tool edge.
      if (observation.providerKind === "claxedo") return { event, childSessionId }
      const { child, childKey } = subagentChildren.child({
        observation,
        subagentKey: event.subagentKey,
        childSessionId,
        source,
      })
      for (const correlationKey of correlationKeys) {
        router.associate(correlationKey, child.target)
      }
      const fileCorrelation = correlationKeys[0] ?? event.subagentKey
      if (fileTranscript && fileTranscript.state !== "unavailable" && !this.hydratedFileTranscripts.has(childKey)) {
        this.hydratedFileTranscripts.add(childKey)
        router.associate(fileCorrelation, child.target)
        const text = transcriptText(fileTranscript.messages)
        if (text) router.project({ type: "text-delta", delta: text }, source, { kind: "child", correlationKey: fileCorrelation })
      }
      subagentChildren.settle(child, observation, source)
      return { event, childSessionId: child.sessionId }
    }
    const rebindAgentSession = (sdkSessionId: string) => {
      if (!sdkSessionId || sdkSessionId === agentSessionId) return
      agentSessionId = sdkSessionId
      this.bindStoreSession({
        sessionId: id,
        directory,
        agentSessionId,
      })
    }

    this.lifecycle().set(id, { abort })
    const run = execute({
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
        abort.signal.removeEventListener("abort", cancelInteractions)
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
            const titleEvent = commitSdkAutomaticTitle(this.store, id, agentSessionId, directory, input.parts)
            if (titleEvent) yield titleEvent
          }
          yield event
          if (isTerminalCompatEvent(event)) promptDone = true
        }
        if (promptDone) break
      }
    } finally {
      await run
      await subagentChildren.settleOpen(`turn-end:${id}:${input.assistantMessageId}`, (observation) =>
        observeSubagent({ observation, source: { dir: "in", method: "subagent/turn-end" } }))
      router.dispose()
    }

    if (abort.signal.reason === EXPLICIT_TURN_ABORT_REASON) {
      const source = { dir: "in" as const, method: "prompt.aborted" }
      yield* router.terminalizeParent("Aborted by user", source)
      const updated = messageUpdated(buildAssistantMessage({
        id: router.assistantMessageId(),
        sessionID: id,
        parentID: input.userMessageId ?? input.parentMessageId ?? id,
        agent: input.agent,
        model: input.model,
        directory,
        created: router.created(),
        completed: Date.now(),
        error: { name: "MessageAbortedError", data: { message: "Aborted by user" } },
        variant: input.variant,
      }))
      this.store.appendEvent({
        ...fenced,
        sessionId: id,
        agentSessionId,
        payload: updated,
        source: { dir: "in", method: "prompt.aborted" },
      })
      yield updated
      // Provider-originated Goal turns have no ordinary turn subscriber to
      // publish their cancellation. Settle through the same projector so the
      // persisted status and the native runtime feed both observe idle.
      parentProjector.project({ type: "session-status", status: "idle" }, source)
      yield* queue.splice(0)
      return
    }
    if (!promptError) return
    for (const event of router.terminalizeParent(promptError, { dir: "in", method: "prompt.error.open-tools", frame: { message: promptError } })) yield event
    const updated = messageUpdated(buildAssistantMessage({
      id: router.assistantMessageId(),
      sessionID: id,
      parentID: input.userMessageId ?? input.parentMessageId ?? id,
      agent: input.agent,
      model: input.model,
      directory,
      created: router.created(),
      completed: Date.now(),
      error: { name: "UnknownError", data: firstTurnErrorData(promptError) },
      variant: input.variant,
    }))
    this.store.appendEvent({
      ...fenced,
      sessionId: id,
      agentSessionId,
      payload: updated,
      source: { dir: "in", method: "prompt.error", frame: { message: promptError } },
    })
    yield updated
    const error = sessionError(promptError, id)
    this.store.appendEvent({
      ...fenced,
      sessionId: id,
      agentSessionId,
      payload: error,
      source: { dir: "in", method: "prompt.error", frame: { message: promptError } },
    })
    yield error
  }

  async getMessages(binding: AgentExecutionBinding): Promise<AgentMessage[]> {
    const { sessionId } = assertAgentExecutionBinding(binding)
    return this.store.getMessages(sessionId)
  }

  async abort(binding: AgentExecutionBinding): Promise<AbortResult> {
    assertAgentExecutionBinding(binding)
    const id = binding.sessionId
    const lifecycle = this.lifecycle()
    if (!lifecycle.abort(id)) return { ok: true, status: "already_idle" }
    // `cancelled` is an admission acknowledgement: callers may start the next
    // turn as soon as it resolves. Wait until this adapter's own generation has
    // left its busy section so the replacement cannot be rejected by a stale
    // second lock and persisted as a failed assistant turn.
    await lifecycle.whenIdle(id)
    return { ok: true, status: "cancelled" }
  }

  async listCommands(_directory: string): Promise<AgentCommand[]> { return listCommands() }

  async getTodos(binding: AgentExecutionBinding): Promise<Array<{ content: string; status: string; priority: string }>> {
    const { sessionId } = assertAgentExecutionBinding(binding)
    return this.store.getTodos(sessionId)
  }

  async listDraftPermissionModes(directory: string): Promise<AgentPermissionModeState> {
    directory = requireWorkspaceDirectory(directory)
    return this.driver.permissionModes?.("", directory) ?? { modes: [], appliesFrom: "next-turn" }
  }

  async listPermissionModes(binding: AgentExecutionBinding): Promise<AgentPermissionModeState> {
    const { sessionId, directory } = assertAgentExecutionBinding(binding)
    const selected = this.store.getSessionConfig(sessionId)?.permissionMode
    if (selected) return this.setPermissionMode(binding, selected)
    return this.driver.permissionModes?.(sessionId, directory) ?? { modes: [], appliesFrom: "next-turn" }
  }

  async setPermissionMode(binding: AgentExecutionBinding, modeId: string): Promise<AgentPermissionModeState> {
    const { sessionId, directory } = assertAgentExecutionBinding(binding)
    return this.applyPermissionMode(sessionId, directory, modeId)
  }

  private async applyPermissionMode(sessionId: string, directory: string, modeId: string): Promise<AgentPermissionModeState> {
    if (!this.driver.setPermissionMode) {
      throw new Error(`${this.driver.type} does not support permission modes`)
    }
    const state = await this.driver.setPermissionMode(sessionId, modeId, directory)
    if (!state.currentModeId) throw new Error(`${this.driver.type} did not report its selected permission mode`)
    if (this.store.getSessionConfig(sessionId)?.permissionMode !== state.currentModeId) {
      if (!this.store.updateSessionConfig(sessionId, { permissionMode: state.currentModeId })) {
        throw new Error(`Session ${sessionId} has no runtime config`)
      }
    }
    return state
  }

  async listPermissions(directory: string): Promise<AgentPermission[]> { return this.interactions.listPermissions(directory) }

  async respondPermission(
    binding: AgentExecutionBinding,
    permId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
  ) {
    assertAgentExecutionBinding(binding)
    return this.interactions.respondPermission(binding, permId, decision)
  }

  async listQuestions(directory: string): Promise<AgentQuestion[]> { return this.interactions.listQuestions(directory) }

  async replyQuestion(binding: AgentExecutionBinding, qId: string, answers: AgentQuestionAnswer[]) {
    assertAgentExecutionBinding(binding)
    return this.interactions.replyQuestion(binding, qId, answers)
  }

  async rejectQuestion(binding: AgentExecutionBinding, qId: string) {
    assertAgentExecutionBinding(binding)
    return this.interactions.rejectQuestion(binding, qId)
  }

  async applyConfig(config: Record<string, unknown>): Promise<void> { await this.driver.applyConfig(config) }

  async probeConfigOptions(directory: string): Promise<AgentConfigOptions> {
    return sdkConfigOptions(await this.driver.configOptions(this.currentModel, directory))
  }

  peekConfigOptions(directory: string): AgentConfigOptions {
    return sdkConfigOptions(this.driver.peekConfigOptions(this.currentModel, directory))
  }

  readRuntimeHealth(_directory: string, context?: AgentHarnessAdapterHealthContext): AgentHarnessAdapterHealth {
    if (context?.sessionId && !this.lifecycle().get(context.sessionId)) return { status: "ok" }
    return this.driver.readRuntimeHealth(_directory)
  }

  private closeStore() {
    if (!this.ownsStore || this.storeClosed) return
    this.storeClosed = true
    this.store.close?.()
  }

  dispose(): Promise<void> {
    return this.producers.dispose(() => {
      // Stop driver-owned Goal continuation before aborting its current turn.
      const driverDone = this.driver?.dispose?.()
      this.lifecycle().abortAll()
      this.interactions.resolvePermissions()
      this.interactions.rejectAllQuestions()
      return driverDone
    }, () => this.closeStore())
  }

  private resolvePendingPermissions(sessionId?: string, decision: "deny" | "reject_always" = "deny") {
    this.interactions.resolvePermissions(sessionId, decision)
  }

}
