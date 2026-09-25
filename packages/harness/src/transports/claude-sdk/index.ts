import path from "node:path"
import { randomUUID } from "node:crypto"
import { query, type CanUseTool, type EffortLevel, type McpServerConfig, type SDKMessage, type Query } from "@anthropic-ai/claude-agent-sdk"
import { createAgentEventRuntime, type AgentEventRuntime } from "@claxedo/agent-event-runtime"
import { claudeChildCorrelationKey, claudeSdkAdapter, claudeSubagentObservations, createClaudeTaskLedger, foldNestedSubagentFrame,
  type ClaudeSdkAdapterState, type ClaudeTaskLedger } from "@claxedo/agent-event-runtime/harnesses/claude"
import { isHarnessEffortLevel } from "@claxedo/agent-runtime-contract"
import type {
  AttachInput, CapabilityContext, ConfigApplied, Deadline, HarnessServices, HarnessSession, HarnessTransport,
  RoutedEvent, SessionBroker, StartInput, TransportCapabilities, TransportConfigUpdate,
  TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { claudePlugins, composeClaudeConfigHome } from "../../profiles/claude-code"
import { claudeBinding, claudeEnvironment } from "./credentials"
import { ClaudeTransportError } from "./errors"
import { ClaudeProcess } from "./process"
import { ClaudeTurnInput } from "./turn-input"

type Entry = {
  input: StartInput
  session: HarnessSession
  broker: SessionBroker
  processes: Set<ClaudeProcess>
  active?: { id: string; abort: AbortController; input: ClaudeTurnInput }
}

export type ClaudeSdkOptions = { executable: string; configRoot: string; userConfigRoot: string; env?: NodeJS.ProcessEnv }

const protocolPermissionMap = {
  allowOnce: "allow_once", allowAlways: "allow_always", rejectOnce: "deny", rejectAlways: "reject_always",
  allow: "allow", deny: "deny",
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
  ],
} as const

function claudePromptText(turn: TurnInput): string {
  return [turn.system, turn.prompt.system, ...turn.prompt.parts.map((part) => {
    if (part.type !== "text") throw new ClaudeTransportError("configuration", "Claude turn attachment delivery is unavailable")
    return part.text
  })].filter(Boolean).join("\n\n")
}

function claudeEffort(value: string | null | undefined): EffortLevel | undefined {
  if (!value) return undefined
  if (!isHarnessEffortLevel(value)) throw new ClaudeTransportError("configuration", `Unsupported Claude effort ${value}`)
  return value
}

function mcpServers(input: StartInput, services: HarnessServices): Record<string, McpServerConfig> {
  const projected = [...input.projection.mcpServers]
  const firstParty = services.firstPartyMcp(input.sessionId, input.locality)
  if (firstParty) projected.push({ ...firstParty, origin: "first-party" })
  return Object.fromEntries(projected.map((server): [string, McpServerConfig] => server.kind === "stdio"
    ? [server.name, { type: "stdio", command: server.command, args: [...server.args ?? []], env: server.env ? { ...server.env } : undefined }]
    : [server.name, { type: server.kind, url: server.url, headers: server.headers ? { ...server.headers } : undefined }]))
}

function capability(): TransportCapabilities {
  return {
    modelSelection: { status: "optional" }, effortLevels: { status: "unresolved", models: [] },
    instructionChannel: "turn-system-prompt", configOwner: "runtime",
    requests: { permissions: true, questions: true, elicitation: false }, steer: true, subagents: true,
    goals: { implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [] },
    fork: false, agents: false, commands: false, todos: true, history: "store", titles: "side-request",
    pluginIntake: { mcp: "session", skills: "plugin-dir" }, mcpTransports: { stdio: true, http: true, sse: true },
    timing: { model: "next-turn", effort: "next-turn", permissionMode: "next-turn", credentials: "next-turn" },
  }
}

export class ClaudeSdkTransport implements HarnessTransport {
  readonly kind = "claude-sdk" as const
  private readonly entries = new Map<string, Entry>()
  private disposed = false

  constructor(private readonly services: HarnessServices, private readonly options: ClaudeSdkOptions) {}

  async capabilities(_context: CapabilityContext): Promise<TransportCapabilities> { return capability() }

  async start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    if (this.disposed) throw new ClaudeTransportError("session", "Claude transport disposed")
    if (this.entries.has(input.sessionId)) throw new ClaudeTransportError("session", "Claude session already attached")
    claudeBinding(input.credentials, input.owner)
    const session: HarnessSession = { directory: input.directory, locality: input.locality,
      binding: { sessionId: input.sessionId, workspaceId: path.resolve(input.directory), directory: input.directory,
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
    if (!entry || entry.session !== session) throw new ClaudeTransportError("session", "Claude session is not attached")
    return entry
  }

  private async permission(entry: Entry, turn: TurnInput, broker: TurnBroker, toolName: string,
    toolInput: Record<string, unknown>, options: Parameters<CanUseTool>[2]) {
    if (options.signal.aborted || broker.signal.aborted) return { behavior: protocolPermissionMap.deny, message: "Turn cancelled" }
    const requestId = randomUUID()
    if (toolName === "AskUserQuestion") {
      const questions = toolInput.questions
      if (!Array.isArray(questions) || !questions.length) throw new ClaudeTransportError("protocol", "Claude question has no choices")
      const answer = await broker.ask({ kind: "question", requestId, question: {
        id: requestId, sessionID: entry.input.sessionId, questions, harnessPayload: { toolName, toolInput },
      } })
      if (answer.kind !== "answers") return { behavior: protocolPermissionMap.deny, message: "Question dismissed" }
      return { behavior: protocolPermissionMap.allow, updatedInput: { ...toolInput, answers: Object.fromEntries(answer.answers.map((value, index) => [questions[index]?.question, value.join(", ")])) } }
    }
    const answer = await broker.ask({ kind: "permission", requestId, grantKey: JSON.stringify({ toolName, toolInput, directory: entry.input.directory,
      mode: entry.input.config.permissionMode, blockedPath: options.blockedPath, agentID: options.agentID }),
      permission: { id: requestId, sessionID: entry.input.sessionId, permission: toolName, title: options.title ?? toolName,
        patterns: [], always: [], metadata: { input: toolInput, description: options.description ?? "", turnId: turn.turnId },
        harnessPayload: { toolName, toolInput, suggestions: options.suggestions } },
      options: protocolPermissionMap.options,
    })
    if (options.signal.aborted || broker.signal.aborted) return { behavior: protocolPermissionMap.deny, message: "Turn cancelled" }
    if (answer.kind !== "permission") return { behavior: protocolPermissionMap.deny, message: "Permission dismissed" }
    if (answer.decision === protocolPermissionMap.allowOnce) return { behavior: protocolPermissionMap.allow, updatedInput: toolInput }
    if (answer.decision === protocolPermissionMap.allowAlways) return { behavior: protocolPermissionMap.allow, updatedInput: toolInput }
    return { behavior: protocolPermissionMap.deny, message: "Permission denied", interrupt: answer.decision === protocolPermissionMap.rejectAlways }
  }

  private async launch(entry: Entry, turn: TurnInput, broker: TurnBroker, input: ClaudeTurnInput): Promise<Query> {
    const binding = claudeBinding(entry.input.credentials, entry.input.owner)
    const home = binding ? await composeClaudeConfigHome(path.join(this.options.configRoot, entry.input.sessionId), this.options.userConfigRoot) : undefined
    const env = claudeEnvironment(this.options.env ?? process.env, binding, home)
    const abort = new AbortController()
    entry.active = { id: turn.turnId, abort, input }
    if (broker.signal.aborted) abort.abort()
    else broker.signal.addEventListener("abort", () => abort.abort(), { once: true })
    const effort = claudeEffort(turn.effort)
    return query({ prompt: input.stream, options: {
      cwd: entry.input.directory, pathToClaudeCodeExecutable: this.options.executable,
      env, model: turn.model?.modelID ?? entry.input.model?.modelID ?? "default",
      ...(effort ? { effort } : {}),
      ...(turn.system ? { systemPrompt: { type: "preset", preset: "claude_code", append: turn.system } } : {}),
      ...(entry.session.binding.upstreamSessionId.startsWith("claude-sdk:") ? {} : { resume: entry.session.binding.upstreamSessionId }),
      includePartialMessages: true, extraArgs: { "replay-user-messages": null },
      settingSources: ["user", "project", "local"], plugins: claudePlugins(entry.input.projection),
      mcpServers: mcpServers(entry.input, this.services), abortController: abort,
      canUseTool: (name, payload, options) => this.permission(entry, turn, broker, name, payload, options),
      spawnClaudeCodeProcess: (options) => {
        const child = new ClaudeProcess(this.services, options, entry.input.sessionId)
        entry.processes.add(child)
        return child
      },
    } })
  }

  private async translate(message: SDKMessage, runtime: AgentEventRuntime<ClaudeSdkAdapterState>, tasks: ClaudeTaskLedger,
    broker: TurnBroker): Promise<RoutedEvent[]> {
    const folded = foldNestedSubagentFrame(message, tasks)
    for (const observation of claudeSubagentObservations(folded, tasks)) await broker.observeSubagent(observation)
    const key = claudeChildCorrelationKey(folded)
    return runtime.ingest({ source: "claude.sdk", method: `claude/${message.type}`, payload: folded }).events.map((event) => ({
      event, route: key ? { kind: "child", correlationKey: key } : { kind: "parent" },
      source: { dir: "in", method: `claude.${message.type}` },
    }))
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    if (entry.active) throw new ClaudeTransportError("session", "Claude turn already active")
    const input = new ClaudeTurnInput(claudePromptText(turn))
    const runtime = createAgentEventRuntime({ harness: "claude", threadId: turn.assistantMessageId, adapter: claudeSdkAdapter() })
    const tasks = createClaudeTaskLedger()
    const aborted = () => entry.active?.abort.signal.aborted === true
    let settled = false
    let result: SDKMessage | undefined
    let upstreamSessionId: string | undefined
    try {
      const stream = await this.launch(entry, turn, broker, input)
      for await (const message of stream) {
        if (input.observe(message)) continue
        if (message.type === "result") { input.close(); result = message; continue }
        if ("session_id" in message && typeof message.session_id === "string" && message.session_id &&
          entry.session.binding.upstreamSessionId !== message.session_id) {
          entry.session.binding.upstreamSessionId = message.session_id
          upstreamSessionId = message.session_id
        }
        for (const event of await this.translate(message, runtime, tasks, broker)) yield event
      }
      if (result) {
        for (const event of runtime.ingest({ source: "claude.sdk", method: "claude/result", payload: result }).events) yield { event, route: { kind: "parent" } }
      }
      if (upstreamSessionId) await entry.broker.rebind(upstreamSessionId)
      settled = true
    } catch (error) {
      if (!aborted()) throw error
    } finally {
      input.settle(settled ? "ended" : "failed")
      entry.active = undefined
      await Promise.all([...entry.processes].map(async (child) => { await child.retire({ at: Date.now() + 5_000, signal: new AbortController().signal }); entry.processes.delete(child) }))
    }
  }

  readonly steer = { steer: async (session: HarnessSession, ref: TurnRef, input: TurnInput) => {
    const active = this.entry(session).active
    return active?.id === ref.turnId ? active.input.steer(claudePromptText(input)) : { ok: false as const, status: "no_active_turn" as const, message: "Claude turn is idle" }
  } }

  async cancel(session: HarnessSession, turn: TurnRef, deadline: Deadline) {
    const entry = this.entry(session)
    if (!entry.active || entry.active.id !== turn.turnId) return { execution: "terminal" as const, cleanup: "unknown" as const }
    entry.active.abort.abort()
    await Promise.all([...entry.processes].map((child) => child.retire(deadline)))
    return { execution: "unknown" as const, cleanup: "owned" as const }
  }

  async configure(update: TransportConfigUpdate): Promise<ConfigApplied> {
    if (update.credentials && this.entries.size !== 1) return { state: "refused", reason: "Credential update requires exactly one attached session" }
    for (const entry of this.entries.values()) {
      if (update.credentials) { claudeBinding(update.credentials, entry.input.owner); entry.input = { ...entry.input, credentials: update.credentials } }
      if (update.projection) entry.input = { ...entry.input, projection: update.projection }
    }
    return { state: "applied" }
  }

  async close(session: HarnessSession): Promise<void> {
    const entry = this.entry(session)
    entry.active?.abort.abort()
    await Promise.all([...entry.processes].map((child) => child.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })))
    this.entries.delete(session.binding.sessionId)
  }

  async dispose(): Promise<void> {
    for (const entry of this.entries.values()) await this.close(entry.session)
    this.disposed = true
  }
}
