import { createIdleReaper } from "../shared/process-lifecycle"
import { randomUUID } from "crypto"
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
import type { AgentConfigOption, PromptInput } from "../../index"
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
} from "../../process-observer"
import { requireCodexExecutable } from "./executable"
import { CodexAppServerProcess } from "./app-server-process"
import {
  accountIdFromClaims,
  codexChatgptAuthTokens,
  mergeCodexAuth,
  readCodexAuthFile,
  sourceAuthValue,
  sourceCodexAuthValue,
  writeCodexAuthFile,
} from "./auth-file"
import {
  CODEX_DYNAMIC_TOOLS,
} from "./dynamic-agent"
import type { CodexActiveThread } from "./active-thread"
import { handleCodexServerRequest } from "./server-request"
import { startTurnWithThreadRecovery } from "./thread-recovery"

export { isThreadNotFound, sessionLostMessage, startTurnWithThreadRecovery } from "./thread-recovery"

const log = Log.create({ service: "codex-app-server-adapter" })
const CODEX_SOURCE = "codex.app-server"
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OPENAI_ISSUER = "https://auth.openai.com"

export function createCodexAppServerDriver(host: SdkRuntimeDriverHost, options: CodexDriverOptions = {}): SdkRuntimeDriver {
  return new CodexAppServerDriver(host, options)
}

type CodexDriverOptions = { binary?: string; fetch?: FetchLike; codexHome?: string }

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
  /** Releases the app-server after its activity leases expire. */
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
    fetchModels: (directory) => this.fetchModels(directory),
  })

  constructor(
    private readonly host: SdkRuntimeDriverHost,
    private readonly options: CodexDriverOptions,
  ) {
    // Keep auth reads and writes on the same resolved Codex home for this driver.
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
  }

  setAuth(keys: SdkRuntimeAuth) {
    const previous = this.authSignature()
    this.auth = {
      ...this.auth,
      ...(keys.openai !== undefined ? { openai: keys.openai || undefined } : {}),
    }
    if (this.authSignature() !== previous) {
      this.authRevision++
      this.modelSource.invalidate()
    }
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
    if (this.authSignature() !== previous) {
      this.authRevision++
      this.modelSource.invalidate()
    }
    const proc = this.process ?? (this.processStartup ? await this.processStartup : null)
    if (proc?.alive) await this.syncProcessAuth(proc)
  }

  private readonly permissionSelection = new PermissionModeSelection(CODEX_PERMISSION_MODES, "next-turn")

  permissionModes(sessionId: string) {
    return this.permissionSelection.state(sessionId)
  }

  /** Stores the selection applied by every subsequent thread and turn request. */
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

  async deleteAgentSession(_sessionId: string, agentSessionId: string, directory: string) {
    const proc = await this.ensureProcess(directory)
    await proc.request("thread/archive", { threadId: agentSessionId })
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
      this.modelSource.peek(input.directory),
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

  async configOptions(currentModel: string, directory?: string): Promise<AgentConfigOption[]> {
    return this.buildConfigOptions(await this.modelSource.models(directory), currentModel)
  }

  peekConfigOptions(currentModel: string, directory?: string): AgentConfigOption[] {
    return this.buildConfigOptions(this.modelSource.peek(directory), currentModel)
  }

  private buildConfigOptions(models: readonly SdkModelEntry[], currentModel: string) {
    if (models.length === 0) return []
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
    return handleCodexServerRequest({
      message,
      activeThreads: this.activeThreads,
      host: this.host,
      permissionModeId: (sessionId) => this.permissionSelection.currentId(sessionId),
      refreshTokens: () => this.refreshChatgptAuthTokens(),
    })
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

export { observeCodexAppServerProcess } from "./app-server-process"
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

function codexTurnModel(input: PromptInput, configuredModel: string) {
  return codexAppServerModel(text(input.model.modelID) ?? text(configuredModel))
}
