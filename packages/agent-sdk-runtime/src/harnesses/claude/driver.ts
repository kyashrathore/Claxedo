import {
  createAgentEventRuntime,
  type AgentEventRuntime,
  type RuntimeGoalSnapshot,
} from "@claxedo/agent-event-runtime"
import {
  claudeChildCorrelationKey,
  claudeSdkAdapter,
  claudeSubagentObservations,
} from "@claxedo/agent-event-runtime/harnesses/claude"
import { randomUUID } from "crypto"
import { spawn } from "child_process"
import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKActiveGoalMessage,
  type SDKMessage,
  type SessionStore,
  type SessionStoreEntry,
  type SpawnOptions,
  type SpawnedProcess,
  type SdkPluginConfig,
} from "@anthropic-ai/claude-agent-sdk"
import type { AgentConfigOption, AgentQuestionAnswer } from "../../index"
import type { AgentHarnessAdapterHealth } from "../../adapter-contract"
import { goalCapabilities } from "../../capabilities"
import { resolvedMcpServers, type ResolvedMcpServer } from "../../mcp-resolver"
import { firstPartyMcpProvider, type FirstPartyMcpProvider } from "../../first-party-mcp"
import { createLiveModelSource } from "../../live-model-source"
import { modelConfigOption, resolveTurnEffort, thoughtLevelConfigOption, type SdkModelEntry } from "../../sdk-model-catalog"
import { asRecord } from "@claxedo/helpers/guards"
import {
  errorMessage,
  extractTextFromParts,
  text,
  type SdkRuntimeAuth,
  type SdkRuntimeDriver,
  type SdkRuntimeDriverHost,
  type SdkRuntimeTurnInput,
  stringRecord,
} from "../shared/sdk-runtime-adapter"
import { createNativeGoalStore, nativeGoalCommand } from "../shared/native-goal-store"
import { interruptGoalTurn } from "../shared/goal-stop-order"
import { claudeAuthEnv, claudeAuthValue } from "./auth"
import { requireClaudeExecutable } from "./executable"
import { harnessSpawnEnv } from "../shared/spawn-env"
import {
  CLAUDE_DENY_FLOOR,
  CLAUDE_PERMISSION_MODES,
  PermissionModeSelection,
} from "../shared/permission-modes"
import { isClaudeSdkPermissionMode } from "./permission-mode-parity"
import {
  observeAgentProcess,
  type AgentProcessObserver,
  type AgentProcessObserverHandle,
} from "../../process-observer"

const CLAUDE_PENDING_PREFIX = "claude-sdk:"
const MODEL_LIST_TIMEOUT_MS = 30_000

function idlePrompt(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<never>>(() => {}),
      }
    },
  }
}

// Child text is forwarded because the routed nested-turn contract admits it.
export const CLAUDE_FORWARD_SUBAGENT_TEXT = true

export function claudeSystemPrompt(system?: string) {
  return system
    ? { type: "preset" as const, preset: "claude_code" as const, append: system }
    : undefined
}

export function claudeGoalSnapshot(
  sessionId: string,
  message: SDKActiveGoalMessage,
): RuntimeGoalSnapshot | null {
  if (!message.value) return null
  const setAt = message.value.set_at < 1_000_000_000_000
    ? message.value.set_at * 1_000
    : message.value.set_at
  return {
    sessionId,
    objective: message.value.condition,
    status: "active",
    createdAt: setAt,
    updatedAt: Date.now(),
    iteration: message.value.iterations,
    ...(message.value.last_reason ? { lastReason: message.value.last_reason } : {}),
  }
}

/**
 * The single reader of Claude's Goal progress, and the only place coupled to
 * its format.
 *
 * FORMAT COUPLING: the SDK has no typed Goal-progress message. The CLI reports
 * every iteration by writing an UNTYPED `goal_status` attachment entry to the
 * session store — `{ type, met, condition, reason?, iterations? }` — so this
 * helper sniffs it out of `SessionStoreEntry.attachment`. Every field is read
 * defensively: it runs inside the SDK's `sessionStore.append`, where a throw
 * would fail the very turn that carries the Goal, so an entry shape that no
 * longer matches must degrade to "no Goal update" (`undefined`) instead.
 *
 * Returns the new snapshot, `null` when the Goal is met (clear it), or
 * `undefined` when the entry says nothing about a Goal.
 */
export function claudeTranscriptGoalSnapshot(
  sessionId: string,
  entry: SessionStoreEntry,
  previous?: RuntimeGoalSnapshot,
): RuntimeGoalSnapshot | null | undefined {
  const row = asRecord(entry)
  if (!row || row.type !== "attachment") return undefined
  const attachment = asRecord(row.attachment)
  if (text(attachment?.type) !== "goal_status") return undefined
  if (attachment?.met === true) return null
  if (attachment?.met !== false) return undefined
  const objective = text(attachment.condition)
  if (!objective) return undefined
  const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN
  const updatedAt = Number.isFinite(timestamp) ? timestamp : Date.now()
  return {
    sessionId,
    objective,
    status: "active",
    createdAt: previous?.objective === objective ? previous.createdAt : updatedAt,
    updatedAt,
    ...(typeof attachment.iterations === "number" ? { iteration: attachment.iterations } : {}),
    ...(text(attachment.reason) ? { lastReason: text(attachment.reason) } : {}),
  }
}

/**
 * The Agent Plugins launch payload names the plugin roots materialized on disk
 * for this workspace; the SDK takes them as local plugin configs.
 */
export function claudePluginConfigs(input: unknown): SdkPluginConfig[] {
  const launch = asRecord(input)
  if (!Array.isArray(launch?.pluginRoots)) return []
  return [...new Set(launch.pluginRoots.filter((item): item is string => typeof item === "string" && Boolean(item.trim())))]
    .map((pluginPath) => ({ type: "local", path: pluginPath }))
}

export type ClaudeSdkDriverOptions = {
  query?: typeof query
  executable?: () => string
}

export function createClaudeSdkDriver(
  host: SdkRuntimeDriverHost,
  options: ClaudeSdkDriverOptions = {},
): SdkRuntimeDriver {
  return new ClaudeSdkDriver(host, options)
}

class ClaudeSdkDriver implements SdkRuntimeDriver {
  readonly type = "claude" as const
  readonly interactions = { permissions: true, questions: true } as const
  private readonly goalStore = createNativeGoalStore()
  readonly nativeGoal: NonNullable<SdkRuntimeDriver["nativeGoal"]> = {
    capabilities: () => goalCapabilities({
      implemented: true,
      available: true,
      actions: [],
      recovery: "blocked",
      optionalFields: ["iteration", "lastReason"],
    }),
    read: (sessionId) => this.goalStore.read(sessionId),
    run: (input, objective, onGoal) => this.runQuery(input, nativeGoalCommand(objective), onGoal),
    stop: (sessionId, directory) => this.stopGoal(sessionId, directory),
    // The resource calls stop first, which clears the native Stop hook before
    // this removes the retained, paused objective.
    delete: async (sessionId) => {
      const had = !!this.goalStore.peek(sessionId)
      this.goalStore.forget(sessionId)
      return had
    },
  }
  private auth: SdkRuntimeAuth = {}
  private currentMcp: Record<string, ResolvedMcpServer> = {}
  private firstPartyMcp: FirstPartyMcpProvider | undefined
  private currentPlugins: SdkPluginConfig[] = []
  private readonly modelSource = createLiveModelSource({
    harness: "claude",
    fetchModels: (directory) => this.fetchModels(directory),
  })

  /**
   * `next-turn`: `permissionMode` is read when `query()` is called, and a turn
   * is one query, so a change is live from the next message. The SDK also has
   * `setPermissionMode()` for mid-turn changes, deliberately unused — it applies
   * to a streaming-input query this driver does not hold open between turns, so
   * calling it would mean keeping a handle alive purely to mutate it.
   */
  private readonly permissionSelection = new PermissionModeSelection(CLAUDE_PERMISSION_MODES, "next-turn")

  constructor(
    private readonly host: SdkRuntimeDriverHost,
    private readonly driverOptions: ClaudeSdkDriverOptions,
  ) {}

  permissionModes(sessionId: string) {
    return this.permissionSelection.state(sessionId)
  }

  async setPermissionMode(sessionId: string, modeId: string) {
    return this.permissionSelection.set(sessionId, modeId)
  }

  setAuth(keys: SdkRuntimeAuth) {
    const previous = this.auth.anthropic
    this.auth = {
      ...this.auth,
      ...(keys.anthropic !== undefined ? { anthropic: keys.anthropic || undefined } : {}),
    }
    if (this.auth.anthropic !== previous) this.modelSource.invalidate()
  }

  applyConfig(config: Record<string, unknown>) {
    const previous = this.auth.anthropic
    const auth = stringRecord(config.auth)
    this.auth = {
      anthropic: claudeAuthValue(auth),
    }
    this.currentMcp = resolvedMcpServers(config.mcp) ?? {}
    this.firstPartyMcp = firstPartyMcpProvider(config)
    this.currentPlugins = claudePluginConfigs(config.launch)
    if (this.auth.anthropic !== previous) this.modelSource.invalidate()
    // Held, not applied here: the SDK takes `effort` as a per-query option, so
    // it is read when the next session is created rather than pushed at the
    // running one. `undefined` means "let the model decide", which is not the
    // same as any named level and must survive a config apply that omits it.
    if ("effort" in config) {
      this.currentEffort = typeof config.effort === "string" ? config.effort : undefined
    }
  }

  private mcpServersFor(sessionId: string): { mcpServers?: Record<string, McpServerConfig> } {
    const firstParty = this.firstPartyMcp?.server(sessionId)
    const mcpServers = {
      ...claudeMcpServers(this.currentMcp),
      ...(firstParty ? { [firstParty.name]: { type: "http" as const, url: firstParty.url, headers: firstParty.headers } } : {}),
    }
    return Object.keys(mcpServers).length ? { mcpServers } : {}
  }

  /** Selected reasoning effort, echoed back through `configOptions`. */
  private currentEffort: string | undefined

  async createAgentSession() {
    return { id: `${CLAUDE_PENDING_PREFIX}${randomUUID()}` }
  }

  deleteAgentSession(sessionId: string) {
    this.goalStore.forget(sessionId)
  }

  createRuntime(threadId: string, todos: Array<{ id?: string; content: string; status: string }> = []): AgentEventRuntime {
    return createAgentEventRuntime({
      harness: this.type,
      threadId,
      adapter: claudeSdkAdapter(todos.flatMap((todo) => todo.id
        ? [{ id: todo.id, description: todo.content, status: todo.status }]
        : [])),
    })
  }

  async runTurn(input: SdkRuntimeTurnInput) {
    await this.runQuery(input, extractTextFromParts(input.input.parts))
  }

  private async stopGoal(sessionId: string, directory: string) {
    const goal = this.goalStore.peek(sessionId)
    if (!goal) return null
    const resume = this.host.getAgentSessionId(sessionId)
    if (!resume || resume.startsWith(CLAUDE_PENDING_PREFIX)) throw new Error("Claude Goal has no native session to clear")
    // Claude persists its Stop hook in the session transcript. Kill and drain
    // its current query before reopening that same session to clear the hook.
    await interruptGoalTurn(sessionId, this.host.lifecycle())
    const abortController = new AbortController()
    let cleared = false
    const q = (this.driverOptions.query ?? query)({
      prompt: nativeGoalCommand("clear"),
      options: {
        cwd: directory,
        resume,
        pathToClaudeCodeExecutable: (this.driverOptions.executable ?? requireClaudeExecutable)(),
        abortController,
        tools: [],
        maxTurns: 1,
        canUseTool: async () => ({ behavior: "deny", message: "Clearing the session Goal does not execute tools" }),
        env: claudeSpawnEnv({ ...process.env, ...claudeAuthEnv(this.auth.anthropic) }),
        spawnClaudeCodeProcess: (options) => spawnObservedClaudeCodeProcess({
          options, observer: this.host.processObserver, role: "harness", sessionId,
        }),
      },
    })
    const timeout = setTimeout(() => abortController.abort(), 30_000)
    try {
      for await (const message of q) {
        // Slash commands are handled locally. A model turn is not evidence
        // that the native command cleared the persisted hook.
        if (message.type === "result") {
          cleared = message.subtype === "success" && !message.is_error && message.num_turns === 0
        }
      }
      if (!cleared) throw new Error("Claude did not confirm clearing the native Goal")
    } catch (cause) {
      const blocked = { ...goal, status: "blocked" as const, updatedAt: Date.now(), lastReason: errorMessage(cause) }
      this.goalStore.apply(sessionId, blocked)
      this.host.publishGoal({ sessionId, directory, goal: blocked })
      throw cause
    } finally {
      clearTimeout(timeout)
      q.close()
    }
    const paused = { ...goal, status: "paused" as const, updatedAt: Date.now() }
    this.goalStore.apply(sessionId, paused)
    return paused
  }

  private async runQuery(
    input: SdkRuntimeTurnInput,
    prompt: string,
    onGoal?: (goal: RuntimeGoalSnapshot | null) => void,
  ) {
    const applyGoal = (goal: RuntimeGoalSnapshot | null) => {
      this.goalStore.apply(input.sessionId, goal)
      onGoal?.(goal)
      this.host.publishGoal({ sessionId: input.sessionId, directory: input.directory, goal })
    }
    let goalSessionStore: SessionStore | undefined
    if (onGoal) {
      /**
       * A WRITE-ONLY observer, not a storage adapter: this store exists solely
       * because `append` is the only channel on which the CLI reports Goal
       * progress. It deliberately keeps nothing.
       *
       * Storing (or importing) a transcript here would be worse than useless.
       * The subprocess keeps writing its own complete local JSONL — this is a
       * secondary copy — and the SDK redirects resume at the store only when
       * `load()` answers with entries, which it materializes into a temporary
       * CLAUDE_CONFIG_DIR and resumes the CLI from INSTEAD of that local
       * transcript. Answering with nothing keeps the CLI on its own history;
       * answering with a mirror would cost an O(transcript) import per Goal
       * turn and, since ordinary turns run without a `sessionStore` and never
       * reach here, would eventually resume from a copy missing them.
       */
      goalSessionStore = {
        append: async (_key, entries) => {
          if (input.abort.signal.aborted) return
          for (const entry of entries) {
            const goal = claudeTranscriptGoalSnapshot(
              input.sessionId,
              entry,
              this.goalStore.peek(input.sessionId),
            )
            if (goal !== undefined) applyGoal(goal)
          }
        },
        load: async () => null,
        listSessions: async () => [],
        listSubkeys: async () => [],
      }
    }
    const requestPermission: CanUseTool = async (toolName, toolInput, options) => {
      const questions = toolName === "AskUserQuestion" ? toolInput.questions : undefined
      if (toolName === "AskUserQuestion" && (!Array.isArray(questions) || !questions.length || questions.some((question) => !text(asRecord(question)?.question)))) {
        throw new Error("Claude AskUserQuestion requires a non-empty questions array")
      }
      const requestId = randomUUID()
      input.ingest({
        source: "claude.sdk",
        method: "claude/can-use-tool",
        payload: {
          requestId,
          toolName,
          input: toolInput,
          suggestions: options.suggestions,
        },
      }, {
        dir: "in",
        method: "claude.canUseTool",
        frame: { toolName, toolInput },
      })
      if (Array.isArray(questions)) {
        let cancel: () => void = () => {}
        try {
          const answers = await new Promise<AgentQuestionAnswer[] | undefined>((resolve) => {
            cancel = () => {
              this.host.pendingQuestions.delete(requestId)
              resolve(undefined)
            }
            this.host.pendingQuestions.set(requestId, {
              sessionId: input.sessionId,
              agentSessionId: input.getAgentSessionId(),
              questions,
              resolve,
              reject: () => resolve(undefined),
            })
            options.signal.addEventListener("abort", cancel, { once: true })
            if (options.signal.aborted) cancel()
          })
          if (!answers) return { behavior: "deny", message: "User dismissed the question" }
          if (answers.length !== questions.length) throw new Error("Claude question reply must answer each question")
          return {
            behavior: "allow",
            updatedInput: {
              ...toolInput,
              answers: Object.fromEntries(questions.map((question, index) => [
                text(asRecord(question)?.question)!,
                answers[index]!.join(", "),
              ])),
            },
          }
        } finally {
          options.signal.removeEventListener("abort", cancel)
        }
      }
      const decision = await new Promise<"allow_once" | "allow_always" | "deny" | "reject_always">((resolve) => {
        this.host.pendingPermissions.set(requestId, {
          sessionId: input.sessionId,
          agentSessionId: input.getAgentSessionId(),
          method: "claude/can-use-tool",
          params: { toolName, input: toolInput, suggestions: options.suggestions },
          resolve,
        })
      })
      const updates = decision === "allow_always" ? sessionPermissionSuggestions(options.suggestions) : undefined
      if (updates?.length) {
        const accepted = applyClaudePermissionUpdates(this.host.getSessionConfig(input.sessionId)?.permissionState, updates)
        // Persist before allowing execution, so a failed write cannot silently
        // turn a durable approval into a one-turn approval.
        this.host.updatePermissionState(input.sessionId, accepted.permissions, accepted.mode)
        if (accepted.mode) this.permissionSelection.set(input.sessionId, accepted.mode)
      }
      const result: PermissionResult = decision === "allow_once" || decision === "allow_always"
        ? {
            behavior: "allow",
            ...(decision === "allow_always" ? { updatedPermissions: updates } : {}),
          }
        : {
            behavior: "deny",
            message: "User denied the tool request",
            interrupt: decision === "reject_always",
          }
      return result
    }

    const turnEffort = resolveTurnEffort(
      this.modelSource.peek(input.directory),
      input.input.model.modelID,
      input.input.variant,
    )
    const systemPrompt = claudeSystemPrompt(input.input.system)
    const permissionModeId = this.permissionSelection.currentId(input.sessionId)
    const permissions = readClaudePermissionState(this.host.getSessionConfig(input.sessionId)?.permissionState)
    const q: Query = (this.driverOptions.query ?? query)({
      prompt,
      options: {
        cwd: input.directory,
        ...(systemPrompt ? { systemPrompt } : {}),
        // Spawn the user's / sandbox image's installed Claude Code, never a
        // bundled binary. Throws an actionable install error when absent.
        pathToClaudeCodeExecutable: (this.driverOptions.executable ?? requireClaudeExecutable)(),
        includePartialMessages: true,
        ...(goalSessionStore ? { sessionStore: goalSessionStore, sessionStoreFlush: "eager" as const } : {}),
        forwardSubagentText: CLAUDE_FORWARD_SUBAGENT_TEXT,
        abortController: input.abort,
        // Both are passed together on purpose. `permissionMode` decides how much
        // runs unprompted; `canUseTool` only fires when the flow falls THROUGH to
        // a prompt, so under `bypassPermissions` it never runs at all. Policy that
        // must hold in every mode therefore cannot live in the callback — it lives
        // in the deny floor below.
        ...(isClaudeSdkPermissionMode(permissionModeId) ? { permissionMode: permissionModeId } : {}),
        ...(permissionModeId === "bypassPermissions" ? { allowDangerouslySkipPermissions: true as const } : {}),
        additionalDirectories: permissions.additionalDirectories,
        settings: { permissions: {
          allow: permissions.allow,
          ask: permissions.ask,
          deny: [...permissions.deny, ...CLAUDE_DENY_FLOOR],
        } },
        canUseTool: requestPermission,
        ...(input.input.agent ? { agent: input.input.agent } : {}),
        ...(turnModel(input.input.model.modelID, input.model) ? { model: turnModel(input.input.model.modelID, input.model) } : {}),
        // Reasoning effort rides the TURN, not a config push. A Claude turn is
        // exactly one `query()`, and the SDK takes `effort` as a per-query
        // option alongside `model` and `agent` above — so this is the same
        // shape where the chosen level travels on the prompt rather than being
        // pushed at the process. `variant` is the
        // field that already carries it end to end (`PromptInput.variant`).
        ...(turnEffort ? { effort: turnEffort } : {}),
        ...(input.getAgentSessionId().startsWith(CLAUDE_PENDING_PREFIX)
          ? {}
          : { resume: input.getAgentSessionId() }),
        ...this.mcpServersFor(input.sessionId),
        ...(this.currentPlugins.length ? { plugins: this.currentPlugins } : {}),
        env: claudeSpawnEnv({
          ...process.env,
          ...claudeAuthEnv(this.auth.anthropic),
          CLAUDE_AGENT_SDK_CLIENT_APP: "claxedo-workspace-runtime/0.1.0",
          CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
          CLAUDE_CODE_ENABLE_TASKS: "1",
        }),
        spawnClaudeCodeProcess: (options) => spawnObservedClaudeCodeProcess({
          options,
          observer: this.host.processObserver,
          role: "harness",
          sessionId: input.sessionId,
          mcp: this.currentMcp,
        }),
      },
    })
    this.host.lifecycle().set(input.sessionId, {
      abort: input.abort,
      close: () => q.close(),
    })
    try {
      let result: SDKMessage | undefined
      for await (const message of q as AsyncIterable<SDKMessage | SDKActiveGoalMessage>) {
        if (message.type === "active_goal") {
          if (input.abort.signal.aborted) continue
          applyGoal(claudeGoalSnapshot(input.sessionId, message))
          continue
        }
        // Ordinary query results precede subprocess cleanup. Keep their terminal
        // projection out of both the store and event hub until iteration closes.
        if (!onGoal && message.type === "result") {
          result = message
          continue
        }
        await ingestClaudeSdkMessage(input, message)
      }
      if (result) await ingestClaudeSdkMessage(input, result)
    } catch (cause) {
      // This query carried the Goal: if it died, no iteration is left to report
      // progress, so the Goal must not stay `active` — that state is what makes
      // the composer offer a Stop for work that is already gone.
      if (!onGoal) throw cause
      const settled = this.goalStore.settleUnfinished(
        input.sessionId,
        input.abort.signal.aborted
          ? { status: "paused" }
          : { status: "blocked", reason: errorMessage(cause) },
      )
      if (settled) applyGoal(settled)
      throw cause
    }
  }

  readRuntimeHealth(): AgentHarnessAdapterHealth {
    return { status: "ok" }
  }

  async configOptions(currentModel: string, directory?: string): Promise<AgentConfigOption[]> {
    return this.buildConfigOptions(await this.modelSource.models(directory), currentModel)
  }

  peekConfigOptions(currentModel: string, directory?: string): AgentConfigOption[] {
    return this.buildConfigOptions(this.modelSource.peek(directory), currentModel)
  }

  /**
   * Model first, then the selected model's effort levels when it has any. The
   * effort row is omitted rather than disabled for models without it — an inert
   * control that appears and disappears with the model reads as a glitch.
   */
  private buildConfigOptions(models: readonly SdkModelEntry[], currentModel: string): AgentConfigOption[] {
    if (models.length === 0) return []
    const effort = thoughtLevelConfigOption(models, currentModel, this.currentEffort)
    return effort
      ? [modelConfigOption(models, currentModel), effort]
      : [modelConfigOption(models, currentModel)]
  }

  /**
   * The SDK only answers `supportedModels()` over an initialized session, so
   * list models through a short-lived probe query that never sends a prompt.
   * The never-yielding prompt stream keeps the CLI idle until `close()`.
   */
  private async fetchModels(directory?: string): Promise<SdkModelEntry[]> {
    const abort = new AbortController()
    const q: Query = query({
        prompt: idlePrompt(),
      options: {
        cwd: directory ?? process.cwd(),
        pathToClaudeCodeExecutable: requireClaudeExecutable(),
        abortController: abort,
        env: claudeSpawnEnv({
          ...process.env,
          ...claudeAuthEnv(this.auth.anthropic),
          CLAUDE_AGENT_SDK_CLIENT_APP: "claxedo-workspace-runtime/0.1.0",
        }),
        spawnClaudeCodeProcess: (options) => spawnObservedClaudeCodeProcess({
          options,
          observer: this.host.processObserver,
          role: "probe",
          mcp: this.currentMcp,
        }),
      },
    })
    try {
      const models = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`claude supportedModels timed out after ${MODEL_LIST_TIMEOUT_MS}ms`)), MODEL_LIST_TIMEOUT_MS).unref?.()
        }),
      ])
      return models.map((model) => ({
        id: model.value,
        name: model.displayName,
        ...(model.description ? { description: model.description } : {}),
        // Model-specific effort metadata drives the harness config options.
        ...(model.supportsEffort ? { supportsEffort: true } : {}),
        ...(model.supportedEffortLevels?.length
          ? { supportedEffortLevels: [...model.supportedEffortLevels] }
          : {}),
      }))
    } finally {
      q.close()
      abort.abort()
    }
  }
}

export async function ingestClaudeSdkMessage(
  input: Pick<SdkRuntimeTurnInput, "ingest" | "observeSubagent" | "rebindAgentSession">,
  message: SDKMessage,
) {
  const sdkSessionId = text(asRecord(message)?.session_id)
  if (sdkSessionId) input.rebindAgentSession(sdkSessionId)
  await Promise.all(claudeSubagentObservations(message).map((observation) => input.observeSubagent({
    observation,
    correlationKeys: [observation.stableCorrelationId, observation.toolCallId]
      .filter((key): key is string => !!key),
    source: {
      dir: "in",
      method: `claude.${message.type}`,
      frame: message,
    },
  })))
  input.ingest({
    source: "claude.sdk",
    method: `claude/${message.type}`,
    payload: message,
  }, {
    dir: "in",
    method: `claude.${message.type}`,
    frame: message,
  }, claudeChildCorrelationKey(message)
    ? { kind: "child", correlationKey: claudeChildCorrelationKey(message) }
    : { kind: "parent" })
}

export function spawnObservedClaudeCodeProcess(input: {
  options: SpawnOptions
  observer?: AgentProcessObserver
  role: "harness" | "probe"
  sessionId?: string
  mcp?: Record<string, ResolvedMcpServer>
  spawnProcess?: typeof spawn
}): SpawnedProcess {
  const proc = (input.spawnProcess ?? spawn)(
    input.options.command,
    input.options.args,
    {
      ...(input.options.cwd ? { cwd: input.options.cwd } : {}),
      env: input.options.env,
      signal: input.options.signal,
      stdio: ["pipe", "pipe", "inherit"],
    },
  )
  const ownerId = `claude-${input.role}:${randomUUID()}`
  const handles = [
    observeAgentProcess(input.observer, {
      ownerId,
      launchId: randomUUID(),
      harnessId: "claude",
      access: "native",
      role: input.role,
      label: input.role === "probe" ? "Claude model probe" : "Claude Code",
      locality: "local-process",
      confidence: proc.pid ? "direct" : "inferred",
      capabilities: {
        resourceMetrics: "process",
        ownerActions: false,
      },
      ...(proc.pid ? { pid: proc.pid } : {}),
      ...(input.options.cwd ? { directory: input.options.cwd } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      executableBasename: input.options.command.split(/[\\/]/).at(-1) || "claude",
    }),
    ...Object.values(input.mcp ?? {}).map((server) => observeAgentProcess(input.observer, {
      ownerId: `claude-mcp:${randomUUID()}`,
      launchId: randomUUID(),
      harnessId: "claude",
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
      ...(input.options.cwd ? { directory: input.options.cwd } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      mcpName: server.name,
      transport: server.transport === "stdio" ? "stdio" as const : "streamable-http" as const,
      ...(server.transport === "stdio"
        ? { executableBasename: server.command.split(/[\\/]/).at(-1) || "mcp" }
        : {}),
    })),
  ]
  let exited = false
  const exit = (event: Parameters<AgentProcessObserverHandle["exit"]>[0]) => {
    if (exited) return
    exited = true
    handles.forEach((handle) => handle.exit(event))
  }
  proc.once("exit", (code) => exit({
    reason: "exited",
    ...(code !== null ? { exitCode: code } : {}),
  }))
  proc.once("error", () => exit({ reason: "error" }))
  handles.forEach((handle) => handle.update({ lifecycle: "ready" }))
  return proc
}

export function claudeSpawnEnv(input: Record<string, string | undefined>) {
  return harnessSpawnEnv(input)
}

function claudeMcpServers(input: Record<string, ResolvedMcpServer>): Record<string, McpServerConfig> {
  return Object.fromEntries(Object.entries(input).map(([name, server]): [string, McpServerConfig] => {
    if (server.transport === "stdio") {
      return [name, {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: server.env,
      }]
    }
    return [name, {
      type: "http",
      url: server.url,
      headers: server.headers,
    }]
  }))
}

function turnModel(input: string | undefined, configuredModel: string) {
  const value = text(input) ?? text(configuredModel)
  if (!value || value === "default") return undefined
  return value
}

function sessionPermissionSuggestions(suggestions?: PermissionUpdate[]) {
  if (!suggestions?.length) return undefined
  return suggestions.map((item) => ({ ...item, destination: "session" as const }))
}

type ClaudePermissionState = {
  allow: string[]
  deny: string[]
  ask: string[]
  additionalDirectories: string[]
}

function readClaudePermissionState(state?: Record<string, unknown>): ClaudePermissionState {
  const result: ClaudePermissionState = { allow: [], deny: [], ask: [], additionalDirectories: [] }
  for (const key of ["allow", "deny", "ask", "additionalDirectories"] as const) {
    const value = state?.[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(`Invalid persisted Claude permission ${key}`)
    }
    result[key] = [...value]
  }
  return result
}

/** Replay the provider's accepted updates; rule matching remains Claude's job. */
export function applyClaudePermissionUpdates(state: Record<string, unknown> | undefined, updates: PermissionUpdate[]) {
  const permissions = readClaudePermissionState(state)
  let mode: string | undefined
  for (const update of updates) {
    if (update.type === "setMode") {
      if (!isClaudeSdkPermissionMode(update.mode)) throw new Error(`Unsupported Claude permission mode ${update.mode}`)
      mode = update.mode
    } else if (update.type === "addDirectories") {
      permissions.additionalDirectories = [...new Set([...permissions.additionalDirectories, ...update.directories])]
    } else if (update.type === "removeDirectories") {
      permissions.additionalDirectories = permissions.additionalDirectories.filter((value) => !update.directories.includes(value))
    } else {
      const rules = update.rules.map((rule) => rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`)
      const current = permissions[update.behavior]
      permissions[update.behavior] = update.type === "replaceRules" ? rules
        : update.type === "removeRules" ? current.filter((value) => !rules.includes(value))
        : [...new Set([...current, ...rules])]
    }
  }
  return { permissions, mode }
}
