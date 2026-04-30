/**
 * ACPAdapter
 *
 * Drives Claude, Codex, and Cursor ACP agents using the @agentclientprotocol/sdk.
 * One ACP process per local session, lazily spawned and idle-killed after
 * CLAXEDO_ACP_IDLE_TIMEOUT_MS. A separate probe process is used for config
 * discovery so active sessions can run in parallel.
 *
 * Uses a local SQLite database (~/.claxedo/wr-sessions.db) to persist session mappings.
 *
 * ACP session/update notification → UIMessageChunk mapping:
 *   agent_message_chunk (text) → text-delta
 *   tool_call            → tool-start
 *   tool_call_update (completed/failed) → tool-output
 *   plan                 → todo-update
 *   session/prompt response → finish
 *   requestPermission    → permission-request (sync, awaits user response)
 */

import { spawn, type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import fs from "fs"
import * as path from "path"
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type PermissionOption,
  type PermissionOptionKind,
  type McpServer,
  type StopReason,
  type SessionConfigOption,
  type Usage,
} from "@agentclientprotocol/sdk"
import {
  buildAssistantMessage,
  buildUserMessage,
  messageUpdated,
  permissionAsked,
  permissionReplied,
  sessionError,
  sessionStatus,
  sessionUpdated,
  withDir,
  type CompatEvent,
} from "../compat-events"
import { publishGlobalEvent } from "../global-event-bus"
import { RuntimeStore } from "../store"
import type { AbortResult, AgentAdapter, PromptInput, SessionConfig, SessionConfigPatch } from "./index"
import { blocks, extractAgents, init, merge, resume, sync, type ACPState } from "./acp-session"
import { translateSessionUpdate, translateStopReason, createTranslatorContext } from "./translate-session-update"
import { translateAgentEventToCompat } from "./translate-agent-event-to-compat"
import { listCommands } from "../agent-config"
import { Log } from "../log"
import { ACP_RECOVER } from "./acp-recovery"
import { recovering } from "../types/status"
import { toAcpMcpServers, type ResolvedMcpServer } from "../mcp-resolver"

const log = Log.create({ service: "acp-adapter" })

const MODEL_ENV_VARS: Record<string, string> = {
  "claude-agent-acp": "ANTHROPIC_MODEL",
  "codex-acp": "OPENAI_MODEL",
}

/** Maps ACP binary name → env var that holds its API key */
const AUTH_ENV_VARS: Record<string, string> = {
  "claude-agent-acp": "ANTHROPIC_API_KEY",
  "codex-acp": "OPENAI_API_KEY",
  agent: "CURSOR_API_KEY",
  "cursor-agent": "CURSOR_API_KEY",
}

// Module-level auth store — updated by config push from claxedo-server
const _acpAuthKeys: { anthropic?: string; openai?: string; cursor?: string } = {}

/** Called by config push handler to update API keys for next ACP process spawn. */
export function setAcpAuth(keys: { anthropic?: string; openai?: string; cursor?: string }): void {
  if (keys.anthropic !== undefined) _acpAuthKeys.anthropic = keys.anthropic || undefined
  if (keys.openai !== undefined) _acpAuthKeys.openai = keys.openai || undefined
  if (keys.cursor !== undefined) _acpAuthKeys.cursor = keys.cursor || undefined
  log.info("ACP auth keys updated", {
    hasAnthropic: !!_acpAuthKeys.anthropic,
    hasOpenai: !!_acpAuthKeys.openai,
    hasCursor: !!_acpAuthKeys.cursor,
  })
}

const IDLE_TIMEOUT_MS = (() => {
  const v = Number(process.env.CLAXEDO_ACP_IDLE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 5 * 60 * 1000
})()

const PROMPT_TIMEOUT_MS = (() => {
  const v = Number(process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 5 * 60_000
})()

const RPC_STALL_LOG_MS = (() => {
  const v = Number(process.env.CLAXEDO_ACP_RPC_STALL_LOG_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 5_000
})()

function probeTimeoutMs() {
  const v = Number(process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : newSessionTimeoutMs()
}

function newSessionTimeoutMs() {
  const v = Number(process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 10_000
}

function bun() {
  const name = process.platform === "win32" ? "bun.exe" : "bun"
  const parts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const home = process.env.HOME ? path.join(process.env.HOME, ".bun", "bin") : ""
  for (const dir of [...parts, home].filter(Boolean)) {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) return file
  }
}

function launch(binary: string, args: string[]) {
  const name = path.basename(binary).replace(/\.exe$/i, "")
  if (name !== "claude-agent-acp" && name !== "codex-acp") return { cmd: binary, args, name, mode: "direct" as const }
  const bunPath = bun()
  if (!bunPath) return { cmd: binary, args, name, mode: "direct" as const }
  try {
    const file = fs.realpathSync(binary)
    const head = fs.readFileSync(file, "utf8").slice(0, 64)
    if (!head.startsWith("#!/usr/bin/env node")) return { cmd: binary, args, name, mode: "direct" as const }
    return { cmd: bunPath, args: [file, ...args], name, mode: "bun" as const }
  } catch {
    return { cmd: binary, args, name, mode: "direct" as const }
  }
}

/** Extract a human-readable message from any error value (Error, JSON-RPC error object, or unknown). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>
    // JSON-RPC error object: { code, message, data } — prefer data.message (detailed) over top-level message (generic)
    if (obj.data && typeof obj.data === "object" && typeof (obj.data as Record<string, unknown>).message === "string") {
      return (obj.data as Record<string, unknown>).message as string
    }
    if (typeof obj.message === "string") return obj.message
    try { return JSON.stringify(err) } catch { /* fall through */ }
  }
  return String(err)
}

function chunkDelta(input: unknown) {
  if (!input || typeof input !== "object") return
  const row = input as { sessionUpdate?: unknown; delta?: unknown }
  if (row.sessionUpdate !== "agent_message_chunk") return
  if (typeof row.delta !== "string") return
  return row.delta
}

function messageUsage(usage: Usage) {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    reasoning: usage.thoughtTokens ?? 0,
    cache: {
      read: usage.cachedReadTokens ?? 0,
      write: usage.cachedWriteTokens ?? 0,
    },
  }
}

function missing(err: unknown) {
  const msg = errorMessage(err)
  return msg.includes("Resource not found")
}

function watch(op: string, extra: Record<string, unknown>) {
  const ts = Date.now()
  const id = setTimeout(() => {
    log.warn("ACP RPC still waiting", {
      op,
      waitMs: Date.now() - ts,
      ...extra,
    })
  }, RPC_STALL_LOG_MS)
  return () => clearTimeout(id)
}

/** Extract plain text from prompt parts for title generation. */
function extractTextFromParts(parts: unknown[]): string {
  for (const part of parts) {
    if (!part || typeof part !== "object") continue
    const p = part as Record<string, unknown>
    if (p.type === "text" && typeof p.text === "string") return p.text.trim()
    // InputText variant
    if (p.type === "input_text" && typeof p.text === "string") return p.text.trim()
    // Plain string content
    if (typeof p.content === "string") return p.content.trim()
  }
  return ""
}

type SessionUpdate = SessionNotification["update"]
type PermissionPusher = (permId: string, tool: string, paths: string[]) => void

interface PendingPermission {
  aid: string
  tool: string
  paths: string[]
  options: PermissionOption[]
  resolve: (response: RequestPermissionResponse) => void
}
type ProcEntry = {
  directory: string
  proc: ACPProcess | null
  init: Promise<{ proc: ACPProcess; isNew: boolean }> | null
}
type ProbeEntry = {
  directory: string
  proc: ACPProcess | null
  init: Promise<ACPProcess> | null
}

function root() {
  return process.cwd()
}

// ── Shared ACP process ───────────────────────────────────────────────────────

class ACPProcess {
  private proc: ChildProcess
  readonly conn: ClientSideConnection
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private caps: InitializeResponse["agentCapabilities"] | null = null
  readonly pendingPermissions = new Map<string, PendingPermission>()
  // agentSessionId → update listener
  readonly sessionListeners = new Map<string, (update: SessionUpdate) => void>()
  private states = new Map<string, ACPState>()
  // agentSessionId → permission pusher
  readonly permissionPushers = new Map<string, PermissionPusher>()
  /** Cached config options from newSession() response or config_option_update notifications */
  cachedConfigOptions: SessionConfigOption[] | null = null
  // Serial queue: ACP processes one prompt at a time per process
  private promptQueue: Promise<void> = Promise.resolve()
  private promptQueueDepth = 0

  constructor(
    readonly directory: string,
    binary: string,
    args: string[],
    model: string,
    private readonly mcp: () => McpServer[],
    private readonly onDead: () => void,
  ) {
    const child = launch(binary, args)
    log.info("Spawning ACP process", {
      binary,
      args,
      directory,
      model,
      mode: child.mode,
      command: child.cmd,
      commandArgs: child.args,
    })

    const binaryName = child.name
    const modelEnvKey = MODEL_ENV_VARS[binaryName]
    const authEnvKey = AUTH_ENV_VARS[binaryName]
    const authValue =
      binaryName === "claude-agent-acp"
        ? _acpAuthKeys.anthropic
        : binaryName === "codex-acp"
          ? _acpAuthKeys.openai
          : _acpAuthKeys.cursor
    const env = {
      ...process.env,
      ...(model && modelEnvKey ? { [modelEnvKey]: model } : {}),
      ...(authValue && authEnvKey ? { [authEnvKey]: authValue } : {}),
    }

    this.proc = spawn(child.cmd, child.args, {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    })

    this.proc.stderr?.on("data", (data: Buffer) => {
      // Promoted to info so binary errors are always visible
      log.info("ACP stderr", { text: data.toString().trim() })
    })

    this.proc.on("exit", (code, signal) => {
      log.info("ACP process exited", { code, signal, directory })
      this.onDead()
    })

    this.proc.on("error", (err) => {
      log.error("ACP spawn error", { err, binary, directory })
      this.onDead()
    })

    // Convert Node streams → Web streams for the SDK
    const stdin = this.proc.stdin!
    const stdout = this.proc.stdout!

    const webWritable = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise((resolve, reject) => {
          stdin.write(chunk, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      },
      close() { stdin.end() },
    })

    const webReadable = new ReadableStream<Uint8Array>({
      start(controller) {
        stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
        stdout.on("end", () => controller.close())
        stdout.on("error", (err) => controller.error(err))
      },
    })

    const stream = ndJsonStream(webWritable, webReadable)

    const self = this
    const clientImpl: Client = {
      sessionUpdate: async (params: SessionNotification) => {
        const kind = params.update?.sessionUpdate ?? "(unknown)"
        log.info("ACP sessionUpdate received", {
          sessionId: params.sessionId,
          kind,
          hasListener: self.sessionListeners.has(params.sessionId),
        })
        // Always cache config options (even without a per-session listener)
        if (params.update?.sessionUpdate === "config_option_update") {
          const opts = (params.update as { configOptions: SessionConfigOption[] }).configOptions
          self.remember(params.sessionId, { configOptions: opts })
          log.info("ACP sessionUpdate: cached config options", { count: opts.length })
        }
        const listener = self.sessionListeners.get(params.sessionId)
        if (!listener) {
          log.info("ACP sessionUpdate: no listener registered, dropping update", {
            sessionId: params.sessionId,
            kind,
          })
          return
        }
        listener(params.update)
      },
      requestPermission: async (params: RequestPermissionRequest) => {
        const permId = randomUUID()
        const toolCall = params.toolCall
        const tool = toolCall.title ?? "unknown"
        const paths: string[] = []
        const hasListener = self.sessionListeners.has(params.sessionId)

        log.info("ACP requestPermission received", {
          sessionId: params.sessionId,
          tool,
          permId,
          optionKinds: params.options.map((o) => o.kind),
          hasListener,
        })

        return new Promise<RequestPermissionResponse>((resolve) => {
          self.pendingPermissions.set(permId, {
            aid: params.sessionId,
            tool,
            paths,
            options: params.options,
            resolve,
          })

          // Push permission-request directly via the registered pusher (no synthetic injection)
          const pusher = self.permissionPushers.get(params.sessionId)
          if (pusher) {
            log.info("ACP requestPermission: pushing permission-request to stream", {
              permId,
              tool,
            })
            pusher(permId, tool, (params.toolCall.locations ?? []).map((l) => l.path))
          } else {
            log.info(
              "ACP requestPermission: no active pusher — permission stored but not forwarded to frontend yet",
              { permId, tool, sessionId: params.sessionId },
            )
          }
        })
      },
    }

    this.conn = new ClientSideConnection((_agent) => clientImpl, stream)
    this.resetIdleTimer()
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      log.info("ACP process idle timeout, disposing", { directory: this.directory, idleMs: IDLE_TIMEOUT_MS })
      this.dispose()
    }, IDLE_TIMEOUT_MS)
  }

  async initialize(): Promise<void> {
    this.resetIdleTimer()
    const t0 = Date.now()
    log.info("ACP initialize: starting handshake", { directory: this.directory })
    const result = await this.conn.initialize({
      protocolVersion: 1,
      clientInfo: { name: "claxedo-workspace-runtime", version: "0.1.0" },
      clientCapabilities: {
        auth: { terminal: false },
        // Allow filesystem and terminal — the ACP binary will call requestPermission
        // before executing sensitive operations. Setting these false causes the binary
        // to auto-fail those tool calls without ever asking for permission.
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    })
    this.caps = result.agentCapabilities ?? null
    log.info("ACP initialize: handshake complete", { directory: this.directory, ms: Date.now() - t0 })
  }

  private state(sessionId: string) {
    return this.states.get(sessionId) ?? init(this.caps)
  }

  private remember(sessionId: string, meta: Parameters<typeof merge>[1]) {
    const next = merge(this.state(sessionId), meta)
    this.states.set(sessionId, next)
    if (next.cfg && next.cfg.length > 0) this.cachedConfigOptions = next.cfg
    return next
  }

  /** Derive available agents from any session state or cached config options. */
  getAgents(): Array<{ name: string; description?: string; mode: string }> {
    // Try extracting from the first available session state
    for (const state of this.states.values()) {
      const agents = extractAgents(state)
      if (agents.length > 0) return agents
    }
    // Fall back to cached config options (available even before a session prompt)
    if (this.cachedConfigOptions) {
      const agents = extractAgents({
        caps: this.caps,
        prompt: null,
        cfg: this.cachedConfigOptions,
        modeIds: [],
        models: false,
      })
      if (agents.length > 0) return agents
    }
    return []
  }

  async newSession(workingDirectory: string, _title?: string): Promise<string> {
    this.resetIdleTimer()
    const t0 = Date.now()
    log.info("ACP newSession: calling conn.newSession", { workingDirectory })
    const result = await this.conn.newSession({
      cwd: workingDirectory,
      mcpServers: this.mcp(),
    })
    this.remember(result.sessionId, result)
    log.info("ACP newSession: got sessionId", { agentSessionId: result.sessionId, ms: Date.now() - t0 })
    return result.sessionId
  }

  async resumeSession(agentSessionId: string, workingDirectory: string) {
    this.resetIdleTimer()
    const t0 = Date.now()
    const state = this.state(agentSessionId)
    const kind =
      state.caps?.sessionCapabilities?.resume
        ? "resume"
        : state.caps?.loadSession
          ? "load"
          : "none"
    const pid = this.proc.pid ?? null
    log.info("ACP session restore: starting", {
      agentSessionId,
      workingDirectory,
      kind,
      pid,
      modeCount: state.modeIds.length,
      hasCfg: !!state.cfg?.length,
      models: state.models,
    })
    const stop = watch("resumeSession", { agentSessionId, workingDirectory, kind, pid })
    try {
      const result = await resume(this.conn, state, agentSessionId, workingDirectory, this.mcp())
      this.states.set(agentSessionId, result.state)
      if (result.state.cfg && result.state.cfg.length > 0) this.cachedConfigOptions = result.state.cfg
      log.info("ACP session restored", { agentSessionId, kind: result.kind, pid, ms: Date.now() - t0 })
    } catch (err) {
      log.error("ACP session restore failed", {
        agentSessionId,
        workingDirectory,
        kind,
        pid,
        err,
        ms: Date.now() - t0,
      })
      throw err
    } finally {
      stop()
    }
  }

  async syncSession(agentSessionId: string, input: PromptInput) {
    this.resetIdleTimer()
    const t0 = Date.now()
    const state = this.state(agentSessionId)
    const pid = this.proc.pid ?? null
    log.info("ACP session sync: starting", {
      agentSessionId,
      agent: input.agent,
      model: input.model.modelID,
      variant: input.variant ?? null,
      pid,
      modeCount: state.modeIds.length,
      hasCfg: !!state.cfg?.length,
      models: state.models,
    })
    const stop = watch("syncSession", {
      agentSessionId,
      agent: input.agent,
      model: input.model.modelID,
      variant: input.variant ?? null,
      pid,
    })
    try {
      const next = await sync(this.conn, state, agentSessionId, input)
      this.states.set(agentSessionId, next)
      if (next.cfg && next.cfg.length > 0) this.cachedConfigOptions = next.cfg
      log.info("ACP session synced", {
        agentSessionId,
        agent: input.agent,
        model: input.model.modelID,
        variant: input.variant ?? null,
        pid,
        ms: Date.now() - t0,
      })
    } catch (err) {
      log.error("ACP session sync failed", {
        agentSessionId,
        agent: input.agent,
        model: input.model.modelID,
        variant: input.variant ?? null,
        pid,
        err,
        ms: Date.now() - t0,
      })
      throw err
    } finally {
      stop()
    }
  }

  async prompt(
    agentSessionId: string,
    input: PromptInput,
    onUpdate: (update: SessionUpdate) => void,
  ): Promise<{ stopReason: StopReason; usage?: Usage | null }> {
    this.resetIdleTimer()

    // Serialize: only one prompt runs at a time per ACP process.
    let slotRelease!: () => void
    const prev = this.promptQueue
    this.promptQueue = new Promise<void>((resolve) => { slotRelease = resolve })
    this.promptQueueDepth++

    if (this.promptQueueDepth > 1) {
      log.info("ACP prompt: waiting in serial queue", {
        agentSessionId,
        queueDepth: this.promptQueueDepth,
      })
    }
    await prev
    this.promptQueueDepth--

    log.info("ACP prompt: starting", {
      agentSessionId,
      partCount: input.parts.length,
      timeoutMs: PROMPT_TIMEOUT_MS,
    })

    const t0 = Date.now()
    try {
      const prompt = blocks(input.parts, input.system, this.state(agentSessionId).prompt)

      // Inactivity timeout: resets on every received update so long tool calls
      // don't hit the wall-clock limit. Only fires when the agent goes silent.
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      let rejectTimeout!: (err: Error) => void
      const timeoutPromise = new Promise<never>((_, reject) => {
        rejectTimeout = reject
      })
      const resetTimeout = () => {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        timeoutId = setTimeout(
          () => rejectTimeout(new Error(`ACP prompt timed out after ${PROMPT_TIMEOUT_MS}ms of inactivity`)),
          PROMPT_TIMEOUT_MS,
        )
      }
      resetTimeout()

      // Wrap the listener so every incoming update resets both the inactivity timer
      // and the process idle timer (prevents the process from being killed mid-prompt).
      this.sessionListeners.set(agentSessionId, (update: SessionUpdate) => {
        resetTimeout()
        this.resetIdleTimer()
        onUpdate(update)
      })

      try {
        const result = await Promise.race([
          this.conn.prompt({ sessionId: agentSessionId, prompt }),
          timeoutPromise,
        ])
        log.info("ACP prompt: completed", {
          agentSessionId,
          stopReason: result.stopReason,
          ms: Date.now() - t0,
        })
        return { stopReason: result.stopReason, usage: result.usage }
      } catch (err) {
        // On timeout (or any error), cancel the session so the ACP binary stops working
        // rather than continuing to run orphaned with no listener.
        log.info("ACP prompt: cancelling session after error/timeout", { agentSessionId })
        this.conn.cancel({ sessionId: agentSessionId }).catch(() => {})
        throw err
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
      }
    } catch (err) {
      log.error("ACP prompt: error", { agentSessionId, err, ms: Date.now() - t0 })
      throw err
    } finally {
      this.sessionListeners.delete(agentSessionId)
      slotRelease()
    }
  }

  async cancel(agentSessionId: string): Promise<void> {
    log.info("ACP cancel", { agentSessionId })
    await this.conn.cancel({ sessionId: agentSessionId })
  }

  respondPermission(permId: string, response: RequestPermissionResponse): void {
    const pending = this.pendingPermissions.get(permId)
    if (pending) {
      log.info("ACP respondPermission: resolving", { permId, tool: pending.tool })
      pending.resolve(response)
      this.pendingPermissions.delete(permId)
    } else {
      log.info("ACP respondPermission: permId not found in pending map", { permId })
    }
  }

  dispose() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    log.info("ACP process dispose: sending SIGTERM", { directory: this.directory })
    try { this.proc.kill("SIGTERM") } catch {}
  }

  get alive(): boolean {
    return this.proc.exitCode === null && !this.proc.killed
  }
}

// ── ACPAdapter ────────────────────────────────────────────────────────────────

export class ACPAdapter implements AgentAdapter {
  private store: RuntimeStore
  private currentModel: string = process.env.CLAXEDO_ACP_MODEL ?? ""
  private currentMcp: McpServer[] = []
  private busySessions = new Set<string>()
  private sessions = new Map<string, ProcEntry>()
  private probe: ProbeEntry | null = null

  constructor(private readonly options: { binary: string; type?: string; storeRoot?: string }) {
    this.store = new RuntimeStore(options.storeRoot)
  }

  private session(id: string, directory: string) {
    const hit = this.sessions.get(id)
    if (hit) {
      hit.directory = directory
      return hit
    }
    const next: ProcEntry = {
      directory,
      proc: null,
      init: null,
    }
    this.sessions.set(id, next)
    return next
  }

  private restartSession(id: string) {
    const entry = this.sessions.get(id)
    entry?.proc?.dispose()
    if (!entry) return
    entry.proc = null
    entry.init = null
  }

  private restartProbe() {
    this.probe?.proc?.dispose()
    if (!this.probe) return
    this.probe.proc = null
    this.probe.init = null
  }

  private restart() {
    for (const id of this.sessions.keys()) {
      this.restartSession(id)
    }
    this.restartProbe()
  }

  setModel(model: string): void {
    this.currentModel = model
    this.restart()
    log.info("ACP model updated, ACP session processes disposed", {
      model,
      type: this.options.type,
      binary: this.options.binary,
    })
  }

  setAuth(keys: { anthropic?: string; openai?: string; cursor?: string }): void {
    setAcpAuth(keys)
    this.restart()
    log.info("ACP auth updated, ACP session processes disposed", {
      type: this.options.type,
      binary: this.options.binary,
    })
  }

  private spawnArgs() {
    if (this.options.type !== "cursor-acp") return []
    return ["acp"]
  }

  private make(dead: () => void = () => {}) {
    return new ACPProcess(root(), this.options.binary, this.spawnArgs(), this.currentModel, () => this.currentMcp, dead)
  }

  private async getOrSpawnProcess(id: string, directory: string): Promise<{ proc: ACPProcess; isNew: boolean }> {
    const entry = this.session(id, directory)
    const live = entry.proc
    if (live?.alive) {
      log.info("ACP getOrSpawnProcess: reusing session process", {
        id,
        directory,
        type: this.options.type,
      })
      return { proc: live, isNew: false }
    }
    if (entry.init) return entry.init
    const t0 = Date.now()
    entry.init = (async () => {
      const proc = this.make(() => {
        log.info("ACP process onDead callback: clearing session process", {
          id,
          directory,
          type: this.options.type,
        })
        const current = this.sessions.get(id)
        if (!current) return
        if (current.proc === proc) current.proc = null
        current.init = null
        if (this.store.getSession(id)) {
          this.store.processLostSession(id)
        }
      })
      try {
        await proc.initialize()
        entry.proc = proc
        log.info("ACP getOrSpawnProcess: session process ready", {
          id,
          directory,
          type: this.options.type,
          ms: Date.now() - t0,
        })
        return { proc, isNew: true }
      } catch (err) {
        entry.proc = null
        proc.dispose()
        throw err
      } finally {
        if (entry.init) entry.init = null
      }
    })()
    return entry.init
  }

  private async getOrSpawnProbe(directory: string): Promise<ACPProcess> {
    if (this.probe && this.probe.directory !== directory) {
      this.restartProbe()
      this.probe = null
    }
    this.probe ??= {
      directory,
      proc: null,
      init: null,
    }
    this.probe.directory = directory
    const live = this.probe.proc
    if (live?.alive) return live
    if (this.probe.init) return this.probe.init
    const t0 = Date.now()
    this.probe.init = (async () => {
      const proc = this.make(() => {
        log.info("ACP probe process onDead callback: clearing probe process", {
          directory,
          type: this.options.type,
        })
        if (!this.probe) return
        if (this.probe.proc === proc) this.probe.proc = null
        this.probe.init = null
      })
      try {
        await proc.initialize()
        this.probe!.proc = proc
        log.info("ACP probe process ready", {
          directory,
          type: this.options.type,
          ms: Date.now() - t0,
        })
        return proc
      } catch (err) {
        if (this.probe?.proc === proc) this.probe.proc = null
        proc.dispose()
        throw err
      } finally {
        if (this.probe?.init) this.probe.init = null
      }
    })()
    return this.probe.init
  }

  private async boot(
    proc: {
      newSession: (directory: string, title?: string) => Promise<string>
      dispose: () => void
    },
    directory: string,
    title?: string,
    ms = newSessionTimeoutMs(),
  ) {
    let id: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        proc.newSession(directory, title),
        new Promise<string>((_, reject) => {
          id = setTimeout(() => reject(new Error(`ACP newSession timed out after ${ms}ms`)), ms)
        }),
      ])
    } catch (err) {
      log.warn("ACP newSession: failed", {
        directory,
        error: errorMessage(err),
      })
      proc.dispose()
      throw err
    } finally {
      if (id) clearTimeout(id)
    }
  }

  private cfg(model?: SessionConfig["model"]) {
    if (model) return model
    if (this.currentModel) {
      return {
        providerID: this.options.type ?? "claude-acp",
        modelID: this.currentModel,
      }
    }
    return {
      providerID: this.options.type ?? "claude-acp",
      modelID: "default",
    }
  }

  async listSessions(directory: string): Promise<unknown[]> {
    return this.store.listSessions(directory)
  }

  async getSession(id: string, _directory: string): Promise<unknown | null> {
    return this.store.getSession(id)
  }

  async createSession(directory: string, title?: string): Promise<{ id: string }> {
    log.info("createSession: start", { directory, title, binary: this.options.binary })
    const id = randomUUID()
    const { proc } = await this.getOrSpawnProcess(id, directory)
    const agentSessionId = await this.boot(proc, directory, title)
    log.info("createSession: ACP session created", { id, agentSessionId })
    this.store.bindSession({
      sessionId: id,
      directory,
      title,
      agentSessionId,
    })
    this.store.updateSessionConfig(id, {
      runner: {
        type: (this.options.type ?? "claude-acp") as SessionConfig["runner"]["type"],
        binary: this.options.binary,
        ...(this.currentModel ? { model: this.currentModel } : {}),
      },
      ...(this.currentModel ? { model: this.cfg() } : {}),
      variant: null,
      agent: null,
    })
    log.info("createSession: local session stored", { id, agentSessionId })
    return { id }
  }

  async updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, _directory: string): Promise<unknown | null> {
    return this.store.updateSession(id, updates)
  }

  async getSessionConfig(id: string, _directory: string): Promise<SessionConfig> {
    return this.store.getSessionConfig(id) ?? {
      runner: {
        type: (this.options.type ?? "claude-acp") as SessionConfig["runner"]["type"],
        binary: this.options.binary,
        ...(this.currentModel ? { model: this.currentModel } : {}),
      },
      ...(this.currentModel ? { model: this.cfg() } : {}),
      variant: null,
      agent: null,
    }
  }

  async updateSessionConfig(id: string, patch: SessionConfigPatch, directory: string): Promise<SessionConfig> {
    const next = this.store.updateSessionConfig(id, patch) ?? await this.getSessionConfig(id, directory)
    const proc = this.sessions.get(id)?.proc
    const agentSessionId = this.store.getAgentSessionId(id)
    if (!proc?.alive || !agentSessionId) return next
    await proc.syncSession(agentSessionId, {
      parts: [],
      assistantMessageId: "cfg",
      agent: next.agent ?? "build",
      model: this.cfg(next.model),
      ...(next.variant ? { variant: next.variant } : {}),
    }).catch(() => {})
    return next
  }

  async deleteSession(id: string, _directory: string): Promise<void> {
    const entry = this.sessions.get(id)
    this.sessions.delete(id)
    entry?.proc?.dispose()
    this.store.deleteSession(id)
  }

  async *sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<CompatEvent> {
    const t0 = Date.now()
    log.info("sendMessage: start", { id, directory, partCount: input.parts.length })

    if (this.busySessions.has(id)) {
      log.info("sendMessage: session already busy, rejecting duplicate", { id })
      yield sessionError("Session is already processing a message", id)
      return
    }
    this.busySessions.add(id)

    try {
      yield* this._sendMessage(id, input, directory, t0)
    } finally {
      this.busySessions.delete(id)
    }
  }

  async *_sendMessage(id: string, input: PromptInput, directory: string, t0: number): AsyncIterable<CompatEvent> {
    const current = this.store.getAgentSessionId(id)
    if (!current) {
      log.error("sendMessage: session not found in DB", { id })
      yield sessionError(`Session ${id} not found`, id)
      return
    }
    let agentSessionId = current
    const session = this.store.getSession(id) as { title?: string | null } | null
    let created = Date.now()
    log.info("sendMessage: found session in store", { id, agentSessionId })

    let proc: ACPProcess
    let fresh = false
    try {
      const result = await this.getOrSpawnProcess(id, directory)
      proc = result.proc
      fresh = result.isNew
    } catch (err) {
      log.error("sendMessage: failed to get/spawn ACP process", { err, directory })
      yield sessionError(`Failed to start ACP process: ${err}`, id)
      return
    }

    log.info("sendMessage: got ACP process, starting prompt", {
      directory,
      binary: this.options.binary,
      agentSessionId,
      msToHere: Date.now() - t0,
    })

    const recover = this.store.consumeRecoveryError(id)
    const start: CompatEvent[] = []
    if (recover) {
      start.push(sessionStatus(id, recovering(recover)))
    } else {
      start.push(sessionStatus(id, { type: "busy" }))
    }
    if (input.userMessageId) {
      start.push(messageUpdated(buildUserMessage({
        id: input.userMessageId,
        sessionID: id,
        agent: input.agent,
        model: input.model,
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.system ? { system: input.system } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
      })))
    }
    start.push(messageUpdated(buildAssistantMessage({
      id: input.assistantMessageId,
      sessionID: id,
      parentID: input.userMessageId ?? id,
      agent: input.agent,
      model: input.model,
      directory,
      created,
    })))
    this.store.startTurn({
      sessionId: id,
      agentSessionId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      agent: input.agent,
      model: input.model,
      parts: input.parts,
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.format ? { format: input.format } : {}),
      ...(input.system ? { system: input.system } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
    })

    const queue: CompatEvent[] = [...start]
    let promptDone = false
    let promptError: string | null = null
    let promptPromise: Promise<void> = Promise.resolve()
    const resolvers: Array<() => void> = []
    let chunkCount = 0
    let assistantMsgId = input.assistantMessageId
    let accumulatedText = ""
    let accumulatedThinkingText = ""
    const toolNames: Record<string, string> = {}
    const partIdMap: Record<string, string> = {}
    const toolInputs: Record<string, Record<string, unknown>> = {}
    const toolMetadata: Record<string, Record<string, unknown>> = {}
    const toolStatus: Record<string, "running" | "completed" | "error"> = {}
    const compatCtx = {
      sessionId: id,
      directory,
      assistantMsgId,
      accumulatedText,
      accumulatedThinkingText,
      toolNamesByCallId: toolNames,
      partIdMap,
      toolInputsByCallId: toolInputs,
      toolMetadataByCallId: toolMetadata,
      toolStatusByCallId: toolStatus,
      textPartSeq: 0,
      reasoningPartSeq: 0,
      splitText: false,
      splitReasoning: false,
    }

    const push = (event: CompatEvent) => {
      chunkCount++
      log.info("sendMessage: pushing chunk to stream", {
        chunkType: event.type,
        chunkN: chunkCount,
        msFromStart: Date.now() - t0,
      })
      queue.push(event)
      for (const r of resolvers.splice(0)) r()
    }

    const wait = () =>
      new Promise<void>((resolve) => {
        if (queue.length > 0 || promptDone) resolve()
        else resolvers.push(resolve)
      })

    const translatorCtx = createTranslatorContext(this.options.type)
    const bound = async <T>(label: string, run: Promise<T>) => {
      let id: ReturnType<typeof setTimeout> | undefined
      const ms = newSessionTimeoutMs()
      try {
        return await Promise.race([
          run,
          new Promise<T>((_, reject) => {
            id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
          }),
        ])
      } finally {
        if (id) clearTimeout(id)
      }
    }
    const replace = async () => {
      log.info("sendMessage: ACP session missing, creating replacement session", {
        id,
        oldAgentSessionId: agentSessionId,
      })
      agentSessionId = await this.boot(proc, directory, session?.title ?? undefined)
      this.store.bindSession({
        sessionId: id,
        directory,
        title: session?.title ?? undefined,
        agentSessionId,
      })
    }

    try {
      if (fresh) {
        log.info("sendMessage: process is freshly spawned, restoring ACP session", {
          id,
          agentSessionId,
        })
        try {
          await bound("ACP resume", proc.resumeSession(agentSessionId, directory))
        } catch (err) {
          if (!missing(err)) throw err
          await replace()
        }
      }
      try {
        await bound("ACP sync", proc.syncSession(agentSessionId, input))
      } catch (err) {
        if (!missing(err)) throw err
        await replace()
        await bound("ACP sync", proc.syncSession(agentSessionId, input))
      }
    } catch (err) {
      promptError = errorMessage(err)
      promptDone = true
      for (const r of resolvers.splice(0)) r()
    }

    if (!promptError) {
      const forward = (update: SessionUpdate) => {
        const chunks = translateSessionUpdate(update, translatorCtx)
        for (const chunk of chunks) {
          if (chunk.type === "text-delta") accumulatedText += chunk.delta
          if (chunk.type === "thinking-delta") accumulatedThinkingText += chunk.delta
          compatCtx.assistantMsgId = assistantMsgId
          compatCtx.accumulatedText = accumulatedText
          compatCtx.accumulatedThinkingText = accumulatedThinkingText
          const events = translateAgentEventToCompat(chunk, compatCtx)
          for (const event of events) {
            this.store.appendEvent({
              sessionId: id,
              agentSessionId,
              payload: event.payload,
              source: {
                dir: "in",
                method: "sessionUpdate",
                frame: update,
              },
            })
            push(event.payload)
          }
          if (chunk.type !== "step-start") continue
          assistantMsgId = chunk.newMessageId
          created = Date.now()
          accumulatedText = ""
          accumulatedThinkingText = ""
          compatCtx.assistantMsgId = assistantMsgId
          compatCtx.accumulatedText = ""
          compatCtx.accumulatedThinkingText = ""
          compatCtx.textPartSeq = 0
          compatCtx.reasoningPartSeq = 0
          compatCtx.splitText = false
          compatCtx.splitReasoning = false
          const event = messageUpdated(buildAssistantMessage({
            id: assistantMsgId,
            sessionID: id,
            parentID: input.userMessageId ?? id,
            agent: input.agent,
            model: input.model,
            directory,
            created,
          }))
          this.store.appendEvent({
            sessionId: id,
            agentSessionId,
            payload: event,
            source: {
              dir: "in",
              method: "sessionUpdate",
              frame: update,
            },
          })
          push(event)
        }
      }
      const install = () => {
        proc.permissionPushers.set(agentSessionId, (permId, tool, paths) => {
          log.info("sendMessage: forwarding permission-request to stream", { permId, tool })
          const event = permissionAsked({
            id: permId,
            sessionID: id,
            permission: tool,
            patterns: paths,
            metadata: {},
            always: paths,
          })
          this.store.appendEvent({
            sessionId: id,
            agentSessionId,
            payload: event,
            source: {
              dir: "in",
              method: "requestPermission",
              frame: { tool, paths },
            },
          })
          push(event)
        })
      }
      const stop = (stopReason: StopReason) => {
        log.info("sendMessage: prompt resolved", { stopReason, ms: Date.now() - t0 })
        for (const chunk of translateStopReason(stopReason, id)) {
          compatCtx.assistantMsgId = assistantMsgId
          compatCtx.accumulatedText = accumulatedText
          compatCtx.accumulatedThinkingText = accumulatedThinkingText
          const events = translateAgentEventToCompat(chunk, compatCtx)
          for (const event of events) {
            this.store.appendEvent({
              sessionId: id,
              agentSessionId,
              payload: event.payload,
              source: {
                dir: "in",
                method: "prompt.stop",
                frame: { stopReason },
              },
            })
            push(event.payload)
          }
        }
      }
      let retried = false
      const run = async (): Promise<void> => {
        install()
        try {
          const result = await proc.prompt(agentSessionId, input, forward)
          if (result.usage && result.usage.totalTokens > 0) {
            const event = messageUpdated({
              ...buildAssistantMessage({
                id: assistantMsgId,
                sessionID: id,
                parentID: input.userMessageId ?? id,
                agent: input.agent,
                model: input.model,
                directory,
                created,
                completed: Date.now(),
                variant: input.variant,
              }),
              tokens: messageUsage(result.usage),
            })
            this.store.appendEvent({
              sessionId: id,
              agentSessionId,
              payload: event,
              source: {
                dir: "in",
                method: "prompt.result",
                frame: { usage: result.usage },
              },
            })
            push(event)
          }
          stop(result.stopReason)
        } catch (err) {
          proc.permissionPushers.delete(agentSessionId)
          if (retried || !missing(err)) throw err
          retried = true
          await replace()
          await proc.syncSession(agentSessionId, input)
          return run()
        }
      }
      promptPromise = run()
      .catch((err: unknown) => {
        log.error("sendMessage: prompt rejected", { err, ms: Date.now() - t0 })
        promptError = errorMessage(err)
      })
      .finally(() => {
        proc.permissionPushers.delete(agentSessionId)
        promptDone = true
        for (const r of resolvers.splice(0)) r()
      })
    }

    let titleEmitted = false
    try {
      while (true) {
        await wait()
        let event: CompatEvent | undefined
        while ((event = queue.shift())) {
          // Before yielding session.idle, emit auto-title if needed
          if (event.type === "session.idle" && !titleEmitted) {
            titleEmitted = true
            const titleEvent = this.maybeAutoTitle(id, agentSessionId, directory, input.parts)
            if (titleEvent) yield titleEvent
          }
          yield event
          if (event.type === "session.idle" || event.type === "session.error") {
            log.info("sendMessage: terminal chunk yielded, returning", {
              chunkType: event.type,
              totalChunks: chunkCount,
              ms: Date.now() - t0,
            })
          }
        }
        if (promptDone) break
      }
    } finally {
      await promptPromise
    }

    if (promptError) {
      log.error("sendMessage: ending with error", { promptError, ms: Date.now() - t0 })
      const updated = messageUpdated(buildAssistantMessage({
        id: assistantMsgId,
        sessionID: id,
        parentID: input.userMessageId ?? id,
        agent: input.agent,
        model: input.model,
        directory,
        created,
        completed: Date.now(),
        error: {
          name: "UnknownError",
          data: { message: promptError },
        },
        variant: input.variant,
      }))
      this.store.appendEvent({
        sessionId: id,
        agentSessionId,
        payload: updated,
        source: {
          dir: "in",
          method: "prompt.error",
          frame: { message: promptError },
        },
      })
      yield updated
      const event = sessionError(promptError, id)
      this.store.appendEvent({
        sessionId: id,
        agentSessionId,
        payload: event,
        source: {
          dir: "in",
          method: "prompt.error",
          frame: { message: promptError },
        },
      })
      yield event
      return
    }

    log.info("sendMessage: finished successfully", { totalChunks: chunkCount, ms: Date.now() - t0 })
  }

  /** Emit a truncated-text title immediately; fire-and-forget an LLM title generation via ACP. */
  private maybeAutoTitle(id: string, agentSessionId: string, directory: string, parts: unknown[]): CompatEvent | null {
    try {
      const session = this.store.getSession(id) as { title?: string | null } | null
      if (session?.title) return null
      const text = extractTextFromParts(parts)
      if (!text) return null

      // Immediate fallback: truncated user message
      const fallback = text.length > 72 ? text.slice(0, 72).trimEnd() + "…" : text
      const now = Date.now()
      const event = sessionUpdated({
        id,
        slug: id,
        projectID: "",
        directory,
        title: fallback,
        version: "local",
        time: { created: now, updated: now },
      })
      this.store.appendEvent({
        sessionId: id,
        agentSessionId,
        payload: event,
        source: { dir: "in", method: "auto-title", frame: { title: fallback } },
      })

      // Fire-and-forget: generate a better title via the ACP process
      this.generateAITitle(id, agentSessionId, directory, text).catch((err) => {
        log.warn("generateAITitle: failed (keeping fallback title)", { err })
      })

      return event
    } catch (err) {
      log.warn("maybeAutoTitle: failed", { err })
      return null
    }
  }

  /** Use the ACP process to generate a short AI title, then push update via SSE. */
  private async generateAITitle(sessionId: string, _agentSessionId: string, directory: string, userText: string): Promise<void> {
    let proc: ACPProcess
    try {
      const result = await this.getOrSpawnProcess(sessionId, directory)
      proc = result.proc
    } catch {
      return // no process available
    }

    // Create a temporary ACP session for title generation
    let titleAcpSessionId: string
    try {
      titleAcpSessionId = await this.boot(proc, directory)
    } catch (err) {
      log.warn("generateAITitle: failed to create temp session", { err })
      return
    }

    // Collect response text via the session update listener
    let responseText = ""
    const truncated = userText.length > 200 ? userText.slice(0, 200) + "…" : userText
    const titleInput: PromptInput = {
      parts: [{ type: "text", text: `Generate a short title (under 10 words, no quotes) for a coding conversation that starts with this message:\n\n${truncated}` }],
      assistantMessageId: `title_${Date.now()}`,
      agent: "title",
      model: { providerID: "", modelID: "" },
    }

    try {
      await proc.prompt(titleAcpSessionId, titleInput, (update) => {
        const delta = chunkDelta(update)
        if (delta) responseText += delta
      })
    } catch (err) {
      log.warn("generateAITitle: prompt failed", { err })
      return
    }

    // Clean up the response
    const cleaned = responseText
      .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    if (!cleaned) return

    const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned

    // Check current title hasn't been manually set in the meantime
    const fallback = userText.length > 72 ? userText.slice(0, 72).trimEnd() + "…" : userText
    const current = this.store.getSession(sessionId) as { title?: string | null } | null
    if (current?.title && current.title !== fallback) {
      return // title was manually updated, don't overwrite
    }

    const now = Date.now()
    const event = sessionUpdated({
      id: sessionId,
      slug: sessionId,
      projectID: "",
      directory,
      title,
      version: "local",
      time: { created: now, updated: now },
    })
    this.store.appendEvent({
      sessionId,
      payload: event,
      source: { dir: "in", method: "ai-title", frame: { title } },
    })
    publishGlobalEvent(withDir(directory, event))
    log.info("generateAITitle: updated title", { sessionId, title })
  }

  async getMessages(id: string, _directory: string): Promise<unknown[]> {
    return this.store.getMessages(id)
  }

  async abort(id: string, directory: string): Promise<AbortResult> {
    log.info("abort: called", { id, directory })
    const agentSessionId = this.store.getAgentSessionId(id)
    if (!agentSessionId) {
      log.info("abort: session not found in store", { id })
      this.store.processLostSession(id, "ACP session could not be cancelled because no agent session is attached.")
      return {
        ok: false,
        status: "recovering",
        message: "ACP session could not be cancelled because no agent session is attached.",
      }
    }
    const proc = this.sessions.get(id)?.proc
    if (!proc?.alive) {
      log.info("abort: no alive process for session", { id, directory })
      this.store.processLostSession(id, "ACP session could not be cancelled because its process is no longer alive.", agentSessionId)
      return {
        ok: false,
        status: "recovering",
        message: "ACP session could not be cancelled because its process is no longer alive.",
      }
    }
    try {
      await proc.cancel(agentSessionId)
      return { ok: true, status: "cancelled" }
    } catch (err) {
      log.info("abort: cancel failed; disposing session process", { id, directory, err })
      proc.dispose()
      const entry = this.sessions.get(id)
      if (entry?.proc === proc) entry.proc = null
      this.store.processLostSession(id, "ACP session cancellation failed; the agent process was stopped.", agentSessionId)
      return {
        ok: false,
        status: "recovering",
        message: "ACP session cancellation failed; the agent process was stopped.",
      }
    }
  }

  async revert(_id: string, _directory: string): Promise<void> {
    // ACP has no revert concept
  }

  async unrevert(_id: string, _directory: string): Promise<void> {
    // ACP has no unrevert concept
  }

  async forkSession(id: string, _messageId: string, directory: string): Promise<{ id: string }> {
    log.info("forkSession: called", { id, directory })
    const row = this.getSession(id, directory) as Promise<{ agent_session_id?: string; title?: string | null } | null>
    const session = await row
    const agentSessionId = this.store.getAgentSessionId(id)
    if (!session || !agentSessionId) throw new Error(`Session ${id} not found`)

    const result = await this.getOrSpawnProcess(id, directory)
    const proc = result.proc
    if (result.isNew) {
      await proc.resumeSession(agentSessionId, directory)
    }
    let newAgentSessionId: string
    try {
      const result = await proc.conn.unstable_forkSession({
        sessionId: agentSessionId,
        cwd: directory,
        mcpServers: this.currentMcp,
      })
      newAgentSessionId = result.sessionId
      log.info("forkSession: ACP fork succeeded", { newAgentSessionId })
    } catch (err) {
      log.info("forkSession: ACP fork failed, using random id", { err })
      newAgentSessionId = randomUUID()
    }

    const newId = randomUUID()
    this.store.bindSession({
      sessionId: newId,
      directory,
      title: session.title ?? undefined,
      agentSessionId: newAgentSessionId,
    })
    log.info("forkSession: done", { newId, newAgentSessionId })
    return { id: newId }
  }

  async executeCommand(_id: string, command: string, _directory: string): Promise<void> {
    log.info("executeCommand: not directly supported in ACP", { command })
  }

  async listCommands(_directory: string): Promise<unknown[]> {
    return listCommands()
  }

  async listAgents(directory: string): Promise<unknown[]> {
    for (const entry of this.sessions.values()) {
      const proc = entry.proc
      if (!proc?.alive) continue
      const list = proc.getAgents()
      if (list.length > 0) return list
    }
    const probe = this.probe?.proc
    if (probe?.alive) {
      const list = probe.getAgents()
      if (list.length > 0) return list
    }
    const cfg = await this.probeConfigOptions(directory)
    if (Array.isArray(cfg) && cfg.length > 0) {
      const list = extractAgents({
        caps: null,
        prompt: null,
        cfg: cfg as SessionConfigOption[],
        modeIds: [],
        models: false,
      })
      if (list.length > 0) return list
    }
    // Fallback: no process or no modes discovered yet
    return [
      { name: "build", description: "Software build and deployment specialist", mode: "primary" },
    ]
  }

  async getTodos(sessionId: string, _directory: string): Promise<Array<{ content: string; status: string; priority: string }>> {
    return this.store.getTodos(sessionId)
  }

  async listPermissions(directory: string): Promise<unknown[]> {
    const rows = this.store.listPermissions(directory)
    const live = rows.filter((row) => {
      const proc = this.sessions.get(row.sessionID)?.proc
      if (proc?.alive && proc.pendingPermissions.has(row.id)) return true
      this.store.stalePermission(row.id)
      this.store.markRecovering(row.sessionID, ACP_RECOVER)
      return false
    })
    log.info("listPermissions", { count: rows.length, live: live.length })
    return live
  }

  async respondPermission(
    permId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
    directory: string,
  ): Promise<void> {
    log.info("respondPermission: called", { permId, decision, directory })
    const row = (this.store.listPermissions(directory) as Array<{ id: string; sessionID: string }>).find((item) => item.id === permId)
    const clear = () => {
      if (!row) return
      this.store.appendEvent({
        sessionId: row.sessionID,
        payload: permissionReplied(
          row.sessionID,
          permId,
          decision === "allow_always" ? "always" : decision === "allow_once" ? "once" : "reject",
        ),
        source: {
          dir: "out",
          method: "permission.reply",
          frame: { decision },
        },
      })
    }
    const proc = row ? this.sessions.get(row.sessionID)?.proc : undefined
    if (!proc?.alive) {
      log.info("respondPermission: no alive process for permission session", {
        directory,
        permId,
        sessionId: row?.sessionID,
      })
      clear()
      return
    }
    const pending = proc.pendingPermissions.get(permId)
    if (!pending) {
      log.info("respondPermission: permId not found in pending map", {
        permId,
        knownPermIds: [...proc.pendingPermissions.keys()],
      })
      clear()
      return
    }
    const kindMap: Record<string, PermissionOptionKind> = {
      allow_once: "allow_once",
      allow_always: "allow_always",
      deny: "reject_once",
      reject_always: "reject_always",
    }
    const targetKind = kindMap[decision] ?? "reject_once"
    const option = pending.options.find((o) => o.kind === targetKind) ?? pending.options[0]
    if (option) {
      log.info("respondPermission: resolving with option", {
        permId,
        decision,
        targetKind,
        selectedOptionId: option.optionId,
        selectedKind: option.kind,
      })
      proc.respondPermission(permId, { outcome: { outcome: "selected", optionId: option.optionId } })
      clear()
    } else {
      log.info("respondPermission: no matching option found in pending.options", {
        permId,
        decision,
        availableKinds: pending.options.map((o) => o.kind),
      })
      clear()
    }
  }

  async replyQuestion(_qId: string, _answer: string, _directory: string): Promise<void> {
    // ACP handles questions via permissions
  }

  async listQuestions(_directory: string): Promise<unknown[]> {
    return []
  }

  async rejectQuestion(_qId: string, _directory: string): Promise<void> {
    // ACP handles questions via permissions
  }

  async applyConfig(config: Record<string, unknown>): Promise<void> {
    const mcp = config.mcp as Record<string, ResolvedMcpServer> | undefined
    this.currentMcp = toAcpMcpServers(mcp ?? {})

    // Extract and apply auth keys from the config snapshot
    const auth = config.auth as Record<string, string> | undefined
    if (auth && typeof auth === "object") {
      setAcpAuth({
        anthropic: auth["claude-acp"] ?? auth["anthropic"],
        openai: auth["codex-acp"] ?? auth["openai"],
        cursor: auth["cursor-acp"] ?? auth["cursor"],
      })
    }
    this.restart()
    log.info("Applied config in-memory, restarted ACP process", {
      keys: Object.keys(config),
      type: this.options.type,
      binary: this.options.binary,
    })
  }

  peekConfigOptions(_directory: string): unknown[] | null {
    for (const entry of this.sessions.values()) {
      const proc = entry.proc
      if (proc?.alive && proc.cachedConfigOptions) return proc.cachedConfigOptions
    }
    const proc = this.probe?.proc
    if (proc?.alive && proc.cachedConfigOptions) return proc.cachedConfigOptions
    return null
  }

  async probeConfigOptions(directory: string): Promise<unknown[]> {
    const live = this.peekConfigOptions(directory)
    if (live) {
      log.info("probeConfigOptions: returning cached options from existing process")
      return live
    }
    const wait = async <T>(label: string, run: Promise<T>) => {
      const ms = probeTimeoutMs()
      let id: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          run,
          new Promise<T>((_, reject) => {
            id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
          }),
        ])
      } finally {
        if (id) clearTimeout(id)
      }
    }
    try {
      const proc = await wait("ACP mode probe", this.getOrSpawnProbe(directory))
      if (proc.cachedConfigOptions) return proc.cachedConfigOptions
      await this.boot(proc, directory, undefined, probeTimeoutMs())
      if (!proc.cachedConfigOptions) {
        const ms = probeTimeoutMs()
        await wait("ACP mode cache", new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, ms)
          const check = setInterval(() => {
            if (proc.cachedConfigOptions) {
              clearTimeout(timeout)
              clearInterval(check)
              resolve()
            }
          }, 100)
        }))
      }
      return proc.cachedConfigOptions ?? []
    } catch (err) {
      log.warn("probeConfigOptions: failed, returning no options", {
        directory,
        error: errorMessage(err),
      })
      return []
    }
  }

  dispose(): void {
    log.info("ACPAdapter dispose: disposing session processes", {
      sessions: this.sessions.size,
      type: this.options.type,
      binary: this.options.binary,
    })
    this.restart()
    this.sessions.clear()
    this.probe = null
  }
}
