import { spawn, type ChildProcess } from "child_process"
import { isWindowsShimBinary, killHarnessProcess } from "../shared/windows-process"
import { createIdleReaper } from "../shared/process-lifecycle"
import { randomUUID } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import {
  createAgentEventRuntime,
  type AgentEventRuntime,
} from "@claxedo/agent-event-runtime"
import {
  codexAppServerAdapter,
  codexCollabAgentCall,
  codexStartedSubagent,
} from "@claxedo/agent-event-runtime/harnesses/codex"
import type { AgentConfigOptionRow, PromptInput } from "../../index"
import type { AgentHarnessAdapterHealth, FetchLike } from "../../adapter-contract"
import type { ResolvedMcpServer } from "../../mcp-resolver"
import { Log } from "../../log"
import { createLiveModelSource } from "../../live-model-source"
import {
  modelConfigOption,
  resolveSupportedEffort,
  thoughtLevelConfigOption,
  type SdkModelEntry,
} from "../../sdk-model-catalog"
import {
  errorMessage,
  extractTextFromParts,
  record,
  text,
  type JsonRecord,
  type SdkRuntimeAuth,
  type SdkRuntimeDriver,
  type SdkRuntimeDriverHost,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
import { harnessSpawnEnv } from "../shared/spawn-env"
import {
  CODEX_PERMISSION_MODES,
  CODEX_SETTINGS,
  DEFAULT_CODEX_MODE,
  PermissionModeSelection,
  codexSandboxPolicy,
  codexSettingsFor,
} from "../shared/permission-modes"
import {
  observeAgentProcess,
  type AgentProcessObserver,
  type AgentProcessObserverHandle,
} from "../../process-observer"
import { requireCodexExecutable } from "./executable"

const log = Log.create({ service: "codex-app-server-adapter" })
const CODEX_SOURCE = "codex.app-server"
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OPENAI_ISSUER = "https://auth.openai.com"

type CodexActiveThread = {
  sessionId: string
  agentSessionId: string
  directory: string
  model?: string
  effort?: string
  process: CodexAppServerProcess
  project: (method: string, payload: JsonRecord, frame: unknown) => void
  observeSubagent: SdkRuntimeTurnInput["observeSubagent"]
}

/**
 * The app-server reports an unknown thread as `thread not found: <uuid>`. Matched on the
 * message because the JSON-RPC error carries no dedicated code for it.
 */
export function isThreadNotFound(err: unknown): boolean {
  return /thread not found/i.test(errorMessage(err))
}

/**
 * Number of resume+retry cycles attempted after the first `thread not found`. Two cycles
 * (an initial resume and one further attempt) bound the recovery so a permanently-lost
 * thread terminates instead of looping — or, before this bound existed, propagating the
 * raw protocol string on the very next failure.
 */
const MAX_THREAD_RESUME_ATTEMPTS = 2

/**
 * Human copy for a permanently-lost Codex thread. Phrased so `classifyFirstTurnError`
 * routes it to the `session` recovery class (the `session not found` phrasing matches its
 * regex) — the app-server's own `thread not found: <uuid>` string never becomes the
 * headline. The original protocol string (including the uuid) is appended so it survives
 * into the client's raw-detail disclosure, which reads `error.data.message`.
 */
export function sessionLostMessage(cause: unknown): string {
  return `The agent process no longer has this conversation (session not found). ${errorMessage(cause)}`
}

/**
 * A Codex thread lives in the memory of the app-server process that started it, but is
 * persisted to disk. `ensureProcess` transparently respawns a dead subprocess (crash,
 * idle kill, host sleep), so a session that worked earlier can hand its threadId to a
 * process that has never heard of it — the app-server answers `thread not found: <uuid>`
 * and, without recovery, EVERY later turn in that session fails permanently.
 *
 * On that specific error, resume the thread by id into the current process and retry the
 * turn. Recovery is bounded to {@link MAX_THREAD_RESUME_ATTEMPTS} resume+retry cycles: if
 * the thread is still missing after them, the state is treated as terminal and a
 * classified, human error is thrown (see {@link sessionLostMessage}) rather than
 * propagating the raw `thread not found: <uuid>` protocol string to the transcript.
 *
 * Any non-`thread not found` error propagates untouched (never mask a real failure), and
 * the bound guarantees this cannot loop. We deliberately do NOT re-create the thread and
 * replay the prompt: a fresh thread has none of the conversation history the UI still
 * shows, so a silently context-free answer under a full transcript would be a lie.
 */
export async function startTurnWithThreadRecovery(input: {
  startTurn: () => Promise<JsonRecord>
  resumeThread: () => Promise<unknown>
}): Promise<JsonRecord> {
  try {
    return await input.startTurn()
  } catch (err) {
    if (!isThreadNotFound(err)) throw err
    let lastError = err
    for (let attempt = 0; attempt < MAX_THREAD_RESUME_ATTEMPTS; attempt++) {
      await input.resumeThread()
      try {
        return await input.startTurn()
      } catch (retryErr) {
        if (!isThreadNotFound(retryErr)) throw retryErr
        lastError = retryErr
      }
    }
    // Bounded recovery exhausted: the thread is genuinely gone. Surface a classified,
    // human terminal error — never the raw protocol string as the headline.
    throw new Error(sessionLostMessage(lastError))
  }
}

export function createCodexAppServerDriver(host: SdkRuntimeDriverHost, options: CodexDriverOptions = {}): SdkRuntimeDriver {
  return new CodexAppServerDriver(host, options)
}

type CodexDriverOptions = { binary?: string; fetch?: FetchLike; codexHome?: string }

function appServerCommand(binary: string) {
  const args = ["app-server", "--listen", "stdio://"]
  if (/\.(?:cjs|mjs|js)$/i.test(binary)) {
    return { command: process.execPath, args: [binary, ...args] }
  }
  return { command: binary, args }
}

const CODEX_DYNAMIC_TOOLS = [{
  name: "spawn_agent",
  description: "Spawn a child Codex agent to execute one bounded task.",
  inputSchema: {
    type: "object",
    properties: {
      task_name: { type: "string", description: "Short stable name for the child task." },
      message: { type: "string", description: "Task instructions for the child agent." },
    },
    required: ["task_name", "message"],
    additionalProperties: false,
  },
}]

/**
 * How long an idle codex app-server survives.
 *
 * Matches the OpenCode adapter's desktop default. Codex is the more expensive
 * one to leave resident, because the driver otherwise holds it for its own
 * lifetime rather than the session's.
 */
function codexIdleTimeoutMs() {
  const configured = Number(process.env.CLAXEDO_CODEX_IDLE_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 30_000
}

class CodexAppServerDriver implements SdkRuntimeDriver {
  readonly type = "codex" as const
  private auth: SdkRuntimeAuth = {}
  private codexAuth: JsonRecord | undefined
  private process: CodexAppServerProcess | null = null
  /**
   * Reap the app-server when nothing is using it.
   *
   * Without this the process lives for the driver's lifetime, so an idle
   * desktop holds a codex app-server it was asked for once. `ensureProcess`
   * re-spawns transparently, which every caller already relies on.
   *
   * Restored after a merge took the upstream driver wholesale and dropped it —
   * upstream never had one. `idle-reaping.test.ts` is what noticed.
   */
  private readonly idleMs = codexIdleTimeoutMs()
  private readonly idle = createIdleReaper({
    idleMs: this.idleMs,
    onIdle: () => this.reapIdleProcess(),
  })
  private processStartup: Promise<CodexAppServerProcess> | null = null
  private processStartupAbort: AbortController | null = null
  private processAuthSync: Promise<void> | null = null
  private authRevision = 0
  private processAuthRevision = -1
  private processAuthWasExplicit = false
  private lifecycleRevision = 0
  private disposed = false
  private processError: string | null = null
  private currentMcp: Record<string, ResolvedMcpServer> = {}
  private activeThreads = new Map<string, CodexActiveThread>()
  private readonly codexHome: string
  private readonly modelSource = createLiveModelSource({
    harness: "codex",
    fetchModels: (directory) => this.fetchModels(directory),
  })

  constructor(
    private readonly host: SdkRuntimeDriverHost,
    private readonly options: CodexDriverOptions,
  ) {
    // Resolve the codex home once so auth reads/writes never fall back to the
    // real `~/.codex` under test. Honors the same CODEX_HOME the CLI respects.
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
  }

  setAuth(keys: SdkRuntimeAuth) {
    const previous = this.authSignature()
    this.auth = {
      ...this.auth,
      ...(keys.openai !== undefined ? { openai: keys.openai || undefined } : {}),
    }
    if (this.authSignature() !== previous) this.authRevision++
  }

  async applyConfig(config: Record<string, unknown>) {
    const previous = this.authSignature()
    const auth = record(config.auth) as Record<string, string> | undefined
    const source = auth?.["codex-app-server"] ?? auth?.openai
    this.codexAuth = sourceCodexAuthValue(source)
    this.auth = {
      openai: sourceAuthValue(source),
    }
    this.currentMcp = (record(config.mcp) as Record<string, ResolvedMcpServer> | undefined) ?? {}
    if (this.authSignature() !== previous) this.authRevision++
    const proc = this.process ?? (this.processStartup ? await this.processStartup : null)
    if (proc?.alive) await this.syncProcessAuth(proc)
  }

  private readonly permissionSelection = new PermissionModeSelection(CODEX_PERMISSION_MODES, "next-turn")

  permissionModes(sessionId: string) {
    return this.permissionSelection.state(sessionId)
  }

  /**
   * Stores only — nothing is sent here.
   *
   * `thread/settings/update` exists and would let this land immediately, but
   * both `thread/start` and `turn/start` already carry the policy on every
   * request, so applying it at turn start reaches the same place with one code
   * path instead of two that can disagree. The pinned-policy bug this replaces
   * came precisely from those two call sites drifting apart.
   */
  async setPermissionMode(sessionId: string, modeId: string, _directory: string) {
    if (!CODEX_SETTINGS[modeId]) throw new Error(`Unknown Codex permission mode "${modeId}"`)
    return this.permissionSelection.set(sessionId, modeId)
  }

  async createAgentSession(input: { directory: string; model: string; system?: string }) {
    const proc = await this.ensureProcess(input.directory)
    const model = codexAppServerModel(input.model)
    // A thread created before the user has touched the picker still has to run
    // under the default rung rather than whatever `thread/start` would assume.
    const settings = CODEX_SETTINGS[DEFAULT_CODEX_MODE]!
    const result = await proc.request("thread/start", {
      cwd: input.directory,
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: settings.sandbox,
      dynamicTools: CODEX_DYNAMIC_TOOLS,
      ...(input.system ? { developerInstructions: input.system } : {}),
      ...(model ? { model } : {}),
    }) as JsonRecord
    const thread = record(result.thread)
    const threadId = text(thread?.id)
    if (!threadId) throw new Error("Codex app-server did not return a thread id")
    return threadId
  }

  createRuntime(threadId: string): AgentEventRuntime {
    return createAgentEventRuntime({
      harness: this.type,
      threadId,
      adapter: codexAppServerAdapter(),
    })
  }

  /**
   * Own the idle lease for the whole turn, whatever the turn does.
   *
   * Idle teardown driven by "time since the last request STARTED" would reap a
   * turn that is still inside one long silent tool call, so the lease is taken
   * before anything else — including the app-server start, which is itself
   * slow enough to matter.
   *
   * It lives in this wrapper rather than in the turn body because EVERY exit
   * has to release it. Acquired above the body's own `try`, a failed start
   * leaked the lease, and one leaked lease disarms the reaper for the driver's
   * whole life: the next turn's app-server then stays resident forever.
   */
  async runTurn(input: SdkRuntimeTurnInput) {
    const turn = this.idle.lease()
    try {
      await this.runLeasedTurn(input)
    } finally {
      turn.release()
    }
  }

  private async runLeasedTurn(input: SdkRuntimeTurnInput) {
    const threadId = input.getAgentSessionId()
    const proc = await this.ensureProcess(input.directory)
    let turnId = ""
    let resolveCompleted: (() => void) | undefined
    let rejectCompleted: ((err: Error) => void) | undefined
    let rejectTurnStart: ((err: Error) => void) | undefined
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve
      rejectCompleted = reject
    })
    const turnStartFailed = new Promise<never>((_, reject) => {
      rejectTurnStart = reject
    })
    completed.catch(() => {})
    turnStartFailed.catch(() => {})
    const failTurn = (err: Error) => {
      rejectCompleted?.(err)
      rejectTurnStart?.(err)
    }
    const onAbort = () => failTurn(new Error("Codex turn aborted"))
    const onStderr = (message: string) => {
      if (message.includes("401 Unauthorized")) {
        failTurn(new Error("Codex authentication failed with 401 Unauthorized. Run `codex login` or sync a valid Codex credential, then retry."))
      }
    }
    const model = codexTurnModel(input.input, input.model)
    const effort = resolveSupportedEffort(
      this.modelSource.peek(),
      codexAppServerModel(input.input.model.modelID),
      input.input.variant,
    )
    const project = (method: string, payload: JsonRecord, frame: unknown, route?: { kind: "parent" } | { kind: "child"; correlationKey: string }) => input.ingest({
      source: CODEX_SOURCE,
      method,
      payload,
    }, {
      dir: "in",
      method,
      frame,
    }, route)
    this.activeThreads.set(threadId, {
      sessionId: input.sessionId,
      agentSessionId: threadId,
      directory: input.directory,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      process: proc,
      project,
      observeSubagent: input.observeSubagent,
    })
    let messageQueue = Promise.resolve()
    const unsubscribe = proc.onMessage((message) => {
      const method = text(message.method)
      const params = record(message.params) ?? {}
      if (!method) return
      messageQueue = messageQueue.then(async () => {
        const startedSubagent = method === "thread/started" ? codexStartedSubagent(params) : undefined
        if (startedSubagent?.parentThreadId === threadId) {
          await input.observeSubagent({
            observation: {
              observationId: `codex:thread-started:${startedSubagent.id}:${startedSubagent.status}`,
              harnessExecutionId: threadId,
              stableCorrelationId: startedSubagent.id,
              providerId: startedSubagent.id,
              providerKind: "codex",
              status: startedSubagent.status,
              transcript: { kind: "live" },
              ...(startedSubagent.label ? { label: startedSubagent.label } : {}),
              ...(startedSubagent.subagentType ? { subagentType: startedSubagent.subagentType } : {}),
              ...(startedSubagent.description ? { description: startedSubagent.description } : {}),
            },
            correlationKeys: [startedSubagent.id],
            source: { dir: "in", method, frame: message },
          })
        }

        const call = codexCollabAgentCall(record(params.item))
        if (call?.senderThreadId === threadId) {
          await Promise.all(call.receiverThreadIds.map((receiverThreadId) => input.observeSubagent({
            observation: {
              observationId: `codex:${method}:${call.id}:${receiverThreadId}:${call.statuses[receiverThreadId] ?? "edge"}`,
              harnessExecutionId: threadId,
              stableCorrelationId: receiverThreadId,
              toolCallId: call.id,
              toolCallRole: call.toolCallRole,
              providerId: receiverThreadId,
              providerKind: "codex",
              transcript: { kind: "live" },
              ...(call.statuses[receiverThreadId]
                ? { status: call.statuses[receiverThreadId] }
                : call.toolCallRole === "spawn" && method === "item/started"
                  ? { status: "pending" as const }
                  : {}),
              ...(call.prompt ? { description: call.prompt } : {}),
              subagentType: call.model ?? "codex",
            },
            correlationKeys: [receiverThreadId],
            source: { dir: "in", method, frame: message },
          })))
        }

        const eventThreadId = text(params.threadId) ?? text(record(params.thread)?.id)
        const parentOwned = !eventThreadId || eventThreadId === threadId
        if (method === "turn/started" && parentOwned) {
          turnId = text(record(params.turn)?.id) ?? turnId
          const active = this.host.lifecycle().get(input.sessionId)
          if (active) active.turnId = turnId
        }
        project(
          method,
          params,
          message,
          parentOwned ? { kind: "parent" } : { kind: "child", correlationKey: eventThreadId },
        )
        if (method === "turn/completed" && parentOwned) resolveCompleted?.()
      }).catch((err: unknown) => failTurn(new Error(errorMessage(err))))
    })
    const unsubscribeStderr = proc.onStderr(onStderr)
    input.abort.signal.addEventListener("abort", onAbort, { once: true })
    const startTurn = () => proc.request("turn/start", {
      threadId,
      input: codexUserInput(input.input.parts),
      cwd: input.directory,
      approvalPolicy: codexSettingsFor(this.permissionSelection.currentId(input.sessionId)).approvalPolicy,
      approvalsReviewer: "user",
      sandboxPolicy: codexSandboxPolicy(
        codexSettingsFor(this.permissionSelection.currentId(input.sessionId)).sandbox,
        input.directory,
      ),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    }) as Promise<JsonRecord>

    try {
      const result = await Promise.race([
        startTurnWithThreadRecovery({
          startTurn,
          resumeThread: async () => {
            log.info("codex thread missing from app-server process; resuming from disk", { threadId })
            await proc.request("thread/resume", { threadId, cwd: input.directory })
          },
        }),
        turnStartFailed,
      ])
      turnId = text(record(result.turn)?.id) ?? turnId
      this.host.lifecycle().set(input.sessionId, {
        abort: input.abort,
        turnId,
        close: () => {
          if (turnId) void proc.request("turn/interrupt", { threadId, turnId }).catch(() => {})
        },
      })
      await completed
    } finally {
      input.abort.signal.removeEventListener("abort", onAbort)
      unsubscribeStderr()
      unsubscribe()
      this.activeThreads.delete(threadId)
    }
  }

  readRuntimeHealth(): AgentHarnessAdapterHealth {
    if (!this.processError) return { status: "ok" }
    return {
      status: "degraded",
      reason: "harness_process_lost",
      message: this.processError,
    }
  }

  /**
   * Only reap a genuinely idle child. A lease covers a prompt turn, but a
   * thread can outlive its turn, and disposing under one would surface as a
   * lost session rather than as reclaimed memory.
   */
  private reapIdleProcess() {
    if (this.activeThreads.size > 0) {
      this.idle.touch()
      return
    }
    if (!this.process) return
    log.info("codex app-server idle timeout, disposing", { idleMs: this.idleMs })
    this.process.dispose()
    this.process = null
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.idle.cancel()
    this.lifecycleRevision++
    this.activeThreads.clear()
    this.processStartupAbort?.abort()
    this.process?.dispose()
    this.process = null
    void this.processStartup?.then((proc) => proc.dispose(), () => {})
  }

  async configOptions(currentModel: string, directory?: string): Promise<AgentConfigOptionRow[]> {
    return this.buildConfigOptions(await this.modelSource.models(directory), currentModel)
  }

  peekConfigOptions(currentModel: string): AgentConfigOptionRow[] {
    return this.buildConfigOptions(this.modelSource.peek(), currentModel)
  }

  private buildConfigOptions(models: readonly SdkModelEntry[], currentModel: string) {
    const effort = thoughtLevelConfigOption(models, codexAppServerModel(currentModel), undefined)
    return effort
      ? [modelConfigOption(models, currentModel), effort]
      : [modelConfigOption(models, currentModel)]
  }

  /**
   * `model/list` entries carry both a picker `id` and the wire `model` slug;
   * `thread/start`/`turn/start` take the slug, so that's what the option id
   * must be. Hidden models stay out of the picker, and duplicate slugs (several
   * picker rows can share one) collapse to the first row.
   */
  private async fetchModels(directory?: string): Promise<SdkModelEntry[]> {
    const cwd = directory ?? process.cwd()
    const observation = observeAgentProcess(this.host.processObserver, {
      ownerId: `codex-probe:${randomUUID()}`,
      launchId: randomUUID(),
      harnessId: "codex",
      access: "native",
      role: "probe",
      label: "Codex model probe",
      locality: "in-process",
      confidence: "direct",
      capabilities: {
        resourceMetrics: "shared-process",
        ownerActions: false,
      },
      directory: cwd,
    })
    observation.update({ lifecycle: "ready" })
    try {
      const proc = await this.ensureProcess(cwd)
      const models = new Map<string, SdkModelEntry>()
      let cursor: string | undefined
      do {
        const result = record(await proc.request("model/list", cursor ? { cursor } : {})) ?? {}
        const data = Array.isArray(result.data) ? result.data : []
        for (const item of data) {
          const row = record(item)
          if (!row || row.hidden === true) continue
          const id = text(row.model) ?? text(row.id)
          if (!id || models.has(id)) continue
          const supportedEffortLevels = Array.isArray(row.supportedReasoningEfforts)
            ? row.supportedReasoningEfforts
              .map((option) => text(record(option)?.reasoningEffort))
              .filter((effort): effort is string => !!effort)
            : []
          models.set(id, {
            id,
            name: text(row.displayName) ?? id,
            ...(text(row.description) ? { description: text(row.description)! } : {}),
            ...(row.isDefault === true ? { isDefault: true } : {}),
            ...(supportedEffortLevels.length
              ? { supportsEffort: true, supportedEffortLevels }
              : {}),
            ...(text(row.defaultReasoningEffort) ? { defaultEffort: text(row.defaultReasoningEffort)! } : {}),
          })
        }
        cursor = text(result.nextCursor)
      } while (cursor)
      return [...models.values()]
    } finally {
      observation.exit({ reason: "disposed" })
    }
  }

  failInteractiveState(err: Error) {
    this.processError = err.message
    this.host.lifecycle().abortAll()
    for (const pending of this.host.pendingPermissions.values()) pending.resolve("deny")
    this.host.pendingPermissions.clear()
    for (const pending of this.host.pendingQuestions.values()) pending.reject()
    this.host.pendingQuestions.clear()
    this.activeThreads.clear()
    log.warn("codex app-server process died; cleared interactive state", { err })
  }

  private async ensureProcess(directory: string) {
    if (this.disposed) throw new Error("Codex app-server driver is disposed")
    if (!this.process?.alive && !this.processStartup) {
      this.process?.dispose()
      const revision = this.lifecycleRevision
      const abort = new AbortController()
      this.processStartupAbort = abort
      const startup = this.startProcess(directory, revision, abort.signal)
      const pending = startup.finally(() => {
        if (this.processStartup === pending) {
          this.processStartup = null
          this.processStartupAbort = null
        }
      })
      this.processStartup = pending
    }
    const proc = this.processStartup ? await this.processStartup : this.process!
    await this.syncProcessAuth(proc)
    return proc
  }

  private async startProcess(directory: string, lifecycleRevision: number, signal: AbortSignal) {
    let started: CodexAppServerProcess | undefined
    started = await CodexAppServerProcess.start({
      binary: this.options.binary ?? requireCodexExecutable(),
      directory,
      env: codexSpawnEnv({
        ...process.env,
        CODEX_HOME: this.codexHome,
      }),
      requestHandler: (message) => this.handleServerRequest(message),
      processObserver: this.host.processObserver,
      mcp: this.currentMcp,
      signal,
      onClose: (err) => {
        if (this.process === started) this.process = null
        this.failInteractiveState(err)
      },
    })
    if (this.disposed || lifecycleRevision !== this.lifecycleRevision) {
      started.dispose()
      throw new Error("Codex app-server driver was disposed during startup")
    }
    this.process = started
    this.processAuthRevision = -1
    this.processAuthWasExplicit = false
    this.processError = null
    await this.syncProcessAuth(started)
    if (this.disposed || lifecycleRevision !== this.lifecycleRevision) {
      started.dispose()
      if (this.process === started) this.process = null
      throw new Error("Codex app-server driver was disposed during startup")
    }
    return started
  }

  private async syncProcessAuth(proc: CodexAppServerProcess): Promise<void> {
    if (this.processAuthSync) await this.processAuthSync
    if (this.process !== proc || !proc.alive || this.processAuthRevision === this.authRevision) return
    const revision = this.authRevision
    const params = this.loginParams()
    const pending = (async () => {
      try {
        if (params) await proc.request("account/login/start", params)
        else if (this.processAuthWasExplicit) {
          await proc.request("account/logout", null)
        }
      } catch (err) {
        throw new Error(`Codex auth could not initialize: ${errorMessage(err)}`)
      }
      if (this.process === proc) {
        this.processAuthWasExplicit = !!params
        if (revision === this.authRevision) this.processAuthRevision = revision
      }
    })()
    const sync = pending.finally(() => {
      if (this.processAuthSync === sync) this.processAuthSync = null
    })
    this.processAuthSync = sync
    await this.processAuthSync
    if (this.process === proc && proc.alive && this.processAuthRevision !== this.authRevision) {
      await this.syncProcessAuth(proc)
    }
  }

  private loginParams() {
    if (this.auth.openai) return { type: "apiKey", apiKey: this.auth.openai }
    const tokens = codexChatgptAuthTokens(this.codexAuth)
    if (!tokens) return
    return {
      type: "chatgptAuthTokens",
      accessToken: tokens.access,
      chatgptAccountId: tokens.accountId,
      chatgptPlanType: tokens.planType ?? null,
    }
  }

  private authSignature() {
    return JSON.stringify(this.loginParams() ?? null)
  }

  private async handleServerRequest(message: JsonRecord) {
    const method = text(message.method) ?? "request"
    const params = record(message.params) ?? {}
    const requestId = String(message.id ?? randomUUID())
    const threadId = text(params.threadId) ?? text(params.conversationId)
    const active = threadId ? this.activeThreads.get(threadId) : undefined
    const payload = { ...params, requestId }
    if (method === "item/tool/requestUserInput") {
      active?.project(method, payload, message)
      const questions = Array.isArray(params.questions) ? params.questions : []
      const answer = await new Promise<string>((resolve, reject) => {
        if (!active) {
          reject(new Error("No active session for Codex question"))
          return
        }
        this.host.pendingQuestions.set(requestId, {
          sessionId: active.sessionId,
          agentSessionId: active.agentSessionId,
          questions,
          resolve,
          reject,
        })
      })
      return {
        answers: Object.fromEntries((questionIds(params)[0] ? questionIds(params) : ["answer"]).map((id) => [id, { answers: [answer] }])),
      }
    }
    if (method === "item/tool/call") {
      if (!active || text(params.tool) !== "spawn_agent") {
        return {
          contentItems: [{ type: "inputText", text: `Dynamic tool ${text(params.tool) ?? "call"} is not implemented by Claxedo.` }],
          success: false,
        }
      }
      return this.spawnDynamicCodexAgent(active, params, message)
    }
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval" ||
      method === "applyPatchApproval" ||
      method === "execCommandApproval"
    ) {
      active?.project(method, payload, message)
      const decision = await new Promise<"allow_once" | "allow_always" | "deny" | "reject_always">((resolve) => {
        if (!active) {
          resolve("deny")
          return
        }
        this.host.pendingPermissions.set(requestId, {
          sessionId: active.sessionId,
          agentSessionId: active.agentSessionId,
          method,
          params,
          resolve,
        })
      })
      return permissionResponse(method, decision, params)
    }
    if (method === "account/chatgptAuthTokens/refresh") {
      const tokens = await this.refreshChatgptAuthTokens()
      return {
        accessToken: tokens.access,
        chatgptAccountId: tokens.accountId,
        chatgptPlanType: tokens.planType ?? null,
      }
    }
    throw new Error(`Unsupported Codex app-server request: ${method}`)
  }

  private async spawnDynamicCodexAgent(active: CodexActiveThread, params: JsonRecord, frame: JsonRecord) {
    const callId = text(params.callId) ?? randomUUID()
    const args = record(params.arguments) ?? {}
    const prompt = text(args.message) ?? text(args.prompt) ?? text(args.description)
    if (!prompt) {
      return {
        contentItems: [{ type: "inputText", text: "spawn_agent requires a message." }],
        success: false,
      }
    }
    const label = text(args.task_name) ?? "Codex subagent"
    const settings = codexSettingsFor(this.permissionSelection.currentId(active.sessionId))
    let childThreadId = ""
    try {
      const result = record(await active.process.request("thread/start", {
        cwd: active.directory,
        approvalPolicy: settings.approvalPolicy,
        approvalsReviewer: "user",
        sandbox: settings.sandbox,
        threadSource: "subagent",
        ...(active.model ? { model: active.model } : {}),
      }))
      childThreadId = text(record(result?.thread)?.id) ?? ""
      if (!childThreadId) throw new Error("Codex app-server did not return a child thread id")
      await active.observeSubagent({
        observation: {
          observationId: `codex:dynamic:${callId}:${childThreadId}:running`,
          harnessExecutionId: active.agentSessionId,
          stableCorrelationId: childThreadId,
          toolCallId: callId,
          toolCallRole: "spawn",
          providerId: childThreadId,
          providerKind: "codex",
          status: "running",
          transcript: { kind: "live" },
          label,
          description: prompt,
          subagentType: active.model ?? "codex",
        },
        correlationKeys: [childThreadId],
        source: { dir: "in", method: "item/tool/call", frame },
      })
      await this.runDynamicCodexChild(active, childThreadId, prompt)
      await active.observeSubagent({
        observation: {
          observationId: `codex:dynamic:${callId}:${childThreadId}:completed`,
          harnessExecutionId: active.agentSessionId,
          stableCorrelationId: childThreadId,
          toolCallId: callId,
          toolCallRole: "spawn",
          providerId: childThreadId,
          providerKind: "codex",
          status: "completed",
          transcript: { kind: "live" },
          label,
          description: prompt,
          subagentType: active.model ?? "codex",
        },
        correlationKeys: [childThreadId],
        source: { dir: "in", method: "item/tool/call", frame },
      })
      return {
        contentItems: [{ type: "inputText", text: `Subagent ${childThreadId} completed successfully.` }],
        success: true,
      }
    } catch (cause) {
      if (childThreadId) {
        await active.observeSubagent({
          observation: {
            observationId: `codex:dynamic:${callId}:${childThreadId}:failed`,
            harnessExecutionId: active.agentSessionId,
            stableCorrelationId: childThreadId,
            toolCallId: callId,
            toolCallRole: "spawn",
            providerId: childThreadId,
            providerKind: "codex",
            status: "failed",
            transcript: { kind: "live" },
            label: errorMessage(cause),
            description: prompt,
            subagentType: active.model ?? "codex",
          },
          correlationKeys: [childThreadId],
          source: { dir: "in", method: "item/tool/call", frame },
        })
      }
      return {
        contentItems: [{ type: "inputText", text: `Subagent failed: ${errorMessage(cause)}` }],
        success: false,
      }
    }
  }

  private async runDynamicCodexChild(active: CodexActiveThread, threadId: string, prompt: string) {
    let resolveCompleted: (() => void) | undefined
    let rejectCompleted: ((err: Error) => void) | undefined
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve
      rejectCompleted = reject
    })
    const unsubscribe = active.process.onMessage((message) => {
      const params = record(message.params) ?? {}
      if (text(params.threadId) !== threadId) return
      if (text(message.method) === "turn/completed") resolveCompleted?.()
      if (text(message.method) === "error") rejectCompleted?.(new Error(text(params.message) ?? "Codex child turn failed"))
    })
    try {
      await active.process.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        cwd: active.directory,
        approvalPolicy: codexSettingsFor(this.permissionSelection.currentId(active.sessionId)).approvalPolicy,
        approvalsReviewer: "user",
        sandboxPolicy: codexSandboxPolicy(
          codexSettingsFor(this.permissionSelection.currentId(active.sessionId)).sandbox,
          active.directory,
        ),
        ...(active.model ? { model: active.model } : {}),
        ...(active.effort ? { effort: active.effort } : {}),
      })
      await completed
    } finally {
      unsubscribe()
    }
  }

  private async refreshChatgptAuthTokens() {
    const current = codexChatgptAuthTokens(this.codexAuth) ?? codexChatgptAuthTokens(readCodexAuthFile(this.codexHome))
    if (!current?.refresh) {
      throw new Error("Codex ChatGPT auth is missing a refresh token. Run `codex login` or sync a valid Codex credential, then retry.")
    }
    const response = await (this.options.fetch ?? fetch)(`${OPENAI_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refresh,
        client_id: OPENAI_CLIENT_ID,
      }).toString(),
    })
    if (!response.ok) {
      throw new Error(`Codex ChatGPT auth refresh failed (${response.status}). Run \`codex login\` or sync a valid Codex credential, then retry.`)
    }
    const row = record(await response.json().catch(() => undefined))
    const access = text(row?.access_token)
    const refresh = text(row?.refresh_token) ?? current.refresh
    if (!access) throw new Error("Codex ChatGPT auth refresh returned no access token")
    const next = {
      access,
      refresh,
      accountId: text(row?.account_id) ?? accountIdFromClaims(row) ?? current.accountId,
      idToken: text(row?.id_token) ?? current.idToken,
      planType: current.planType,
    }
    this.codexAuth = mergeCodexAuth(this.codexAuth ?? readCodexAuthFile(this.codexHome), next)
    await writeCodexAuthFile(this.codexHome, this.codexAuth)
    return next
  }
}

export function codexSpawnEnv(input: Record<string, string | undefined>) {
  return harnessSpawnEnv(input)
}

function executableBasename(input: string) {
  return input.split(/[\\/]/).at(-1) || "codex"
}

function compositeObservation(handles: AgentProcessObserverHandle[]): AgentProcessObserverHandle {
  let exited = false
  return {
    update(event) {
      handles.forEach((handle) => handle.update(event))
    },
    exit(event) {
      if (exited) return
      exited = true
      handles.forEach((handle) => handle.exit(event))
    },
  }
}

export function observeCodexAppServerProcess(input: {
  observer?: AgentProcessObserver
  binary: string
  directory: string
  pid?: number
  mcp?: Record<string, ResolvedMcpServer>
}): AgentProcessObserverHandle {
  const ownerId = `codex-app-server:${randomUUID()}`
  return compositeObservation([
    observeAgentProcess(input.observer, {
      ownerId,
      launchId: randomUUID(),
      harnessId: "codex",
      access: "native",
      role: "harness",
      label: "Codex app server",
      locality: "local-process",
      confidence: input.pid ? "direct" : "inferred",
      capabilities: {
        resourceMetrics: "process",
        ownerActions: false,
      },
      ...(input.pid ? { pid: input.pid } : {}),
      directory: input.directory,
      executableBasename: executableBasename(input.binary),
    }),
    ...Object.values(input.mcp ?? {}).map((server) => observeAgentProcess(input.observer, {
      ownerId: `codex-mcp:${randomUUID()}`,
      launchId: randomUUID(),
      harnessId: "codex",
      access: "native",
      role: "mcp" as const,
      label: `MCP ${server.name}`,
      locality: server.transport === "stdio" ? "local-process" as const : "remote" as const,
      confidence: server.transport === "stdio" ? "inferred" as const : "not-process-backed" as const,
      capabilities: {
        resourceMetrics: server.transport === "stdio" ? "process" as const : "none" as const,
        ownerActions: false,
      },
      parentOwnerId: ownerId,
      directory: input.directory,
      mcpName: server.name,
      transport: server.transport === "stdio" ? "stdio" as const : "streamable-http" as const,
      ...(server.transport === "stdio"
        ? { executableBasename: executableBasename(server.command) }
        : {}),
    })),
  ])
}

class CodexAppServerProcess {
  private proc: ChildProcess
  private buffer = ""
  private seq = 0
  private disposed = false
  private killTimer: ReturnType<typeof setTimeout> | undefined
  private pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (err: Error) => void
  }>()
  private listeners = new Set<(message: JsonRecord) => void>()
  private stderrListeners = new Set<(message: string) => void>()
  private observation: AgentProcessObserverHandle
  private observationExited = false

  private constructor(
    private readonly binary: string,
    private readonly directory: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly requestHandler: (message: JsonRecord) => Promise<unknown>,
    private readonly onClose: (err: Error) => void,
    processObserver?: AgentProcessObserver,
    mcp: Record<string, ResolvedMcpServer> = {},
  ) {
    const command = appServerCommand(binary)
    // Shims must go through the shell (see isWindowsShimBinary); the quoting
    // keeps a binary path with spaces intact through cmd.exe's tokenization.
    const windowsShim = isWindowsShimBinary(command.command)
    this.proc = spawn(windowsShim ? `"${command.command}"` : command.command, command.args, {
      cwd: directory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(windowsShim ? { shell: true } : {}),
    })
    this.observation = observeCodexAppServerProcess({
      observer: processObserver,
      binary,
      directory,
      ...(this.proc.pid ? { pid: this.proc.pid } : {}),
      mcp,
    })
    this.proc.stdout?.setEncoding("utf8")
    this.proc.stderr?.setEncoding("utf8")
    this.proc.stdout?.on("data", (chunk: string) => this.read(chunk))
    this.proc.stderr?.on("data", (chunk: string) => {
      const message = chunk.trim()
      log.warn("codex app-server stderr", { message })
      for (const listener of this.stderrListeners) listener(message)
    })
    this.proc.on("error", (cause) => {
      if (this.killTimer) clearTimeout(this.killTimer)
      const err = cause instanceof Error ? cause : new Error(String(cause))
      this.exitObservation({ reason: "error" })
      for (const item of this.pending.values()) item.reject(err)
      this.pending.clear()
      if (this.disposed) return
      this.onClose(err)
    })
    this.proc.on("exit", (code, signal) => {
      if (this.killTimer) clearTimeout(this.killTimer)
      this.exitObservation({ reason: "exited", ...(code !== null ? { exitCode: code } : {}) })
      const err = new Error(`codex app-server exited (${signal ?? code ?? "unknown"})`)
      for (const item of this.pending.values()) item.reject(err)
      this.pending.clear()
      if (this.disposed) return
      this.onClose(err)
    })
  }

  static async start(input: {
    binary: string
    directory: string
    env: NodeJS.ProcessEnv
    requestHandler: (message: JsonRecord) => Promise<unknown>
    onClose?: (err: Error) => void
    processObserver?: AgentProcessObserver
    mcp?: Record<string, ResolvedMcpServer>
    signal?: AbortSignal
  }) {
    const proc = new CodexAppServerProcess(
      input.binary,
      input.directory,
      input.env,
      input.requestHandler,
      input.onClose ?? (() => {}),
      input.processObserver,
      input.mcp,
    )
    const onAbort = () => proc.dispose()
    try {
      if (input.signal?.aborted) throw new Error("Codex app-server startup was cancelled")
      input.signal?.addEventListener("abort", onAbort, { once: true })
      await proc.request("initialize", {
        clientInfo: { name: "claxedo-workspace-runtime", version: "0.1.0" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      })
      proc.notify("initialized")
      proc.observation.update({ lifecycle: "ready" })
      return proc
    } catch (cause) {
      proc.dispose()
      throw cause
    } finally {
      input.signal?.removeEventListener("abort", onAbort)
    }
  }

  get alive() {
    return this.proc.exitCode === null && !this.proc.killed
  }

  onMessage(listener: (message: JsonRecord) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStderr(listener: (message: string) => void) {
    this.stderrListeners.add(listener)
    return () => this.stderrListeners.delete(listener)
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params })
  }

  respond(id: unknown, result: unknown) {
    this.write({ id, result })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.exitObservation({ reason: "disposed" })
    const err = new Error("codex app-server process was disposed")
    for (const item of this.pending.values()) item.reject(err)
    this.pending.clear()
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return
    killHarnessProcess(this.proc, "SIGTERM")
    this.killTimer = setTimeout(() => {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) return
      killHarnessProcess(this.proc, "SIGKILL")
    }, 1_000)
    this.killTimer.unref()
  }

  private exitObservation(input: { reason: "error" | "exited" | "disposed"; exitCode?: number }) {
    if (this.observationExited) return
    this.observationExited = true
    this.observation.exit(input)
  }

  private write(message: JsonRecord) {
    this.proc.stdin?.write(JSON.stringify(message) + "\n")
  }

  private read(chunk: string) {
    this.buffer += chunk
    while (true) {
      const i = this.buffer.indexOf("\n")
      if (i < 0) return
      const line = this.buffer.slice(0, i).trim()
      this.buffer = this.buffer.slice(i + 1)
      if (!line) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string) {
    let message: JsonRecord
    try {
      message = JSON.parse(line) as JsonRecord
    } catch {
      log.warn("codex app-server emitted non-json line", { line })
      return
    }
    const method = text(message.method)
    const id = typeof message.id === "number" ? message.id : undefined
    if (id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      const error = record(message.error)
      if (error) {
        pending.reject(new Error(text(error.message) ?? `codex app-server request ${id} failed`))
        return
      }
      pending.resolve(message.result)
      return
    }
    if (!method) return
    if (message.id !== undefined) {
      this.requestHandler(message)
        .then((result) => this.respond(message.id, result))
        .catch((err) => this.write({
          id: message.id,
          error: { message: errorMessage(err) },
        }))
      return
    }
    for (const listener of this.listeners) listener(message)
  }
}

function sourceAuthValue(input: string | undefined) {
  if (!input) return
  try {
    const value = JSON.parse(input) as JsonRecord
    if (codexChatgptAuthTokens(value)) return
    return text(value.OPENAI_API_KEY)
  } catch {
    return input
  }
}

function sourceCodexAuthValue(input: string | undefined) {
  if (!input) return
  try {
    const value = JSON.parse(input) as JsonRecord
    if (value.type === "codex_auth" || value.auth_mode === "chatgpt" || codexChatgptAuthTokens(value)) return value
  } catch {}
}

function readCodexAuthFile(home: string) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")) as JsonRecord
  } catch {
    return
  }
}

async function writeCodexAuthFile(home: string, input: JsonRecord | undefined) {
  if (!input) return
  await fs.promises.mkdir(home, { recursive: true, mode: 0o700 })
  await fs.promises.writeFile(path.join(home, "auth.json"), JSON.stringify(input, null, 2) + "\n", { mode: 0o600 })
}

function codexChatgptAuthTokens(input: JsonRecord | undefined) {
  if (!input) return
  const tokens = record(input.tokens)
  const oauth = record(input.oauth)
  const access = text(input.access) ?? text(tokens?.access_token) ?? text(oauth?.access)
  const refresh = text(input.refresh) ?? text(tokens?.refresh_token) ?? text(oauth?.refresh)
  const idToken = text(input.id_token) ?? text(tokens?.id_token) ?? text(oauth?.id_token)
  const accountId = text(input.account_id)
    ?? text(input.accountId)
    ?? text(tokens?.account_id)
    ?? text(oauth?.account_id)
    ?? accountIdFromClaims(input)
  if (!access || !accountId) return
  return {
    access,
    ...(refresh ? { refresh } : {}),
    ...(idToken ? { idToken } : {}),
    accountId,
    ...(text(input.chatgptPlanType) ?? text(input.plan_type) ?? text(oauth?.plan_type)
      ? { planType: text(input.chatgptPlanType) ?? text(input.plan_type) ?? text(oauth?.plan_type) }
      : {}),
  }
}

function mergeCodexAuth(input: JsonRecord | undefined, tokens: { access: string; refresh: string; accountId: string; idToken?: string; planType?: string }) {
  const current = input ?? { type: "codex_auth", auth_mode: "chatgpt" }
  const existingTokens = record(current.tokens) ?? {}
  const existingOauth = record(current.oauth) ?? {}
  // Codex (>=0.143) requires `tokens.id_token`; carry the refreshed one forward,
  // falling back to any previously-stored value so the file never regresses to
  // a shape the codex CLI refuses to parse.
  const idToken = tokens.idToken ?? text(existingTokens.id_token) ?? text(existingOauth.id_token)
  return {
    ...current,
    type: "codex_auth",
    auth_mode: text(current.auth_mode) ?? "chatgpt",
    tokens: {
      ...existingTokens,
      ...(idToken ? { id_token: idToken } : {}),
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      account_id: tokens.accountId,
    },
    access: tokens.access,
    refresh: tokens.refresh,
    account_id: tokens.accountId,
    last_refresh: new Date().toISOString(),
    oauth: {
      ...existingOauth,
      ...(idToken ? { id_token: idToken } : {}),
      access: tokens.access,
      refresh: tokens.refresh,
      account_id: tokens.accountId,
      ...(tokens.planType ? { plan_type: tokens.planType } : {}),
    },
  }
}

function accountIdFromClaims(input: JsonRecord | undefined) {
  return accountIdFromJwt(text(input?.id_token) ?? text(record(input?.tokens)?.id_token))
    ?? accountIdFromJwt(text(input?.access_token) ?? text(input?.access) ?? text(record(input?.tokens)?.access_token))
}

function accountIdFromJwt(token: string | undefined) {
  if (!token) return
  const payload = token.split(".")[1]
  if (!payload) return
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JsonRecord
    const openai = record(claims["https://api.openai.com/auth"])
    return text(claims.chatgpt_account_id) ?? text(openai?.chatgpt_account_id)
  } catch {
    return
  }
}

function codexUserInput(parts: unknown[]) {
  const textInput = extractTextFromParts(parts)
  if (!textInput) return [{ type: "text", text: "", text_elements: [] }]
  return [{ type: "text", text: textInput, text_elements: [] }]
}

function codexAppServerModel(model: string | undefined) {
  const value = text(model)
  if (!value || value === "default") return
  return value
}

function codexTurnModel(input: PromptInput, fallback: string) {
  return codexAppServerModel(text(input.model.modelID) ?? text(fallback))
}

function questionIds(params: JsonRecord) {
  const list = Array.isArray(params.questions) ? params.questions : []
  return list.flatMap((question) => text(record(question)?.id) ?? [])
}

function permissionResponse(method: string, decision: "allow_once" | "allow_always" | "deny" | "reject_always", params: JsonRecord) {
  const allow = decision === "allow_once" || decision === "allow_always"
  const session = decision === "allow_always"
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: allow ? session ? "approved_for_session" : "approved" : decision === "deny" ? "denied" : "abort" }
  }
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: allow ? (record(params.permissions) ?? {}) : {},
      scope: session ? "session" : "turn",
    }
  }
  return { decision: allow ? session ? "acceptForSession" : "accept" : decision === "deny" ? "decline" : "cancel" }
}
