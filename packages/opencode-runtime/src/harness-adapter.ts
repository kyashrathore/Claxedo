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
import type { OpenCodeRuntime } from "./runtime"
import { authorizeWorkspace, type WorkspaceScope } from "./scope"
import type { ProjectedEvent } from "./event-pump"
import type { SessionMessage, SessionSummary } from "./session-port"

type AdapterOptions = Readonly<{
  runtime: OpenCodeRuntime
  workspaceID: string
}>

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
    id: typeof row.id === "string" ? row.id : `${messageID}:${String(ordinal).padStart(6, "0")}`,
    sessionID,
    messageID,
  }
}

function message(sessionID: string, row: SessionMessage): AgentMessage {
  const parts = row.type === "user"
    ? [{ id: `${row.id}:text`, sessionID, messageID: row.id, type: "text", text: row.text ?? "" }]
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
    parts,
  }
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
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
 * Harness-neutral adapter backed exclusively by the public embedded SDK.
 * There is no URL, server process, raw router, or retry transport in this rail.
 */
export class OpenCodeSdkHarnessAdapter implements AgentHarnessAdapter {
  private readonly runtime: OpenCodeRuntime
  private readonly workspaceID: string
  private readonly configs = new Map<string, SessionConfig>()

  constructor(options: AdapterOptions) {
    this.runtime = options.runtime
    this.workspaceID = options.workspaceID
  }

  private scope(directory: string | undefined): WorkspaceScope {
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
    })
  }

  async listSessions(directory: string | undefined) {
    return (await this.runtime.sessions.list(this.scope(directory))).sessions.map(session)
  }

  async getSession(id: string, directory: string | undefined) {
    try {
      return session(await this.runtime.sessions.get(this.scope(directory), id))
    } catch (error) {
      if (String(error).toLowerCase().includes("not found")) return null
      throw error
    }
  }

  async createSession(directory: string | undefined, title?: string, id?: string) {
    const created = await this.runtime.sessions.create(this.scope(directory), { ...(id ? { id } : {}), ...(title ? { title } : {}) })
    return { id: created.id }
  }

  async updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, directory: string | undefined) {
    const scope = this.scope(directory)
    if (updates.title !== undefined) await this.runtime.sessions.rename(scope, id, updates.title)
    // Archive is a Claxedo projection concern. It must not be written into the
    // SDK and allowed to become a second authority.
    return session(await this.runtime.sessions.get(scope, id))
  }

  async deleteSession(id: string, directory: string | undefined) {
    await this.runtime.sessions.remove(this.scope(directory), id)
    this.configs.delete(id)
  }

  async getSessionConfig(id: string, _directory: string | undefined): Promise<SessionConfig> {
    return this.configs.get(id) ?? { harness: { id: "opencode", access: "native" }, variant: null, agent: null }
  }

  async updateSessionConfig(id: string, update: SessionConfigUpdate, directory: string | undefined): Promise<SessionConfig> {
    const previous = await this.getSessionConfig(id, directory)
    const next: SessionConfig = {
      harness: update.harness ?? previous.harness,
      model: update.model === undefined ? previous.model : update.model ?? undefined,
      variant: update.variant === undefined ? previous.variant : update.variant,
      agent: update.agent === undefined ? previous.agent : update.agent,
    }
    const scope = this.scope(directory)
    if (update.agent) await this.runtime.sessions.switchAgent(scope, id, update.agent)
    if (update.model) await this.runtime.sessions.switchModel(scope, id, update.model)
    this.configs.set(id, next)
    return next
  }

  async *sendMessage(id: string, input: PromptInput, directory: string | undefined): AsyncIterable<AgentRuntimeStreamEvent> {
    const scope = this.scope(directory)
    const queue = new EventQueue()
    const unsubscribe = this.runtime.events.subscribe((event) => {
      if (event.directory === scope.directory && eventSessionID(event) === id) queue.push(event)
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

  async getMessages(id: string, directory: string | undefined) {
    return (await this.runtime.sessions.messages(this.scope(directory), id, { order: "asc" })).messages.map((row) => message(id, row))
  }

  async getMessagePage(id: string, input: AgentMessagePageInput, directory: string | undefined): Promise<AgentMessagePage> {
    if (input.view) throw new Error(`OpenCode SDK does not expose the ${input.view} transcript view`)
    const page = await this.runtime.sessions.messages(this.scope(directory), id, {
      limit: input.limit,
      ...(input.before ? { cursor: input.before } : {}),
      order: "desc",
    })
    return {
      messages: page.messages.map((row) => message(id, row)).reverse(),
      ...(page.previous ? { nextCursor: page.previous } : {}),
    }
  }

  async abort(id: string, directory: string | undefined) {
    await this.runtime.sessions.interrupt(this.scope(directory), id)
    return { ok: true as const, status: "cancelled" as const }
  }

  async forkSession(id: string, messageId: string, directory: string | undefined) {
    const forked = await this.runtime.sessions.fork(this.scope(directory), id, { type: "before", messageID: messageId })
    return { id: forked.id }
  }

  async executeCommand(id: string, command: string, directory: string | undefined) {
    await this.runtime.sessions.command(this.scope(directory), id, { command })
  }

  async listCommands(directory: string | undefined): Promise<AgentCommand[]> {
    return (await this.runtime.catalog.commands(this.scope(directory))).map((row) => ({
      name: row.name,
      ...(row.description === undefined ? {} : { description: row.description }),
    }))
  }

  async listAgents(directory: string | undefined): Promise<AgentAgent[]> {
    return (await this.runtime.catalog.agents(this.scope(directory))).map((row) => ({
      name: row.name,
      ...(row.description === undefined ? {} : { description: row.description }),
      ...(row.mode === undefined ? {} : { mode: row.mode }),
    }))
  }

  async listPermissions(directory: string | undefined): Promise<AgentPermission[]> {
    return (await this.runtime.interactions.permissions(this.scope(directory))).map((row) => ({
      id: `${row.sessionID}:${row.id}`,
      sessionID: row.sessionID,
      ...(row.type === undefined ? {} : { permission: row.type }),
      ...(row.title === undefined ? {} : { title: row.title }),
      ...(row.metadata === undefined ? {} : { metadata: { ...row.metadata } }),
      ...(row.createdAt === undefined ? {} : { time: { created: row.createdAt } }),
    }))
  }

  async respondPermission(id: string, decision: "allow_once" | "allow_always" | "deny" | "reject_always", directory: string | undefined) {
    const separator = id.indexOf(":")
    if (separator < 1) throw new Error("OpenCode permission replies require a session-scoped request id")
    await this.runtime.interactions.replyPermission(this.scope(directory), {
      sessionID: id.slice(0, separator),
      requestID: id.slice(separator + 1),
      reply: decision === "allow_once" ? "once" : decision === "allow_always" ? "always" : "reject",
    })
  }

  async listQuestions(directory: string | undefined): Promise<AgentQuestion[]> {
    return (await this.runtime.interactions.forms(this.scope(directory))).map((row) => ({
      id: `${row.sessionID}:${row.id}`,
      sessionID: row.sessionID,
      questions: row.fields ? [...row.fields] : [],
    }))
  }

  async replyQuestion(id: string, answer: string, directory: string | undefined) {
    const separator = id.indexOf(":")
    if (separator < 1) throw new Error("OpenCode form replies require a session-scoped form id")
    const sessionID = id.slice(0, separator)
    const formID = id.slice(separator + 1)
    const form = (await this.runtime.interactions.forms(this.scope(directory))).find((row) => row.id === formID && row.sessionID === sessionID)
    const fields = form?.fields?.map(record) ?? []
    if (fields.length !== 1 || typeof fields[0]?.key !== "string") {
      throw new Error("The legacy single-answer question API cannot answer this structured OpenCode form")
    }
    await this.runtime.interactions.replyForm(this.scope(directory), {
      sessionID,
      formID,
      answer: { [fields[0].key as string]: answer },
    })
  }

  async rejectQuestion(id: string, directory: string | undefined) {
    const separator = id.indexOf(":")
    if (separator < 1) throw new Error("OpenCode form cancellation requires a session-scoped form id")
    await this.runtime.interactions.cancelForm(this.scope(directory), {
      sessionID: id.slice(0, separator),
      formID: id.slice(separator + 1),
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
