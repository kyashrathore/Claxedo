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
import type { AgentConfigOption } from "../../index"
import type { AgentGoalResource, AgentHarnessAdapterHealth, FetchLike } from "../../adapter-contract"
import type { ResolvedMcpServer } from "../../mcp-resolver"
import { Log } from "../../log"
import { createLiveModelSource } from "../../live-model-source"
import {
  resolveSupportedEffort,
} from "../../sdk-model-catalog"
import {
  errorMessage,
  record,
  text,
  type JsonRecord,
  type SdkRuntimeAuth,
  type SdkRuntimeDriver,
  type SdkRuntimeDriverHost,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
import {
  CODEX_PERMISSION_MODES,
  CODEX_SETTINGS,
  DEFAULT_CODEX_MODE,
  PermissionModeSelection,
  codexSandboxPolicy,
  codexSettingsFor,
} from "../shared/permission-modes"
import { requireCodexExecutable } from "./executable"
import { CodexAppServerProcess } from "./app-server-process"
import {
  codexChatgptAuthTokens,
  readCodexAuthFile,
  refreshCodexChatgptAuth,
  sourceAuthValue,
  sourceCodexAuthValue,
} from "./auth-file"
import { codexConfigOptions, fetchCodexModels } from "./model-options"
import { CodexGoalController } from "./goal"
import {
  CODEX_DYNAMIC_TOOLS,
  type CodexActiveThread,
  codexAppServerModel,
  codexGoalSnapshot,
  codexIdleTimeoutMs,
  codexSpawnEnv,
  codexTurnModel,
  codexUserInput,
  permissionResponse,
  questionIds,
  startTurnWithThreadRecovery,
} from "./protocol"

export {
  codexGoalSnapshot,
  codexSpawnEnv,
  isThreadNotFound,
  sessionLostMessage,
  startTurnWithThreadRecovery,
} from "./protocol"

const log = Log.create({ service: "codex-app-server-adapter" })
const CODEX_SOURCE = "codex.app-server"

export function createCodexAppServerDriver(host: SdkRuntimeDriverHost, options: CodexDriverOptions = {}): SdkRuntimeDriver {
  return new CodexAppServerDriver(host, options)
}

type CodexDriverOptions = { binary?: string; fetch?: FetchLike; codexHome?: string }

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
  private processGoalUnsubscribe: (() => void) | null = null
  private lifecycleRevision = 0
  private disposed = false
  private processError: string | null = null
  private currentMcp: Record<string, ResolvedMcpServer> = {}
  private activeThreads = new Map<string, CodexActiveThread>()
  private readonly goalController: CodexGoalController
  readonly goals: AgentGoalResource
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
    this.goalController = new CodexGoalController({
      driverHost: this.host,
      ensureProcess: (directory) => this.ensureProcess(directory),
      liveProcess: () => this.process,
      lease: () => this.idle.lease(),
      activeThreads: this.activeThreads,
      projectThreadNotification: (input, threadId, method, params, frame) =>
        this.projectThreadNotification(input, threadId, method, params, frame),
    })
    this.goals = this.goalController.resource
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

  createRuntime(threadId: string): AgentEventRuntime {
    return createAgentEventRuntime({
      harness: this.type,
      threadId,
      adapter: codexAppServerAdapter(),
    })
  }

  /**
   * Deleting a session drops local state whatever the provider does: it never
   * spawns an app-server just to clean a Goal up, and never fails because the
   * cleanup failed.
   */
  async deleteAgentSession(sessionId: string, agentSessionId: string, directory: string) {
    await this.goalController.clearOnSessionDelete(sessionId, agentSessionId, directory)
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
      if (method === "thread/goal/updated" || method === "thread/goal/cleared") return
      messageQueue = messageQueue.then(async () => {
        const { parentOwned } = await this.projectThreadNotification(input, threadId, method, params, message)
        if (method === "turn/started" && parentOwned) {
          turnId = text(record(params.turn)?.id) ?? turnId
          const active = this.host.lifecycle().get(input.sessionId)
          if (active) active.turnId = turnId
        }
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

  private async projectThreadNotification(
    input: SdkRuntimeTurnInput,
    threadId: string,
    method: string,
    params: JsonRecord,
    frame: unknown,
  ) {
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
        source: { dir: "in", method, frame },
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
        source: { dir: "in", method, frame },
      })))
    }
    const eventThreadId = text(params.threadId) ?? text(record(params.thread)?.id)
    const parentOwned = !eventThreadId || eventThreadId === threadId
    input.ingest({ source: CODEX_SOURCE, method, payload: params }, {
      dir: "in",
      method,
      frame,
    }, parentOwned ? { kind: "parent" } : { kind: "child", correlationKey: eventThreadId })
    return { parentOwned, eventThreadId }
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
    this.processGoalUnsubscribe?.()
    this.processGoalUnsubscribe = null
    this.process.dispose()
    this.process = null
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.idle.cancel()
    this.lifecycleRevision++
    this.activeThreads.clear()
    this.goalController.dispose()
    this.processGoalUnsubscribe?.()
    this.processGoalUnsubscribe = null
    this.processStartupAbort?.abort()
    this.process?.dispose()
    this.process = null
    void this.processStartup?.then((proc) => proc.dispose(), () => {})
  }

  async configOptions(currentModel: string, directory?: string): Promise<AgentConfigOption[]> {
    return codexConfigOptions(await this.modelSource.models(directory), currentModel)
  }

  peekConfigOptions(currentModel: string, directory?: string): AgentConfigOption[] {
    return codexConfigOptions(this.modelSource.peek(directory), currentModel)
  }

  private async fetchModels(directory?: string) {
    return await fetchCodexModels({
      directory,
      processObserver: this.host.processObserver,
      ensureProcess: (cwd) => this.ensureProcess(cwd),
    })
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
        if (this.process === started) {
          this.processGoalUnsubscribe?.()
          this.processGoalUnsubscribe = null
          this.process = null
        }
        this.failInteractiveState(err)
      },
    })
    if (this.disposed || lifecycleRevision !== this.lifecycleRevision) {
      started.dispose()
      throw new Error("Codex app-server driver was disposed during startup")
    }
    this.process = started
    this.processGoalUnsubscribe?.()
    this.processGoalUnsubscribe = started.onMessage((message) => this.goalController.handleProcessMessage(message))
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
      const refreshed = await refreshCodexChatgptAuth({ auth: this.codexAuth, home: this.codexHome, fetch: this.options.fetch })
      this.codexAuth = refreshed.auth
      return refreshed.login
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

}

export { observeCodexAppServerProcess } from "./app-server-process"
