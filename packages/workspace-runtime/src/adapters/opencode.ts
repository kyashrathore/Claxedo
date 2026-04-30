/**
 * OpenCodeAdapter
 *
 * Manages an opencode server process and proxies HTTP requests to it.
 * If constructed with a URL, proxies to that existing server (backward compat).
 * If constructed without a URL, spawns `opencode serve` on demand.
 *
 * Session methods forward requests with x-opencode-directory header.
 * sendMessage() subscribes to /global/event SSE and forwards CompatEvent.
 */

import { spawn, type ChildProcess } from "child_process"
import path from "path"
import {
  buildAssistantMessage,
  buildUserMessage,
  eventSessionId,
  messageCompleted,
  messageUpdated,
  sessionError,
  toCompatEvent,
  type CompatEvent,
} from "../compat-events"
import type { AgentAdapter, PromptInput, SessionConfig, SessionConfigPatch } from "./index"
import { listCommands } from "../agent-config"
import { Log } from "../log"
import { dataDir } from "../paths"
import { workspaceDir } from "../target"
import { toOpencodeConfig, type ResolvedMcpServer } from "../mcp-resolver"

const log = Log.create({ service: "opencode-adapter" })
const OPENCODE_CONFIG_DIR = path.join(dataDir(), "opencode-config")

const IDLE_TIMEOUT_MS = (() => {
  const v = Number(process.env.CLAXEDO_OC_IDLE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 5 * 60 * 1000
})()

export function spawnEnv(base = process.env) {
  if (base.OPENCODE_CONFIG_DIR) return { ...base }
  return {
    ...base,
    OPENCODE_CONFIG_DIR,
  }
}

function json(input: string | undefined) {
  if (!input) return
  try {
    const value = JSON.parse(input) as Record<string, unknown>
    return value && typeof value === "object" ? value : undefined
  } catch {}
}

function authEntry(input: string | undefined) {
  const value = json(input)
  if (!value) {
    const key = input?.trim()
    if (!key) return
    return { type: "api" as const, key }
  }
  if (value.type === "api" && typeof value.key === "string") {
    return { type: "api" as const, key: value.key }
  }
  if (
    value.type === "oauth"
    && typeof value.refresh === "string"
    && typeof value.access === "string"
    && typeof value.expires === "number"
  ) {
    return {
      type: "oauth" as const,
      refresh: value.refresh,
      access: value.access,
      expires: value.expires,
      ...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
      ...(typeof value.enterpriseUrl === "string" ? { enterpriseUrl: value.enterpriseUrl } : {}),
    }
  }
  if (value.type !== "codex_auth") return
  const refresh =
    typeof value.refresh === "string"
      ? value.refresh
      : value.oauth && typeof value.oauth === "object" && typeof (value.oauth as Record<string, unknown>).refresh === "string"
        ? (value.oauth as Record<string, unknown>).refresh as string
        : undefined
  const access =
    typeof value.access === "string"
      ? value.access
      : value.oauth && typeof value.oauth === "object" && typeof (value.oauth as Record<string, unknown>).access === "string"
        ? (value.oauth as Record<string, unknown>).access as string
        : undefined
  const expires =
    typeof value.expires === "number"
      ? value.expires
      : value.oauth && typeof value.oauth === "object" && typeof (value.oauth as Record<string, unknown>).expires === "number"
        ? (value.oauth as Record<string, unknown>).expires as number
        : undefined
  if (typeof value.OPENAI_API_KEY === "string" && value.OPENAI_API_KEY) {
    return { type: "api" as const, key: value.OPENAI_API_KEY }
  }
  if (!refresh || !access || !expires) return
  return {
    type: "oauth" as const,
    refresh,
    access,
    expires,
    ...(typeof value.account_id === "string" ? { accountId: value.account_id } : {}),
    ...(value.oauth && typeof value.oauth === "object" && typeof (value.oauth as Record<string, unknown>).account_id === "string"
      ? { accountId: (value.oauth as Record<string, unknown>).account_id as string }
      : {}),
    ...(typeof value.enterprise_url === "string" ? { enterpriseUrl: value.enterprise_url } : {}),
    ...(value.oauth && typeof value.oauth === "object" && typeof (value.oauth as Record<string, unknown>).enterprise_url === "string"
      ? { enterpriseUrl: (value.oauth as Record<string, unknown>).enterprise_url as string }
      : {}),
  }
}

export function opencodeAuthContent(auth: Record<string, string> | undefined) {
  const openai = authEntry(auth?.openai ?? auth?.["codex-acp"])
  if (!openai) return
  return JSON.stringify({ openai })
}

export class OpenCodeAdapter implements AgentAdapter {
  private fixedUrl: string
  private opencodeUrl: string
  private base: Headers
  private proc: ChildProcess | null = null
  private spawnPromise: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private shouldSpawn: boolean
  private cfg: Record<string, ResolvedMcpServer> = {}
  private auth: Record<string, string> = {}

  constructor(opencodeUrl?: string, input?: { headers?: HeadersInit }) {
    this.fixedUrl = opencodeUrl ?? ""
    this.opencodeUrl = this.fixedUrl
    this.base = new Headers(input?.headers)
    this.shouldSpawn = !this.fixedUrl
  }

  // ── Server lifecycle ─────────────────────────────────────────────────────────

  /** Ensure the opencode server is running, spawning if needed. Returns the URL. */
  private async ensureServer(): Promise<string> {
    if (this.opencodeUrl) {
      this.resetIdleTimer()
      return this.opencodeUrl
    }
    if (this.fixedUrl) {
      this.opencodeUrl = this.fixedUrl
      return this.opencodeUrl
    }
    if (!this.shouldSpawn) {
      throw new Error("No opencode server URL configured")
    }
    if (!this.spawnPromise) {
      this.spawnPromise = this.spawnServer()
    }
    await this.spawnPromise
    return this.opencodeUrl
  }

  /** Public accessor for server.ts /provider proxy. */
  async getServerUrl(): Promise<string> {
    return this.ensureServer()
  }

  private resetIdleTimer() {
    if (!this.proc) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      log.info("opencode process idle timeout, disposing", { idleMs: IDLE_TIMEOUT_MS })
      this.killProcess()
    }, IDLE_TIMEOUT_MS)
  }

  private async spawnServer(): Promise<void> {
    const port = 10000 + Math.floor(Math.random() * 50000)
    const directory = workspaceDir()

    log.info("Spawning opencode server", { port, directory })

    const env = spawnEnv({
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(toOpencodeConfig(this.cfg)),
      ...(opencodeAuthContent(this.auth) ? { OPENCODE_AUTH_CONTENT: opencodeAuthContent(this.auth)! } : {}),
    })
    const proc = spawn("opencode", ["serve", `--hostname=127.0.0.1`, `--port=${port}`], {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    })

    this.proc = proc

    // Persistent exit handler — clears state so next call re-spawns
    proc.on("exit", (code, signal) => {
      log.info("opencode process exited", { code, signal })
      if (this.proc === proc) {
        this.proc = null
        this.opencodeUrl = ""
        this.spawnPromise = null
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
      }
    })

    proc.on("error", (err) => {
      log.error("opencode spawn error", { err })
    })

    proc.stderr?.on("data", (chunk: Buffer) => {
      log.info("opencode stderr", { text: chunk.toString().trim() })
    })

    // Wait for "opencode server listening on <url>" in stdout
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for opencode server to start (15s)"))
      }, 15_000)

      let output = ""
      proc.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString()
        for (const line of output.split("\n")) {
          if (line.includes("opencode server listening")) {
            const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
            if (match) {
              clearTimeout(timeout)
              resolve(match[1]!)
              return
            }
          }
        }
      })

      // If the process exits during startup, reject
      proc.once("exit", (code) => {
        clearTimeout(timeout)
        reject(new Error(`opencode exited during startup (code ${code}):\n${output}`))
      })
    })

    this.opencodeUrl = url
    this.resetIdleTimer()
    log.info("opencode server started", { url })
  }

  private killProcess() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.proc) {
      log.info("Killing opencode process")
      try { this.proc.kill("SIGTERM") } catch {}
      this.proc = null
    }
    this.opencodeUrl = this.fixedUrl
    this.spawnPromise = null
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private headers(directory: string, type = true) {
    const headers = new Headers(this.base)
    headers.set("x-opencode-directory", directory)
    if (type) headers.set("Content-Type", "application/json")
    return headers
  }

  // ── Session lifecycle ────────────────────────────────────────────────────────

  async listSessions(directory: string): Promise<unknown[]> {
    const url = await this.ensureServer()
    const res = await fetch(`${url}/session`, {
      headers: this.headers(directory),
    })
    if (!res.ok) return []
    return res.json() as Promise<unknown[]>
  }

  async getSession(id: string, directory: string): Promise<unknown | null> {
    const url = await this.ensureServer()
    const res = await fetch(`${url}/session/${id}`, {
      headers: this.headers(directory),
    })
    if (!res.ok) return null
    return res.json()
  }

  async createSession(directory: string, title?: string): Promise<{ id: string }> {
    const url = await this.ensureServer()
    const res = await fetch(`${url}/session`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify(title ? { title } : {}),
    })
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`)
    return res.json() as Promise<{ id: string }>
  }

  async updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, directory: string): Promise<unknown | null> {
    const url = await this.ensureServer()
    const res = await fetch(`${url}/session/${id}`, {
      method: "PATCH",
      headers: this.headers(directory),
      body: JSON.stringify(updates),
    })
    if (!res.ok) return null
    return res.json()
  }

  async getSessionConfig(_id: string, _directory: string): Promise<SessionConfig> {
    return {
      runner: { type: "opencode" },
      variant: null,
      agent: null,
    }
  }

  async updateSessionConfig(_id: string, patch: SessionConfigPatch, _directory: string): Promise<SessionConfig> {
    return {
      runner: patch.runner ?? { type: "opencode" },
      ...(patch.model ? { model: patch.model } : {}),
      variant: patch.variant ?? null,
      agent: patch.agent ?? null,
    }
  }

  async deleteSession(id: string, directory: string): Promise<void> {
    const url = await this.ensureServer()
    await fetch(`${url}/session/${id}`, {
      method: "DELETE",
      headers: this.headers(directory),
    })
  }

  // ── Messaging ────────────────────────────────────────────────────────────────

  async *sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<CompatEvent> {
    const url = await this.ensureServer()
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
    }
    yield messageUpdated(buildAssistantMessage({
      id: input.assistantMessageId,
      sessionID: id,
      parentID: input.userMessageId ?? id,
      agent: input.agent,
      model: input.model,
      directory,
    }))

    const eventStream = this.openEventStream(url)
    await eventStream.ready

    const postRes = await fetch(`${url}/session/${id}/prompt_async`, {
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
    }).catch((err) => {
      eventStream.close()
      return null as null
    })

    if (!postRes || !postRes.ok) {
      eventStream.close()
      const text = postRes ? await postRes.text().catch(() => "unknown error") : "connection refused"
      yield messageCompleted(id, input.assistantMessageId)
      yield sessionError(`Failed to send message: ${text}`, id)
      return
    }

    yield* this.drainEventStream(eventStream, id)
    yield messageCompleted(id, input.assistantMessageId)
  }

  private openEventStream(serverUrl: string): {
    close(): void
    reader: ReadableStreamDefaultReader<Uint8Array> | null
    abortController: AbortController
    ready: Promise<void>
    err?: string
  } {
    const abortController = new AbortController()
    let done = () => {}
    const ready = new Promise<void>((resolve) => {
      done = resolve
    })
    const handle = {
      close: () => abortController.abort(),
      reader: null as ReadableStreamDefaultReader<Uint8Array> | null,
      abortController,
      ready,
      err: undefined as string | undefined,
    }

    fetch(`${serverUrl}/global/event`, {
      headers: (() => {
        const headers = new Headers(this.base)
        headers.set("Accept", "text/event-stream")
        return headers
      })(),
      signal: abortController.signal,
    })
      .then((res) => {
        if (res.ok && res.body) {
          handle.reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
          done()
          return
        }
        handle.err = `Failed to connect to opencode event stream: ${res.status}`
        abortController.abort()
        done()
      })
      .catch((err) => {
        handle.err = err instanceof Error ? err.message : String(err)
        done()
      })

    return handle
  }

  private async *drainEventStream(
    handle: ReturnType<typeof OpenCodeAdapter.prototype.openEventStream>,
    sessionId: string,
  ): AsyncIterable<CompatEvent> {
    await handle.ready
    if (!handle.reader) {
      yield sessionError(handle.err ?? "Failed to connect to opencode event stream", sessionId)
      return
    }

    yield* this.subscribeGlobalEventsFromReader(handle.reader, sessionId)
    handle.close()
  }

  private async *subscribeGlobalEventsFromReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    sessionId: string,
  ): AsyncIterable<CompatEvent> {
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const raw = line.slice(6).trim()
          if (!raw) continue
          try {
            const raw_data = JSON.parse(raw) as {
              payload?: unknown
              type?: string
              properties?: Record<string, unknown>
            }
            const event = toCompatEvent(raw_data.payload ?? raw_data)
            if (!event) continue
            const evtSessionId = eventSessionId(event)
            if (evtSessionId && evtSessionId !== sessionId) continue
            yield event
            if (event.type === "session.idle" || event.type === "session.error") return
          } catch {
            // ignore
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async *readSseStream(
    body: ReadableStream<Uint8Array>,
    sessionId: string,
  ): AsyncIterable<CompatEvent> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const raw = line.slice(6).trim()
          if (!raw || raw === "[DONE]") continue
          try {
            const event = toCompatEvent(JSON.parse(raw))
            if (!event) continue
            const evtSessionId = eventSessionId(event)
            if (evtSessionId && evtSessionId !== sessionId) continue
            yield event
            if (event.type === "session.idle" || event.type === "session.error") return
          } catch {
            // ignore parse errors
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  // ── Remaining API methods ────────────────────────────────────────────────────

  async getMessages(id: string, directory: string): Promise<unknown[]> {
    const url = await this.ensureServer()
    const res = await fetch(`${url}/session/${id}/message`, {
      headers: this.headers(directory),
    })
    if (!res.ok) return []
    return res.json() as Promise<unknown[]>
  }

  async abort(id: string, directory: string) {
    const url = await this.ensureServer()
    const res = await fetch(`${url}/session/${id}/abort`, {
      method: "POST",
      headers: this.headers(directory),
    })
    if (!res.ok) return { ok: false as const, status: "failed" as const, message: `Abort failed with HTTP ${res.status}` }
    return { ok: true as const, status: "cancelled" as const }
  }

  async revert(id: string, directory: string): Promise<void> {
    const url = await this.ensureServer()
    await fetch(`${url}/session/${id}/revert`, {
      method: "POST",
      headers: this.headers(directory),
    })
  }

  async unrevert(id: string, directory: string): Promise<void> {
    const url = await this.ensureServer()
    await fetch(`${url}/session/${id}/unrevert`, {
      method: "POST",
      headers: this.headers(directory),
    })
  }

  async forkSession(id: string, messageId: string, directory: string): Promise<{ id: string }> {
    const url = await this.ensureServer()
    const res = await fetch(`${url}/session/${id}/fork`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({ messageId }),
    })
    if (!res.ok) throw new Error(`Fork failed: ${res.status}`)
    return res.json() as Promise<{ id: string }>
  }

  async executeCommand(id: string, command: string, directory: string): Promise<void> {
    const url = await this.ensureServer()
    await fetch(`${url}/session/${id}/command`, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({ command }),
    })
  }

  async listCommands(_directory: string): Promise<unknown[]> {
    return listCommands()
  }

  async listAgents(_directory: string): Promise<unknown[]> {
    try {
      const url = await this.ensureServer()
      const res = await fetch(`${url}/agent`, {
        headers: this.headers(_directory, true),
      })
      if (!res.ok) return []
      return (await res.json()) as unknown[]
    } catch {
      return []
    }
  }

  async listPermissions(directory: string): Promise<unknown[]> {
    const url = await this.ensureServer()
    const res = await fetch(`${url}/permission`, {
      headers: this.headers(directory),
    })
    if (!res.ok) return []
    return res.json() as Promise<unknown[]>
  }

  async respondPermission(
    permId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
    directory: string,
  ): Promise<void> {
    const url = await this.ensureServer()
    const [sessionId, actualPermId] = permId.includes(":") ? permId.split(":") : ["", permId]
    const endpoint = sessionId
      ? `${url}/session/${sessionId}/permissions/${actualPermId}`
      : `${url}/permission/${permId}/respond`
    await fetch(endpoint, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({
        decision: decision === "reject_always" ? "deny" : decision,
      }),
    })
  }

  async listQuestions(directory: string): Promise<unknown[]> {
    const url = await this.ensureServer()
    const res = await fetch(`${url}/question`, {
      headers: this.headers(directory),
    })
    if (!res.ok) return []
    return res.json() as Promise<unknown[]>
  }

  async replyQuestion(qId: string, answer: string, directory: string): Promise<void> {
    const url = await this.ensureServer()
    const [sessionId, actualQId] = qId.includes(":") ? qId.split(":") : ["", qId]
    const endpoint = sessionId
      ? `${url}/session/${sessionId}/question/${actualQId}/reply`
      : `${url}/question/${qId}/reply`
    await fetch(endpoint, {
      method: "POST",
      headers: this.headers(directory),
      body: JSON.stringify({ answer }),
    })
  }

  async rejectQuestion(qId: string, directory: string): Promise<void> {
    const url = await this.ensureServer()
    const [sessionId, actualQId] = qId.includes(":") ? qId.split(":") : ["", qId]
    const endpoint = sessionId
      ? `${url}/session/${sessionId}/question/${actualQId}/reject`
      : `${url}/question/${qId}/reject`
    await fetch(endpoint, {
      method: "POST",
      headers: this.headers(directory),
    })
  }

  async getTodos(sessionId: string, directory: string): Promise<Array<{ content: string; status: string; priority: string }>> {
    const url = await this.ensureServer()
    const res = await fetch(`${url}/session/${sessionId}/todo`, {
      headers: this.headers(directory),
    })
    if (!res.ok) return []
    return res.json() as Promise<Array<{ content: string; status: string; priority: string }>>
  }

  applyConfig(config: Record<string, unknown>): Promise<void> {
    this.cfg = (config.mcp as Record<string, ResolvedMcpServer> | undefined) ?? {}
    this.auth = (config.auth as Record<string, string> | undefined) ?? {}
    if (this.shouldSpawn && this.proc) {
      log.info("applyConfig: restarting spawned opencode to apply config", {
        hasAuth: !!opencodeAuthContent(this.auth),
      })
      this.killProcess()
      return Promise.resolve()
    }
    log.info("applyConfig: opencode config cached", {
      mode: this.shouldSpawn ? "spawned" : "external",
      mcp: Object.keys(this.cfg),
      hasAuth: !!opencodeAuthContent(this.auth),
    })
    return Promise.resolve()
  }

  async probeConfigOptions(_directory: string): Promise<unknown[]> {
    return []
  }

  dispose(): void {
    this.killProcess()
  }
}
