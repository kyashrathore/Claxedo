import { randomUUID } from "crypto"
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
  sessionUpdated,
  type CompatEvent,
} from "../../compat-events"
import { listCommands } from "../../command-discovery"
import type {
  AgentCommand,
  AgentConfigOption,
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentRuntimeStreamEvent,
  AgentSession,
  PromptInput,
  SessionConfig,
  SessionConfigUpdate,
} from "../../index"
import type {
  AbortResult,
  AgentGoalResource,
  AgentGoalMutationResult,
  AgentHarnessAdapter,
  AgentHarnessAdapterHealth,
  AgentInteractionResult,
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
import { hasConcreteSessionTitle } from "../../session-title"
import { deriveSessionTitle } from "../../session-title"
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
import { Log } from "../../log"
import { isTerminalRuntimePayload } from "../../runtime/turn-outcome"
import {
  admissibleSubagentObservation,
  openSubagentTranscript,
  scopedSubagentKey,
  subagentCorrelationKeys,
  subagentOutcome,
  transcriptText,
} from "./subagent-transcript"
import { acceptedSessionConfig, acceptedSessionUpdate } from "./accepted-session-mutation"
import { SdkRuntimeInteractions } from "./sdk-runtime-interactions"

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
export { errorMessage, extractTextFromParts, record, text } from "./sdk-runtime-values"

const log = Log.create({ service: "sdk-runtime-adapter" })

function missingStore(): SdkRuntimeStore {
  throw new Error("SdkRuntimeAdapter requires a runtime store from the host")
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
      getSessionConfig: (sessionId) => this.store.getSessionConfig(sessionId),
      publishGoal: (input) => this.publishGoal(input.sessionId, input.directory, input.goal),
      runProviderTurn: (input, execute) => this.runProviderTurn(input.sessionId, input.directory, execute),
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
      goals: !!this.driver.goals || !!this.driver.nativeGoal,
    })
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
    if (!native) return
    return createNativeGoalResource({
      native,
      driverType: this.driver.type,
      lifecycle: () => this.lifecycle(),
      projectedGoal: (sessionId) => this.store.getGoal?.(sessionId),
      publishGoal: (sessionId, directory, goal) => this.publishGoal(sessionId, directory, goal),
      sessionConfig: (sessionId, directory) => this.getSessionConfig(sessionId, directory),
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
  ): Promise<boolean> {
    const config = this.store.getSessionConfig(sessionId)
    const input: PromptInput = {
      parts: [],
      assistantMessageId: randomUUID(),
      agent: config?.agent ?? "build",
      model: config?.model ?? { providerID: this.driver.type, modelID: this.currentModel || "default" },
      ...(config?.variant ? { variant: config.variant } : {}),
    }
    return (async () => {
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

  async listSessions(directory: string): Promise<AgentSession[]> {
    directory = requireWorkspaceDirectory(directory)
    return this.store.listSessions(directory) as AgentSession[]
  }

  async getSession(id: string, _directory: string): Promise<AgentSession | null> {
    return this.store.getSession(id) as AgentSession | null
  }

  async createSession(directory: string, title?: string, sessionId: string = randomUUID()): Promise<{ id: string }> {
    directory = requireWorkspaceDirectory(directory)
    if (this.store.getSession(sessionId)) return { id: sessionId }
    const agentSessionId = await this.driver.createAgentSession({
      directory,
      title,
      model: this.currentModel,
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
      ...(this.currentModel ? { model: { providerID: this.driver.type, modelID: this.currentModel } } : {}),
      variant: null,
      agent: null,
    })
    return { id: sessionId }
  }

  async createHandoffSession(directory: string, title: string | undefined, sessionId: string, options: { system: string }) {
    directory = requireWorkspaceDirectory(directory)
    const agentSessionId = await this.driver.createAgentSession({ directory, title, model: this.currentModel, system: options.system })
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
  }

  async releaseHandoffSource(sessionId: string, agentSessionId: string, _ownerKey: string | null, directory: string) {
    this.lifecycle().abort(sessionId)
    await this.driver.deleteAgentSession?.(sessionId, agentSessionId, directory)
  }

  async updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, _directory: string): Promise<AgentSession | null> {
    if (updates.time?.archived !== undefined) this.lifecycle().abort(id)
    return acceptedSessionUpdate(this.store, id, updates)
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
    const current = this.store.getSessionConfig(id)
    if (!current) throw new Error(`Session ${id} has no runtime config`)
    return acceptedSessionConfig(current, update)
  }

  async deleteSession(id: string, directory: string): Promise<void> {
    directory = requireWorkspaceDirectory(directory)
    this.lifecycle().abort(id)
    for (const child of this.store.listSubagents?.(id) ?? []) {
      const childSessionId = (child as { childSessionId?: string }).childSessionId
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

  /** Holds the busy lock until terminal emission and releases it on every exit path. */
  async *sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<AgentRuntimeStreamEvent> {
    directory = requireWorkspaceDirectory(directory)
    yield* this.streamMessage(id, input, directory, (turn) => this.driver.runTurn(turn))
  }

  private async *streamMessage(
    id: string,
    input: PromptInput,
    directory: string,
    execute: (turn: SdkRuntimeTurnInput) => Promise<void>,
  ): AsyncIterable<AgentRuntimeStreamEvent> {
    const leaveBusy = this.lifecycle().enter(id)
    if (!leaveBusy) {
      yield sessionError("Session is already processing a message", id)
      return
    }
    try {
      for await (const event of this._sendMessage(id, input, directory, execute)) {
        // Release BEFORE yielding: the consumer may take arbitrarily long to
        // process this event (the auto-title round-trip is downstream of it),
        // and every millisecond of that is a window a next prompt can lose in.
        if (isTerminalRuntimePayload(event)) leaveBusy()
        yield event
      }
    } finally {
      leaveBusy()
    }
  }

  private async *_sendMessage(
    id: string,
    input: PromptInput,
    directory: string,
    execute: (turn: SdkRuntimeTurnInput) => Promise<void>,
  ): AsyncIterable<AgentRuntimeStreamEvent> {
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

      const childSessionId = event.childSessionId
      if (!childSessionId) return { event }
      const childKey = scopedSubagentKey(id, event.subagentKey)
      const child = this.subagentChildren.get(childKey)
        ?? [...this.subagentChildren.values()].find((candidate) => candidate.sessionId === childSessionId)
        ?? (() => {
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
        this.bindStoreSession({
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
        this.bindStoreSession({
          sessionId: child.sessionId,
          parentSessionId: id,
          directory,
          title: observation.description ?? observation.label ?? "Subagent",
          agentSessionId: child.agentSessionId,
        })
      }
      this.subagentChildren.set(childKey, child)
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
      const outcome = subagentOutcome(observation)
      if (outcome) {
        this.store.finishTurn({
          sessionId: child.sessionId,
          assistantMessageId: child.target.assistantMessageId,
          outcome,
        })
      }
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

  async getMessages(id: string, _directory: string): Promise<AgentMessage[]> {
    return this.store.getMessages(id) as AgentMessage[]
  }

  async abort(id: string, _directory: string): Promise<AbortResult> {
    const lifecycle = this.lifecycle()
    if (!lifecycle.abort(id)) return { ok: true, status: "already_idle" }
    this.interactions.resolvePermissions(id, "deny")
    // `cancelled` is an admission acknowledgement: callers may start the next
    // turn as soon as it resolves. Wait until this adapter's own generation has
    // left its busy section so the replacement cannot be rejected by a stale
    // second lock and persisted as a failed assistant turn.
    await lifecycle.whenIdle(id)
    return { ok: true, status: "cancelled" }
  }

  async listCommands(_directory: string): Promise<AgentCommand[]> {
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

  async listPermissions(directory: string): Promise<AgentPermission[]> {
    return this.interactions.listPermissions(directory)
  }

  async respondPermission(
    permId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
    directory: string,
  ) {
    return this.interactions.respondPermission(permId, decision, directory)
  }

  async listQuestions(directory: string): Promise<AgentQuestion[]> {
    return this.interactions.listQuestions(directory)
  }

  async replyQuestion(qId: string, answer: string, _directory: string) {
    return this.interactions.replyQuestion(qId, answer)
  }

  async rejectQuestion(qId: string, _directory: string) {
    return this.interactions.rejectQuestion(qId)
  }

  async applyConfig(config: Record<string, unknown>): Promise<void> {
    await this.driver.applyConfig(config)
  }

  async probeConfigOptions(directory: string): Promise<AgentConfigOption[]> {
    return this.driver.configOptions(this.currentModel, directory)
  }

  peekConfigOptions(directory: string): AgentConfigOption[] {
    return this.driver.peekConfigOptions(this.currentModel, directory)
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
    this.interactions.resolvePermissions()
    this.interactions.rejectAllQuestions()
    this.driver?.dispose?.()
    this.closeStore()
  }

  private resolvePendingPermissions(sessionId?: string, decision: "deny" | "reject_always" = "deny") {
    this.interactions.resolvePermissions(sessionId, decision)
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
      title: deriveSessionTitle(text),
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
