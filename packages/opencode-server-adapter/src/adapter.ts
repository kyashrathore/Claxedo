import { assertAgentExecutionBinding, NO_HARNESS_EFFORT, parseAgentMessage } from "@claxedo/agent-runtime-contract"
import type { AgentExecutionBinding, AgentMessage, AgentSession, PromptInput } from "@claxedo/agent-runtime-contract"
import type { AgentHarnessAdapter } from "@claxedo/agent-sdk-runtime/adapters"
import { harnessCapabilities } from "@claxedo/agent-sdk-runtime/capabilities"
import type { HarnessCapabilities, SessionConfig, SessionConfigUpdate } from "@claxedo/agent-sdk-runtime"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import { asRecord } from "@claxedo/helpers/guards"
import { OPENCODE_SERVER_CONNECTION_CAPABILITIES, type ResolvedOpenCodeServerConnection } from "./config"
import { OpenCodeServerAdapterError } from "./errors"
import { serverSentEvents } from "./sse"
import {
  isUnsupportedInteractiveEvent,
  openCodeEventSessionId,
  type OpenCodeLeafEvent,
} from "./translate"
import { OpenCodeTurn } from "./turn"

const ERROR_BODY_BYTES = 4_096
const JSON_BODY_BYTES = 16 * 1024 * 1024
const SSE_FRAME_BYTES = 1024 * 1024

type OpenCodeServerRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** An upstream message proven to belong to the bound session. */
type UpstreamMessage = Record<string, unknown> & {
  info: Record<string, unknown>
  parts: Record<string, unknown>[]
}

export class OpenCodeServerAdapter implements AgentHarnessAdapter {
  readonly sessionConfigOwner = "runtime" as const
  readonly instructionChannel = "none" as const
  private readonly streams = new Map<string, AbortController>()
  private compatibility: Promise<void> | undefined
  private disposed = false

  constructor(
    private readonly config: ResolvedOpenCodeServerConnection,
    private readonly requestFn: OpenCodeServerRequest = fetch,
  ) {}

  readHarnessCapabilities(directory?: string): HarnessCapabilities {
    this.assertSourceDirectory(directory)
    return harnessCapabilities({
      harness: this.config.connectionId,
      modelSelection: { status: "unsupported" },
      ...OPENCODE_SERVER_CONNECTION_CAPABILITIES,
      goals: false,
      effortLevels: NO_HARNESS_EFFORT,
      instructionChannel: this.instructionChannel,
    })
  }

  async createSession(directory: string | undefined, title?: string, id?: string): Promise<{ id: string; agentSessionId: string }> {
    this.assertSourceDirectory(directory)
    await this.ensureCompatible()
    const data = await this.json("session.create", "/session", {
      method: "POST",
      body: JSON.stringify((title ? { title } : {})),
    })
    const session = this.session("session.create", data)
    return { id: id ?? session.id, agentSessionId: session.id }
  }

  async getSession(binding: AgentExecutionBinding): Promise<AgentSession | null> {
    this.assertBinding(binding)
    const response = await this.request("session.get", `/session/${encodeURIComponent(binding.upstreamSessionId)}`)
    if (response.status === 404) return null
    await this.requireOk("session.get", response)
    return this.projectSession(this.session("session.get", await this.jsonBody("session.get", response), binding.upstreamSessionId), binding)
  }

  async updateSession(binding: AgentExecutionBinding, updates: { title?: string; time?: { archived?: number } }): Promise<AgentSession | null> {
    this.assertBinding(binding)
    await this.ensureCompatible()
    const response = await this.request("session.update", `/session/${encodeURIComponent(binding.upstreamSessionId)}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    })
    if (response.status === 404) return null
    await this.requireOk("session.update", response)
    return this.projectSession(this.session("session.update", await this.jsonBody("session.update", response), binding.upstreamSessionId), binding)
  }

  async deleteSession(binding: AgentExecutionBinding): Promise<void> {
    this.assertBinding(binding)
    await this.ensureCompatible()
    const response = await this.request("session.delete", `/session/${encodeURIComponent(binding.upstreamSessionId)}`, { method: "DELETE" })
    await this.requireOk("session.delete", response)
  }

  async getMessages(binding: AgentExecutionBinding): Promise<AgentMessage[]> {
    this.assertBinding(binding)
    const data = await this.json("session.messages", `/session/${encodeURIComponent(binding.upstreamSessionId)}/message`)
    if (!Array.isArray(data)) throw this.error("invalid_response", "OpenCode session.messages response must be an array", "session.messages")
    return this.validateMessages(data, binding.upstreamSessionId).map((row) => {
      const message = parseAgentMessage(this.projectMessage(row, binding))
      // Refusing here matches every other read on this adapter: a response it
      // cannot type is an `invalid_response`, not a message with parts quietly
      // removed. The streaming path drops parts it does not recognize because
      // it emits a filtered event stream; this one promises whole messages.
      if (!message) {
        throw this.error("invalid_response", "OpenCode session.messages returned a message the runtime contract does not describe", "session.messages")
      }
      return message
    })
  }

  async getTodos(binding: AgentExecutionBinding) {
    this.assertBinding(binding)
    const data = await this.json("session.todo", `/session/${encodeURIComponent(binding.upstreamSessionId)}/todo`)
    if (!Array.isArray(data)) throw this.error("invalid_response", "OpenCode session.todo response must be an array", "session.todo")
    return data.map((item) => {
      const todo = asRecord(item)
      if (!todo || typeof todo.content !== "string" || typeof todo.status !== "string" || typeof todo.priority !== "string") {
        throw this.error("invalid_response", "OpenCode session.todo response contained an invalid item", "session.todo")
      }
      return { content: todo.content, status: todo.status, priority: todo.priority }
    })
  }

  async abort(binding: AgentExecutionBinding) {
    this.assertBinding(binding)
    const result = await this.abortUpstream(binding)
    if (result.ok && result.status === "cancelled") {
      this.streams.get(binding.upstreamSessionId)?.abort(new DOMException("Turn aborted", "AbortError"))
    }
    return result
  }

  getSessionConfig(binding: AgentExecutionBinding): Promise<SessionConfig> {
    this.assertBinding(binding)
    return Promise.reject(this.error("unsupported_operation", "External OpenCode servers do not expose authoritative session configuration", "session.config.get"))
  }

  updateSessionConfig(binding: AgentExecutionBinding, _update: SessionConfigUpdate): Promise<SessionConfig> {
    this.assertBinding(binding)
    return Promise.reject(this.error("unsupported_operation", "External OpenCode servers do not expose authoritative session configuration", "session.config.update"))
  }

  executeTurn(binding: AgentExecutionBinding, input: PromptInput): AsyncIterable<AgentRuntimeEvent> {
    this.assertBinding(binding)
    return this.streamTurn(binding, input)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const stream of this.streams.values()) stream.abort(new DOMException("Adapter disposed", "AbortError"))
    this.streams.clear()
  }

  private async *streamTurn(binding: AgentExecutionBinding, input: PromptInput): AsyncIterable<AgentRuntimeEvent> {
    this.assertUsable()
    await this.ensureCompatible()
    const controller = new AbortController()
    if (this.streams.has(binding.upstreamSessionId)) {
      throw this.error("invalid_binding", "The bound OpenCode session already has an active turn", "events.connect")
    }
    this.streams.set(binding.upstreamSessionId, controller)
    let sent = false
    let reconnects = 0
    try {
      const history = await this.getMessages(binding)
      const turn = new OpenCodeTurn(history.map((message) => message.info.id))
      while (!controller.signal.aborted) {
        let response: Response | undefined
        try {
          response = await this.eventResponse(controller.signal)
          if (!sent) {
            await this.prompt(binding, input, turn.userMessageId, controller.signal)
            sent = true
          } else {
            // Subscribe before the snapshot so completion cannot fall between them.
            const reconciliation = await this.reconcile(binding, turn)
            for (const value of reconciliation.events) yield value
            if (reconciliation.terminal) return
          }
          let reconcileAt = performance.now() + this.config.deadlines.streamIdleMs
          for await (const frame of serverSentEvents(response, {
            signal: controller.signal,
            idleTimeoutMs: this.config.deadlines.streamIdleMs,
            maxFrameBytes: SSE_FRAME_BYTES,
          })) {
            const event = this.parseBoundEvent(frame.data, binding)
            // Global heartbeats keep transport reads alive, but cannot defer
            // authoritative completion checks for this bound session forever.
            if (event?.type === "session.idle" || performance.now() >= reconcileAt) {
              const reconciliation = await this.reconcile(binding, turn, event?.type === "session.idle" ? "recover" : "completion")
              for (const value of reconciliation.events) yield value
              if (reconciliation.terminal) return
              reconcileAt = performance.now() + this.config.deadlines.streamIdleMs
              if (event?.type === "session.idle") continue
            }
            if (!event) continue
            if (isUnsupportedInteractiveEvent(event)) {
              await this.abortUpstream(binding).catch(() => undefined)
              throw this.error("unsupported_interaction", `OpenCode emitted unsupported ${event.type}`, "events.read")
            }
            for (const value of turn.translate(event)) {
              const translated = this.projectEvent(value, binding)
              if (translated.type === "error") translated.error = this.redact(translated.error)
              yield translated
              if (translated.type === "finish" || translated.type === "error") return
            }
          }
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) return
          if (error instanceof OpenCodeServerAdapterError && (
            error.code === "invalid_event"
            || error.code === "frame_too_large"
            || error.code === "unsupported_interaction"
          )) throw error
          if (!sent) throw error
        } finally {
          // Reconciliation may finish before the SSE iterator owns the body.
          await response?.body?.cancel().catch(() => undefined)
        }

        if (reconnects >= this.config.reconnect.maxAttempts) {
          const reconciliation = await this.reconcile(binding, turn)
          for (const event of reconciliation.events) yield event
          if (reconciliation.terminal) return
          throw this.error("reconciliation_gap", "OpenCode stream disconnected while the bound session remained active", "events.reconcile")
        }
        reconnects += 1
        await reconnectDelay(this.config.reconnect.delayMs, controller.signal)
      }
    } finally {
      if (this.streams.get(binding.upstreamSessionId) === controller) this.streams.delete(binding.upstreamSessionId)
      controller.abort(new DOMException("Turn stream closed", "AbortError"))
    }
  }

  private async prompt(binding: AgentExecutionBinding, input: PromptInput, messageID: string, signal: AbortSignal) {
    const response = await this.request("session.prompt", `/session/${encodeURIComponent(binding.upstreamSessionId)}/prompt_async`, {
      method: "POST",
      signal,
      body: JSON.stringify({
        parts: input.parts,
        messageID,
        agent: input.agent,
        // External OpenCode owns its default model. This provider advertises
        // modelSelection=unsupported, so Claxedo's internal `default`
        // placeholder must never be serialized as an OpenCode model choice.
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.system ? { system: input.system } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
      }),
    })
    await this.requireOk("session.prompt", response)
  }

  private async abortUpstream(binding: AgentExecutionBinding) {
    await this.ensureCompatible()
    const response = await this.request("session.abort", `/session/${encodeURIComponent(binding.upstreamSessionId)}/abort`, { method: "POST" })
    if (response.status === 404) {
      return { ok: false as const, status: "not_found" as const, message: `Session ${binding.sessionId} was not found` }
    }
    await this.requireOk("session.abort", response)
    return { ok: true as const, status: "cancelled" as const }
  }

  private async reconcile(binding: AgentExecutionBinding, turn: OpenCodeTurn, mode: "recover" | "completion" = "recover") {
    let statuses: unknown
    try {
      statuses = await this.json("session.status", "/session/status")
    } catch {
      throw this.error("reconciliation_gap", "OpenCode authoritative reconciliation snapshots were unavailable", "events.reconcile")
    }
    const statusesMap = asRecord(statuses)
    if (!statusesMap) throw this.error("reconciliation_gap", "OpenCode status snapshot was invalid", "events.reconcile")
    const status = statusesMap[binding.upstreamSessionId]
    const type = asRecord(status)?.type
    if (status !== undefined && type !== "idle" && type !== "busy" && type !== "retry") {
      throw this.error("reconciliation_gap", "OpenCode status snapshot contained an unknown bound-session state", "events.reconcile")
    }
    if (mode === "completion" && (type === "busy" || type === "retry")) return { events: [], terminal: false }
    let messages: unknown
    try {
      messages = await this.json("session.messages", `/session/${encodeURIComponent(binding.upstreamSessionId)}/message`)
    } catch {
      throw this.error("reconciliation_gap", "OpenCode authoritative reconciliation snapshots were unavailable", "events.reconcile")
    }
    if (!Array.isArray(messages)) throw this.error("reconciliation_gap", "OpenCode message reconciliation snapshot was invalid", "events.reconcile")
    const result = turn.reconcile(this.validateMessages(messages, binding.upstreamSessionId))
    if (type === "busy" || type === "retry") return { events: result.events, terminal: false }
    // Idle sessions are absent from OpenCode's active-status map. Require both
    // the bound session and this prompt's terminal assistant message to exist.
    if (!await this.getSession(binding) || (!result.failure && !result.finished)) {
      throw this.error("reconciliation_gap", "OpenCode snapshots did not establish completion of the current prompt", "events.reconcile")
    }
    result.events.push(result.failure
      ? { type: "error", error: this.redact(result.failure) }
      : { type: "finish", sessionId: binding.sessionId })
    return { events: result.events, terminal: true }
  }

  private async ensureCompatible() {
    this.assertUsable()
    if (!this.compatibility) {
      this.compatibility = this.probeCompatibility().catch((error) => {
        this.compatibility = undefined
        throw error
      })
    }
    return await this.compatibility
  }

  private async probeCompatibility() {
    const response = await this.request("compatibility.probe", "/global/health")
    if (!response.ok) {
      throw this.error("compatibility_probe_failed", `OpenCode compatibility probe failed with HTTP ${response.status}`, "compatibility.probe", response.status, await this.responseBody(response))
    }
    let data: unknown
    try { data = await this.jsonBody("compatibility.probe", response) } catch {
      throw this.error("compatibility_probe_failed", "OpenCode compatibility probe returned invalid JSON", "compatibility.probe")
    }
    const health = asRecord(data)
    if (health?.healthy !== true || typeof health.version !== "string" || !health.version) {
      throw this.error("compatibility_probe_failed", "OpenCode compatibility probe returned an unsupported health payload", "compatibility.probe")
    }
  }

  private async eventResponse(signal: AbortSignal) {
    const response = await this.request("events.connect", "/global/event", { signal, headers: { Accept: "text/event-stream" } })
    await this.requireOk("events.connect", response)
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      throw this.error("invalid_response", "OpenCode events.connect response is not text/event-stream", "events.connect")
    }
    return response
  }

  private parseBoundEvent(data: string, binding: AgentExecutionBinding): OpenCodeLeafEvent | undefined {
    let value: unknown
    try { value = JSON.parse(data) } catch { throw this.error("invalid_event", "OpenCode event data is not valid JSON", "events.read") }
    const envelope = asRecord(value)
    const payload = asRecord(envelope?.payload)
    if (!envelope || !payload || typeof payload.id !== "string" || typeof payload.type !== "string") {
      throw this.error("invalid_event", "OpenCode global event envelope is invalid", "events.read")
    }
    // Durable sync records share the global stream but are not live Session
    // events and intentionally carry `syncEvent` instead of `properties`.
    if (payload.type === "sync") return undefined
    const properties = asRecord(payload.properties)
    if (!properties) throw this.error("invalid_event", "OpenCode global event envelope is invalid", "events.read")
    const event = { type: payload.type, properties }
    const sessionId = openCodeEventSessionId(event)
    // OpenCode's canonical global stream starts with server.connected and emits
    // server.heartbeat events without a directory. They are intentionally
    // installation-scoped and irrelevant to a bound turn. A session-bearing
    // event must still include a directory so it cannot cross workspace scope.
    if (typeof envelope.directory !== "string") {
      if (sessionId !== undefined) {
        throw this.error("invalid_event", "OpenCode session event omitted its workspace directory", "events.read")
      }
      return undefined
    }
    if (envelope.directory !== this.config.targetDirectory) return undefined
    if (sessionId !== binding.upstreamSessionId) return undefined
    return event
  }

  /**
   * Parse an upstream message list into the bound-session shape the rest of the
   * adapter works with. Validating and typing in one pass is what keeps every
   * caller from re-asserting the shape this method already proved.
   */
  private validateMessages(messages: unknown[], upstreamSessionId: string): UpstreamMessage[] {
    return messages.map((item) => {
      const row = asRecord(item)
      const info = asRecord(row?.info)
      if (!row || !info || info.sessionID !== upstreamSessionId || typeof info.id !== "string" || !Array.isArray(row.parts)) {
        throw this.error("invalid_response", "OpenCode messages crossed the bound upstream session", "session.messages")
      }
      const messageId = info.id
      const parts = row.parts.map((itemPart) => {
        const part = asRecord(itemPart)
        if (!part || part.sessionID !== upstreamSessionId || part.messageID !== messageId) {
          throw this.error("invalid_response", "OpenCode message part crossed the bound upstream session", "session.messages")
        }
        return part
      })
      return { ...row, info, parts }
    })
  }

  private session(operation: string, data: unknown, expectedId?: string) {
    const row = asRecord(data)
    if (!row || typeof row.id !== "string" || !row.id || row.directory !== this.config.targetDirectory || (expectedId && row.id !== expectedId)) {
      throw this.error("invalid_response", `OpenCode ${operation} response crossed its bound session or workspace`, operation)
    }
    return { ...row, id: row.id }
  }

  private projectSession(session: { id: string; [key: string]: unknown }, binding: AgentExecutionBinding): AgentSession {
    return {
      ...session,
      id: binding.sessionId,
      workspaceId: binding.workspaceId,
      directory: binding.directory,
    } as AgentSession
  }

  private projectMessage(message: UpstreamMessage, binding: AgentExecutionBinding) {
    return {
      ...message,
      info: { ...message.info, sessionID: binding.sessionId },
      parts: message.parts.map((part) => ({ ...part, sessionID: binding.sessionId })),
    }
  }

  private projectEvent(event: AgentRuntimeEvent, binding: AgentExecutionBinding) {
    if (event.type !== "finish") return event
    return { ...event, sessionId: binding.sessionId }
  }

  private async json(operation: string, path: string, init?: RequestInit) {
    const response = await this.request(operation, path, init)
    await this.requireOk(operation, response)
    return await this.jsonBody(operation, response)
  }

  private async jsonBody(operation: string, response: Response) {
    const text = await readLimited(response, JSON_BODY_BYTES, this.config.deadlines.requestMs, operation)
    try { return JSON.parse(text) as unknown } catch { throw this.error("invalid_response", `OpenCode ${operation} returned invalid JSON`, operation, response.status) }
  }

  private async request(operation: string, path: string, init: RequestInit = {}) {
    this.assertUsable()
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new DOMException("Request deadline exceeded", "TimeoutError")), this.config.deadlines.requestMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal
    const headers = this.headers(init.headers)
    if (init.body !== undefined && !headers.has("content-type")) headers.set("Content-Type", "application/json")
    try {
      return await this.requestFn(new URL(`${this.config.baseUrl}${path}`), { ...init, signal, headers, redirect: "error" })
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason ?? error
      if (timeout.signal.aborted) throw this.error("deadline_exceeded", `OpenCode ${operation} request deadline exceeded`, operation)
      if (isAbortError(error)) throw error
      throw this.error("transport_error", `OpenCode ${operation} transport failed`, operation)
    } finally {
      clearTimeout(timer)
    }
  }

  private headers(requestHeaders?: HeadersInit) {
    const headers = new Headers(requestHeaders)
    for (const [name, value] of Object.entries(this.config.trustedHeaders)) headers.set(name, value)
    if (this.config.tenant) headers.set(this.config.tenant.header, this.config.tenant.value)
    if (this.config.auth?.type === "basic") headers.set("Authorization", `Basic ${Buffer.from(`${this.config.auth.username}:${this.config.auth.password}`, "utf8").toString("base64")}`)
    if (this.config.auth?.type === "header") headers.set(this.config.auth.name, this.config.auth.value)
    headers.set("X-OpenCode-Directory", this.config.targetDirectory)
    return headers
  }

  private async requireOk(operation: string, response: Response) {
    if (response.ok) return
    throw this.error("http_error", `OpenCode ${operation} failed with HTTP ${response.status}`, operation, response.status, await this.responseBody(response))
  }

  private async responseBody(response: Response) {
    const text = await readLimited(response, ERROR_BODY_BYTES, this.config.deadlines.requestMs, "response.error").catch(() => "")
    return this.redact(text)
  }

  private redact(input: string) {
    let value = input
    for (const secret of this.config.redactions) value = value.split(secret).join("[REDACTED]")
    return value
  }

  private error(code: ConstructorParameters<typeof OpenCodeServerAdapterError>[0], message: string, operation?: string, status?: number, body?: unknown) {
    return new OpenCodeServerAdapterError(code, message, { ...(operation ? { operation } : {}), ...(status === undefined ? {} : { status }), ...(body === undefined ? {} : { body }) })
  }

  private assertBinding(binding: AgentExecutionBinding) {
    try { assertAgentExecutionBinding(binding) } catch { throw this.error("invalid_binding", "OpenCode operation requires a complete execution binding") }
    if (binding.connectionId !== `connection:${this.config.connectionId}`) throw this.error("invalid_binding", "Execution binding belongs to a different connection")
    this.assertSourceDirectory(binding.directory)
  }

  private assertSourceDirectory(directory: string | undefined) {
    if (directory !== this.config.sourceDirectory) throw this.error("invalid_directory", "Workspace directory does not match the configured OpenCode path mapping")
  }

  private assertUsable() {
    if (this.disposed) throw this.error("disposed", "OpenCode server adapter is disposed")
  }
}

async function readLimited(response: Response, maxBytes: number, deadlineMs: number, operation: string) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let result = ""
  let bytes = 0
  try {
    while (true) {
      const next = await readResponseChunk(reader, deadlineMs, operation)
      if (next.done) break
      bytes += next.value.byteLength
      result += decoder.decode(next.value, { stream: true })
      if (bytes > maxBytes) return `${result.slice(0, maxBytes)}…[truncated]`
    }
    return result + decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function readResponseChunk(reader: ReadableStreamDefaultReader<Uint8Array>, deadlineMs: number, operation: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new OpenCodeServerAdapterError("deadline_exceeded", `OpenCode ${operation} response deadline exceeded`, { operation })), deadlineMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function isAbortError(error: unknown) { return error instanceof Error && error.name === "AbortError" }

async function reconnectDelay(ms: number, signal: AbortSignal) {
  if (ms === 0) return
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, ms)
    function done() { signal.removeEventListener("abort", aborted); resolve() }
    function aborted() { clearTimeout(timeout); reject(signal.reason ?? new DOMException("Aborted", "AbortError")) }
    signal.addEventListener("abort", aborted, { once: true })
  })
}
