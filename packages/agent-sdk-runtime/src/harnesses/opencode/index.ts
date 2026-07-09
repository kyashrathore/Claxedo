/**
 * OpenCodeHarnessAdapter
 *
 * Manages an opencode server process and proxies HTTP requests to it.
 * If constructed with a URL, proxies to that existing server (backward compat).
 * If constructed without a URL, spawns `opencode serve` on demand.
 *
 * Session methods forward requests with x-opencode-directory header.
 * sendMessage() subscribes to /global/event SSE, forwards CompatEvent for
 * compatibility routes, and publishes canonical AgentRuntimeEvent envelopes.
 */

import {
  buildAssistantMessage,
  buildUserMessage,
  messageCompleted,
  messagePartUpdated,
  messageUpdated,
  sessionError,
  sessionStatus as sessionStatusCompat,
  type CompatEvent,
  type CompatPart,
} from "../../compat-events"
import type {
  AgentAgentRow,
  AgentCommandRow,
  AgentConfigOptionRow,
  AgentMessageRow,
  AgentPermissionRow,
  AgentQuestionRow,
  AgentRuntimeStreamEvent,
  AgentSessionRow,
  PromptInput,
  SessionConfig,
  SessionConfigUpdate,
} from "../../index"
import type { AgentHarnessAdapter } from "../../adapter-contract"
import { harnessCapabilities, type HarnessCapabilities } from "../../capabilities"
import { listCommands } from "../../command-discovery"
import { Log } from "../../log"
import { requireWorkspaceDirectory } from "../../target"
import { toOpencodeConfig, type ResolvedMcpServer } from "../../mcp-resolver"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import { createLegacyOpenCodeRuntimePublisher, drainEventStream, openEventStream } from "./events"
import { opencodeAuthContent } from "./env"
import { OpenCodeServerProcess } from "./process"
export { opencodeAuthContent, prepareSpawnEnv, spawnEnv } from "./env"

const log = Log.create({ service: "opencode-adapter" })

/**
 * Injected request-handler transport. A HOST that embeds the engine in-process
 * supplies one of these instead of a URL; the adapter routes ALL of its HTTP
 * through it (session calls, /session/status, /mcp sync, /global/event stream)
 * and never consults `OpenCodeServerProcess`. The seam (URL vs injected handler
 * vs spawn) is kit MECHANISM; which transport a composition uses is a HOST
 * decision. Requests are built against {@link OPENCODE_INTERNAL_BASE}; a handler
 * reads `new URL(req.url).pathname + .search` and ignores the synthetic origin.
 */
export type OpenCodeRequestFn = (request: Request) => Promise<Response>

// Synthetic origin for adapter-built Requests. In URL/spawn mode the RequestFn
// rewrites this origin to the real server URL; in injected mode the host handler
// sees it verbatim and routes on path only.
const OPENCODE_INTERNAL_BASE = "http://opencode.internal"

function rec(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function dataUrl(mime: string, data: string) {
  if (data.startsWith("data:")) return data
  return `data:${mime};base64,${data}`
}

function extension(mime: string) {
  const subtype = mime.split("/")[1]?.split(";")[0]
  if (!subtype) return "bin"
  if (subtype === "jpeg") return "jpg"
  return subtype.replace(/[^a-z0-9]/gi, "") || "bin"
}

function promptParts(sessionId: string, messageId: string, parts: unknown[]): CompatPart[] {
  return parts.flatMap((item, i) => {
    const row = rec(item)
    const type = typeof row?.type === "string" ? row.type : undefined
    const id = `${String(i).padStart(6, "0")}_${messageId}-input`
    if (type === "text") {
      return [{
        id,
        sessionID: sessionId,
        messageID: messageId,
        type,
        text: typeof row?.text === "string" ? row.text : "",
      } satisfies CompatPart]
    }
    if ((type === "image" || type === "audio") && typeof row?.mimeType === "string" && typeof row?.data === "string") {
      return [{
        id,
        sessionID: sessionId,
        messageID: messageId,
        type: "file",
        mime: row.mimeType,
        url: dataUrl(row.mimeType, row.data),
        filename: `${type}.${extension(row.mimeType)}`,
      } satisfies CompatPart]
    }
    if (type === "resource_link" && typeof row?.uri === "string") {
      return [{
        id,
        sessionID: sessionId,
        messageID: messageId,
        type: "file",
        mime: typeof row.mimeType === "string" ? row.mimeType : "application/octet-stream",
        url: row.uri,
        filename: typeof row.name === "string" ? row.name : typeof row.title === "string" ? row.title : "resource",
      } satisfies CompatPart]
    }
    const resource = rec(row?.resource)
    if (type === "resource" && typeof resource?.text === "string") {
      return [{
        id,
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text: resource.text,
      } satisfies CompatPart]
    }
    return [] as CompatPart[]
  })
}

function visiblePartText(part: CompatPart) {
  const row = part as { text?: unknown; content?: unknown }
  return typeof row.text === "string" ? row.text : typeof row.content === "string" ? row.content : ""
}

function eventHasVisibleAssistantContent(event: CompatEvent) {
  if (event.type === "message.part.updated") {
    return visiblePartText(event.properties.part).trim().length > 0
  }
  if (event.type === "message.part.delta") {
    const row = event.properties as { field?: unknown; delta?: unknown }
    return (row.field === "text" || row.field === "content") && typeof row.delta === "string" && row.delta.trim().length > 0
  }
  return false
}

function eventIsError(event: CompatEvent) {
  return event.type === "session.error"
}

export class OpenCodeHarnessAdapter implements AgentHarnessAdapter {
  readonly adapterCapabilities = ["http-proxy"] as const
  private base: Headers
  private cfg: Record<string, ResolvedMcpServer> = {}
  private auth: Record<string, string> = {}
  private eventHub: RuntimeEventHub | undefined
  private server: OpenCodeServerProcess

  // This flag gates the adapter's own MECHANISM — whether `listSessions` /
  // `getStatusSnapshot` proxy to the opencode upstream or return local
  // fallbacks. It is distinct from the workspace-runtime's root compat ROUTE
  // SURFACE (/mcp, /provider, /vcs, /session/status), which is gated
  // separately by the host. The three-state host option
  // WorkspaceHostOptions.opencodeCompat maps `undefined`/`true` → mechanism on,
  // `false` → mechanism off. Defaults on for direct adapter construction.
  private compat: boolean
  // Injected transport (host-embedded engine). When set, ALL adapter HTTP goes
  // through it and `OpenCodeServerProcess` is never consulted — nothing spawns.
  // If both `request` and `opencodeUrl` are given, the injected handler wins.
  private injectedRequest: OpenCodeRequestFn | undefined
  constructor(opencodeUrl?: string, input?: { headers?: HeadersInit; eventHub?: RuntimeEventHub; compat?: boolean; request?: OpenCodeRequestFn }) {
    this.compat = input?.compat ?? true
    this.base = new Headers(input?.headers)
    this.eventHub = input?.eventHub
    this.injectedRequest = input?.request
    this.server = new OpenCodeServerProcess(opencodeUrl, {
      config: () => this.cfg,
      auth: () => this.auth,
    })
  }

  // ── Server lifecycle ─────────────────────────────────────────────────────────

  /** Ensure the opencode server is running, spawning if needed. Returns the URL. */
  private async ensureServer(): Promise<string> {
    return this.server.ensureServer()
  }

  /**
   * Resolve the transport used for every adapter HTTP call. Injected mode
   * returns the host handler; URL/spawn mode returns a fn that rewrites the
   * synthetic {@link OPENCODE_INTERNAL_BASE} origin onto the real server URL and
   * defers to `fetch`. This is the single seam all call sites go through.
   */
  private async requestFn(): Promise<OpenCodeRequestFn> {
    if (this.injectedRequest) return this.injectedRequest
    const url = await this.ensureServer()
    return (req) => {
      const src = new URL(req.url)
      const target = new URL(src.pathname + src.search, url)
      return fetch(new Request(target.toString(), req))
    }
  }

  /** Public accessor for the kit's compat proxy — resolves the active transport. */
  async getRequestFn(): Promise<OpenCodeRequestFn> {
    return this.requestFn()
  }

  /**
   * Public accessor for URL/spawn-mode consumers. Injected mode has no URL —
   * callers must use {@link getRequestFn} instead.
   */
  async getServerUrl(): Promise<string> {
    if (this.injectedRequest) {
      throw new Error("OpenCodeHarnessAdapter is in injected-request mode; use getRequestFn()")
    }
    return this.ensureServer()
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private headers(directory: string, type = true) {
    const headers = new Headers(this.base)
    headers.set("x-opencode-directory", requireWorkspaceDirectory(directory))
    if (type) headers.set("Content-Type", "application/json")
    return headers
  }

  // Build an adapter Request against the synthetic base. Node's undici requires
  // `duplex: "half"` on any Request carrying a body (bodies here are JSON strings).
  private static request(path: string, init?: RequestInit): Request {
    const hasBody = init?.body !== undefined && init.body !== null
    return new Request(`${OPENCODE_INTERNAL_BASE}${path}`, hasBody ? { ...init, duplex: "half" } as RequestInit & { duplex: "half" } : init)
  }

  private async syncMcpConfig(request: OpenCodeRequestFn, directory: string) {
    const config = toOpencodeConfig(this.cfg).mcp
    if (!config || typeof config !== "object" || Array.isArray(config)) return
    const results = await Promise.allSettled(
      Object.entries(config).map(async ([name, cfg]) => {
        const res = await request(OpenCodeHarnessAdapter.request(`/mcp`, {
          method: "POST",
          headers: this.headers(directory),
          body: JSON.stringify({ name, config: cfg }),
        }))
        if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text().catch(() => res.statusText)}`)
      }),
    )
    const failed = results.filter((item): item is PromiseRejectedResult => item.status === "rejected")
    if (failed.length) {
      log.warn("failed to sync opencode MCP config before session create", {
        errors: failed.map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason)),
      })
    }
  }

  // ── Session lifecycle ────────────────────────────────────────────────────────

  readHarnessCapabilities(): HarnessCapabilities {
    return harnessCapabilities({
      harness: "opencode",
      abort: true,
      reconnect: false,
      replay: true,
      permissions: true,
      questions: true,
      todos: true,
      commands: true,
      fork: true,
      revert: true,
      unrevert: true,
      configOptions: false,
    })
  }

  /**
   * Workspace-runtime route handlers proxy `/session/status` calls
   * directly through the adapter so the workspace-id header set by the cloud
   * gateway flows through to the upstream opencode server. The response body
   * is forwarded as-is — callers stream/json it themselves.
   */
  async getStatusSnapshot(
    directory: string,
    opts: { headers?: Record<string, string> } = {},
  ): Promise<Response> {
    if (!this.compat) return Response.json({})
    const request = await this.requestFn()
    const headers = this.headers(directory, false)
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        headers.set(k, v)
      }
    }
    return await request(OpenCodeHarnessAdapter.request(`/session/status`, { headers }))
  }

  async listSessions(directory: string): Promise<AgentSessionRow[]> {
    if (!this.compat) return []
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session`, {
      headers: this.headers(directory),
    }))
    if (!res.ok) return []
    return res.json() as Promise<AgentSessionRow[]>
  }

  async getSession(id: string, directory: string): Promise<AgentSessionRow | null> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session/${id}`, {
      headers: this.headers(directory),
    }))
    if (!res.ok) return null
    return res.json() as Promise<AgentSessionRow>
  }

  async createSession(directory: string, title?: string): Promise<{ id: string }> {
    const request = await this.requestFn()
    await this.syncMcpConfig(request, directory)
    const res = await request(OpenCodeHarnessAdapter.request(`/session`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify(title ? { title } : {}),
    }))
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`)
    return res.json() as Promise<{ id: string }>
  }

  async updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, directory: string): Promise<AgentSessionRow | null> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session/${id}`, {
      method: "PATCH",
      headers: this.headers(directory),
      body: JSON.stringify(updates),
    }))
    if (!res.ok) return null
    return res.json() as Promise<AgentSessionRow>
  }

  async getSessionConfig(_id: string, _directory: string): Promise<SessionConfig> {
    return {
      harness: { id: "opencode", access: "native" },
      variant: null,
      agent: null,
    }
  }

  async updateSessionConfig(_id: string, update: SessionConfigUpdate, _directory: string): Promise<SessionConfig> {
    return {
      harness: update.harness ?? { id: "opencode", access: "native" },
      ...(update.model ? { model: update.model } : {}),
      variant: update.variant ?? null,
      agent: update.agent ?? null,
    }
  }

  async deleteSession(id: string, directory: string): Promise<void> {
    const request = await this.requestFn()
    await request(OpenCodeHarnessAdapter.request(`/session/${id}`, {
      method: "DELETE",
      headers: this.headers(directory),
    }))
  }

  // ── Messaging ────────────────────────────────────────────────────────────────

  async *sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<AgentRuntimeStreamEvent> {
    directory = requireWorkspaceDirectory(directory)
    const request = await this.requestFn()
    const publishRuntime = createLegacyOpenCodeRuntimePublisher({
      directory,
      sessionId: id,
      assistantMessageId: input.assistantMessageId,
      eventHub: this.eventHub,
    })
    publishRuntime(sessionStatusCompat(id, { type: "busy" }))
    if (input.userMessageId) {
      yield messageUpdated(buildUserMessage({
        id: input.userMessageId,
        sessionID: id,
        agent: input.agent,
        model: input.model,
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.system ? { system: input.system } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
      }))
      for (const part of promptParts(id, input.userMessageId, input.parts)) {
        yield messagePartUpdated(part)
      }
    }
    yield messageUpdated(buildAssistantMessage({
      id: input.assistantMessageId,
      sessionID: id,
      parentID: input.userMessageId ?? id,
      agent: input.agent,
      model: input.model,
      directory,
    }))

    const stream = openEventStream(request, this.headers(directory, false))
    await stream.ready

    const postRes = await request(OpenCodeHarnessAdapter.request(`/session/${id}/prompt_async`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({
        parts: input.parts,
        ...(input.userMessageId ? { messageID: input.userMessageId } : {}),
        agent: input.agent,
        model: input.model,
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.system ? { system: input.system } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
      }),
    })).catch(() => null as null)

    if (!postRes || !postRes.ok) {
      const text = postRes ? await postRes.text().catch(() => "unknown error") : "connection refused"
      stream.close()
      const error = sessionError(`Failed to send message: ${text}`, id)
      publishRuntime(error)
      yield error
      return
    }

    let sawVisibleAssistantContent = false
    let sawError = false
    for await (const event of drainEventStream(stream, id)) {
      if (eventHasVisibleAssistantContent(event)) sawVisibleAssistantContent = true
      if (eventIsError(event)) sawError = true
      publishRuntime(event)
      yield event
    }

    if (!sawError && !sawVisibleAssistantContent) {
      const error = sessionError("OpenCode completed without visible assistant content", id)
      publishRuntime(error)
      yield error
      return
    }

    if (!sawError) yield messageCompleted(id, input.assistantMessageId)
  }

  // ── Remaining API methods ────────────────────────────────────────────────────

  async getMessages(id: string, directory: string): Promise<AgentMessageRow[]> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session/${id}/message`, {
      headers: this.headers(directory),
    }))
    if (!res.ok) return []
    return res.json() as Promise<AgentMessageRow[]>
  }

  async abort(id: string, directory: string) {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session/${id}/abort`, {
      method: "POST",
      headers: this.headers(directory),
    }))
    if (!res.ok) return { ok: false as const, status: "failed" as const, message: `Abort failed with HTTP ${res.status}` }
    return { ok: true as const, status: "cancelled" as const }
  }

  async revert(id: string, directory: string): Promise<void> {
    const request = await this.requestFn()
    await request(OpenCodeHarnessAdapter.request(`/session/${id}/revert`, {
      method: "POST",
      headers: this.headers(directory),
    }))
  }

  async unrevert(id: string, directory: string): Promise<void> {
    const request = await this.requestFn()
    await request(OpenCodeHarnessAdapter.request(`/session/${id}/unrevert`, {
      method: "POST",
      headers: this.headers(directory),
    }))
  }

  async forkSession(id: string, messageId: string, directory: string): Promise<{ id: string }> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session/${id}/fork`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({ messageId }),
    }))
    if (!res.ok) throw new Error(`Fork failed: ${res.status}`)
    return res.json() as Promise<{ id: string }>
  }

  async executeCommand(id: string, command: string, directory: string): Promise<void> {
    const request = await this.requestFn()
    await request(OpenCodeHarnessAdapter.request(`/session/${id}/command`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({ command }),
    }))
  }

  async listCommands(_directory: string): Promise<AgentCommandRow[]> {
    return listCommands()
  }

  async listAgents(_directory: string): Promise<AgentAgentRow[]> {
    throw new Error("opencode does not expose live agent options")
  }

  async listPermissions(directory: string): Promise<AgentPermissionRow[]> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/permission`, {
      headers: this.headers(directory),
    }))
    if (!res.ok) return []
    return res.json() as Promise<AgentPermissionRow[]>
  }

  async respondPermission(
    permId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
    directory: string,
  ): Promise<void> {
    const request = await this.requestFn()
    const [sessionId, actualPermId] = permId.includes(":") ? permId.split(":") : ["", permId]
    const endpoint = sessionId
      ? `/session/${sessionId}/permissions/${actualPermId}`
      : `/permission/${permId}/respond`
    await request(OpenCodeHarnessAdapter.request(endpoint, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({
        decision: decision === "reject_always" ? "deny" : decision,
      }),
    }))
  }

  async listQuestions(directory: string): Promise<AgentQuestionRow[]> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/question`, {
      headers: this.headers(directory),
    }))
    if (!res.ok) return []
    return res.json() as Promise<AgentQuestionRow[]>
  }

  async replyQuestion(qId: string, answer: string, directory: string): Promise<void> {
    const request = await this.requestFn()
    const [sessionId, actualQId] = qId.includes(":") ? qId.split(":") : ["", qId]
    const endpoint = sessionId
      ? `/session/${sessionId}/question/${actualQId}/reply`
      : `/question/${qId}/reply`
    await request(OpenCodeHarnessAdapter.request(endpoint, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({ answer }),
    }))
  }

  async rejectQuestion(qId: string, directory: string): Promise<void> {
    const request = await this.requestFn()
    const [sessionId, actualQId] = qId.includes(":") ? qId.split(":") : ["", qId]
    const endpoint = sessionId
      ? `/session/${sessionId}/question/${actualQId}/reject`
      : `/question/${qId}/reject`
    await request(OpenCodeHarnessAdapter.request(endpoint, {
      method: "POST",
      headers: this.headers(directory),
    }))
  }

  async getTodos(sessionId: string, directory: string): Promise<Array<{ content: string; status: string; priority: string }>> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session/${sessionId}/todo`, {
      headers: this.headers(directory),
    }))
    if (!res.ok) return []
    return res.json() as Promise<Array<{ content: string; status: string; priority: string }>>
  }

  applyConfig(config: Record<string, unknown>): Promise<void> {
    this.cfg = (config.mcp as Record<string, ResolvedMcpServer> | undefined) ?? {}
    this.auth = (config.auth as Record<string, string> | undefined) ?? {}
    if (this.server.restartSpawnedProcess()) {
      log.info("applyConfig: restarting spawned opencode to apply config", {
        hasAuth: !!opencodeAuthContent(this.auth),
      })
      return Promise.resolve()
    }
    log.info("applyConfig: opencode config cached", {
      mode: this.injectedRequest ? "injected" : this.server.mode,
      mcp: Object.keys(this.cfg),
      hasAuth: !!opencodeAuthContent(this.auth),
    })
    return Promise.resolve()
  }

  async probeConfigOptions(_directory: string): Promise<AgentConfigOptionRow[]> {
    throw new Error("opencode does not expose harness config options")
  }

  dispose(): void {
    this.server.dispose()
  }
}
