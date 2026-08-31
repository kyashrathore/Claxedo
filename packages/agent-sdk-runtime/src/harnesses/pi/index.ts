import { randomUUID } from "node:crypto"
import {
  buildAssistantMessage,
  buildUserMessage,
  messagePartUpdated,
  messageUpdated,
  sessionError,
  type CompatPart,
} from "../../compat-events"
import {
  harnessCapabilities,
  goalCapabilities,
  GOAL_ACTIONS,
  type HarnessCapabilities,
  type HarnessCapabilityContext,
} from "../../capabilities"
import {
  type AgentAgent,
  type AgentCommand,
  type AgentConfigOption,
  type AgentMessage,
  type AgentPermission,
  type AgentQuestion,
  type AgentRuntimeStreamEvent,
  type AgentSession,
  type PromptInput,
  type RuntimeDirectory,
  type SessionConfig,
  type SessionConfigUpdate,
} from "../../index"
import type {
  AbortResult,
  AgentGoalMutationResult,
  AgentGoalResource,
  AgentHarnessAdapter,
  AgentHarnessAdapterProcessOptions,
} from "../../adapter-contract"
import { createVirtualSessionEnv } from "../../virtual-session-env"
import type { RunStore, SessionEnv, SessionEnvFactory, SessionEnvFactoryInput } from "../../session-env"
import { createMemoryRunStore } from "../../session-env"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import { firstTurnErrorData } from "../../first-turn-error"
import { agentRuntimeEvent, type AgentRuntimeEvent, type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { Agent, AgentTool } from "@mariozechner/pi-agent-core"
import type { Usage as PiUsage } from "@mariozechner/pi-ai"
import {
  createPiAgent,
  evaluatePiGoal,
  PiModelResolutionError,
  refreshPiAgent,
  runPiModelTurn,
  type PiModelBackend,
  sessionEnvBashTool,
  type PiModelBackendResolver,
  type PiGoalEvaluator,
} from "./model-backend"
import {
  observeAgentProcess,
  type AgentProcessObserver,
  type AgentProcessObserverHandle,
} from "../../process-observer"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"

type PiSession = {
  id: string
  directory?: RuntimeDirectory
  parentID?: string
  title: string | null
  created: number
  updated: number
  env: SessionEnv
  config: SessionConfig
  messages: AgentMessage[]
  active?: AbortController
  /** Live pi Agent for model-backed turns; lazily created at first model turn. */
  agent?: Agent
  /** Backend extra tools captured at Agent creation; preserved across placement swaps. */
  agentExtraTools?: AgentTool[]
  processOwnerId: string
  processObservation: AgentProcessObserverHandle
  goal?: RuntimeGoalSnapshot | null
  goalRun?: { generation: number; backend: PiModelBackend; done: Promise<void> }
}

export type PiAdapterOptions = AgentHarnessAdapterProcessOptions & {
  createEnv?: SessionEnvFactory
  defaultPlacement?: PiSessionPlacement | ((input: {
    sessionId: string
    directory: RuntimeDirectory
  }) => PiSessionPlacement | Promise<PiSessionPlacement>)
  runStore?: RunStore<AgentRuntimeStreamEvent>
  eventHub?: RuntimeEventHub
  /**
   * Optional model backend for Pi turns. Resolution happens per turn so
   * credential rotation is visible immediately.
   */
  modelBackend?: PiModelBackendResolver
  toolExtensionProvider?: PiToolExtensionProvider
  /** Durable owner used when Pi is composed inside the shared runtime. */
  goalStore?: AgentRuntimeStoreWithRecovery
  createStore?: (storeRoot?: string) => AgentRuntimeStoreWithRecovery
  storeRoot?: string
  /** Test/host seam; production defaults to a fresh no-tools Pi evaluator. */
  evaluateGoal?: PiGoalEvaluator
}

export type PiToolExtensionProvider = {
  providesSubagentTool(input: { sessionId: string; model: NonNullable<SessionConfig["model"]> }): boolean
}

export type PiSessionPlacement = Omit<SessionEnvFactoryInput, "sessionId">

function text(input: unknown) {
  return typeof input === "string" && input.trim().length > 0 ? input : undefined
}

function promptText(parts: unknown[]) {
  return parts.flatMap((part) => {
    if (typeof part === "string") return [part]
    if (!part || typeof part !== "object") return []
    const row = part as Record<string, unknown>
    if (typeof row.text === "string") return [row.text]
    if (typeof row.content === "string") return [row.content]
    const resource = row.resource
    if (resource && typeof resource === "object" && typeof (resource as Record<string, unknown>).text === "string") {
      return [(resource as Record<string, string>).text]
    }
    return []
  }).join("\n\n").trim()
}

function notImplemented(feature: string) {
  return new Error(`${feature} is not implemented for Pi central sessions yet`)
}

function row(session: PiSession): AgentSession {
  return {
    id: session.id,
    ...(session.parentID ? { parentID: session.parentID } : {}),
    title: session.title,
    slug: session.id,
    version: "central",
    time: { created: session.created, updated: session.updated },
  }
}

function defaultConfig(): SessionConfig {
  return {
    harness: { id: "pi", access: "native" },
    model: { providerID: "pi", modelID: "virtual" },
    variant: null,
    agent: null,
  }
}

function textPart(input: { sessionId: string; messageId: string; text: string; suffix: string }): CompatPart {
  return {
    id: `${input.messageId}-${input.suffix}`,
    sessionID: input.sessionId,
    messageID: input.messageId,
    type: "text",
    text: input.text,
  }
}

function putMessage(session: PiSession, message: AgentMessage) {
  session.messages = [
    ...session.messages.filter((item) => item.info.id !== message.info.id),
    message,
  ]
}

function runtimeEvent(input: AgentRuntimeStreamEvent): input is AgentRuntimeEvent {
  return !("properties" in input)
}

export class PiHarnessAdapter implements AgentHarnessAdapter {
  private sessions = new Map<string, PiSession>()
  private createEnv: SessionEnvFactory
  private defaultPlacement: NonNullable<PiAdapterOptions["defaultPlacement"]> | undefined
  private runStore: RunStore<AgentRuntimeStreamEvent>
  private eventHub: RuntimeEventHub | undefined
  private modelBackend: PiModelBackendResolver | undefined
  private toolExtensionProvider: PiToolExtensionProvider | undefined
  private processObserver: AgentProcessObserver | undefined
  private goalStore: AgentRuntimeStoreWithRecovery | undefined
  private ownsGoalStore = false
  private evaluateGoal: PiGoalEvaluator
  private goalGeneration = new Map<string, number>()
  private publishedGoals = new Map<string, string>()

  readonly goals: AgentGoalResource

  constructor(options: PiAdapterOptions = {}) {
    this.createEnv = options.createEnv ?? (() => createVirtualSessionEnv())
    this.defaultPlacement = options.defaultPlacement
    this.runStore = options.runStore ?? createMemoryRunStore()
    this.eventHub = options.eventHub
    this.modelBackend = options.modelBackend
    this.toolExtensionProvider = options.toolExtensionProvider
    this.processObserver = options.processObserver
    this.goalStore = options.goalStore ?? options.createStore?.(options.storeRoot)
    this.ownsGoalStore = !options.goalStore && !!this.goalStore
    this.evaluateGoal = options.evaluateGoal ?? evaluatePiGoal
    this.goals = this.goalResource()
  }

  private goalResource(): AgentGoalResource {
    const unavailable = (message: string) => ({
      ok: false as const,
      status: "unavailable" as const,
      message,
    })
    return {
      readCapabilities: (sessionId) => {
        const session = this.sessions.get(sessionId)
        const selected = session?.config.model
        const available = !!session && !!this.modelBackend && !!selected
          && !(selected.providerID === "pi" && selected.modelID === "virtual")
        return goalCapabilities({
          implemented: true,
          available,
          ...(!available ? {
            unavailableReason: !session
              ? `Session ${sessionId} not found`
              : !this.modelBackend
                ? "Pi Goal requires a model backend"
                : "Pi Goal requires a selected model",
          } : {}),
          actions: GOAL_ACTIONS,
          recovery: "blocked",
          optionalFields: ["iteration", "lastReason"],
        })
      },
      read: async (sessionId) => this.readGoal(sessionId),
      start: async (sessionId, input) => {
        const session = this.sessions.get(sessionId)
        if (!session) return { ok: false, status: "not_found", message: `Session ${sessionId} not found` }
        const current = this.readGoal(sessionId)
        if (current && current.status !== "complete") {
          return { ok: false, status: "conflict", message: "A Goal already exists for this session" }
        }
        let backend
        try {
          backend = await this.resolveModelBackend(session)
        } catch (cause) {
          return unavailable(cause instanceof Error ? cause.message : String(cause))
        }
        if (!backend) return unavailable("Pi Goal requires a selected model and available credentials")
        const now = Date.now()
        const goal: RuntimeGoalSnapshot = {
          sessionId,
          objective: input.objective,
          status: "active",
          createdAt: now,
          updatedAt: now,
          iteration: 0,
        }
        this.publishGoal(session, goal)
        this.launchGoal(session, backend)
        return { ok: true, goal }
      },
      pause: async (sessionId) => this.pauseGoal(sessionId),
      stop: async (sessionId) => this.pauseGoal(sessionId),
      resume: async (sessionId) => {
        const session = this.sessions.get(sessionId)
        const current = this.readGoal(sessionId)
        if (!session || !current) return { ok: false, status: "not_found", message: "No Goal exists" }
        if (current.status !== "paused" && current.status !== "blocked") {
          return { ok: false, status: "conflict", message: `Goal is ${current.status}, not paused` }
        }
        let backend
        try {
          backend = await this.resolveModelBackend(session)
        } catch (cause) {
          return unavailable(cause instanceof Error ? cause.message : String(cause))
        }
        if (!backend) return unavailable("Pi Goal requires a selected model and available credentials")
        const goal = { ...current, status: "active" as const, updatedAt: Date.now(), lastReason: "Resumed" }
        this.publishGoal(session, goal)
        this.launchGoal(session, backend)
        return { ok: true, goal }
      },
      delete: async (sessionId) => {
        const session = this.sessions.get(sessionId)
        if (!session || !this.readGoal(sessionId)) {
          return { ok: false, status: "not_found", message: "No Goal exists" }
        }
        await this.disableGoalContinuation(session)
        this.publishGoal(session, null)
        return { ok: true, goal: null }
      },
    }
  }

  private async resolveModelBackend(session: PiSession) {
    const model = session.config.model
    if (!this.modelBackend || !model || (model.providerID === "pi" && model.modelID === "virtual")) return undefined
    const backend = await this.modelBackend({ sessionId: session.id, model })
    if (!backend) return undefined
    if (backend.model.provider !== model.providerID || backend.model.id !== model.modelID) {
      throw new PiModelResolutionError(
        "unsupported_model",
        `Pi selected ${model.providerID}/${model.modelID}, but the backend resolved ${backend.model.provider}/${backend.model.id}`,
        model,
      )
    }
    return backend
  }

  private readGoal(sessionId: string): RuntimeGoalSnapshot | null {
    const session = this.sessions.get(sessionId)
    const current = session?.goal ?? this.goalStore?.getGoal?.(sessionId) ?? null
    if (!session || !current) return current
    if (!session.goalRun && current.status === "active") {
      const blocked = {
        ...current,
        status: "blocked" as const,
        updatedAt: Date.now(),
        lastReason: "Pi conversation state is not recoverable after process restart",
      }
      this.publishGoal(session, blocked)
      return blocked
    }
    return current
  }

  private publishGoal(session: PiSession, goal: RuntimeGoalSnapshot | null) {
    const signature = JSON.stringify(goal)
    if (this.publishedGoals.get(session.id) === signature) return
    this.publishedGoals.set(session.id, signature)
    session.goal = goal
    this.goalStore?.setGoal?.(session.id, goal)
    this.eventHub?.publishRuntime({
      directory: session.directory ?? session.id,
      sessionId: session.id,
      agentSessionId: session.id,
      payload: goal
        ? agentRuntimeEvent.goalUpdated({ sessionId: session.id, goal })
        : agentRuntimeEvent.goalCleared({ sessionId: session.id }),
    })
  }

  private disableGoalContinuation(session: PiSession) {
    const run = session.goalRun
    this.goalGeneration.set(session.id, (this.goalGeneration.get(session.id) ?? 0) + 1)
    session.agent?.clearFollowUpQueue()
    session.active?.abort()
    session.agent?.abort()
    return run?.done ?? Promise.resolve()
  }

  private async pauseGoal(sessionId: string): Promise<AgentGoalMutationResult<RuntimeGoalSnapshot>> {
    const session = this.sessions.get(sessionId)
    const current = this.readGoal(sessionId)
    if (!session || !current) return { ok: false, status: "not_found", message: "No Goal exists" }
    if (current.status === "complete") {
      return { ok: false, status: "conflict", message: "A completed Goal cannot be paused" }
    }
    const paused = { ...current, status: "paused" as const, updatedAt: Date.now(), lastReason: "Paused" }
    // Publish the disabled state before interrupting provider work. The awaited
    // turn_end evaluator observes paused and cannot enqueue another follow-up.
    this.publishGoal(session, paused)
    // Do not admit Resume until the aborted turn has released the shared Pi
    // Agent and session.active slot. Otherwise the old turn's finally block can
    // clear the new turn's controller, leaving a resumed Goal active at
    // Iteration 0 forever.
    await this.disableGoalContinuation(session)
    return { ok: true, goal: paused }
  }

  private launchGoal(session: PiSession, backend: PiModelBackend) {
    const generation = (this.goalGeneration.get(session.id) ?? 0) + 1
    this.goalGeneration.set(session.id, generation)
    const goalRun = { generation, backend, done: Promise.resolve() }
    session.goalRun = goalRun
    const config = session.config
    const input: PromptInput = {
      parts: [{
        type: "text",
        text: [
          `Work autonomously toward this Goal: ${session.goal?.objective ?? ""}`,
          "Use tools as needed. Report concrete progress and evidence; an independent evaluator decides completion.",
        ].join("\n\n"),
      }],
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      agent: config.agent ?? "pi",
      model: config.model ?? { providerID: "pi", modelID: "virtual" },
      ...(config.variant ? { variant: config.variant } : {}),
    }
    goalRun.done = (async () => {
      let runError: string | undefined
      for await (const event of this.sendMessage(session.id, input, session.directory)) {
        if (event.type === "error") runError = event.error
      }
      const current = this.readGoal(session.id)
      if (this.goalGeneration.get(session.id) === generation && current?.status === "active") {
        this.publishGoal(session, {
          ...current,
          status: "blocked",
          updatedAt: Date.now(),
          lastReason: runError ?? "Pi Goal ended without a completion evaluation",
        })
      }
    })().catch((cause) => {
      const current = this.readGoal(session.id)
      if (this.goalGeneration.get(session.id) !== generation || current?.status !== "active") return
      this.publishGoal(session, {
        ...current,
        status: "blocked",
        updatedAt: Date.now(),
        lastReason: cause instanceof Error ? cause.message : String(cause),
      })
    }).finally(() => {
      if (session.goalRun === goalRun) session.goalRun = undefined
    })
  }

  /** Resolve the exact selected model and (re)build the session's live Agent. */
  private async resolveModelAgent(session: PiSession): Promise<Agent | undefined> {
    const configured = session.config.model
    const model = configured?.providerID === "pi" && configured.modelID === "virtual" ? undefined : configured
    if (!this.modelBackend) {
      if (model) {
        throw new PiModelResolutionError(
          "unavailable",
          `Pi model ${model.providerID}/${model.modelID} is unavailable because no model backend is configured`,
          model,
        )
      }
      return undefined
    }
    const backend = model
      ? await this.resolveModelBackend(session)
      : await this.modelBackend({ sessionId: session.id })
    if (!backend) {
      if (model) {
        throw new PiModelResolutionError(
          "missing_credentials",
          `Pi model ${model.providerID}/${model.modelID} has no available credentials`,
          model,
        )
      }
      return undefined
    }
    if (session.agent) {
      refreshPiAgent(session.agent, backend)
    } else {
      session.agent = createPiAgent({ sessionId: session.id, backend, env: session.env })
      session.agentExtraTools = backend.extraTools ?? []
    }
    return session.agent
  }

  async listSessions(directory: RuntimeDirectory) {
    return [...this.sessions.values()]
      .filter((session) => session.directory === directory)
      .map(row)
  }

  async getSession(id: string, _directory: RuntimeDirectory) {
    const session = this.sessions.get(id)
    return session ? row(session) : null
  }

  async createSession(directory: RuntimeDirectory, title?: string, id: string = randomUUID()) {
    return await this.bindSession({ id, title, directory })
  }

  async createHandoffSession(directory: RuntimeDirectory, title: string | undefined, id: string) {
    if (this.sessions.has(id)) await this.deleteSession(id, directory)
    return { ...await this.bindSession({ id, title, directory }), ownerKey: null }
  }

  async bindSession(input: { id: string; parentID?: string; title?: string | null; directory?: RuntimeDirectory; placement?: PiSessionPlacement }) {
    const existing = this.sessions.get(input.id)
    if (existing) {
      // Placement is applied only when the session env is first attached.
      // Re-binding an existing session is an idempotent metadata update.
      existing.title = input.title === undefined ? existing.title : input.title
      if (input.parentID) existing.parentID = input.parentID
      existing.updated = Date.now()
      return { id: existing.id }
    }
    const now = Date.now()
    const placement = await this.sessionEnvInput(input)
    const processOwnerId = `pi-session:${input.id}`
    const processObservation = observeAgentProcess(this.processObserver, {
      ownerId: processOwnerId,
      launchId: randomUUID(),
      harnessId: "pi",
      access: "native",
      role: "harness",
      label: "Pi in-process model runtime",
      locality: "in-process",
      confidence: "direct",
      capabilities: {
        resourceMetrics: "shared-process",
        ownerActions: false,
      },
      ...(placement.workspaceId ? { workspaceId: placement.workspaceId } : {}),
      ...(placement.directory ? { directory: placement.directory } : input.directory ? { directory: input.directory } : {}),
      sessionId: input.id,
    })
    processObservation.update({ lifecycle: "ready" })
    this.goalStore?.bindSession({
      sessionId: input.id,
      ...(input.parentID ? { parentSessionId: input.parentID } : {}),
      // The runtime store uses the empty directory as the canonical central
      // scope. A Session id is never a directory and would make central Pi
      // sessions disappear from list(undefined).
      directory: placement.directory ?? input.directory ?? "",
      title: input.title ?? undefined,
      agentSessionId: input.id,
    })
    const persistedGoal = this.goalStore?.getGoal?.(input.id) ?? null
    this.sessions.set(input.id, {
      id: input.id,
      ...(placement.directory ? { directory: placement.directory } : input.directory ? { directory: input.directory } : {}),
      ...(input.parentID ? { parentID: input.parentID } : {}),
      title: input.title ?? null,
      created: now,
      updated: now,
      env: observePiSessionEnv(
        await this.createEnv(placement),
        {
          ownerId: processOwnerId,
          sessionId: input.id,
          ...(placement.workspaceId ? { workspaceId: placement.workspaceId } : {}),
          ...(placement.directory ? { directory: placement.directory } : input.directory ? { directory: input.directory } : {}),
        },
        this.processObserver,
      ),
      config: defaultConfig(),
      messages: [],
      processOwnerId,
      processObservation,
      goal: persistedGoal,
    })
    return { id: input.id }
  }

  private async sessionEnvInput(input: { id: string; directory?: RuntimeDirectory; placement?: PiSessionPlacement }): Promise<SessionEnvFactoryInput> {
    const placement = input.placement
      ?? (typeof this.defaultPlacement === "function"
        ? await this.defaultPlacement({ sessionId: input.id, directory: input.directory })
        : this.defaultPlacement)
      ?? {
        mode: "hybrid" as const,
        host: "central" as const,
        toolSandbox: { kind: "virtual" as const, id: input.id },
      }
    return {
      sessionId: input.id,
      mode: placement.mode,
      host: placement.host,
      ...(placement.directory ? { directory: placement.directory } : input.directory ? { directory: input.directory } : {}),
      ...(placement.workspaceId ? { workspaceId: placement.workspaceId } : {}),
      ...(placement.toolSandbox ? { toolSandbox: placement.toolSandbox } : {}),
    }
  }

  async updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, _directory: RuntimeDirectory) {
    const session = this.sessions.get(id)
    if (!session) return null
    session.title = updates.title ?? session.title
    session.updated = Date.now()
    return row(session)
  }

  async getSessionConfig(id: string, _directory: RuntimeDirectory) {
    return this.sessions.get(id)?.config ?? defaultConfig()
  }

  async updateSessionConfig(id: string, update: SessionConfigUpdate, _directory: RuntimeDirectory) {
    const session = this.sessions.get(id)
    if (!session) return defaultConfig()
    if (update.model !== undefined && session.active) {
      throw new Error("Start a new Pi session to use another model")
    }
    session.config = {
      harness: update.harness ?? session.config.harness,
      ...(update.model === undefined
        ? session.config.model ? { model: session.config.model } : {}
        : update.model ? { model: update.model } : {}),
      variant: update.variant === undefined ? session.config.variant ?? null : update.variant,
      agent: update.agent === undefined ? session.config.agent ?? null : update.agent,
    }
    return session.config
  }

  async deleteSession(id: string, _directory: RuntimeDirectory) {
    const session = this.sessions.get(id)
    if (session) await this.disableGoalContinuation(session)
    await session?.env.dispose?.()
    session?.processObservation.exit({ reason: "disposed" })
    this.sessions.delete(id)
    this.goalStore?.deleteSession(id)
  }

  /**
   * Swap the session's tool placement MID-CONVERSATION (Demo B): dispose the
   * old SessionEnv, create one for the new placement, and re-point the live
   * Agent's tools at it. Conversation history is untouched. Refused while a
   * turn is active — a running tool call must never have its env ripped out.
   */
  async updateSessionPlacement(id: string, placement: PiSessionPlacement): Promise<{ ok: true }> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session ${id} not found`)
    if (session.active) throw new Error("Session has an active turn; placement can only change while idle")
    const envInput = await this.sessionEnvInput({ id, placement })
    const nextEnv = observePiSessionEnv(
      await this.createEnv(envInput),
      {
        ownerId: session.processOwnerId,
        sessionId: id,
        ...(envInput.workspaceId ? { workspaceId: envInput.workspaceId } : {}),
        ...(envInput.directory ? { directory: envInput.directory } : {}),
      },
      this.processObserver,
    )
    const previous = session.env
    session.env = nextEnv
    if (session.agent) {
      session.agent.state.tools = [sessionEnvBashTool(nextEnv), ...(session.agentExtraTools ?? [])]
    }
    session.updated = Date.now()
    await previous.dispose?.()
    return { ok: true }
  }

  async readHarnessCapabilities(_directory: RuntimeDirectory, context?: HarnessCapabilityContext): Promise<HarnessCapabilities> {
    const session = context?.sessionId ? this.sessions.get(context.sessionId) : undefined
    const model = session?.config.model
    const supportsSubagentTool = !!(
      session &&
      model &&
      !(model.providerID === "pi" && model.modelID === "virtual") &&
      this.modelBackend &&
      this.toolExtensionProvider?.providesSubagentTool({ sessionId: session.id, model })
    )
    const backend = supportsSubagentTool && session && model
      ? await this.modelBackend?.({ sessionId: session.id, model })
      : undefined
    const subagents = !!backend?.extraTools?.some((tool) => tool.name === "subagent")
    return harnessCapabilities({
      harness: "pi",
      abort: true,
      reconnect: true,
      replay: true,
      // Pi raises no permission requests, so the auto-accept command that gates
      // on this would toggle something with nothing to answer.
      permissions: false,
      questions: false,
      todos: false,
      commands: false,
      fork: false,
      revert: false,
      unrevert: false,
      configOptions: false,
      subagents,
      goals: true,
    })
  }

  async *sendMessage(id: string, input: PromptInput, directory: RuntimeDirectory): AsyncIterable<AgentRuntimeStreamEvent> {
    const session = this.sessions.get(id)
    if (!session) {
      yield sessionError(`Session ${id} not found`, id)
      return
    }
    const abort = new AbortController()
    session.active = abort
    const scope = directory ?? id
    const emit = (event: AgentRuntimeStreamEvent) => {
      this.runStore.appendEvent({ runId: id, payload: event })
      if (runtimeEvent(event)) {
        this.eventHub?.publishRuntime({
          directory: scope,
          sessionId: id,
          assistantMessageId: input.assistantMessageId,
          payload: event,
        })
      }
      return event
    }
    let assistantText = ""
    let assistantError: string | undefined
    let assistantUsage: PiUsage | undefined
    const assistant = {
      id: input.assistantMessageId,
      sessionID: id,
      parentID: input.userMessageId ?? id,
      agent: input.agent,
      model: input.model,
      directory: scope,
      ...(input.variant ? { variant: input.variant } : {}),
    }
    try {
      if (input.userMessageId) {
        const prompt = promptText(input.parts)
        const user = {
          info: buildUserMessage({
          id: input.userMessageId,
          sessionID: id,
          agent: input.agent,
          model: input.model,
          ...(input.tools ? { tools: input.tools } : {}),
          ...(input.format ? { format: input.format } : {}),
          ...(input.system ? { system: input.system } : {}),
          ...(input.variant ? { variant: input.variant } : {}),
          }),
          parts: prompt ? [textPart({ sessionId: id, messageId: input.userMessageId, text: prompt, suffix: "input" })] : [],
        }
        putMessage(session, user)
        yield emit(messageUpdated(user.info))
        if (user.parts[0]) yield emit(messagePartUpdated(user.parts[0]))
      }
      const info = buildAssistantMessage(assistant)
      putMessage(session, { info, parts: [] })
      yield emit(messageUpdated(info))
      yield emit({ type: "session-status", status: "busy" })
      const executable = promptText(input.parts)
      const command = text(executable.match(/^\/?bash\s+([\s\S]+)/)?.[1]) ?? text(executable.match(/^exec:\s*([\s\S]+)/i)?.[1])
      if (command) {
        const result = await session.env.exec(command, { signal: abort.signal })
        const output = result.stdout || result.stderr || `exit ${result.exitCode}`
        if (output) {
          assistantText = output
          yield emit({ type: "text-delta", delta: output })
        }
      } else if (executable) {
        const agent = await this.resolveModelAgent(session)
        if (agent) {
          // Real pi model turn: LLM via the resolved backend (e.g. the
          // openai-codex subscription provider), tools via the SessionEnv.
          const goalRun = session.goalRun
          const turn = runPiModelTurn({
            agent,
            prompt: executable,
            signal: abort.signal,
            ...(goalRun ? {
              onTurnEnd: async ({ work, hasToolResults, signal }) => {
                if (hasToolResults) return
                const current = this.readGoal(session.id)
                if (
                  !current
                  || current.status !== "active"
                  || session.goalRun?.generation !== goalRun.generation
                  || this.goalGeneration.get(session.id) !== goalRun.generation
                ) return
                let evaluation
                try {
                  evaluation = await this.evaluateGoal({
                    backend: goalRun.backend,
                    objective: current.objective,
                    work,
                    signal,
                  })
                } catch (cause) {
                  const latest = this.readGoal(session.id)
                  if (latest?.status !== "active" || session.goalRun?.generation !== goalRun.generation) return
                  this.publishGoal(session, {
                    ...latest,
                    status: "blocked",
                    updatedAt: Date.now(),
                    lastReason: cause instanceof Error ? cause.message : String(cause),
                  })
                  return
                }
                const latest = this.readGoal(session.id)
                if (latest?.status !== "active" || session.goalRun?.generation !== goalRun.generation) return
                const next: RuntimeGoalSnapshot = {
                  ...latest,
                  status: evaluation.met ? "complete" : "active",
                  updatedAt: Date.now(),
                  iteration: (latest.iteration ?? 0) + 1,
                  lastReason: evaluation.reason,
                }
                this.publishGoal(session, next)
                if (evaluation.met) return
                agent.followUp({
                  role: "user",
                  content: [
                    `Continue working toward the Goal: ${latest.objective}`,
                    `Independent evaluator: ${evaluation.reason}`,
                    "Address the missing evidence and continue autonomously.",
                  ].join("\n\n"),
                  timestamp: Date.now(),
                })
              },
            } : {}),
          })
          while (true) {
            const next = await turn.next()
            if (next.done) {
              assistantText = next.value.text
              assistantUsage = next.value.usage
              if (next.value.error) throw new Error(next.value.error)
              break
            }
            yield emit(next.value)
          }
        } else {
          throw new Error("This legacy Pi session has no configured model. Start a new Pi session and choose a model.")
        }
      }
    } catch (cause) {
      assistantError = cause instanceof Error ? cause.message : String(cause)
    } finally {
      session.active = undefined
      session.updated = Date.now()
    }
    const completed = Date.now()
    if (assistantUsage) {
      yield emit({
        type: "usage",
        contextSize: assistantUsage.totalTokens,
        contextUsed: assistantUsage.totalTokens,
        observation: {
          kind: "cumulative",
          nativeSessionId: session.id,
          tokens: {
            input: assistantUsage.input,
            output: assistantUsage.output,
            reasoning: null,
            cache: { read: assistantUsage.cacheRead, write: assistantUsage.cacheWrite },
          },
        },
      })
    }
    const info = {
      ...buildAssistantMessage({
        ...assistant,
        completed,
        ...(assistantError
          ? { error: { name: "UnknownError", data: firstTurnErrorData(assistantError) } }
          : { finish: "stop" }),
      }),
      ...(assistantUsage
        ? {
            tokens: {
              input: assistantUsage.input,
              output: assistantUsage.output,
              reasoning: 0,
              cache: { read: assistantUsage.cacheRead, write: assistantUsage.cacheWrite },
            },
          }
        : {}),
    }
    putMessage(session, {
      info,
      parts: assistantText
        ? [textPart({ sessionId: id, messageId: input.assistantMessageId, text: assistantText, suffix: "text" })]
        : [],
    })
    yield emit(messageUpdated(info))
    if (assistantError) {
      yield emit({ type: "session-status", status: "error" })
      yield emit({ type: "error", error: assistantError })
      return
    }
    yield emit({ type: "session-status", status: "idle" })
    yield emit({ type: "finish", sessionId: id })
  }

  async getMessages(id: string, _directory: RuntimeDirectory) {
    return this.sessions.get(id)?.messages ?? []
  }

  async abort(id: string, _directory: RuntimeDirectory): Promise<AbortResult> {
    const session = this.sessions.get(id)
    if (!session?.active) return { ok: true, status: "already_idle" }
    session.active.abort()
    session.active = undefined
    return { ok: true, status: "cancelled" }
  }

  async revert() {
    throw notImplemented("Revert")
  }

  async unrevert() {
    throw notImplemented("Unrevert")
  }

  async forkSession(): Promise<{ id: string }> {
    throw notImplemented("Fork")
  }

  async executeCommand() {
    throw notImplemented("Commands")
  }

  async listCommands(): Promise<AgentCommand[]> {
    return []
  }

  async listAgents(): Promise<AgentAgent[]> {
    return []
  }

  async getTodos() {
    return []
  }

  /**
   * Pi never asks. Its tools run in `just-bash` over an `InMemoryFs` — see
   * `createVirtualSessionEnv` — so there is nothing to gate and no request to
   * raise. Both members stay because the port requires them.
   */
  async listPermissions(_directory?: RuntimeDirectory): Promise<AgentPermission[]> {
    return []
  }

  async respondPermission(
    _permId: string,
    _decision: "allow_once" | "allow_always" | "deny" | "reject_always",
    _directory?: RuntimeDirectory,
  ) {}

  async listQuestions(): Promise<AgentQuestion[]> {
    return []
  }

  async replyQuestion() {}

  async rejectQuestion() {}

  async applyConfig() {}

  async probeConfigOptions(): Promise<AgentConfigOption[]> {
    throw new Error("pi does not expose harness config options")
  }

  dispose() {
    for (const session of this.sessions.values()) {
      this.disableGoalContinuation(session)
      session.processObservation.exit({ reason: "disposed" })
      void session.env.dispose?.()
    }
    this.sessions.clear()
    if (this.ownsGoalStore) this.goalStore?.close?.()
  }
}

function observePiSessionEnv(
  env: SessionEnv,
  input: {
    ownerId: string
    sessionId: string
    workspaceId?: string
    directory?: string
  },
  observer?: AgentProcessObserver,
): SessionEnv {
  return {
    ...env,
    async exec(command, options) {
      const handle = observeAgentProcess(observer, {
        ownerId: `pi-tool:${randomUUID()}`,
        launchId: randomUUID(),
        harnessId: "pi",
        access: "native",
        role: "tool",
        label: "Pi SessionEnv command",
        locality: env.kind === "workspace-runtime" ? "local-process" : "in-process",
        confidence: env.kind === "workspace-runtime" ? "inferred" : "direct",
        capabilities: {
          resourceMetrics: env.kind === "workspace-runtime" ? "process" : "shared-process",
          ownerActions: false,
        },
        parentOwnerId: input.ownerId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.directory ? { directory: input.directory } : {}),
        sessionId: input.sessionId,
      })
      try {
        const result = await env.exec(command, options)
        handle.exit({ reason: "exited", exitCode: result.exitCode })
        return result
      } catch (cause) {
        handle.exit({
          reason: options?.signal?.aborted ? "cancelled" : "error",
        })
        throw cause
      }
    },
  }
}
