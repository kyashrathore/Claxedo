import { randomUUID } from "node:crypto"
import { AbortError, type EffortLevel, type ModelInfo, type SDKActiveGoalMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { HARNESS_TABLE, isHarnessEffortLevel } from "@claxedo/agent-runtime-contract"
import type {
  AttachInput, CapabilityContext, ConfigApplied, Deadline, HarnessServices, HarnessSession, HarnessTransport,
  RoutedEvent, SessionBroker, StartInput, TransportCapabilities, TransportConfigUpdate,
  TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { applySessionConfigUpdate, attachedSessionEntry, configOptionsPreview, mergeStartInput, selectedTurnAccount } from "../../contract"
import { withTurnAccount } from "../../translate/turn-account"
import { claudePrompt } from "./attachments"
import { claudeBinding } from "./credentials"
import { TransportError } from "../../contract/errors"
import { ClaudeGoals } from "./goals"
import type { ClaudeSdkOptions } from "./launch-context"
import { ClaudeModelCatalog, modelOptions, requiredClaudeEffort } from "./models"
import { claudeModeState, requireClaudeMode, claudeModeId } from "./permissions"
import { claudeStreamEndedWithoutResult } from "./errors"
import { ClaudeProcess } from "./process"
import { ClaudeQueryLauncher } from "./query-options"
import { observeClaudeSessionMessage } from "./session-events"
import { ClaudeTurnInput } from "./turn-input"
import { claudeTranslator, translateClaude } from "./events"
import { ClaudeMirroredUsage } from "./mirrored-usage"

type Entry = {
  input: StartInput
  session: HarnessSession
  broker: SessionBroker
  processes: Set<ClaudeProcess>
  active?: { id: string; abort: AbortController; input?: ClaudeTurnInput; launched: boolean }
}

function claudeEffort(value: string | null | undefined): EffortLevel | undefined {
  if (!value) return undefined
  if (!isHarnessEffortLevel(value)) throw new TransportError("claude", "configuration", `Unsupported Claude effort ${value}`)
  return value
}

function capability(models?: readonly ModelInfo[]): TransportCapabilities {
  return {
    modelSelection: { status: "optional" }, effortLevels: models ? { status: "resolved", models: models.map((model) => ({
      modelID: model.value, levels: model.supportsEffort ? model.supportedEffortLevels ?? [] : [],
    })) } : { status: "unresolved", models: [] },
    instructionChannel: "turn-system-prompt", configOwner: "runtime",
    requests: { permissions: true, questions: true, elicitation: false }, subagents: true,
    goals: { implemented: true, available: true, actions: [], recovery: "blocked", optionalFields: ["iteration", "lastReason"] },
    todos: true, history: "store", titles: "harness",
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
    return capability(entry ? await this.models.peek(entry.input) : undefined)
  }

  async start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    if (this.disposed) throw new TransportError("claude", "session", "Claude transport disposed")
    if (this.entries.has(input.sessionId)) throw new TransportError("claude", "session", "Claude session already attached")
    claudeBinding(input.credentials)
    const session: HarnessSession = { directory: input.directory, locality: input.locality,
      binding: await broker.rebind(`claude-sdk:${randomUUID()}`) }
    this.entries.set(input.sessionId, { input, session, broker, processes: new Set() })
    return session
  }

  async attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    if (this.disposed) throw new TransportError("claude", "session", "Claude transport disposed")
    if (this.entries.has(input.sessionId)) throw new TransportError("claude", "session", "Claude session already attached")
    claudeBinding(input.credentials)
    const session: HarnessSession = { directory: input.directory, locality: input.locality,
      binding: await broker.rebind(input.binding.upstreamSessionId) }
    this.entries.set(input.sessionId, { input, session, broker, processes: new Set() })
    return session
  }

  private entry(session: HarnessSession): Entry {
    return attachedSessionEntry(this.entries, session, () => new TransportError("claude", "session", "Claude session is not attached"),
      (entry, current) => entry.session.binding.workspaceId === current.binding.workspaceId &&
        entry.session.binding.connectionId === current.binding.connectionId)
  }

  private async launch(entry: Entry, turn: TurnInput, broker: TurnBroker, input: ClaudeTurnInput,
    mirroredUsage: ClaudeMirroredUsage, abort: AbortController) {
    const model = turn.model?.modelID ?? "default"
    const effort = claudeEffort(requiredClaudeEffort(turn.effort ? await this.models.load(entry.input, entry.input.sessionId) : [], model, turn.effort))
    if (abort.signal.aborted || !entry.active) return undefined
    entry.active.launched = true
    return this.launcher.launch({ session: entry.session, input: entry.input, broker: entry.broker, turnBroker: broker,
      prompt: input.stream, abort, processes: entry.processes, mirroredUsage, turnId: turn.turnId,
      model, effort, system: turn.system, agent: turn.prompt.agent, partialMessages: true })
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    yield* withTurnAccount(this.run(entry, turn, broker), selectedTurnAccount("claude", entry.input.credentials, HARNESS_TABLE.claude.providerIds))
  }

  private async *run(entry: Entry, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    if (entry.active) throw new TransportError("claude", "session", "Claude turn already active")
    const abort = new AbortController()
    const active: NonNullable<Entry["active"]> = { id: turn.turnId, abort, launched: false }
    entry.active = active
    const onAbort = () => abort.abort()
    if (broker.signal.aborted) onAbort()
    else broker.signal.addEventListener("abort", onAbort, { once: true })
    const aborted = () => entry.active?.abort.signal.aborted === true
    let settled = false
    try {
      if (abort.signal.aborted) return
      const input = new ClaudeTurnInput(await claudePrompt(turn, entry.input.directory))
      active.input = input
      settled = yield* this.translated(entry, turn, broker, input, abort)
    } catch (error) {
      if (!aborted() || !(error instanceof AbortError)) throw error
    } finally {
      broker.signal.removeEventListener("abort", onAbort)
      active.input?.settle(settled ? "ended" : "failed")
      entry.active = undefined
      await Promise.all([...entry.processes].map(async (child) => { await child.retire({ at: Date.now() + 5_000, signal: new AbortController().signal }); entry.processes.delete(child) }))
    }
  }

  private async *translated(entry: Entry, turn: TurnInput, broker: TurnBroker, input: ClaudeTurnInput, abort: AbortController): AsyncGenerator<RoutedEvent, boolean> {
    const { runtime, tasks } = claudeTranslator(turn.assistantMessageId, turn.todos)
    const mirroredUsage = new ClaudeMirroredUsage(runtime, { broker: entry.broker, assistantMessageId: turn.assistantMessageId, directory: entry.input.directory })
    try {
      const stream = await this.launch(entry, turn, broker, input, mirroredUsage, abort)
      if (!stream) return false
      let result: SDKMessage | undefined
      for await (const message of stream as AsyncIterable<SDKMessage | SDKActiveGoalMessage>) {
        const observed = await observeClaudeSessionMessage(message, entry, entry.broker, abort.signal)
        if (observed.kind === "active-goal") continue
        if (input.observe(observed.message)) continue
        if (observed.message.type === "result") { input.close(); result = observed.message; continue }
        for (const event of await translateClaude(observed.message, runtime, tasks, broker)) yield event
      }
      if (result) {
        mirroredUsage.release()
        for (const event of await translateClaude(result, runtime, tasks, broker)) yield event
      }
      if (!result && !abort.signal.aborted) throw claudeStreamEndedWithoutResult()
      return true
    } finally { mirroredUsage.release() }
  }

  readonly steer = { steer: async (session: HarnessSession, ref: TurnRef, input: TurnInput) => {
    const active = this.entry(session).active
    return active?.id === ref.turnId && active.input ? active.input.steer(await claudePrompt(input, session.directory))
      : { ok: false as const, status: "no_active_turn" as const, message: "Claude turn is idle" }
  } }

  readonly goals = {
    read: async (session: HarnessSession) => this.entry(session).broker.goal.read(),
    start: async (session: HarnessSession, objective: string, broker: SessionBroker) =>
      this.goalRuntime.start(this.entry(session), broker, objective),
    pause: async () => ({ ok: false as const, status: "unsupported" as const, message: "Claude Goal cannot pause" }),
    resume: async () => ({ ok: false as const, status: "unsupported" as const, message: "Claude Goal cannot resume" }),
    stop: async (session: HarnessSession) => {
      const entry = this.entry(session)
      return this.goalRuntime.stop(entry, entry.broker)
    },
    delete: async () => ({ ok: false as const, status: "unsupported" as const, message: "Claude Goal cannot delete" }),
  }

  readonly config = {
    read: async (session: HarnessSession) => this.entry(session).broker.config(),
    update: async (session: HarnessSession, update: import("@claxedo/agent-runtime-contract").SessionConfigUpdate) => {
      const entry = this.entry(session)
      if (update.permissionMode) requireClaudeMode(update.permissionMode)
      return applySessionConfigUpdate(entry.broker.config(), update)
    },
    options: async (target: import("../../contract").ConfigPreviewTarget, mode: "probe" | "peek") => {
      const input = "session" in target ? this.entry(target.session).input : target.draft
      const current = "session" in target ? target.model?.modelID ?? this.entry(target.session).broker.config().model?.modelID
        : target.draft.config.model?.modelID
      const models = mode === "probe" ? await this.models.load(input, "session" in target ? target.session.binding.sessionId : undefined)
        : await this.models.peek(input) ?? []
      return configOptionsPreview(modelOptions(models, current ?? "default"))
    },
    permissionModes: async (target: import("../../contract").ConfigTarget) => {
      const selected = "session" in target ? this.entry(target.session).broker.config().permissionMode : target.draft.config.permissionMode
      return claudeModeState(claudeModeId(selected))
    },
    setPermissionMode: async (session: HarnessSession, modeId: string) => {
      this.entry(session)
      requireClaudeMode(modeId)
      return claudeModeState(modeId)
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
      const settlement = await this.goalRuntime.cancel(entry.input.sessionId)
      if (settlement?.state === "cancelled" || settlement?.state === "completed") return { execution: "terminal" as const, cleanup: "unknown" as const }
      return { execution: "unknown" as const, cleanup: "unknown" as const,
        ...(settlement?.state === "failed" ? { error: { code: "internal_error" as const, message: settlement.error } } : {}) }
    }
    if (!entry.active || entry.active.id !== turn.turnId) return { execution: "terminal" as const, cleanup: "unknown" as const }
    entry.active.abort.abort()
    if (!entry.active.launched) return { execution: "terminal" as const, cleanup: "verified_clear" as const }
    await Promise.all([...entry.processes].map((child) => child.retire(deadline)))
    return { execution: "unknown" as const, cleanup: "unknown" as const }
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    if (update.credentials) claudeBinding(update.credentials)
    entry.input = mergeStartInput(entry.input, update)
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
