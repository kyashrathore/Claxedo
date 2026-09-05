import type {
  AgentAgent,
  AgentCommand,
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentRuntimeStreamEvent,
  AgentSession,
  PromptInput,
  SessionConfig,
  SessionConfigUpdate,
} from "@claxedo/agent-sdk-runtime"
import type { AgentHarnessAdapter, AgentMessagePage, AgentMessagePageInput } from "@claxedo/agent-sdk-runtime/adapters"
import { harnessCapabilities } from "@claxedo/agent-sdk-runtime/capabilities"
import type { AgentExecutionBinding, AgentQuestionAnswer } from "@claxedo/agent-runtime-contract"
import type { Mcp } from "@opencode-ai/plugin"
import type { OpenCodeRuntime } from "./runtime"
import { authorizeWorkspace, type WorkspaceScope } from "./scope"
import type { ProjectedEvent } from "./event-pump"
import { openCodePartId, type SessionMessage, type SessionSummary } from "./session-port"

type AdapterOptions = Readonly<{
  runtime: OpenCodeRuntime
  workspaceID: string
  /** The workspace checkout every workspace-scoped SDK call is authorized against. */
  directory: string
}>

type RuntimeDirectory = string | undefined

function session(row: SessionSummary): AgentSession {
  return {
    id: row.id,
    ...(row.title === undefined ? {} : { title: row.title }),
    ...(row.parentID === undefined ? {} : { parentID: row.parentID }),
    directory: row.directory,
    time: { created: row.createdAt, updated: row.updatedAt },
  }
}

function contentPart(sessionID: string, messageID: string, item: unknown, ordinal: number): unknown {
  if (!item || typeof item !== "object") return item
  const row = item as Record<string, unknown>
  return {
    ...row,
    id: openCodePartId(messageID, "assistant", row, ordinal),
    sessionID,
    messageID,
  }
}

function message(sessionID: string, row: SessionMessage): AgentMessage {
  const parts = row.type === "user"
    ? [{ id: openCodePartId(row.id, "user", {}, 0), sessionID, messageID: row.id, type: "text", text: row.text ?? "" }]
    : (row.content ?? []).map((part, index) => contentPart(sessionID, row.id, part, index))
  return {
    info: {
      id: row.id,
      role: row.type,
      sessionID,
      time: {
        created: row.createdAt,
        ...(row.completedAt === undefined ? {} : { completed: row.completedAt }),
      },
      ...(row.agent === undefined ? {} : { agent: row.agent }),
      ...(row.model === undefined ? {} : { providerID: row.model.providerID, modelID: row.model.id }),
      ...(row.metadata === undefined ? {} : { harnessPayload: row.metadata }),
    },
    parts: parts as AgentMessage["parts"],
  }
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function stringList(input: unknown): string[] {
  return Array.isArray(input) ? input.filter((value): value is string => typeof value === "string" && value.length > 0) : []
}

function stringRecord(input: unknown): Record<string, string> | undefined {
  const row = record(input)
  const entries = Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return entries.length === Object.keys(row).length && entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * The runtime snapshot's MCP servers (`type: "stdio" | "remote"`, the
 * `UserMcpServer` shape every harness receives) in the SDK's own config
 * shape. A snapshot entry of neither type is a contract violation, not a
 * server to skip silently.
 */
function snapshotMcpServers(input: Record<string, unknown>): Record<string, Mcp.ServerConfig> {
  const servers: Record<string, Mcp.ServerConfig> = {}
  for (const [name, value] of Object.entries(input)) {
    const row = record(value)
    const disabled = row.disabled === true ? { disabled: true } : {}
    const environment = stringRecord(row.env)
    const headers = stringRecord(row.headers)
    if (row.type === "stdio" && typeof row.command === "string" && row.command.length > 0) {
      servers[name] = { type: "local", command: [row.command, ...stringList(row.args)], ...(environment ? { environment } : {}), ...disabled }
      continue
    }
    if (row.type === "remote" && typeof row.url === "string" && row.url.length > 0) {
      servers[name] = { type: "remote", url: row.url, ...(headers ? { headers } : {}), ...disabled }
      continue
    }
    throw new Error(`OpenCode MCP server ${name} must be a stdio server with a command or a remote server with a url`)
  }
  return servers
}

/** Agent Plugins already project their servers in the SDK config shape; only the discriminator is checked. */
function pluginMcpServers(input: Record<string, unknown>): Record<string, Mcp.ServerConfig> {
  const servers: Record<string, Mcp.ServerConfig> = {}
  for (const [name, value] of Object.entries(input)) {
    const row = record(value)
    const local = row.type === "local" && stringList(row.command).length > 0
    const remote = row.type === "remote" && typeof row.url === "string" && row.url.length > 0
    if (!local && !remote) throw new Error(`Agent Plugins OpenCode MCP server ${name} must be a local or remote server`)
    servers[name] = row as unknown as Mcp.ServerConfig
  }
  return servers
}

function eventSessionID(event: ProjectedEvent): string | undefined {
  const data = record(event.data)
  return typeof data.sessionID === "string" ? data.sessionID : undefined
}

function terminal(event: ProjectedEvent, sessionID: string): AgentRuntimeStreamEvent | undefined {
  const data = record(event.data)
  if (event.type === "session.execution.succeeded") return { type: "finish", sessionId: sessionID, harness: "opencode" }
  if (event.type === "session.execution.interrupted") return { type: "finish", sessionId: sessionID, harness: "opencode" }
  if (event.type === "session.execution.failed") {
    const error = data.error
    const reason = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error)
    return { type: "error", error: reason || "OpenCode execution failed", harness: "opencode" }
  }
  return undefined
}

function projectTurnEvent(event: ProjectedEvent, sessionID: string): AgentRuntimeStreamEvent | undefined {
  const data = record(event.data)
  if (event.type === "session.execution.started") return { type: "session-status", status: "busy", harness: "opencode" }
  if (event.type === "session.text.delta" && typeof data.delta === "string") {
    return { type: "text-delta", delta: data.delta, harness: "opencode" }
  }
  if (event.type === "session.reasoning.delta" && typeof data.delta === "string") {
    return { type: "thinking-delta", delta: data.delta, harness: "opencode" }
  }
  if (event.type === "session.tool.called" && typeof data.id === "string" && typeof data.name === "string") {
    return { type: "tool-start", toolCallId: data.id, toolName: data.name, harness: "opencode" }
  }
  if (event.type === "session.tool.success" && typeof data.id === "string") {
    return { type: "tool-status", toolCallId: data.id, status: "completed", harness: "opencode" }
  }
  if (event.type === "session.tool.failed" && typeof data.id === "string") {
    return { type: "tool-error", toolCallId: data.id, error: JSON.stringify(data.error), harness: "opencode" }
  }
  return terminal(event, sessionID)
}

function prompt(input: PromptInput) {
  const text: string[] = []
  const files: Array<{ ref: string; name?: string }> = []
  for (const item of input.parts) {
    const row = record(item)
    if (row.type === "text" && typeof row.text === "string") {
      text.push(row.text)
      continue
    }
    if (row.type === "file" && typeof row.url === "string") {
      files.push({ ref: row.url, ...(typeof row.filename === "string" ? { name: row.filename } : {}) })
      continue
    }
    throw new Error(`OpenCode SDK prompt part ${String(row.type ?? "unknown")} has no canonical V2 mapping`)
  }
  return {
    text: text.join("\n"),
    ...(input.userMessageId ? { id: input.userMessageId } : {}),
    ...(files.length ? { files } : {}),
    delivery: "steer" as const,
  }
}

/** Split the host-wide `session:request` ids this adapter mints back into their halves. */
function scopedId(id: string, what: string) {
  const separator = id.indexOf(":")
  if (separator < 1) throw new Error(`OpenCode ${what} requires a session-scoped request id`)
  return { sessionID: id.slice(0, separator), requestID: id.slice(separator + 1) }
}

function formQuestions(fields: readonly unknown[] | undefined): AgentQuestion["questions"] {
  return (fields ?? []).map((field) => {
    const row = record(field)
    const key = typeof row.key === "string" ? row.key : typeof row.name === "string" ? row.name : "answer"
    const options = Array.isArray(row.options) ? row.options : []
    return {
      header: typeof row.label === "string" ? row.label : key,
      question: typeof row.description === "string" ? row.description : typeof row.label === "string" ? row.label : key,
      options: options.map((option) => {
        const value = record(option)
        const label = typeof value.label === "string" ? value.label : typeof value.value === "string" ? value.value : String(option)
        return { label, description: typeof value.description === "string" ? value.description : "" }
      }),
      ...(row.multiple === true ? { multiple: true } : {}),
      ...(options.length === 0 ? { custom: true } : {}),
    }
  })
}

class EventQueue {
  private values: ProjectedEvent[] = []
  private waiters: Array<(event: ProjectedEvent) => void> = []

  push(event: ProjectedEvent) {
    const waiter = this.waiters.shift()
    if (waiter) waiter(event)
    else this.values.push(event)
  }

  next(): Promise<ProjectedEvent> {
    const value = this.values.shift()
    if (value) return Promise.resolve(value)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

/**
 * The one native OpenCode harness: backed exclusively by the process-owned
 * public embedded SDK. There is no URL, server process, raw router, or retry
 * transport in this rail, and no OpenCode-specific route surface beside it —
 * the host talks to it through the same adapter contract as every other
 * harness, including `applyConfig` for the runtime snapshot's MCP servers and
 * the Agent Plugins launch document.
 */
export class OpenCodeSdkHarnessAdapter implements AgentHarnessAdapter {
  /** Session config is durable in the Claxedo store; the SDK receives it per turn. */
  readonly sessionConfigOwner = "runtime" as const
  private readonly runtime: OpenCodeRuntime
  private readonly workspaceID: string
  private readonly directory: string
  private readonly configs = new Map<string, SessionConfig>()

  constructor(options: AdapterOptions) {
    this.runtime = options.runtime
    this.workspaceID = options.workspaceID
    this.directory = options.directory
  }

  private scope(directory: RuntimeDirectory): WorkspaceScope {
    if (!directory) throw new Error("OpenCode SDK operations require a workspace directory")
    return authorizeWorkspace({ workspaceID: this.workspaceID, directory })
  }

  readHarnessCapabilities() {
    return harnessCapabilities({
      harness: "opencode",
      abort: true,
      reconnect: false,
      replay: true,
      permissions: true,
      questions: true,
      todos: false,
      commands: true,
      fork: true,
      revert: false,
      unrevert: false,
      configOptions: false,
      subagents: false,
      goals: false,
    })
  }

  async listSessions(directory: RuntimeDirectory) {
    return (await this.runtime.sessions.list(this.scope(directory))).sessions.map(session)
  }

  async getSession(binding: AgentExecutionBinding) {
    try {
      return session(await this.runtime.sessions.get(this.scope(binding.directory), binding.sessionId))
    } catch (error) {
      if (record(error)._tag === "SessionNotFoundError") return null
      throw error
    }
  }

  async createSession(directory: RuntimeDirectory, title?: string, id?: string) {
    const created = await this.runtime.sessions.create(this.scope(directory), { ...(id ? { id } : {}), ...(title ? { title } : {}) })
    return { id: created.id }
  }

  async updateSession(binding: AgentExecutionBinding, updates: { title?: string; time?: { archived?: number } }) {
    const scope = this.scope(binding.directory)
    if (updates.title !== undefined) await this.runtime.sessions.rename(scope, binding.sessionId, updates.title)
    // Archive is a Claxedo projection concern. It must not be written into the
    // SDK and allowed to become a second authority.
    return session(await this.runtime.sessions.get(scope, binding.sessionId))
  }

  async deleteSession(binding: AgentExecutionBinding) {
    await this.runtime.sessions.remove(this.scope(binding.directory), binding.sessionId)
    this.configs.delete(binding.sessionId)
  }

  async getSessionConfig(binding: AgentExecutionBinding): Promise<SessionConfig> {
    return this.configs.get(binding.sessionId) ?? { harness: { id: "opencode", access: "native" }, variant: null, agent: null }
  }

  async updateSessionConfig(binding: AgentExecutionBinding, update: SessionConfigUpdate): Promise<SessionConfig> {
    const previous = await this.getSessionConfig(binding)
    const next: SessionConfig = {
      harness: update.harness ?? previous.harness,
      model: update.model === undefined ? previous.model : update.model ?? undefined,
      variant: update.variant === undefined ? previous.variant : update.variant,
      agent: update.agent === undefined ? previous.agent : update.agent,
    }
    const scope = this.scope(binding.directory)
    if (update.agent) await this.runtime.sessions.switchAgent(scope, binding.sessionId, update.agent)
    if (update.model) await this.runtime.sessions.switchModel(scope, binding.sessionId, update.model)
    this.configs.set(binding.sessionId, next)
    return next
  }

  executeTurn(binding: AgentExecutionBinding, input: PromptInput): AsyncIterable<AgentRuntimeStreamEvent> {
    return this.turn(binding.sessionId, input, binding.directory)
  }

  private async *turn(id: string, input: PromptInput, directory: RuntimeDirectory): AsyncIterable<AgentRuntimeStreamEvent> {
    const scope = this.scope(directory)
    const queue = new EventQueue()
    const unsubscribe = this.runtime.events.subscribe((event) => {
      // Execution lifecycle events are session-scoped but have no location.
      // The typed mutations below prove ownership before any event is yielded.
      if (eventSessionID(event) === id && (event.directory === undefined || event.directory === scope.directory)) queue.push(event)
    })
    try {
      await this.runtime.events.ready()
      await this.runtime.sessions.switchAgent(scope, id, input.agent)
      await this.runtime.sessions.switchModel(scope, id, input.model)
      await this.runtime.sessions.prompt(scope, id, prompt(input))
      while (true) {
        const event = await queue.next()
        const projected = projectTurnEvent(event, id)
        if (projected) yield projected
        if (terminal(event, id)) return
      }
    } catch (error) {
      yield { type: "error", error: error instanceof Error ? error.message : String(error), harness: "opencode" }
    } finally {
      unsubscribe()
    }
  }

  async getMessages(binding: AgentExecutionBinding) {
    const rows = await this.runtime.sessions.messages(this.scope(binding.directory), binding.sessionId, { order: "asc" })
    return rows.messages.map((row) => message(binding.sessionId, row))
  }

  async getMessagePage(binding: AgentExecutionBinding, input: AgentMessagePageInput): Promise<AgentMessagePage> {
    if (input.view) throw new Error(`OpenCode SDK does not expose the ${input.view} transcript view`)
    const page = await this.runtime.sessions.messages(this.scope(binding.directory), binding.sessionId, {
      limit: input.limit,
      ...(input.before ? { cursor: input.before } : {}),
      order: "desc",
    })
    return {
      messages: page.messages.map((row) => message(binding.sessionId, row)).reverse(),
      ...(page.previous ? { nextCursor: page.previous } : {}),
    }
  }

  async abort(binding: AgentExecutionBinding) {
    await this.runtime.sessions.interrupt(this.scope(binding.directory), binding.sessionId)
    return { ok: true as const, status: "cancelled" as const }
  }

  async forkSession(binding: AgentExecutionBinding, messageId: string) {
    const forked = await this.runtime.sessions.fork(this.scope(binding.directory), binding.sessionId, { type: "before", messageID: messageId })
    return { id: forked.id }
  }

  async executeCommand(binding: AgentExecutionBinding, command: string) {
    await this.runtime.sessions.command(this.scope(binding.directory), binding.sessionId, { command })
  }

  async listCommands(directory: RuntimeDirectory): Promise<AgentCommand[]> {
    return (await this.runtime.catalog.commands(this.scope(directory))).map((row) => ({
      name: row.name,
      ...(row.description === undefined ? {} : { description: row.description }),
    }))
  }

  async listAgents(directory: RuntimeDirectory): Promise<AgentAgent[]> {
    return (await this.runtime.catalog.agents(this.scope(directory))).map((row) => ({
      name: row.name,
      ...(row.description === undefined ? {} : { description: row.description }),
      ...(row.mode === undefined ? {} : { mode: row.mode }),
    }))
  }

  async listPermissions(directory: RuntimeDirectory): Promise<AgentPermission[]> {
    return (await this.runtime.interactions.permissions(this.scope(directory))).map((row) => ({
      id: `${row.sessionID}:${row.id}`,
      sessionID: row.sessionID,
      permission: row.type ?? "unknown",
      patterns: [],
      always: [],
      metadata: row.metadata === undefined ? {} : { ...row.metadata },
      ...(row.title === undefined ? {} : { title: row.title }),
      ...(row.createdAt === undefined ? {} : { time: { created: row.createdAt } }),
    }))
  }

  async respondPermission(binding: AgentExecutionBinding, permId: string, decision: "allow_once" | "allow_always" | "deny" | "reject_always") {
    const { sessionID, requestID } = scopedId(permId, "permission replies")
    await this.runtime.interactions.replyPermission(this.scope(binding.directory), {
      sessionID,
      requestID,
      reply: decision === "allow_once" ? "once" : decision === "allow_always" ? "always" : "reject",
    })
  }

  async listQuestions(directory: RuntimeDirectory): Promise<AgentQuestion[]> {
    return (await this.runtime.interactions.forms(this.scope(directory))).map((row) => ({
      id: `${row.sessionID}:${row.id}`,
      sessionID: row.sessionID,
      questions: formQuestions(row.fields),
    }))
  }

  async replyQuestion(binding: AgentExecutionBinding, qId: string, answers: AgentQuestionAnswer[]) {
    const { sessionID, requestID: formID } = scopedId(qId, "form replies")
    const scope = this.scope(binding.directory)
    const form = (await this.runtime.interactions.forms(scope)).find((row) => row.id === formID && row.sessionID === sessionID)
    const fields = form?.fields?.map(record) ?? []
    if (fields.length === 0) throw new Error("OpenCode form has no fields to answer")
    const answer: Record<string, string | readonly string[]> = {}
    fields.forEach((field, index) => {
      const key = typeof field.key === "string" ? field.key : typeof field.name === "string" ? field.name : `field-${index}`
      const selected = answers[index] ?? []
      answer[key] = field.multiple === true ? selected : selected[0] ?? ""
    })
    await this.runtime.interactions.replyForm(scope, { sessionID, formID, answer })
  }

  async rejectQuestion(binding: AgentExecutionBinding, qId: string) {
    const { sessionID, requestID: formID } = scopedId(qId, "form cancellation")
    await this.runtime.interactions.cancelForm(this.scope(binding.directory), { sessionID, formID })
  }

  /**
   * The workspace's launch document, enforced in the engine's per-workspace
   * skill and MCP registries through the launch policy: the runtime
   * snapshot's MCP servers plus Agent Plugins' OpenCode config
   * (`launch.config`: skill directories and plugin MCP servers). Auth is not
   * applied here: the SDK reads credentials through Claxedo's credential
   * bridge.
   */
  async applyConfig(config: Record<string, unknown>) {
    const scope = this.scope(this.directory)
    const plugins = record(record(config.launch).config)
    const store = await this.runtime.launch(scope)
    await store.write({
      skills: stringList(plugins.skills),
      mcp: { ...snapshotMcpServers(record(config.mcp)), ...pluginMcpServers(record(plugins.mcp)) },
    })
  }

  readRuntimeHealth() {
    const status = this.runtime.host.status()
    return {
      status: status.lifecycle === "unavailable" || status.lifecycle === "closed" ? "unavailable" as const : status.events === "degraded" ? "degraded" as const : "ok" as const,
      ...(status.reason === undefined ? {} : { reason: status.reason }),
    }
  }

  dispose() {}
}
