import { randomUUID } from "node:crypto"
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk"
import { HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import type {
  AttachInput, BackgroundTaskRef, CapabilityContext, ConfigApplied, Deadline, HarnessServices, HarnessSession, HarnessTransport,
  RoutedEvent, SessionBroker, StartInput, TransportCapabilities, TransportConfigUpdate,
  TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { attachedSessionEntry, HarnessVersionGate, configOptionsPreview, mergeStartInput, selectedTurnAccount } from "../../contract"
import { withTurnAccount } from "../../translate/turn-account"
import { CLAUDE_CODE_RANGE } from "./cli-version"
import { claudeBinding } from "./credentials"
import { TransportError } from "../../contract/errors"
import { ClaudeGoals } from "./goals"
import type { ClaudeSdkOptions } from "./launch-context"
import { ClaudeModelCatalog, modelOptions } from "./models"
import { claudeModeState, requireClaudeMode, claudeModeId } from "./permissions"
import { ClaudeQueryLauncher } from "./query-options"
import { ClaudeTurns, type ClaudeEntry } from "./turns"

function capability(models?: readonly ModelInfo[]): TransportCapabilities {
  return {
    modelSelection: { status: "optional" }, effortLevels: models ? { status: "resolved", models: models.map((model) => ({
      modelID: model.value, levels: model.supportsEffort ? model.supportedEffortLevels ?? [] : [],
    })) } : { status: "unresolved", models: [] },
    instructionChannel: "turn-system-prompt",
    requests: { permissions: true, questions: true, elicitation: true }, subagents: true,
    goals: { implemented: true, available: true, actions: [], recovery: "blocked", optionalFields: ["iteration", "lastReason"] },
    todos: true, history: "store",
  }
}

export class ClaudeSdkTransport implements HarnessTransport {
  readonly kind = "claude-sdk" as const
  private readonly entries = new Map<string, ClaudeEntry>()
  private readonly models: ClaudeModelCatalog
  private readonly goalRuntime: ClaudeGoals
  private readonly launcher: ClaudeQueryLauncher
  private readonly turns: ClaudeTurns
  private disposed = false

  constructor(private readonly services: HarnessServices, private readonly options: ClaudeSdkOptions) {
    this.models = new ClaudeModelCatalog(services, options)
    this.launcher = new ClaudeQueryLauncher(services, options)
    this.turns = new ClaudeTurns(() => this.launcher, this.models, services.log, new HarnessVersionGate(CLAUDE_CODE_RANGE, "claude.sdk"))
    this.goalRuntime = new ClaudeGoals(this.turns)
  }

  async capabilities(context: CapabilityContext): Promise<TransportCapabilities> {
    const entry = context.sessionId ? this.entries.get(context.sessionId) : undefined
    return capability(entry ? await this.models.peek(entry.input) : undefined)
  }

  async start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    return this.bind(input, broker, `claude-sdk:${randomUUID()}`)
  }

  async attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    return this.bind(input, broker, input.binding.upstreamSessionId)
  }

  private async bind(input: StartInput, broker: SessionBroker, upstreamSessionId: string): Promise<HarnessSession> {
    if (this.disposed) throw new TransportError("claude", "session", "Claude transport disposed")
    if (this.entries.has(input.sessionId)) throw new TransportError("claude", "session", "Claude session already attached")
    claudeBinding(input.credentials)
    const session: HarnessSession = { directory: input.directory, locality: input.locality,
      binding: await broker.rebind(upstreamSessionId) }
    this.entries.set(input.sessionId, { input, revision: 0, session, broker: this.goalRuntime.watch(input.sessionId, broker) })
    return session
  }

  private entry(session: HarnessSession): ClaudeEntry {
    return attachedSessionEntry(this.entries, session, () => new TransportError("claude", "session", "Claude session is not attached"),
      (entry, current) => entry.session.binding.workspaceId === current.binding.workspaceId &&
        entry.session.binding.connectionId === current.binding.connectionId)
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    yield* withTurnAccount(this.turns.run(entry, turn, broker), selectedTurnAccount("claude", entry.input.credentials, HARNESS_TABLE.claude.providerIds))
  }

  readonly backgroundTasks = { stop: async (session: HarnessSession, task: BackgroundTaskRef) => this.turns.stopBackgroundTask(this.entry(session), task) }

  readonly steer = { steer: async (session: HarnessSession, ref: TurnRef, input: TurnInput) => this.turns.steer(this.entry(session), ref, input) }

  readonly goals = {
    read: async (session: HarnessSession) => this.entry(session).broker.goal.read(),
    start: async (session: HarnessSession, objective: string) => this.goalRuntime.start(this.entry(session), objective),
    pause: async () => ({ ok: false as const, status: "unsupported" as const, message: "Claude Goal cannot pause" }),
    resume: async () => ({ ok: false as const, status: "unsupported" as const, message: "Claude Goal cannot resume" }),
    stop: async (session: HarnessSession) => this.goalRuntime.stop(this.entry(session)),
    delete: async () => ({ ok: false as const, status: "unsupported" as const, message: "Claude Goal cannot delete" }),
  }

  readonly config = {
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


  async cancel(session: HarnessSession, turn: TurnRef, deadline: Deadline) {
    return this.turns.cancel(this.entry(session), turn, deadline)
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    if (update.credentials) claudeBinding(update.credentials)
    entry.input = mergeStartInput(entry.input, update)
    entry.revision += 1
    return { state: "applied" }
  }

  async close(session: HarnessSession): Promise<void> {
    const entry = this.entry(session)
    this.goalRuntime.forget(entry.input.sessionId)
    await this.turns.stop(entry)
    this.entries.delete(session.binding.sessionId)
  }

  async dispose(): Promise<void> {
    for (const entry of this.entries.values()) await this.close(entry.session)
    this.disposed = true
  }
}
