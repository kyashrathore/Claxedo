import { randomUUID } from "node:crypto"
import { AbortError, type EffortLevel, type ModelInfo, type SDKActiveGoalMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { isHarnessEffortLevel } from "@claxedo/agent-runtime-contract"
import type {
  AttachInput, CapabilityContext, ConfigApplied, Deadline, HarnessServices, HarnessSession, HarnessTransport,
  RoutedEvent, SessionBroker, StartInput, TransportCapabilities, TransportConfigUpdate,
  TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { claudePrompt } from "./attachments"
import { claudeBinding } from "./credentials"
import { ClaudeTransportError } from "./errors"
import { ClaudeGoals } from "./goals"
import type { ClaudeSdkOptions } from "./launch-context"
import { ClaudeModelCatalog, modelOptions, requiredClaudeEffort } from "./models"
import { modes } from "./permissions"
import { ClaudeProcess } from "./process"
import { ClaudeQueryLauncher } from "./query-options"
import { observeClaudeSessionMessage } from "./session-events"
import { ClaudeTurnInput } from "./turn-input"
import { claudeTranslator, translateClaude } from "./translate"

type Entry = {
  input: StartInput
  session: HarnessSession
  broker: SessionBroker
  processes: Set<ClaudeProcess>
  active?: { id: string; abort: AbortController; input: ClaudeTurnInput }
}

function claudeEffort(value: string | null | undefined): EffortLevel | undefined {
  if (!value) return undefined
  if (!isHarnessEffortLevel(value)) throw new ClaudeTransportError("configuration", `Unsupported Claude effort ${value}`)
  return value
}

function capability(models?: readonly ModelInfo[]): TransportCapabilities {
  return {
    modelSelection: { status: "optional" }, effortLevels: models ? { status: "resolved", models: models.map((model) => ({
      modelID: model.value, levels: model.supportsEffort ? model.supportedEffortLevels ?? [] : [],
    })) } : { status: "unresolved", models: [] },
    instructionChannel: "turn-system-prompt", configOwner: "runtime",
    requests: { permissions: true, questions: true, elicitation: false }, steer: true, subagents: true,
    goals: { implemented: true, available: true, actions: [], recovery: "blocked", optionalFields: ["iteration", "lastReason"] },
    fork: false, agents: true, commands: true, todos: true, history: "store", titles: "harness",
    pluginIntake: { mcp: "session", skills: "plugin-dir" }, mcpTransports: { stdio: true, http: true, sse: true },
    timing: { model: "next-turn", effort: "next-turn", permissionMode: "next-turn", credentials: "next-turn" },
  }
}

export class ClaudeSdkTransport implements HarnessTransport {
  readonly kind = "claude-sdk" as const
  private readonly entries = new Map<string, Entry>()
  private readonly models: ClaudeModelCatalog
  private readonly goalRuntime: ClaudeGoals
  private readonly launcher: ClaudeQueryLauncher
  private disposed = false

  constructor(private readonly services: HarnessServices, private readonly options: ClaudeSdkOptions) {
    this.models = new ClaudeModelCatalog(services, options)
    this.launcher = new ClaudeQueryLauncher(services, options)
    this.goalRuntime = new ClaudeGoals(this.launcher)
  }

  async capabilities(context: CapabilityContext): Promise<TransportCapabilities> {
    const entry = context.sessionId ? this.entries.get(context.sessionId) : undefined
    return capability(entry ? this.models.peek(entry.input) : undefined)
  }

  async start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    if (this.disposed) throw new ClaudeTransportError("session", "Claude transport disposed")
    if (this.entries.has(input.sessionId)) throw new ClaudeTransportError("session", "Claude session already attached")
    claudeBinding(input.credentials, input.owner)
    const session: HarnessSession = { directory: input.directory, locality: input.locality,
      binding: { sessionId: input.sessionId, workspaceId: input.workspaceId, directory: input.directory,
        connectionId: "claude-sdk", upstreamSessionId: `claude-sdk:${randomUUID()}` } }
    this.entries.set(input.sessionId, { input, session, broker, processes: new Set() })
    try { await broker.rebind(session.binding.upstreamSessionId) }
    catch (error) { this.entries.delete(input.sessionId); throw error }
    return session
  }

  async attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    if (this.disposed) throw new ClaudeTransportError("session", "Claude transport disposed")
    if (this.entries.has(input.sessionId)) throw new ClaudeTransportError("session", "Claude session already attached")
    claudeBinding(input.credentials, input.owner)
    const session: HarnessSession = { directory: input.directory, locality: input.locality, binding: input.binding }
    this.entries.set(input.sessionId, { input, session, broker, processes: new Set() })
    try { await broker.rebind(input.binding.upstreamSessionId) }
    catch (error) { this.entries.delete(input.sessionId); throw error }
    return session
  }

  private entry(session: HarnessSession): Entry {
    const entry = this.entries.get(session.binding.sessionId)
    if (!entry || entry.session.binding.sessionId !== session.binding.sessionId ||
      entry.session.binding.workspaceId !== session.binding.workspaceId ||
      entry.session.binding.connectionId !== session.binding.connectionId ||
      entry.session.binding.upstreamSessionId !== session.binding.upstreamSessionId) {
      throw new ClaudeTransportError("session", "Claude session is not attached")
    }
    return entry
  }

  private async launch(entry: Entry, turn: TurnInput, broker: TurnBroker, input: ClaudeTurnInput,
    runtime: ReturnType<typeof claudeTranslator>["runtime"], abort: AbortController) {
    const model = turn.model?.modelID ?? turn.prompt.model?.modelID ?? entry.input.model?.modelID ?? "default"
    const effort = claudeEffort(requiredClaudeEffort(turn.effort || turn.prompt.variant ? await this.models.load(entry.input, entry.input.sessionId) : [], model,
      turn.effort ?? turn.prompt.variant))
    return this.launcher.launch({ session: entry.session, input: entry.input, broker: entry.broker, turnBroker: broker,
      prompt: input.stream, abort, processes: entry.processes, runtime, assistantMessageId: turn.assistantMessageId, turnId: turn.turnId,
      model, effort, system: turn.system, agent: turn.prompt.agent, partialMessages: true })
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    if (entry.active) throw new ClaudeTransportError("session", "Claude turn already active")
    const input = new ClaudeTurnInput(await claudePrompt(turn, entry.input.directory))
    const { runtime, tasks } = claudeTranslator(turn.assistantMessageId, turn.todos)
    const abort = new AbortController()
    entry.active = { id: turn.turnId, abort, input }
    if (broker.signal.aborted) abort.abort()
    else broker.signal.addEventListener("abort", () => abort.abort(), { once: true })
    const aborted = () => entry.active?.abort.signal.aborted === true
    let settled = false
    let result: SDKMessage | undefined
    try {
      const stream = await this.launch(entry, turn, broker, input, runtime, abort)
      for await (const message of stream as AsyncIterable<SDKMessage | SDKActiveGoalMessage>) {
        const observed = await observeClaudeSessionMessage(message, entry.session, entry.broker, abort.signal)
        if (observed.kind === "active-goal") continue
        if (input.observe(observed.message)) continue
        if (observed.message.type === "result") { input.close(); result = observed.message; continue }
        for (const event of await translateClaude(observed.message, runtime, tasks, broker)) yield event
      }
      if (result) {
        for (const event of await translateClaude(result, runtime, tasks, broker)) yield event
      }
      settled = true
    } catch (error) {
      if (!aborted() || !(error instanceof AbortError)) throw error
    } finally {
      input.settle(settled ? "ended" : "failed")
      entry.active = undefined
      await Promise.all([...entry.processes].map(async (child) => { await child.retire({ at: Date.now() + 5_000, signal: new AbortController().signal }); entry.processes.delete(child) }))
    }
  }

  readonly steer = { steer: async (session: HarnessSession, ref: TurnRef, input: TurnInput) => {
    const active = this.entry(session).active
    return active?.id === ref.turnId ? active.input.steer(await claudePrompt(input, session.directory))
      : { ok: false as const, status: "no_active_turn" as const, message: "Claude turn is idle" }
  } }

  readonly goals = {
    read: async (session: HarnessSession) => this.entry(session).broker.goal.read(),
    start: async (session: HarnessSession, objective: string, broker: SessionBroker) => {
      const entry = this.entry(session)
      return this.goalRuntime.start(session, entry.input, broker, objective)
    },
    pause: async () => ({ ok: false as const, status: "unsupported" as const, message: "Claude Goal cannot pause" }),
    resume: async () => ({ ok: false as const, status: "unsupported" as const, message: "Claude Goal cannot resume" }),
    stop: async (session: HarnessSession) => {
      const entry = this.entry(session)
      return this.goalRuntime.stop(session, entry.input, entry.broker)
    },
    delete: async () => ({ ok: false as const, status: "unsupported" as const, message: "Claude Goal cannot delete" }),
  }

  readonly config = {
    read: async (session: HarnessSession) => this.entry(session).input.config,
    update: async (session: HarnessSession, update: import("@claxedo/agent-runtime-contract").SessionConfigUpdate) => {
      const entry = this.entry(session)
      const { permissionMode, model, permissionState, ...rest } = { ...entry.input.config, ...update }
      const config: StartInput["config"] = { ...rest,
        ...(permissionMode === null ? {} : { permissionMode }),
        ...(model === null ? {} : { model }),
        ...(permissionState === null ? {} : { permissionState }),
      }
      entry.input = { ...entry.input, config }
      return entry.input.config
    },
    options: async (target: import("../../contract").ConfigTarget, mode: "probe" | "peek") => {
      const input = "session" in target ? this.entry(target.session).input : target.draft
      const models = mode === "probe" ? await this.models.load(input, "session" in target ? target.session.binding.sessionId : undefined)
        : this.models.peek(input) ?? []
      return modelOptions(models, input.model?.modelID ?? "default")
    },
    permissionModes: async (target: import("../../contract").ConfigTarget) => {
      const selected = "session" in target ? this.entry(target.session).input.config.permissionMode : target.draft.config.permissionMode
      return { modes, currentModeId: selected ?? "default", appliesFrom: "next-turn" as const }
    },
    setPermissionMode: async (session: HarnessSession, modeId: string) => {
      const state = await this.config.permissionModes({ session })
      if (!state.modes.some((mode) => mode.id === modeId)) throw new ClaudeTransportError("configuration", `Unknown Claude permission mode ${modeId}`)
      const entry = this.entry(session)
      entry.input = { ...entry.input, config: { ...entry.input.config, permissionMode: modeId } }
      return { ...state, currentModeId: modeId }
    },
  }

  readonly commands = { list: async (target: import("../../contract").ConfigTarget) => {
    const input = "session" in target ? this.entry(target.session).input : target.draft
    const rows = await this.models.commands(input, "session" in target ? target.session.binding.sessionId : undefined)
    return rows.map((row) => ({ name: row.name, description: row.description, harnessPayload: row }))
  } }

  readonly agents = { list: async (target: import("../../contract").ConfigTarget) => {
    const input = "session" in target ? this.entry(target.session).input : target.draft
    const rows = await this.models.agents(input, "session" in target ? target.session.binding.sessionId : undefined)
    return rows.map((row) => ({ name: row.name, description: row.description, harnessPayload: row }))
  } }

  readonly naming = {}

  async cancel(session: HarnessSession, turn: TurnRef, deadline: Deadline) {
    const entry = this.entry(session)
    if (this.goalRuntime.turnId(entry.input.sessionId) === turn.turnId) {
      await this.goalRuntime.cancel(entry.input.sessionId)
      return { execution: "terminal" as const, cleanup: "owned" as const }
    }
    if (!entry.active || entry.active.id !== turn.turnId) return { execution: "terminal" as const, cleanup: "unknown" as const }
    entry.active.abort.abort()
    await Promise.all([...entry.processes].map((child) => child.retire(deadline)))
    return { execution: "unknown" as const, cleanup: "owned" as const }
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    if (update.credentials) { claudeBinding(update.credentials, entry.input.owner); entry.input = { ...entry.input, credentials: update.credentials } }
    if (update.projection) entry.input = { ...entry.input, projection: update.projection }
    return { state: "applied" }
  }

  async close(session: HarnessSession): Promise<void> {
    const entry = this.entry(session)
    await this.goalRuntime.cancel(entry.input.sessionId)
    entry.active?.abort.abort()
    await Promise.all([...entry.processes].map((child) => child.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })))
    this.entries.delete(session.binding.sessionId)
  }

  async dispose(): Promise<void> {
    for (const entry of this.entries.values()) await this.close(entry.session)
    this.disposed = true
  }
}
