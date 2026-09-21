import { createIdleReaper } from "../shared/process-lifecycle"
import os from "os"
import path from "path"
import {
  createAgentEventRuntime,
  type AgentEventRuntime,
} from "@claxedo/agent-event-runtime"
import {
  codexAppServerAdapter,
  codexCollabAgentCall,
  codexSubagentActivity,
  codexStartedSubagent,
} from "@claxedo/agent-event-runtime/harnesses/codex"
import { codexHostSubagentObservation } from "./host-subagent"
import type { AgentConfigOption } from "../../index"
import type { AgentGoalResource, AgentHarnessAdapterHealth, FetchLike } from "../../adapter-contract"
import { resolvedMcpServers, type ResolvedMcpServer } from "../../mcp-resolver"
import { firstPartyMcpProvider, type FirstPartyMcpProvider } from "../../first-party-mcp"
import { Log } from "../../log"
import { harnessEffortLevels } from "../../harness-effort"
import { createLiveModelSource } from "../../live-model-source"
import {
  resolveSupportedEffort,
} from "../../sdk-model-options"
import { asRecord } from "@claxedo/helpers/guards"
import { controlRequestDeadline, modelRequestDeadline } from "../shared/request-deadline"
import {
  errorMessage,
  text,
  type JsonRecord,
  type SdkRuntimeDriver,
  type SdkRuntimeDriverHost,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
import { CODEX_PERMISSION_MODES, CODEX_SETTINGS, PermissionModeSelection, codexSandboxPolicy, codexSettingsFor } from "../shared/permission-modes"
import { generateCodexTitle, setCodexThreadName } from "./title"
import { requireCodexExecutable } from "./executable"
import { CodexAppServerProcess } from "./app-server-process"
import { CODEX_BROKER_PROVIDER, CodexBrokerProvider, codexAuthFailure } from "./broker"
import { harnessProjection } from "../../harness-projection"
import { providerProjectionRecord } from "../../provider-projection"
import { CodexOperatorLogin } from "./operator-login"
import { codexPluginLaunch, type CodexPluginLaunch } from "./plugin-launch"
import type { SessionTitleRequest } from "../../title-generation"
import { codexConfigOptions, fetchCodexModels } from "./model-options"
import { handleCodexServerRequest } from "./server-request"
import { CodexGoalController } from "./goal"
import {
  CODEX_DYNAMIC_TOOLS,
  createCodexTurnStop,
  type CodexActiveThread,
  codexAppServerModel,
  codexGoalSnapshot,
  codexIdleTimeoutMs,
  codexSpawnEnv,
  codexTurnModel,
  codexSteerTurn,
  codexUserInput,
  startTurnWithThreadRecovery,
} from "./protocol"
import { createTurnStopRecord } from "../shared/cancellation-facts"
import { RecoveryCodedError, retirementSettled, volatileLaunchOwnership, type LaunchOwnershipStore, type RetirementResult } from "../../launch"

export {
  codexGoalSnapshot,
  codexSpawnEnv,
  isThreadNotFound,
  sessionLostMessage,
  startTurnWithThreadRecovery,
} from "./protocol"

const log = Log.create({ service: "codex-app-server-adapter" })
const CODEX_SOURCE = "codex.app-server"

function unresolvedLaunch(retained: { result: RetirementResult }) {
  const { result } = retained
  return new RecoveryCodedError(
    result.error?.code ?? "exit_unverified",
    `The Codex app-server this driver launched was not established as stopped (leader ${result.leader}, group ${result.descendants}); no replacement was started${result.error ? `: ${result.error.message}` : ""}`,
  )
}

export function createCodexAppServerDriver(host: SdkRuntimeDriverHost, options: CodexDriverOptions = {}): SdkRuntimeDriver {
  return new CodexAppServerDriver(host, options)
}

type CodexDriverOptions = {
  binary?: string
  fetch?: FetchLike
  codexHome?: string
  /** Where the account-free Codex home a brokered turn runs under is built. */
  brokeredHome?: string
  /** Durable launch records, so an app-server outliving this process stays a recoverable owner. */
  ownership?: LaunchOwnershipStore
  /** The workspace a later owner reconciles this driver's launches under. */
  workspaceId?: string
}

class CodexAppServerDriver implements SdkRuntimeDriver {
  readonly type = "codex" as const
  // `thread/start` keeps `developerInstructions` for the life of the thread.
  readonly instructionChannel = "thread-start" as const
  readonly interactions = { permissions: true, questions: true } as const
  private readonly broker: CodexBrokerProvider
  private readonly operatorLogin: CodexOperatorLogin
  private process: CodexAppServerProcess | null = null
  /** Releases the app-server after its activity leases expire. */
  private readonly idleMs = codexIdleTimeoutMs()
  private readonly idle = createIdleReaper({
    idleMs: this.idleMs,
    onIdle: () => this.reapIdleProcess(),
  })
  private processStartup: Promise<CodexAppServerProcess> | null = null
  private processStartupAbort: AbortController | null = null
  private processGoalUnsubscribe: (() => void) | null = null
  private lifecycleRevision = 0
  private disposed = false
  private processError: string | null = null
  /** A launch whose retirement did not establish that it stopped. Blocks the next one. */
  private unretired: { result: RetirementResult } | null = null
  private currentMcp: Record<string, ResolvedMcpServer> = {}
  private firstPartyMcp: FirstPartyMcpProvider | undefined
  private currentPluginLaunch: CodexPluginLaunch | undefined
  private activeThreads = new Map<string, CodexActiveThread>()
  private readonly goalController: CodexGoalController
  readonly goals: AgentGoalResource
  private readonly codexHome: string
  private readonly modelSource = createLiveModelSource({
    harness: "codex",
    fetchModels: (directory) => this.fetchModels(directory),
  })

  constructor(
    private readonly host: SdkRuntimeDriverHost,
    private readonly options: CodexDriverOptions,
  ) {
    // Keep auth reads and writes on the same resolved Codex home for this driver.
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
    this.broker = new CodexBrokerProvider(options.brokeredHome)
    this.operatorLogin = new CodexOperatorLogin({ home: this.codexHome, ...(options.fetch ? { fetch: options.fetch } : {}) })
    this.goalController = new CodexGoalController({
      driverHost: this.host,
      ensureProcess: (directory) => this.ensureProcess(directory),
      liveProcess: () => this.process,
      lease: () => this.idle.lease(),
      threadConfig: (sessionId) => this.threadConfig(sessionId),
      activeThreads: this.activeThreads,
      projectThreadNotification: (input, threadId, method, params, frame) =>
        this.projectThreadNotification(input, threadId, method, params, frame),
    })
    this.goals = this.goalController.resource
  }

  async applyConfig(config: Record<string, unknown>) {
    const nextPluginLaunch = codexPluginLaunch(config.launch)
    await this.applyPluginLaunch(nextPluginLaunch)
    const auth = providerProjectionRecord(config.auth, {}, { onInvalid: "reject" })
    if (config.auth !== undefined && !auth) {
      throw new Error("codex harness received an auth map that is not provider projections")
    }
    if (this.replaceAuth(harnessProjection(auth, "codex"))) await this.restartProcess()
    this.currentMcp = resolvedMcpServers(config.mcp) ?? {}
    this.firstPartyMcp = firstPartyMcpProvider(config)
  }

  private replaceAuth(projection: Parameters<CodexBrokerProvider["replace"]>[0]) {
    if (!this.broker.replace(projection)) return false
    this.modelSource.invalidate()
    return true
  }

  /** Keep native session tools and MCP credentials consistent on start and resume. */
  private threadConfig(sessionId: string): { config: JsonRecord } {
    const server = this.firstPartyMcp?.server(sessionId)
    return { config: {
      // Claxedo advertises structured questions in ordinary coding turns.
      features: { default_mode_request_user_input: true },
      tools: { update_plan: { enabled: true } },
      ...(server ? { mcp_servers: { [server.name]: { url: server.url, http_headers: server.headers } } } : {}),
    } }
  }

  private async applyPluginLaunch(launch: CodexPluginLaunch | undefined) {
    if (JSON.stringify(launch) === JSON.stringify(this.currentPluginLaunch)) return
    if (this.activeThreads.size > 0) {
      throw new Error("Codex Agent Plugins cannot change while a Codex turn is active")
    }
    this.currentPluginLaunch = launch
    await this.restartProcess()
  }

  private async restartProcess() {
    this.lifecycleRevision++
    this.processStartupAbort?.abort()
    const startup = this.processStartup
    const retiring = this.process
    this.process = null
    if (retiring) await this.retireProcess(retiring)
    if (startup) await startup.catch(() => undefined)
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

  async createAgentSession(input: { directory: string; model: string; system?: string; sessionId: string }) {
    const proc = await this.ensureProcess(input.directory)
    const model = codexAppServerModel(input.model)
    // A thread created before the user has touched the picker still has to run
    // under the default rung rather than whatever `thread/start` would assume.
    const settings = codexSettingsFor(undefined)
    const result = await proc.request("thread/start", {
      cwd: input.directory,
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: settings.sandbox,
      dynamicTools: CODEX_DYNAMIC_TOOLS,
      ...(input.system ? { developerInstructions: input.system } : {}),
      ...(model ? { model } : {}),
      // Named here as well as in the config: the app-server starts a thread on
      // its own default provider unless the start request says otherwise.
      ...(this.broker.selected ? { modelProvider: CODEX_BROKER_PROVIDER } : {}),
      ...this.threadConfig(input.sessionId),
    }, controlRequestDeadline()).then((response) => asRecord(response) ?? {})
    const thread = asRecord(result.thread)
    const threadId = text(thread?.id)
    if (!threadId) throw new Error("Codex app-server did not return a thread id")
    return { id: threadId }
  }

  generateTitle = ({ sessionId, request }: { sessionId: string; request: SessionTitleRequest }) => generateCodexTitle({ request, process: () => this.ensureProcess(request.directory), lease: () => this.idle.lease(), model: codexAppServerModel(request.model?.modelID), ...(this.broker.selected ? { modelProvider: CODEX_BROKER_PROVIDER } : {}), ...this.threadConfig(sessionId) })
  setAgentSessionTitle = ({ agentSessionId, title }: { agentSessionId: string; title: string }) => setCodexThreadName(this.process?.alive ? this.process : null, agentSessionId, title)

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
    // Archive the provider thread so a deleted session cannot be resumed — but
    // only through an already-running app-server: local deletion must neither
    // spawn a process nor fail because the provider cleanup did.
    const proc = this.process
    if (proc?.alive) await proc.request("thread/archive", { threadId: agentSessionId }, controlRequestDeadline()).catch(() => {})
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
    let startPending: Promise<JsonRecord> | undefined
    const stops = createTurnStopRecord()
    const cancellation = createCodexTurnStop({
      process: proc,
      threadId,
      record: stops,
      turnId: async () => {
        if (startPending) {
          const result = await startPending
          turnId = text(asRecord(result.turn)?.id) ?? turnId
        }
        return turnId
      },
    })
    const stop = cancellation.stop
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
    const onAbort = () => {
      // Recorded rather than awaited: the turn must fail now, and the stop's
      // own outcome reaches the caller through the lifecycle entry.
      void stop()
      failTurn(new Error("Codex turn aborted"))
    }
    const onStderr = (message: string) => {
      if (message.includes("401 Unauthorized")) failTurn(new Error(codexAuthFailure(message, this.broker.selected)))
    }
    const model = codexTurnModel(input.input, input.model)
    const effort = resolveSupportedEffort(
      this.modelSource.peek(input.directory),
      codexAppServerModel(input.input.model?.modelID),
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
      const params = asRecord(message.params) ?? {}
      if (!method) return
      cancellation.observe(params)
      if (method === "thread/goal/updated" || method === "thread/goal/cleared") return
      messageQueue = messageQueue.then(async () => {
        const { parentOwned } = await this.projectThreadNotification(input, threadId, method, params, message)
        if (method === "turn/started" && parentOwned) {
          turnId = text(asRecord(params.turn)?.id) ?? turnId
          const active = this.host.lifecycle().get(input.sessionId)
          if (active) active.turnId = turnId
        }
        if (method === "turn/completed" && parentOwned) resolveCompleted?.()
      }).catch((err: unknown) => failTurn(new Error(errorMessage(err))))
    })
    const unsubscribeStderr = proc.onStderr(onStderr)
    input.abort.signal.addEventListener("abort", onAbort, { once: true })
    this.host.lifecycle().set(input.sessionId, {
      abort: input.abort,
      close: stop,
      stops,
      steer: (steered) => codexSteerTurn({ process: proc, threadId, turnId, input: steered, directory: input.directory }),
    })
    const startTurn = async (): Promise<JsonRecord> => asRecord(await proc.request("turn/start", {
      threadId,
      input: await codexUserInput({ parts: input.input.parts, directory: input.directory }),
      cwd: input.directory,
      approvalPolicy: codexSettingsFor(this.permissionSelection.currentId(input.sessionId)).approvalPolicy,
      approvalsReviewer: "user",
      sandboxPolicy: codexSandboxPolicy(
        codexSettingsFor(this.permissionSelection.currentId(input.sessionId)).sandbox,
        input.directory,
      ),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    }, modelRequestDeadline())) ?? {}

    try {
      if (input.abort.signal.aborted) throw new Error("Codex turn aborted")
      startPending = startTurnWithThreadRecovery({
        startTurn,
        resumeThread: async () => {
          log.info("codex thread missing from app-server process; resuming from disk", { threadId })
          await proc.request("thread/resume", { threadId, cwd: input.directory, ...this.threadConfig(input.sessionId) }, controlRequestDeadline())
        },
      })
      const result = await Promise.race([startPending, turnStartFailed])
      turnId = text(asRecord(result.turn)?.id) ?? turnId
      const active = this.host.lifecycle().get(input.sessionId)
      if (active) active.turnId = turnId
      await completed
    } finally {
      try {
        // Awaited so the producer does not leave its busy section before the
        // stop settles. A stop that failed belongs to `stops`, where the
        // cancelling caller reads it; resurfacing it here would report a
        // failed cancellation as a failed turn.
        if (input.abort.signal.aborted) await stop().catch(() => {})
      } finally {
        input.abort.signal.removeEventListener("abort", onAbort)
        unsubscribeStderr()
        unsubscribe()
        this.activeThreads.delete(threadId)
      }
    }
  }

  private async projectThreadNotification(
    input: SdkRuntimeTurnInput,
    threadId: string,
    method: string,
    params: JsonRecord,
    frame: unknown,
  ) {
    const activity = codexSubagentActivity(params.item)
    if (activity && params.threadId === threadId) {
      await input.observeSubagent({
        observation: {
          observationId: `codex:activity:${activity.id}:${activity.kind}`,
          harnessExecutionId: threadId,
          stableCorrelationId: activity.agentThreadId,
          providerId: activity.agentThreadId,
          providerKind: "codex",
          status: activity.kind === "started" ? "running" : "completed",
          transcript: { kind: "live" },
          ...(activity.kind === "started" ? { toolCallId: activity.id, toolCallRole: "spawn" as const } : {}),
          ...(activity.agentPath ? { label: activity.agentPath } : {}),
        },
        correlationKeys: [activity.agentThreadId],
        source: { dir: "in", method, frame },
      })
    }
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
    const call = codexCollabAgentCall(asRecord(params.item))
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
    const hostSpawn = method === "item/completed" ? codexHostSubagentObservation(threadId, asRecord(params.item)) : undefined
    if (hostSpawn) await input.observeSubagent({ observation: hostSpawn, correlationKeys: [], source: { dir: "in", method, frame } })
    const eventThreadId = text(params.threadId) ?? text(asRecord(params.thread)?.id)
    const parentOwned = !eventThreadId || eventThreadId === threadId
    input.ingest({ source: CODEX_SOURCE, method, payload: params }, {
      dir: "in",
      method,
      frame,
    }, parentOwned ? { kind: "parent" } : { kind: "child", correlationKey: eventThreadId })
    return { parentOwned, eventThreadId }
  }

  readRuntimeHealth(): AgentHarnessAdapterHealth {
    if (this.unretired) return {
      status: "unavailable",
      reason: "harness_retirement_unresolved",
      message: unresolvedLaunch(this.unretired).message,
    }
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
    const retiring = this.process
    this.process = null
    // Reclaiming memory must not silently leave a Codex process behind: an
    // unresolved retirement is retained and refuses the next launch.
    void retiring.dispose().then((result) => {
      if (!retirementSettled(result)) this.unretired = { result }
    })
  }

  /** Resolves once every app-server process this driver owns has exited. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.idle.cancel()
    this.lifecycleRevision++
    this.activeThreads.clear()
    this.goalController.dispose()
    this.processGoalUnsubscribe?.()
    this.processGoalUnsubscribe = null
    this.processStartupAbort?.abort()
    const running = this.process
    const startup = this.processStartup
    this.process = null
    const results = await Promise.all([running?.dispose(), startup?.then((proc) => proc.dispose(), () => undefined)])
    const unresolved = results.find((result) => result && !retirementSettled(result))
    if (unresolved) this.unretired = { result: unresolved }
  }

  async configOptions(currentModel: string, directory?: string): Promise<AgentConfigOption[]> {
    return codexConfigOptions(await this.modelSource.models(directory), currentModel)
  }

  peekConfigOptions(currentModel: string, directory?: string): AgentConfigOption[] {
    return codexConfigOptions(this.modelSource.peek(directory), currentModel)
  }

  effortLevels(directory?: string) {
    return harnessEffortLevels(this.modelSource.peek(directory))
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

  /**
   * One app-server at a time, and a replacement only once the launch it
   * replaces has been established as stopped. Two app-servers sharing this
   * driver's Codex home would write each other's threads and auth file, so an
   * unresolved retirement is retained and refused rather than raced.
   */
  private async ensureProcess(directory: string) {
    if (this.disposed) throw new Error("Codex app-server driver is disposed")
    if (this.unretired) throw unresolvedLaunch(this.unretired)
    if (!this.process?.alive && !this.processStartup) {
      const retiring = this.process
      this.process = null
      const revision = this.lifecycleRevision
      const abort = new AbortController()
      this.processStartupAbort = abort
      const startup = (async () => {
        if (retiring) await this.retireProcess(retiring)
        return await this.startProcess(directory, revision, abort.signal)
      })()
      const pending = startup.finally(() => {
        if (this.processStartup === pending) {
          this.processStartup = null
          this.processStartupAbort = null
        }
      })
      this.processStartup = pending
    }
    return this.processStartup ? await this.processStartup : this.process!
  }

  /**
   * Retires one launch and keeps it if the retirement did not establish that it
   * stopped. Nothing else in this driver may start a Codex process until an
   * owner has resolved it.
   */
  private async retireProcess(proc: CodexAppServerProcess) {
    const result = await proc.dispose()
    if (retirementSettled(result)) return result
    this.unretired = { result }
    throw unresolvedLaunch(this.unretired)
  }

  private async startProcess(directory: string, lifecycleRevision: number, signal: AbortSignal) {
    let started: CodexAppServerProcess | undefined
    started = await CodexAppServerProcess.start({
      binary: this.options.binary ?? requireCodexExecutable(),
      directory,
      env: codexSpawnEnv({
        ...process.env,
        CODEX_HOME: this.broker.home(this.codexHome),
      }),
      requestHandler: (message) => this.handleServerRequest(message),
      processObserver: this.host.processObserver,
      mcp: this.currentMcp,
      signal,
      // A composition that gave this driver no store still gets a launch
      // record; it just cannot be reconciled after a restart, which is what
      // volatile ownership says about itself.
      ownership: this.options.ownership ?? volatileLaunchOwnership(),
      // Empty when the composition named no workspace: a launch nobody will
      // reconcile is worth saying so, and inventing an id would hide it.
      workspaceId: this.options.workspaceId ?? "",
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
      await started.dispose()
      throw new Error("Codex app-server driver was disposed during startup")
    }
    this.process = started
    this.processGoalUnsubscribe?.()
    this.processGoalUnsubscribe = started.onMessage((message) => this.goalController.handleProcessMessage(message))
    this.processError = null
    if (this.disposed || lifecycleRevision !== this.lifecycleRevision) {
      await started.dispose()
      if (this.process === started) this.process = null
      throw new Error("Codex app-server driver was disposed during startup")
    }
    return started
  }

  /**
   * Every app-server request this driver answers is handled by
   * `handleCodexServerRequest`, which owns the whole surface — questions,
   * approvals, the `spawn_agent` dynamic tool, and auth refresh. This driver
   * supplies only what is its own: the live thread index, the host's pending
   * queues, the session's permission selection, and the operator login a
   * turn with no binding runs on.
   */
  private handleServerRequest(message: JsonRecord) {
    return handleCodexServerRequest({
      message,
      activeThreads: this.activeThreads,
      host: this.host,
      permissionModeId: (sessionId) => this.permissionSelection.currentId(sessionId),
      refreshTokens: () => this.operatorLogin.refresh(),
    })
  }
}

export { observeCodexAppServerProcess, codexAppServerCommand } from "./app-server-process"
