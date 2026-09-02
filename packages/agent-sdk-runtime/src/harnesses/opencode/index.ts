/**
 * OpenCodeHarnessAdapter
 *
 * Manages an opencode server process and proxies HTTP requests to it.
 * If constructed with a URL, proxies to that existing server.
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
} from "../../compat-events"
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
} from "../../index"
import type {
  AgentGoalMutationResult,
  AgentGoalResource,
  AgentHarnessAdapter,
  ShellCommandInput,
  SummarizeSessionInput,
} from "../../adapter-contract"
import {
  AgentMessagePageError,
  type AgentMessagePage,
  type AgentMessagePageInput,
} from "../../message-page"
import { goalCapabilities, harnessCapabilities, type HarnessCapabilities } from "../../capabilities"
import { listCommands } from "../../command-discovery"
import { Log } from "../../log"
import { requireWorkspaceDirectory } from "../../target"
import { toOpencodeConfig, type ResolvedMcpServer } from "../../mcp-resolver"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import { createSubagentAdmissionBoundary, type SubagentAdmissionStore } from "../../subagent-admission"
import { createLegacyOpenCodeRuntimePublisher, drainEventStream, openEventStream } from "./events"
import { OpenCodeGoalMonitors } from "./goal-monitor"
import { opencodeSubagentObservations } from "./subagent"
import { opencodeAuthContent } from "./env"
import { OpenCodeServerProcess, type OpenCodeServerConnection } from "./process"
import type { ActivityLease } from "../shared/process-lifecycle"
import { eventHasVisibleAssistantContent, eventIsError, promptParts } from "./prompt"
import { randomUUID } from "crypto"
import {
  observeAgentProcess,
  type AgentProcessObserver,
  type AgentProcessObserverHandle,
} from "../../process-observer"
import { createGoalPublisher, type GoalPublisher } from "../shared/goal-publisher"
import { errorMessage } from "../shared/sdk-runtime-values"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
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

function requireUpstream(response: Response, operation: string) {
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}`)
  return response
}

export class OpenCodeHarnessAdapter implements AgentHarnessAdapter {
  readonly adapterCapabilities = ["http-proxy"] as const
  private base: Headers
  private cfg: Record<string, ResolvedMcpServer> = {}
  private auth: Record<string, string> = {}
  private eventHub: RuntimeEventHub | undefined
  private server: OpenCodeServerProcess

  // Controls whether compatibility reads are delegated to the OpenCode server.
  // Route exposure remains a host-level policy.
  private compat: boolean
  // Injected transport (host-embedded engine). When set, ALL adapter HTTP goes
  // through it and `OpenCodeServerProcess` is never consulted — nothing spawns.
  // If both `request` and `opencodeUrl` are given, the injected handler wins.
  private injectedRequest: OpenCodeRequestFn | undefined
  private transportObservation: AgentProcessObserverHandle | undefined
  private mcpObservations: AgentProcessObserverHandle[] = []
  private rootOwnerId: string | undefined
  private processObserver: AgentProcessObserver | undefined
  // The host owns durable parent/child associations; this adapter only admits
  // observations when that persistence service is present.
  private subagents: SubagentAdmissionStore | undefined
  // Admissions assign monotonic per-subagent revisions, so they must not
  // interleave. One chain per adapter keeps them ordered without blocking the
  // event stream the turn is draining.
  private subagentAdmissions = Promise.resolve()
  private goalPublisher: GoalPublisher
  // One watcher for the whole server; every Goal session shares its event stream.
  private goalMonitors = new OpenCodeGoalMonitors({
    request: () => this.requestFn(),
    streamHeaders: (directory) => this.headers(directory, false),
    readGoal: (sessionId, directory) => this.goals.read(sessionId, directory),
    publishGoal: (sessionId, directory, goal) => this.publishGoal(sessionId, directory, goal),
    observe: (event, sessionId, directory) => this.observeSubagents(event, sessionId, directory),
    publisher: (sessionId, directory) =>
      createLegacyOpenCodeRuntimePublisher({
        directory,
        sessionId,
        assistantMessageId: randomUUID(),
        eventHub: this.eventHub,
      }),
  })
  readonly goals: AgentGoalResource

  constructor(opencodeUrl?: string, input?: {
    headers?: HeadersInit
    eventHub?: RuntimeEventHub
    compat?: boolean
    request?: OpenCodeRequestFn
    processObserver?: AgentProcessObserver
    subagents?: SubagentAdmissionStore
  }) {
    this.compat = input?.compat ?? true
    this.base = new Headers(input?.headers)
    this.eventHub = input?.eventHub
    // Built here rather than in a field initializer: initializers run before the
    // constructor body, so one would capture `this.eventHub` while it is still
    // undefined and silently publish nothing.
    this.goalPublisher = createGoalPublisher(this.eventHub)
    this.injectedRequest = input?.request
    this.processObserver = input?.processObserver
    this.subagents = input?.subagents
    this.server = new OpenCodeServerProcess(opencodeUrl, {
      config: () => this.cfg,
      auth: () => this.auth,
      processObserver: input?.processObserver,
    })
    this.goals = this.goalResource()
    if (this.injectedRequest || opencodeUrl) {
      this.rootOwnerId = `opencode-${this.injectedRequest ? "in-process" : "external"}:${randomUUID()}`
      this.transportObservation = observeAgentProcess(input?.processObserver, {
        ownerId: this.rootOwnerId,
        launchId: randomUUID(),
        harnessId: "opencode",
        access: "native",
        role: "harness",
        label: this.injectedRequest ? "OpenCode in-process runtime" : "OpenCode external server",
        locality: this.injectedRequest ? "in-process" : "remote",
        confidence: this.injectedRequest ? "direct" : "not-process-backed",
        capabilities: {
          resourceMetrics: this.injectedRequest ? "shared-process" : "none",
          ownerActions: false,
        },
      })
      this.transportObservation.update({ lifecycle: "ready" })
    }
  }

  private goalResource(): AgentGoalResource {
    const requestGoal = async <T>(sessionId: string, directory: string | undefined, path: string, init?: RequestInit) => {
      const required = requireWorkspaceDirectory(directory)
      const request = await this.requestFn()
      const response = await request(OpenCodeHarnessAdapter.request(`/session/${sessionId}/goal${path}`, {
        ...init,
        headers: this.headers(required),
      }))
      requireUpstream(response, `OpenCode Goal ${path || "read"}`)
      return response.json() as Promise<T>
    }
    const mutate = async <T extends RuntimeGoalSnapshot | null>(
      sessionId: string,
      directory: string | undefined,
      path: string,
      init: RequestInit,
    ): Promise<AgentGoalMutationResult<T>> => {
      const required = requireWorkspaceDirectory(directory)
      try {
        const goal = await requestGoal<T>(sessionId, required, path, init)
        this.publishGoal(sessionId, required, goal)
        return { ok: true, goal }
      } catch (cause) {
        return {
          ok: false,
          status: "failed",
          message: errorMessage(cause),
        }
      }
    }
    // Pause and Stop are the same upstream transition: the engine's /pause
    // endpoint settles the Goal and cancels its run. They stay separate actions
    // in the contract because callers mean different things by them.
    const suspend = async (sessionId: string, directory: string | undefined) => {
      const result = await mutate<RuntimeGoalSnapshot>(sessionId, directory, "/pause", { method: "POST" })
      if (result.ok) this.goalMonitors.stop(sessionId)
      return result
    }
    return {
      readCapabilities: async (sessionId, directory) => {
        try {
          return goalCapabilities(await requestGoal(sessionId, directory, "/capabilities"))
        } catch (cause) {
          return goalCapabilities({
            implemented: true,
            available: false,
            unavailableReason: errorMessage(cause),
            actions: [],
            recovery: "reconcile",
            optionalFields: [],
          })
        }
      },
      read: (sessionId, directory) => requestGoal<RuntimeGoalSnapshot | null>(sessionId, directory, ""),
      start: async (sessionId, input, directory) => {
        const required = requireWorkspaceDirectory(directory)
        const result = await mutate<RuntimeGoalSnapshot>(sessionId, required, "", {
          method: "POST",
          body: JSON.stringify({ objective: input.objective }),
        })
        if (result.ok) this.goalMonitors.start(sessionId, required)
        return result
      },
      pause: suspend,
      stop: suspend,
      resume: async (sessionId, directory) => {
        const required = requireWorkspaceDirectory(directory)
        const result = await mutate<RuntimeGoalSnapshot>(sessionId, required, "/resume", { method: "POST" })
        if (result.ok) this.goalMonitors.start(sessionId, required)
        return result
      },
      delete: async (sessionId, directory) => {
        const result = await mutate<null>(sessionId, directory, "", { method: "DELETE" })
        if (result.ok) this.goalMonitors.stop(sessionId)
        return result
      },
    }
  }

  /**
   * No `applyState`, unlike every other adapter: this adapter keeps no session
   * store. The opencode server owns Goal state, `goals.read` fetches it over
   * HTTP on every read, and the advertised recovery is "reconcile" — so there is
   * no local projection here to mirror the snapshot into.
   */
  private publishGoal(sessionId: string, directory: string, goal: RuntimeGoalSnapshot | null) {
    this.goalPublisher.publish({ sessionId, directory, goal })
  }

  private cleanupGoalSession(sessionId: string) {
    this.goalMonitors.stop(sessionId)
    this.goalPublisher.forget(sessionId)
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
    return this.forwardTo(await this.server.ensureConnection())
  }

  private forwardTo({ url, authorization }: OpenCodeServerConnection): OpenCodeRequestFn {
    return (req) => {
      const src = new URL(req.url)
      const target = new URL(src.pathname + src.search, url)
      // The spawned server requires this launch's credential. Attached HERE,
      // at the one seam every adapter call passes through, rather than at each
      // call site — a missed site would be a 401 in one feature and nowhere
      // else. A caller that already set its own Authorization keeps it.
      // Built from the original Request first so method, body, and duplex are
      // carried verbatim; spreading a Request drops all of them, because its
      // fields are prototype getters rather than own properties.
      const forwarded = new Request(target.toString(), req)
      if (authorization && !forwarded.headers.has("authorization")) {
        forwarded.headers.set("authorization", authorization)
      }
      return fetch(forwarded).then((response) => {
        if (!response.headers.has("content-encoding")) return response
        const headers = new Headers(response.headers)
        headers.delete("content-encoding")
        headers.delete("content-length")
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      })
    }
  }

  /** Public accessor for the kit's compat proxy — resolves the active transport. */
  async getRequestFn(): Promise<OpenCodeRequestFn> {
    return this.requestFn()
  }

  /**
   * Whether a proxy can attach without paying a server start. Injected and
   * external-URL transports are always live because nothing is spawned for
   * them; a spawn-mode adapter is live only once its child is up.
   */
  transportLive(): boolean {
    if (this.injectedRequest) return true
    return this.server.mode === "external" || this.server.hasProcess
  }

  /**
   * Transport for a stream that outlives its opening request, plus the lease
   * that keeps the server alive for the stream's whole life.
   */
  async acquireRequestFn(): Promise<{ request: OpenCodeRequestFn; lease: ActivityLease }> {
    if (this.injectedRequest) return { request: this.injectedRequest, lease: { release() {} } }
    const { connection, lease } = await this.server.acquire()
    return { request: this.forwardTo(connection), lease }
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
    await Promise.all(Object.entries(config).map(async ([name, cfg]) => {
      const response = await request(OpenCodeHarnessAdapter.request(`/mcp`, {
        method: "POST",
        headers: this.headers(directory),
        body: JSON.stringify({ name, config: cfg }),
      }))
      requireUpstream(response, `Configure OpenCode MCP server ${name}`)
    }))
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
      subagents: true,
      goals: true,
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
    if (!this.compat) throw new Error("OpenCode compatibility reads are disabled")
    const request = await this.requestFn()
    const headers = this.headers(directory, false)
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        headers.set(k, v)
      }
    }
    return await request(OpenCodeHarnessAdapter.request(`/session/status`, { headers }))
  }

  async listSessions(directory: string): Promise<AgentSession[]> {
    // compat === false is the kill switch: empty/local results, never the
    // upstream. Hosts route non-compat status snapshots through this read.
    if (!this.compat) return []
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session`, {
      headers: this.headers(directory),
    }))
    requireUpstream(res, "List OpenCode sessions")
    return res.json() as Promise<AgentSession[]>
  }

  async getSession(id: string, directory: string): Promise<AgentSession | null> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session/${id}`, {
      headers: this.headers(directory),
    }))
    if (res.status === 404) return null
    requireUpstream(res, "Read OpenCode session")
    return res.json() as Promise<AgentSession>
  }

  async createSession(directory: string, title?: string, id?: string): Promise<{ id: string }> {
    const request = await this.requestFn()
    await this.syncMcpConfig(request, directory)
    const res = await request(OpenCodeHarnessAdapter.request(`/session`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({ ...(id ? { id } : {}), ...(title ? { title } : {}) }),
    }))
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`)
    return res.json() as Promise<{ id: string }>
  }

  async createHandoffSession(directory: string, title: string | undefined, id: string) {
    const existing = await this.getSession(id, directory)
    if (existing) {
      throw new Error(`Cannot prepare OpenCode handoff: target session ${id} already exists`)
    }
    const created = await this.createSession(directory, title, id)
    let rolledBack = false
    return {
      ...created,
      ownerKey: null,
      rollback: async () => {
        if (rolledBack) return
        await this.deleteSession(created.id, directory)
        rolledBack = true
      },
    }
  }

  async releaseHandoffSource(id: string, _agentSessionId: string, _ownerKey: string | null, directory: string) {
    await this.deleteSession(id, directory)
  }

  async updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, directory: string): Promise<AgentSession | null> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session/${id}`, {
      method: "PATCH",
      headers: this.headers(directory),
      body: JSON.stringify(updates),
    }))
    if (res.status === 404) return null
    requireUpstream(res, "Update OpenCode session")
    return res.json() as Promise<AgentSession>
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
    this.cleanupGoalSession(id)
    const request = await this.requestFn()
    const response = await request(OpenCodeHarnessAdapter.request(`/session/${id}`, {
      method: "DELETE",
      headers: this.headers(directory),
    }))
    requireUpstream(response, "Delete OpenCode session")
  }

  // ── Messaging ────────────────────────────────────────────────────────────────

  /** Holds the process lease for the complete stream, including quiet tool calls. */
  async *sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<AgentRuntimeStreamEvent> {
    directory = requireWorkspaceDirectory(directory)
    const { request, lease } = await this.acquireRequestFn()
    try {
      yield* this.streamPrompt(request, id, input, directory)
    } finally {
      lease.release()
    }
  }

  private async *streamPrompt(
    request: OpenCodeRequestFn,
    id: string,
    input: PromptInput,
    directory: string,
  ): AsyncIterable<AgentRuntimeStreamEvent> {
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
        ...(input.author ? { author: input.author } : {}),
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
      this.observeSubagents(event, id, directory)
      publishRuntime(event)
      yield event
    }
    await this.subagentAdmissions

    if (!sawError && !sawVisibleAssistantContent) {
      const error = sessionError("OpenCode completed without visible assistant content", id)
      publishRuntime(error)
      yield error
      return
    }

    if (!sawError) yield messageCompleted(id, input.assistantMessageId)
  }

  /**
   * Record every delegation the engine published on this turn.
   *
   * The engine is the authoritative producer of the association (see
   * `./subagent`), the host store is the authority for the row, and the
   * resulting `subagent-updated` event is what the app's registry consumes
   * live. A failure here must never break the turn the caller is streaming, so
   * the chain swallows its own errors: a lost card is recoverable on reload,
   * an aborted turn is not.
   */
  private observeSubagents(event: CompatEvent, sessionId: string, directory: string) {
    const store = this.subagents
    if (!store) return
    const observations = opencodeSubagentObservations(event)
    if (observations.length === 0) return
    const admission = createSubagentAdmissionBoundary({
      store,
      publish: (parentSessionId, payload) => {
        this.eventHub?.publishRuntime({ directory, sessionId: parentSessionId, payload })
      },
    })
    this.subagentAdmissions = this.subagentAdmissions.then(async () => {
      for (const observation of observations) {
        await admission.admit(sessionId, observation).catch((error: unknown) => {
          log.error("failed to admit opencode subagent observation", { sessionId, error })
        })
      }
    })
  }

  // ── Remaining API methods ────────────────────────────────────────────────────

  async getMessages(id: string, directory: string): Promise<AgentMessage[]> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session/${id}/message`, {
      headers: this.headers(directory),
    }))
    requireUpstream(res, "List OpenCode messages")
    return res.json() as Promise<AgentMessage[]>
  }

  async getMessagePage(
    id: string,
    input: AgentMessagePageInput,
    directory: string,
  ): Promise<AgentMessagePage> {
    const query = input.view !== undefined
      ? new URLSearchParams({ view: input.view })
      : new URLSearchParams({ limit: String(input.limit) })
    if (input.view === undefined && input.before !== undefined) query.set("before", input.before)

    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session/${id}/message?${query}`, {
      headers: this.headers(directory),
    }))
    if (!res.ok) throw new AgentMessagePageError(res.status, `Failed to get message page: ${res.status}`)

    const messages = await res.json() as AgentMessage[]
    const nextCursor = res.headers.get("x-next-cursor")
    return {
      messages,
      ...(nextCursor !== null ? { nextCursor } : {}),
    }
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
    const response = await request(OpenCodeHarnessAdapter.request(`/session/${id}/revert`, {
      method: "POST",
      headers: this.headers(directory),
    }))
    requireUpstream(response, "Revert OpenCode session")
  }

  async unrevert(id: string, directory: string): Promise<void> {
    const request = await this.requestFn()
    const response = await request(OpenCodeHarnessAdapter.request(`/session/${id}/unrevert`, {
      method: "POST",
      headers: this.headers(directory),
    }))
    requireUpstream(response, "Restore OpenCode session")
  }

  async forkSession(id: string, messageId: string, directory: string, childSessionId?: string): Promise<{ id: string }> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session/${id}/fork`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({ messageId, ...(childSessionId ? { id: childSessionId } : {}) }),
    }))
    if (!res.ok) throw new Error(`Fork failed: ${res.status}`)
    return res.json() as Promise<{ id: string }>
  }

  async executeCommand(id: string, command: string, directory: string): Promise<void> {
    const request = await this.requestFn()
    const response = await request(OpenCodeHarnessAdapter.request(`/session/${id}/command`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({ command }),
    }))
    requireUpstream(response, "Execute OpenCode command")
  }

  async shell(id: string, input: ShellCommandInput, directory: string): Promise<void> {
    const request = await this.requestFn()
    await request(OpenCodeHarnessAdapter.request(`/session/${id}/shell`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({
        command: input.command,
        agent: input.agent,
        ...(input.model ? { model: input.model } : {}),
        ...(input.messageID ? { messageID: input.messageID } : {}),
      }),
    }))
  }

  async summarize(id: string, input: SummarizeSessionInput, directory: string): Promise<void> {
    const request = await this.requestFn()
    await request(OpenCodeHarnessAdapter.request(`/session/${id}/summarize`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({
        providerID: input.providerID,
        modelID: input.modelID,
        ...(input.auto !== undefined ? { auto: input.auto } : {}),
      }),
    }))
  }

  async listCommands(_directory: string): Promise<AgentCommand[]> {
    return listCommands()
  }

  async listAgents(_directory: string): Promise<AgentAgent[]> {
    throw new Error("opencode does not expose live agent options")
  }

  async listPermissions(directory: string): Promise<AgentPermission[]> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/permission`, {
      headers: this.headers(directory),
    }))
    requireUpstream(res, "List OpenCode permissions")
    return res.json() as Promise<AgentPermission[]>
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
    const response = await request(OpenCodeHarnessAdapter.request(endpoint, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({
        decision: decision === "reject_always" ? "deny" : decision,
      }),
    }))
    requireUpstream(response, "Respond to OpenCode permission")
  }

  async listQuestions(directory: string): Promise<AgentQuestion[]> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/question`, {
      headers: this.headers(directory),
    }))
    requireUpstream(res, "List OpenCode questions")
    return res.json() as Promise<AgentQuestion[]>
  }

  async replyQuestion(qId: string, answer: string, directory: string): Promise<void> {
    const request = await this.requestFn()
    const [sessionId, actualQId] = qId.includes(":") ? qId.split(":") : ["", qId]
    const endpoint = sessionId
      ? `/session/${sessionId}/question/${actualQId}/reply`
      : `/question/${qId}/reply`
    const response = await request(OpenCodeHarnessAdapter.request(endpoint, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({ answer }),
    }))
    requireUpstream(response, "Reply to OpenCode question")
  }

  async rejectQuestion(qId: string, directory: string): Promise<void> {
    const request = await this.requestFn()
    const [sessionId, actualQId] = qId.includes(":") ? qId.split(":") : ["", qId]
    const endpoint = sessionId
      ? `/session/${sessionId}/question/${actualQId}/reject`
      : `/question/${qId}/reject`
    const response = await request(OpenCodeHarnessAdapter.request(endpoint, {
      method: "POST",
      headers: this.headers(directory),
    }))
    requireUpstream(response, "Reject OpenCode question")
  }

  async getTodos(sessionId: string, directory: string): Promise<Array<{ content: string; status: string; priority: string }>> {
    const request = await this.requestFn()
    const res = await request(OpenCodeHarnessAdapter.request(`/session/${sessionId}/todo`, {
      headers: this.headers(directory),
    }))
    requireUpstream(res, "List OpenCode todos")
    return res.json() as Promise<Array<{ content: string; status: string; priority: string }>>
  }

  applyConfig(config: Record<string, unknown>): Promise<void> {
    this.cfg = (config.mcp as Record<string, ResolvedMcpServer> | undefined) ?? {}
    this.auth = (config.auth as Record<string, string> | undefined) ?? {}
    this.syncNonSpawnedMcpObservations()
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

  async probeConfigOptions(_directory: string): Promise<never> {
    throw new Error("opencode does not expose harness config options")
  }

  dispose(): void {
    this.goalMonitors.dispose()
    this.transportObservation?.exit({ reason: "disposed" })
    this.mcpObservations.forEach((handle) => handle.exit({ reason: "disposed" }))
    this.mcpObservations = []
    this.server.dispose()
  }

  private syncNonSpawnedMcpObservations() {
    if (!this.rootOwnerId) return
    this.mcpObservations.forEach((handle) => handle.exit({ reason: "disposed" }))
    this.mcpObservations = Object.values(this.cfg).map((server) => observeAgentProcess(
      this.processObserver,
      {
        ownerId: `opencode-mcp:${randomUUID()}`,
        launchId: randomUUID(),
        harnessId: "opencode",
        access: "native",
        role: "mcp",
        label: `MCP ${server.name}`,
        locality: server.transport === "stdio" && this.injectedRequest ? "in-process" : "remote",
        confidence: server.transport === "stdio" && this.injectedRequest ? "inferred" : "not-process-backed",
        capabilities: {
          resourceMetrics: server.transport === "stdio" && this.injectedRequest ? "shared-process" : "none",
          ownerActions: false,
        },
        parentOwnerId: this.rootOwnerId!,
        mcpName: server.name,
        transport: server.transport === "stdio" ? "stdio" : "streamable-http",
        ...(server.transport === "stdio" && this.injectedRequest
          ? { executableBasename: server.command.split(/[\\/]/).at(-1) || "mcp" }
          : {}),
      },
    ))
  }
}
